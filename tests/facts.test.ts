import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadFactsOrThrow,
  openDb,
  syncFacts,
  validateFacts,
  validateRubricFile,
  type Db,
} from '@assit/core';

let dir: string;
let db: Db;

function writeProfile(extra: string = ''): void {
  fs.writeFileSync(
    path.join(dir, 'facts', 'profile.yaml'),
    `fields:
  name.zh: 李工
  phone: "13900001111"
  email: a@b.com
records:
  employment:
    - company: 杭州盈通网络科技有限公司
      title: 高级后端工程师
      start_at: 2021-03
      end_at: null
      is_current: true
${extra}
preferences: {}
`,
  );
}

function writeClaim(name: string, obj: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'facts', 'claims', `${name}.json`), JSON.stringify(obj, null, 2));
}

const BASE_CLAIM = {
  id: 'claim-a-001',
  source_fact: '重构订单服务库存扣减',
  candidate_wording: '重构库存扣减链路，消除并发超卖',
  responsibility_level: '主导方案或交付',
  verification_status: '已确认',
  boundary: '方案与核心实现是我；压测由 QA 执行',
  visibility: 'private',
  last_verified: '2026-08-01',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-facts-'));
  process.env.ASSIT_DATA_DIR = dir;
  fs.mkdirSync(path.join(dir, 'facts', 'claims'), { recursive: true });
  writeProfile();
  db = openDb(path.join(dir, 'test.sqlite'));
});

afterEach(() => {
  db.close();
  delete process.env.ASSIT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('事实库校验', () => {
  it('干净的事实库通过', () => {
    writeClaim('a', BASE_CLAIM);
    const r = validateFacts();
    expect(r.ok).toBe(true);
    expect(r.facts!.claims).toHaveLength(1);
  });

  it('缺必填登记字段是错误', () => {
    fs.writeFileSync(
      path.join(dir, 'facts', 'profile.yaml'),
      'fields:\n  name.zh: 李工\nrecords: {}\npreferences: {}\n',
    );
    const r = validateFacts();
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.message.includes('phone'))).toBe(true);
  });

  it('boundary 缺失直接被 schema 拦下 —— 它是项目深挖的基础', () => {
    const { boundary, ...noBoundary } = BASE_CLAIM;
    writeClaim('a', noBoundary);
    expect(validateFacts().ok).toBe(false);
  });

  it('标成「已确认」却没有确认日期是错误', () => {
    writeClaim('a', { ...BASE_CLAIM, last_verified: null });
    const r = validateFacts();
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.message.includes('确认日期'))).toBe(true);
  });

  it('久未复核的「已确认」给警告，提示转「已过期」', () => {
    writeClaim('a', { ...BASE_CLAIM, last_verified: '2023-01-01' });
    const r = validateFacts({ now: new Date('2026-09-12') });
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.severity === 'warn' && f.message.includes('未复核'))).toBe(true);
  });

  it('主张 id 重复是错误', () => {
    writeClaim('a', BASE_CLAIM);
    writeClaim('b', { ...BASE_CLAIM, source_fact: '另一件事' });
    const r = validateFacts();
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.message.includes('id 重复'))).toBe(true);
  });

  it('code_evidence 的 visibility 与主张不一致是错误 —— 会让路由拦截失效', () => {
    writeClaim('a', {
      ...BASE_CLAIM,
      visibility: 'private',
      code_evidence: { repo: 'org/x', visibility: 'public', commits: ['abc1234'] },
    });
    const r = validateFacts();
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.where === 'code_evidence.visibility')).toBe(true);
  });

  it('过期证书给警告并说明会被剔除', () => {
    writeProfile(`  certificate:
    - name: 某过期认证
      issued_at: 2021-01-01
      expires_at: 2024-01-01`);
    writeClaim('a', BASE_CLAIM);
    const r = validateFacts({ now: new Date('2026-09-12') });
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.message.includes('证书已过期'))).toBe(true);
  });

  it('在职经历填了 end_at 是错误', () => {
    writeProfile();
    const p = path.join(dir, 'facts', 'profile.yaml');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('end_at: null', 'end_at: 2025-01'));
    writeClaim('a', BASE_CLAIM);
    const r = validateFacts();
    expect(r.ok).toBe(false);
  });
});

