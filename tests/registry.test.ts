import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRegistrySync,
  collectBytedance,
  collectTencent,
  doctorRegistry,
  loadRegistry,
  parseExpYears,
  planRegistrySync,
  registryToSources,
  writeBackRegistry,
} from '@assit/core';
import type { EmployerEntry } from '@assit/contract';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-reg-'));
  process.env.ASSIT_REGISTRY_DIR = dir;
});
afterEach(() => {
  delete process.env.ASSIT_REGISTRY_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 一个只按 URL 匹配返回固定响应的 fetch。匹配不到就 404 —— 沉默地成功是最坏的测试。 */
function stubFetch(routes: Record<string, { status?: number; body: string }>): typeof fetch {
  return (async (input: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const r = hit ? hit[1] : { status: 404, body: 'not found' };
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: () => null },
      text: async () => r.body,
    };
  }) as unknown as typeof fetch;
}

const TX_LIST = JSON.stringify({
  Code: 200,
  Data: { Count: 1, Posts: [{ PostId: 'p1', RecruitPostName: '后台开发工程师', LocationName: '深圳',
    ProductName: 'QQ', BGName: 'TEG', Responsibility: '写服务', RequireWorkYearsName: '三年以上工作经验' }] },
});
const TX_DETAIL = JSON.stringify({
  Code: 200,
  Data: { PostId: 'p1', RecruitPostName: '后台开发工程师', LocationName: '深圳',
    Responsibility: '写服务', Requirement: '熟练掌握 Go', RequireWorkYearsName: '三年以上工作经验' },
});

function writeRegistry(text: string): void {
  fs.writeFileSync(path.join(dir, 'cn.yaml'), text, 'utf8');
}

// ── 自建站适配器 ──────────────────────────────────────────────────────────

describe('腾讯适配器', () => {
  it('列表只有职责，任职要求要从详情补 —— 而要求才是打分要看的那一半', async () => {
    const f = stubFetch({ '/post/Query': { body: TX_LIST }, '/post/ByPostId': { body: TX_DETAIL } });
    const r = await collectTencent({ fetchImpl: f, pages: 1, intervalMs: 0 });
    expect(r.postings).toHaveLength(1);
    const p = r.postings[0]!;
    expect(p.jd_text).toContain('岗位职责');
    expect(p.jd_text).toContain('任职要求');
    expect(p.jd_text).toContain('熟练掌握 Go');
  });

  it('ProductName 进 JD 抬头而不是 title —— 它会污染职能分类还参与去重', async () => {
    const f = stubFetch({ '/post/Query': { body: TX_LIST }, '/post/ByPostId': { body: TX_DETAIL } });
    const p = (await collectTencent({ fetchImpl: f, pages: 1, intervalMs: 0 })).postings[0]!;
    expect(p.title).toBe('后台开发工程师');
    expect(p.title).not.toContain('QQ');
    expect(p.jd_text).toContain('所属产品：QQ');
  });

  it('年限来自站点结构化字段，所以记 explicit_jd 而不是从正文猜', async () => {
    const f = stubFetch({ '/post/Query': { body: TX_LIST }, '/post/ByPostId': { body: TX_DETAIL } });
    const p = (await collectTencent({ fetchImpl: f, pages: 1, intervalMs: 0 })).postings[0]!;
    expect(p.attrs.exp_years_min).toMatchObject({ value: 3, confidence: 'explicit_jd' });
  });

  it('认不出的年限返回 null，不猜', () => {
    expect(parseExpYears('三年以上工作经验')).toBe(3);
    expect(parseExpYears('5年以上')).toBe(5);
    expect(parseExpYears('应届毕业生')).toBe(0);
    expect(parseExpYears('经验不限')).toBe(0);
    expect(parseExpYears('资深')).toBeNull();
    expect(parseExpYears(null)).toBeNull();
  });
});

describe('字节适配器', () => {
  const BD = JSON.stringify({
    code: 0,
    data: { job_post_list: [{ id: 'b1', title: '后端工程师', description: '做事', requirement: '会 Go',
      city_info: { name: '北京' } }] },
  });

  it('不开 browser_ua 就显式失败，并说清为什么 —— 不替用户改 UA', async () => {
    await expect(collectBytedance({ fetchImpl: stubFetch({}) })).rejects.toThrow(/browser_ua/);
  });

  it('开了才采，且 JD 全文直接来自列表，不用翻详情', async () => {
    const f = stubFetch({ '/search/job/posts': { body: BD } });
    const r = await collectBytedance({ fetchImpl: f, browserUa: true, pages: 1, intervalMs: 0 });
    expect(r.postings).toHaveLength(1);
    expect(r.postings[0]!.jd_text).toContain('会 Go');
    expect(r.postings[0]!.city).toBe('北京');
  });

  it('非 0 的 code 被记成 rejected，而不是当成空结果', async () => {
    const f = stubFetch({ '/search/job/posts': { body: JSON.stringify({ code: 7, message: '频繁' }) } });
    const r = await collectBytedance({ fetchImpl: f, browserUa: true, pages: 1, intervalMs: 0 });
    expect(r.postings).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/code=7/);
  });
});

