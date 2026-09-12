import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDERS,
  NoProviderAvailable,
  PrivacyBlocked,
  canHandle,
  complete,
  route,
} from '@assit/core';
import { registryOf } from './helpers.js';

const API = { id: 'api:anthropic', kind: 'api', max_visibility: 'public', model: 'm-api' } as const;
const CLI = { id: 'cli:claude', kind: 'cli', max_visibility: 'public', model: 'm-cli' } as const;
const LOCAL = { id: 'local:ollama', kind: 'local', max_visibility: 'nda', model: 'm-local' } as const;

/**
 * 路由守门（plan §7.2 / §9.1）。
 *
 * 这组测试保护的是一条不能出错的规则：公司代码不许流到云端。
 * 靠用户在设置页选对模型是不够的 —— 人会忘，赶时间时尤其会忘。
 */
describe('路由守门：visibility 是闸门，不是提示', () => {
  it('cli:* 的敏感级上限和 api:* 相同 —— 它同样把内容发到云端', () => {
    // 把 CLI 当「本地」是这个系统最容易犯的错误：claude / codex / gemini
    // 都要联网，隐私边界跟直接调 API 没有区别
    for (const spec of DEFAULT_PROVIDERS) {
      if (spec.kind === 'cli' || spec.kind === 'api') {
        expect(spec.max_visibility, `${spec.id} 不该能处理 public 以上`).toBe('public');
      }
      if (spec.kind === 'local') expect(spec.max_visibility).toBe('nda');
    }
  });

  it('只有云端 provider 时，private 载荷抛 PrivacyBlocked', async () => {
    const registry = registryOf(API, CLI);
    await expect(
      route('code_analysis', 'private', {
        registry,
        routes: { code_analysis: { provider: 'api:anthropic', fallback: ['cli:claude'] } },
      }),
    ).rejects.toBeInstanceOf(PrivacyBlocked);
  });

  it('nda 载荷同样被挡住', async () => {
    const registry = registryOf(API);
    await expect(
      route('resume_rewrite', 'nda', {
        registry,
        routes: { resume_rewrite: { provider: 'api:anthropic', fallback: [] } },
      }),
    ).rejects.toBeInstanceOf(PrivacyBlocked);
  });

  it('报错信息要能行动：说清楚谁挡了、该去配什么', async () => {
    const registry = registryOf(API, CLI);
    try {
      await route('code_analysis', 'private', {
        registry,
        routes: { code_analysis: { provider: 'api:anthropic', fallback: ['cli:claude'] } },
      });
      expect.unreachable('应该抛 PrivacyBlocked');
    } catch (e) {
      const err = e as PrivacyBlocked;
      expect(err.rejected.map((r) => r.id).sort()).toEqual(['api:anthropic', 'cli:claude']);
      expect(err.message).toContain('本地模型');
    }
  });

  it('降级链跳过不合格的 provider，而不是「降级到弱模型」', async () => {
    // 首选是云端且载荷是 private -> 不是退而求其次用它，是直接跳过
    const registry = registryOf(API, CLI, LOCAL);
    const d = await route('code_analysis', 'private', {
      registry,
      routes: {
        code_analysis: { provider: 'api:anthropic', fallback: ['cli:claude', 'local:ollama'] },
      },
    });
    expect(d.provider.spec.id).toBe('local:ollama');
    expect(d.skippedForPrivacy.map((s) => s.id)).toEqual(['api:anthropic', 'cli:claude']);
  });

  it('public 载荷正常走首选，不会被无谓地推到本地模型', async () => {
    const registry = registryOf(API, CLI, LOCAL);
    const d = await route('jd_extract', 'public', {
      registry,
      routes: { jd_extract: { provider: 'api:anthropic', fallback: ['local:ollama'] } },
    });
    expect(d.provider.spec.id).toBe('api:anthropic');
    expect(d.skippedForPrivacy).toEqual([]);
  });

  it('不可用的 provider 顺着降级链往下走', async () => {
    const registry = registryOf({ ...API, available: false }, CLI);
    const d = await route('jd_extract', 'public', {
      registry,
      routes: { jd_extract: { provider: 'api:anthropic', fallback: ['cli:claude'] } },
    });
    expect(d.provider.spec.id).toBe('cli:claude');
    expect(d.skippedForAvailability).toEqual(['api:anthropic']);
  });

  it('「没配 key」和「敏感级不够」是两种错误，不能混成一种', async () => {
    // 混成一个错误的话，你分不清该装 ollama 还是该填 API key
    const empty = registryOf({ ...API, available: false });
    await expect(
      route('jd_extract', 'public', {
        registry: empty,
        routes: { jd_extract: { provider: 'api:anthropic', fallback: [] } },
      }),
    ).rejects.toBeInstanceOf(NoProviderAvailable);
  });

  it('canHandle 的偏序：public < private < nda', () => {
    expect(canHandle(API, 'public')).toBe(true);
    expect(canHandle(API, 'private')).toBe(false);
    expect(canHandle(API, 'nda')).toBe(false);
    expect(canHandle(LOCAL, 'public')).toBe(true);
    expect(canHandle(LOCAL, 'private')).toBe(true);
    expect(canHandle(LOCAL, 'nda')).toBe(true);
  });

  it('complete() 走的是同一个闸门 —— 没有旁路', async () => {
    // 这条最重要：拦截必须在唯一入口上，而不是散落在各个调用点
    const registry = registryOf(API);
    await expect(
      complete(
        { task: 'code_analysis', visibility: 'private', prompt: 'func Deduct() {}' },
        { registry, routes: { code_analysis: { provider: 'api:anthropic', fallback: [] } } },
      ),
    ).rejects.toBeInstanceOf(PrivacyBlocked);
  });
});
