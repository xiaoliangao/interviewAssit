import { describe, expect, it } from 'vitest';
import { redact, redactCode, scrubSecrets } from '@assit/core';

/**
 * 脱敏守门（plan §3.2）。
 *
 * 设计文档多处写「只发脱敏摘要」但没定义脱敏产出什么 —— 那种约定在第一次赶工时就会失效。
 * 这里把它钉成断言：这些样例出现在输出里，就是回归。
 */
const LOADED = `
// 库存扣减：热点 SKU 下用分布式锁替换乐观锁重试
package inventory

const dsn = "mysql://root:hunter2@10.12.3.44:3306/orders?charset=utf8"
const awsKey = "AKIAIOSFODNN7EXAMPLE"
const ghToken = "ghp_1234567890abcdefghijklmnopqrstuvwx"
const openaiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz123456"
var adminEmail = "ops@corp.example.com"
var oncall = "13800138000"
const internalHost = "order-db.internal"

func Deduct(ctx context.Context, sku string, n int) error {
    lock := redislock.New("inv:" + sku, 3*time.Second)
    if err := lock.Acquire(ctx); err != nil {
        return fmt.Errorf("acquire: %w", err)
    }
    defer lock.Release(ctx)
    stock := repo.Get(ctx, sku)
    if stock < n {
        return ErrOversell
    }
    repo.Decr(ctx, sku, n)
    return nil
}
`;

const FORBIDDEN = [
  'AKIAIOSFODNN7EXAMPLE',
  'ghp_1234567890abcdefghijklmnopqrstuvwx',
  'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
  '10.12.3.44',
  'hunter2',
  'ops@corp.example.com',
  '13800138000',
  'order-db.internal',
];

describe('脱敏守门：凭据和内网标识不许出机器', () => {
  it('scrubSecrets 清掉全部样例凭据', () => {
    const { text } = scrubSecrets(LOADED);
    for (const secret of FORBIDDEN) {
      expect(text, `泄漏了 ${secret}`).not.toContain(secret);
    }
  });

  it('每个级别都跑过一遍凭据清洗，不只是 signatures', () => {
    for (const level of ['none', 'signatures', 'summary'] as const) {
      const { text } = redact(LOADED, level);
      for (const secret of FORBIDDEN) {
        expect(text, `level=${level} 泄漏了 ${secret}`).not.toContain(secret);
      }
    }
  });

  it('signatures 级保留结构和设计注释，丢掉函数体', () => {
    const { text } = redactCode(LOADED);
    // 模型要能问出「为什么用分布式锁」，就得看得见签名和注释
    expect(text).toContain('func Deduct');
    expect(text).toContain('分布式锁');
    expect(text).toContain('package inventory');
    // 但拿不到可复制的业务实现
    expect(text).not.toContain('repo.Decr(ctx, sku, n)');
    expect(text).toMatch(/行实现已省略/);
  });

  it('signatures 级把字符串常量打码 —— 常量里最常藏配置', () => {
    const { text } = redactCode(LOADED);
    expect(text).not.toContain('charset=utf8');
  });

  it('summary 级不许有任何代码形态的行', () => {
    const { text } = redact(LOADED, 'summary');
    expect(text).not.toContain('func Deduct');
    expect(text).not.toContain('package inventory');
  });

  it('私钥整块被吃掉', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJ\nxxxx\n-----END RSA PRIVATE KEY-----`;
    const { text } = scrubSecrets(pem);
    expect(text).not.toContain('MIIEowIBAAKCAQEA0Z3VS5JJ');
    expect(text).toContain('«PRIVATE_KEY»');
  });

  it('公网地址和普通文本不受影响 —— 过度脱敏会让上下文不可用', () => {
    const ok = '参考 https://pkg.go.dev/sync 的文档，服务部署在 8.8.8.8 之外的公有云';
    const { text } = scrubSecrets(ok);
    expect(text).toContain('8.8.8.8');
    expect(text).toContain('pkg.go.dev');
  });

  it('report 记录了清掉了哪几类，便于事后审计', () => {
    const { report } = redact(LOADED, 'signatures');
    expect(report.level).toBe('signatures');
    expect(report.removed).toContain('aws-access-key');
    expect(report.removed).toContain('function-bodies');
    expect(report.outputChars).toBeLessThan(report.originalChars);
  });
});