// ── 注册表 ────────────────────────────────────────────────────────────────

describe('注册表加载与展开', () => {
  it('id 撞车要显式失败 —— 静默覆盖要到岗位少一半才会发现', () => {
    writeRegistry('employers:\n  - {id: a, name: A, homepage: "https://a.com"}\n');
    fs.writeFileSync(path.join(dir, 'zz.yaml'), 'employers:\n  - {id: a, name: A2, homepage: "https://b.com"}\n');
    expect(() => loadRegistry()).toThrow(/id 重复/);
  });

  it('只有已打通的才展开成采集源，unverified 不会混进去', () => {
    writeRegistry(`employers:
  - {id: tencent, name: 腾讯, homepage: "https://careers.tencent.com", channel: api, adapter: tencent, status: ok}
  - {id: bytedance, name: 字节, homepage: "https://jobs.bytedance.com", channel: api, adapter: bytedance, status: needs_browser_ua}
  - {id: baidu, name: 百度, homepage: "https://talent.baidu.com", channel: cdp, status: needs_cdp}
  - {id: alibaba, name: 阿里, homepage: "https://talent.alibaba.com"}
`);
    const srcs = registryToSources(loadRegistry());
    expect(srcs.map((s) => s.id).sort()).toEqual(['bytedance', 'tencent']);
    const bd = srcs.find((s) => s.id === 'bytedance') as any;
    // 注册表明确记着这家需要，才预置成 true
    expect(bd.browser_ua).toBe(true);
    expect((srcs.find((s) => s.id === 'tencent') as any).browser_ua).toBe(false);
  });
});

describe('sources doctor', () => {
  const OK_REG = `# 顶部注释要活下来
employers:
  # tencent 上面这行注释也要活下来
  - id: tencent
    name: 腾讯
    homepage: https://careers.tencent.com
    channel: api
    adapter: tencent
    status: unverified
    note: 手写的理由
  - { id: alibaba, name: 阿里, homepage: "https://talent.alibaba.com" }
`;

  it('「主页能开」不会被洗成「能采」—— 这是这个功能最容易骗自己的地方', async () => {
    writeRegistry(OK_REG);
    const f = stubFetch({ 'talent.alibaba.com': { body: '<html></html>' } });
    const r = await doctorRegistry(loadRegistry(), { fetchImpl: f, only: ['alibaba'] });
    expect(r[0]!.kind).toBe('reachability');
    expect(r[0]!.ok).toBe(true);
    expect(r[0]!.status).toBeNull(); // 不写状态
    writeBackRegistry(r, dir);
    expect(fs.readFileSync(path.join(dir, 'cn.yaml'), 'utf8')).not.toContain('verified_at');
  });

  it('真采到了才写 ok + verified_at', async () => {
    writeRegistry(OK_REG);
    const f = stubFetch({ '/post/Query': { body: TX_LIST }, '/post/ByPostId': { body: TX_DETAIL } });
    const r = await doctorRegistry(loadRegistry(), { fetchImpl: f, only: ['tencent'] });
    expect(r[0]!.kind).toBe('collect');
    expect(r[0]!.status).toBe('ok');
    writeBackRegistry(r, dir, '2026-01-02');
    const text = fs.readFileSync(path.join(dir, 'cn.yaml'), 'utf8');
    expect(text).toContain('status: ok');
    expect(text).toContain('verified_at: 2026-01-02');
  });

  it('写回保留注释，并且不碰没变的条目', async () => {
    writeRegistry(OK_REG);
    const f = stubFetch({ '/post/Query': { body: TX_LIST }, '/post/ByPostId': { body: TX_DETAIL } });
    const r = await doctorRegistry(loadRegistry(), { fetchImpl: f, only: ['tencent'] });
    writeBackRegistry(r, dir, '2026-01-02');
    const text = fs.readFileSync(path.join(dir, 'cn.yaml'), 'utf8');
    expect(text).toContain('# 顶部注释要活下来');
    expect(text).toContain('# tencent 上面这行注释也要活下来');
    expect(text).toContain('note: 手写的理由');
    // 没被探测的那条一个字节都不该动
    expect(text).toContain('- { id: alibaba, name: 阿里, homepage: "https://talent.alibaba.com" }');
  });

  it('接口通了但零条不算验证过 —— 分不清是没在招还是字段变了', async () => {
    writeRegistry(OK_REG);
    const empty = JSON.stringify({ Code: 200, Data: { Count: 0, Posts: [] } });
    const r = await doctorRegistry(loadRegistry(), {
      fetchImpl: stubFetch({ '/post/Query': { body: empty } }), only: ['tencent'],
    });
    expect(r[0]!.ok).toBe(false);
    expect(r[0]!.status).toBeNull();
    expect(r[0]!.detail).toMatch(/没返回岗位/);
  });

  it('要浏览器 UA 记成 needs_browser_ua，不是 broken —— 那不是坏了，是要你做个决定', async () => {
    writeRegistry(`employers:
  - {id: bytedance, name: 字节, homepage: "https://jobs.bytedance.com", channel: api, adapter: bytedance, status: unverified}
`);
    const r = await doctorRegistry(loadRegistry(), { fetchImpl: stubFetch({}), only: ['bytedance'] });
    expect(r[0]!.status).toBe('needs_browser_ua');
  });
});