describe('事实库同步：状态变更必须留痕', () => {
  it('首次同步写入主张与档案', () => {
    writeClaim('a', BASE_CLAIM);
    const facts = validateFacts().facts!;
    const r = syncFacts(db, facts);
    expect(r.claimsInserted).toBe(1);
    expect(r.profileRecords).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM claims').get()).toEqual({ n: 1 });
  });

  it('重复同步不产生噪音事件', () => {
    writeClaim('a', BASE_CLAIM);
    const facts = validateFacts().facts!;
    syncFacts(db, facts);
    const r2 = syncFacts(db, validateFacts().facts!);
    expect(r2.claimsUnchanged).toBe(1);
    expect(r2.events).toBe(0);
  });

  it('责任等级被改动时写 claim_events —— 降级要可追溯、可撤销', () => {
    writeClaim('a', BASE_CLAIM);
    syncFacts(db, validateFacts().facts!);

    writeClaim('a', { ...BASE_CLAIM, responsibility_level: '参与' });
    const r = syncFacts(db, validateFacts().facts!);
    expect(r.claimsUpdated).toBe(1);

    const ev = db
      .prepare("SELECT * FROM claim_events WHERE field='responsibility_level'")
      .get() as any;
    expect(ev.old_value).toBe('主导方案或交付');
    expect(ev.new_value).toBe('参与');
    expect(ev.source).toBe('sync');
  });

  it('文件里删掉的主张标成「不采用」而不是物理删除', () => {
    // 它可能正被某份已经投出去的简历引用 —— 删了就对不上账
    writeClaim('a', BASE_CLAIM);
    syncFacts(db, validateFacts().facts!);
    fs.unlinkSync(path.join(dir, 'facts', 'claims', 'a.json'));
    writeClaim('b', { ...BASE_CLAIM, id: 'claim-b-001' });
    syncFacts(db, validateFacts().facts!);

    const row = db.prepare("SELECT verification_status s FROM claims WHERE id='claim-a-001'").get() as any;
    expect(row.s).toBe('不采用');
    const ev = db
      .prepare("SELECT COUNT(*) n FROM claim_events WHERE claim_id='claim-a-001'")
      .get() as any;
    expect(ev.n).toBe(1);
  });

  it('外键是开着的 —— 否则所有 REFERENCES 都只是注释', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO resume_bullets (id, resume_version_id, claim_id, section, text)
           VALUES ('b1','nope','nope','项目','x')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('投递的人工确认闸门是 schema 级约束', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO applications
            (id, posting_id, company_id, application_key, channel, resume_sha256, jd_sha256, sent_at, confirmed_by_user)
           VALUES ('a1','p1','c1','k','form','r','j','2026-09-12',0)`,
        )
        .run(),
    ).toThrow();
  });
});

// ── rubric 校验 ────────────────────────────────────────────────────────────
//
// 这组测试的由来：rubric 文件和契约漂移之后，**所有岗位静默地打不出分**，
// 而 `assit validate` 说「通过」。唯一的线索是界面角落一个横幅。
// 下面四条锁住的是「这种事不能再发生」。

describe('rubric 校验：坏掉要响，但不能拦住简历', () => {
  const writeRubric = (text: string): void => {
    fs.mkdirSync(path.join(dir, 'facts', 'rubric'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'facts', 'rubric', 'v1.yaml'), text, 'utf8');
  };

  it('没有 rubric 是 warn 不是 error —— 还没配打分是合法状态', () => {
    const r = validateRubricFile();
    expect(r.every((f) => f.severity === 'warn')).toBe(true);
    expect(r[0]!.message).toMatch(/没有 rubric/);
  });

  it('解析不了要报 error，并明说后果是「所有岗位都打不出分」', () => {
    // 这正是真实踩到的那一份：早期模板留在原地，契约后来变了
    writeRubric(`weights:
  core_stack: 40
  domain_fit: 15
  commute: 10
caps:
  - when: "core_stack 得分 < max*0.5"
    final_score_max: 55
    label: missing_core_stack
`);
    const r = validateRubricFile();
    const errs = r.filter((f) => f.severity === 'error');
    expect(errs.length).toBeGreaterThan(1);
    expect(errs.some((f) => /打不出分/.test(f.message))).toBe(true);
    expect(errs.some((f) => /domain_fit|commute/.test(f.message))).toBe(true);
  });

  it('rubric 坏掉不影响事实库本身可用 —— 打分和简历是两件事', () => {
    writeRubric('weights:\n  nope: 1\n');
    const r = validateFacts();
    expect(r.ok).toBe(false); // 整体不通过，退出码要非零
    expect(r.facts).toBeDefined(); // 但简历照样能生成
    expect(() => loadFactsOrThrow()).not.toThrow();
  });

  it('模板值只报 warn，因为它是「能跑但算的是别人」', () => {
    writeRubric(`profile:
  cities: [杭州, 上海]
  stack: [go, redis, mysql, kubernetes, kafka, docker, linux]
  target_roles: [backend, sre, architect, swe, fullstack]
weights:
  core_stack: 40
`);
    const r = validateRubricFile();
    expect(r.filter((f) => f.severity === 'error')).toHaveLength(0);
    const paths_ = r.map((f) => f.where);
    expect(paths_).toContain('profile.stack');
    expect(paths_).toContain('profile.cities');
    expect(paths_).toContain('profile.target_roles');
  });
});
