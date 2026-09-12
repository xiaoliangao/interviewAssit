import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentBrowserCliBridge,
  GuardBlocked,
  SITE_MATCHERS,
  bossMatcher,
  clearLock,
  collectViaCdp,
  job51Matcher,
  lockState,
  openDb,
  parse51Salary,
  parseBossSalary,
  reserve,
  trip,
  type BridgeTab,
  type BrowserBridge,
  type CapturedResponse,
  type Db,
} from '@assit/core';
import { JobSource } from '@assit/contract';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-cdp-'));
  process.env.ASSIT_DATA_DIR = dir;
  db = openDb();
});
afterEach(() => {
  db.close();
  delete process.env.ASSIT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const BOSS_OK = JSON.stringify({
  code: 0,
  zpData: {
    jobList: [
      { encryptJobId: 'j1', jobName: '后端工程师', brandName: '某某科技', salaryDesc: '25-40K·15薪',
        cityName: '杭州', areaDistrict: '余杭区', skills: ['Go', 'MySQL'], jobDegree: '本科' },
      { encryptJobId: 'j2', jobName: '已下线岗', brandName: '某某科技', jobValidStatus: 0 },
    ],
  },
});

function fakeBridge(responses: CapturedResponse[], opts: { healthy?: boolean } = {}): BrowserBridge & {
  opened: string[]; execs: number; captureStopped: number;
} {
  const state = { opened: [] as string[], execs: 0, captureStopped: 0 };
  return {
    name: 'fake',
    opened: state.opened,
    get execs() { return state.execs; },
    get captureStopped() { return state.captureStopped; },
    health: async () => ({ ok: opts.healthy !== false, detail: 'fake' }),
    tabs: async () => [{ tabId: 't1', url: '', title: '' }],
    open: async (url: string): Promise<BridgeTab> => { state.opened.push(url); return { tabId: 't1', url, title: '' }; },
    startCapture: async () => undefined,
    capturedResponses: async () => responses,
    stopCapture: async () => { state.captureStopped += 1; },
    exec: async () => { state.execs += 1; return true; },
    close: async () => undefined,
  } as any;
}

const src = (over: Partial<any> = {}) =>
  JobSource.parse({ platform: 'cdp', id: 'boss', site: 'boss', keywords: ['后端'], enabled: true, ...over }) as any;

const noSleep = async (): Promise<void> => undefined;

describe('薪资解析：认不出就全 null，不猜', () => {
  it('BOSS 的 25-40K·15薪', () => {
    expect(parseBossSalary('25-40K·15薪')).toEqual({ min: 25000, max: 40000, months: 15 });
    expect(parseBossSalary('1.5-2万')).toEqual({ min: 15000, max: 20000, months: null });
    expect(parseBossSalary('面议')).toEqual({ min: null, max: null, months: null });
    expect(parseBossSalary(undefined)).toEqual({ min: null, max: null, months: null });
  });

  it('51job 的月薪与年薪', () => {
    expect(parse51Salary('2.5-4万/月')).toEqual({ min: 25000, max: 40000, months: null });
    expect(parse51Salary('15-25K·13薪')).toEqual({ min: 15000, max: 25000, months: 13 });
    expect(parse51Salary('30-60万/年')).toEqual({ min: 25000, max: 50000, months: null });
    expect(parse51Salary('薪资面议')).toEqual({ min: null, max: null, months: null });
  });
});

describe('matcher', () => {
  it('BOSS：只认 joblist.json，别的响应一概不碰', () => {
    expect(bossMatcher.matches('https://www.zhipin.com/wapi/zpgeek/search/joblist.json?x=1')).toBe(true);
    expect(bossMatcher.matches('https://www.zhipin.com/wapi/zpgeek/recommend.json')).toBe(false);
  });

  it('BOSS：跳过已下线岗，薪资和技术栈落到三态字段上', () => {
    const out = bossMatcher.parse({ requestId: 'r', url: 'x/joblist.json', status: 200, bodyText: BOSS_OK });
    expect(out).toHaveLength(1);
    expect(out[0]!.platform_job_id).toBe('j1');
    expect(out[0]!.salary_min_yuan).toBe(25000);
    expect(out[0]!.salary_months).toBe(15);
    expect(out[0]!.attrs.tech_stack).toMatchObject({ value: ['Go', 'MySQL'], confidence: 'explicit_jd' });
  });

  it('结构不认识要抛，不许返回空数组', () => {
    const bad = { requestId: 'r', url: 'x/joblist.json', status: 200, bodyText: '{"zpData":{}}' };
    expect(() => bossMatcher.parse(bad)).toThrow(/结构不认识/);
    expect(() => bossMatcher.parse({ ...bad, bodyText: 'not json' })).toThrow(/结构不认识/);
  });

  it('风控：先看码表', () => {
    const v = bossMatcher.risk({ requestId: 'r', url: 'u', status: 200,
      bodyText: JSON.stringify({ code: 37, message: '' }) });
    expect(v.blocked).toBe(true);
    expect(v.code).toBe(37);
  });

  it('风控：码表没命中时靠 message 关键字兜底 —— 新码不该被当成登录失败', () => {
    const v = bossMatcher.risk({ requestId: 'r', url: 'u', status: 200,
      bodyText: JSON.stringify({ code: 9999, message: '当前环境存在异常，请稍后再试' }) });
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain('环境存在异常');
  });

  it('51job 没有公开码表，全靠关键字 —— 这正是兜底那一半的理由', () => {
    expect(job51Matcher.riskCodes).toHaveLength(0);
    const v = job51Matcher.risk({ requestId: 'r', url: 'u', status: 200,
      bodyText: JSON.stringify({ message: '访问频繁' }) });
    expect(v.blocked).toBe(true);
  });

  it('两个平台都已注册 —— 内核确实是平台无关的', () => {
    expect(Object.keys(SITE_MATCHERS).sort()).toEqual(['51job', 'boss']);
  });
});

describe('内核', () => {
  it('零注入：只导航 + 滚动，不自己发请求', async () => {
    const b = fakeBridge([{ requestId: 'r1', url: 'https://x/wapi/zpgeek/search/joblist.json', status: 200, bodyText: BOSS_OK }]);
    const r = await collectViaCdp(db, src(), { bridge: b, sleepImpl: noSleep, scrolls: 2 });
    expect(r.postings).toHaveLength(1);
    expect(b.opened[0]).toContain('zhipin.com/web/geek/job');
    // 唯一执行过的 JS 是滚动
    expect(b.execs).toBe(2);
  });

  it('开页之前先记账 —— 崩了也算用过', async () => {
    const b = fakeBridge([]);
    b.open = async () => { throw new Error('页面崩了'); };
    await expect(collectViaCdp(db, src(), { bridge: b, sleepImpl: noSleep })).rejects.toThrow('页面崩了');
    const n = (db.prepare("SELECT COUNT(*) n FROM platform_access_events WHERE platform='boss'").get() as any).n;
    expect(n).toBe(1);
  });

  it('命中风控立刻停并上锁，不尝试绕过', async () => {
    const risky = JSON.stringify({ code: 37, message: '环境存在异常' });
    const b = fakeBridge([{ requestId: 'r', url: 'https://x/wapi/zpgeek/search/joblist.json', status: 200, bodyText: risky }]);
    await expect(collectViaCdp(db, src(), { bridge: b, sleepImpl: noSleep })).rejects.toThrow(/命中风控/);
    expect(lockState(db, 'boss').locked).toBe(true);
    // 上锁之后连 reserve 都不给过
    expect(() => reserve(db, 'boss')).toThrow(GuardBlocked);
  });

  it('已上锁时直接不开页', async () => {
    trip(db, 'boss', 'captcha', '之前撞过');
    const b = fakeBridge([]);
    const r = await collectViaCdp(db, src(), { bridge: b, sleepImpl: noSleep });
    expect(b.opened).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('闸门拦下');
    clearLock(db, 'boss');
  });

  it('平台改版（解析失败）不上锁 —— 改版和风控是两回事', async () => {
    const b = fakeBridge([{ requestId: 'r', url: 'https://x/wapi/zpgeek/search/joblist.json', status: 200, bodyText: '{"zpData":{}}' }]);
    const r = await collectViaCdp(db, src(), { bridge: b, sleepImpl: noSleep });
    expect(r.postings).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('结构不认识');
    expect(lockState(db, 'boss').locked).toBe(false);
  });

  it('无论成功失败都会停掉旁听并关掉标签页', async () => {
    const b = fakeBridge([{ requestId: 'r', url: 'https://x/wapi/zpgeek/search/joblist.json', status: 200,
      bodyText: JSON.stringify({ code: 37 }) }]);
    await expect(collectViaCdp(db, src(), { bridge: b, sleepImpl: noSleep })).rejects.toThrow();
    expect(b.captureStopped).toBe(1);
  });

  it('桥不可用时报可执行的下一步，不是一句失败', async () => {
    const b = fakeBridge([], { healthy: false });
    await expect(collectViaCdp(db, src(), { bridge: b, sleepImpl: noSleep })).rejects.toThrow(/桥不可用/);
  });

  it('没有 matcher 的平台指向手动粘贴这条退路', async () => {
    await expect(
      collectViaCdp(db, src({ id: 'lp', site: 'liepin' }), { bridge: fakeBridge([]), sleepImpl: noSleep }),
    ).rejects.toThrow(/ingest/);
  });
});

describe('agent-browser-cli 桥', () => {
  it('输出不是 JSON 时指向「版本对不上」，而不是让 undefined 流下去', async () => {
    const bridge = new AgentBrowserCliBridge({
      runner: async () => ({ stdout: 'usage: agent-browser-cli ...', stderr: '' }),
    });
    await expect(bridge.tabs()).rejects.toThrow(/版本对不上/);
  });

  it('open 默认不抢焦点 —— 采集时把用户窗口抢走会让「加速我自己的浏览」不成立', async () => {
    const seen: string[][] = [];
    const bridge = new AgentBrowserCliBridge({
      runner: async (args) => {
        seen.push(args);
        return { stdout: JSON.stringify({ ok: true, result: { opened_tab_id: 't9' } }), stderr: '' };
      },
    });
    await bridge.open('https://example.com');
    expect(seen[0]).toContain('--background');
  });

  it('ok:false 被转成错误，不当成空结果', async () => {
    const bridge = new AgentBrowserCliBridge({
      runner: async () => ({ stdout: JSON.stringify({ ok: false, error: { code: 'no_tab' } }), stderr: '' }),
    });
    await expect(bridge.tabs()).rejects.toThrow(/no_tab/);
  });
});

describe('BOSS 城市码表', () => {
  it('城市名翻成码，「杭州市」也认', async () => {
    const { bossCityCode } = await import('@assit/core');
    expect(bossCityCode('杭州')).toBe('101210100');
    expect(bossCityCode('杭州市')).toBe('101210100');
    expect(bossCityCode('101210100')).toBe('101210100');
  });

  it('查不到就不带这个参数 —— 塞个城市名进去会得到静默的全国结果', async () => {
    const { bossCityCode } = await import('@assit/core');
    expect(bossCityCode('不存在的城市')).toBeUndefined();
    expect(bossMatcher.searchUrl('后端', '不存在的城市')).not.toContain('city=');
    expect(bossMatcher.searchUrl('后端', '杭州')).toContain('city=101210100');
  });
});