describe('registry sync：唯一的供应链入口', () => {
  const UP = `employers:
  - {id: tencent, name: 腾讯控股, homepage: "https://careers.tencent.com/new", channel: api, adapter: tencent}
  - {id: newco, name: 新公司, homepage: "https://newco.example.com", channel: ats, ats: {kind: greenhouse, token: newco}}
`;
  const SHA = 'a'.repeat(40);
  const src = { repo: 'x/y', commit: SHA, filePath: 'r.yaml' };

  const local: EmployerEntry[] = [
    { id: 'tencent', name: '腾讯', homepage: 'https://careers.tencent.com', region: 'cn',
      channel: 'api', adapter: 'tencent', status: 'ok', note: '我自己验过的' },
    { id: 'mine', name: '我自己加的', homepage: 'https://mine.example.com', region: 'cn',
      channel: 'unknown', status: 'unverified' },
  ];

  it('分支名一律拒绝 —— 跟 HEAD 等于把要请求的 URL 交给别人随时改', async () => {
    await expect(planRegistrySync({ ...src, commit: 'main' }, local)).rejects.toThrow(/commit sha/);
  });

  it('plan 不写任何文件', async () => {
    const before = fs.readdirSync(dir);
    const plan = await planRegistrySync(src, local, { fetchImpl: stubFetch({ 'r.yaml': { body: UP } }) });
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(fs.readdirSync(dir)).toEqual(before);
  });

  it('本地手改过的默认跳过 —— 那句理由是有人真去打过一次才写下的', async () => {
    const plan = await planRegistrySync(src, local, { fetchImpl: stubFetch({ 'r.yaml': { body: UP } }) });
    const entries = [
      { id: 'tencent', name: '腾讯改名了', homepage: 'https://x', region: 'cn', channel: 'api',
        adapter: 'tencent', status: 'unverified' },
      { id: 'newco', name: '新公司', homepage: 'https://newco.example.com', region: 'cn',
        channel: 'ats', ats: { kind: 'greenhouse', token: 'newco' }, status: 'unverified' },
    ] as EmployerEntry[];
    const r = applyRegistrySync(plan, entries, { file: path.join(dir, 'upstream.yaml') });
    expect(r.added).toEqual(['newco']);
    expect(r.skipped).toContain('tencent');
  });

  it('上游条目一律落成 unverified —— 别人说能采不等于你这里能采', async () => {
    const plan = await planRegistrySync(src, local, { fetchImpl: stubFetch({ 'r.yaml': { body: UP } }) });
    const entries = [{ id: 'newco', name: '新公司', homepage: 'https://newco.example.com', region: 'cn',
      channel: 'ats', ats: { kind: 'greenhouse', token: 'newco' }, status: 'ok' }] as EmployerEntry[];
    applyRegistrySync(plan, entries, { file: path.join(dir, 'upstream.yaml') });
    const text = fs.readFileSync(path.join(dir, 'upstream.yaml'), 'utf8');
    expect(text).toContain('status: unverified');
    expect(text).toContain(`commit: ${SHA}`);
  });

  it('上游没有的条目只列出来，绝不自动删 —— 那可能是你自己加的一家', async () => {
    const plan = await planRegistrySync(src, local, { fetchImpl: stubFetch({ 'r.yaml': { body: UP } }) });
    const removal = plan.changes.find((c) => c.id === 'mine');
    expect(removal?.kind).toBe('remove');
    applyRegistrySync(plan, [], { file: path.join(dir, 'upstream.yaml') });
    expect(fs.readFileSync(path.join(dir, 'upstream.yaml'), 'utf8')).not.toContain('mine');
  });

  it('上游给的不是合法注册表就报清楚，不硬吃', async () => {
    await expect(
      planRegistrySync(src, local, { fetchImpl: stubFetch({ 'r.yaml': { body: 'employers: [{id: 1}]' } }) }),
    ).rejects.toThrow(/不是合法的注册表/);
  });
});
