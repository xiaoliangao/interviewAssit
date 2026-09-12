import type { JobSource, Posting } from '@assit/contract';
import { GuardBlocked, reserve, record, trip, type Budget } from '../guard/index.js';
import type { Db } from '../db/index.js';
import { AgentBrowserCliBridge, type BrowserBridge } from './bridge/index.js';
import { CdpNotImplemented, type CapturedResponse, type CdpSite, type SiteMatcher } from './cdp.js';
import { bossMatcher, job51Matcher } from './matchers.js';
import type { CollectResult } from './platforms.js';

/**
 * 通道 B 的内核（DESIGN §4.2）—— **平台无关**。
 *
 * 一份内核 + 每平台一个 matcher。BOSS 和 51job 的区别只在
 * 「旁听哪个 URL、JSON 怎么翻」，其余全在这里：
 *
 *   导航真实搜索页 → 滚动加载 → 旁听页面自己的响应 → 节奏 → 风控 → 归一化
 *
 * **零注入。** 工具不发任何请求。原因是 boss-zhipin-scraper issue #53 的教训：
 * 程序注入的 XHR 与页面自身请求特征不同，会被识别为异常环境（code 37）。
 * 顺带解决了另外两件事 —— BOSS 的字体混淆是渲染层的，接口返回本来就是明文；
 * 51job 的 acw_sc__v2 / 瑞数参数 / HMAC 签名由页面 JS 自己算好。
 */

export const SITE_MATCHERS: Partial<Record<CdpSite, SiteMatcher>> = {
  boss: bossMatcher,
  '51job': job51Matcher,
};

export interface CdpRunOptions {
  bridge?: BrowserBridge;
  budget?: Budget;
  /** 列表页之间的随机停顿。节奏是防线的一部分，但**不能替代「停」** */
  paceMs?: [number, number];
  /** 每个关键词滚几屏 */
  scrolls?: number;
  limit?: number;
  onProgress?: (msg: string) => void;
  /** 测试用：跳过真实等待 */
  sleepImpl?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pace([lo, hi]: [number, number]): number {
  return lo + Math.random() * Math.max(0, hi - lo);
}

export class RiskTripped extends Error {
  constructor(readonly site: string, readonly reason: string) {
    super(
      `${site} 命中风控，已停止并上锁：${reason}\n` +
        '**不会尝试绕过。** 这不是道德姿态，是工程理性 —— 绕过反爬是军备竞赛，\n' +
        '你必输，代价是账号。解锁：assit guard unlock <平台>。',
    );
    this.name = 'RiskTripped';
  }
}

export async function collectViaCdp(
  db: Db,
  source: Extract<JobSource, { platform: 'cdp' }>,
  opts: CdpRunOptions = {},
): Promise<CollectResult> {
  const m = SITE_MATCHERS[source.site];
  if (!m) throw new CdpNotImplemented(source.site);

  const bridge = opts.bridge ?? new AgentBrowserCliBridge();
  const sleep = opts.sleepImpl ?? realSleep;
  const paceRange = opts.paceMs ?? source.pace_ms ?? [5000, 10_000];
  const scrolls = opts.scrolls ?? 3;
  const limit = opts.limit ?? 200;

  const health = await bridge.health();
  if (!health.ok) throw new Error(`浏览器桥不可用：${health.detail}`);

  const keywords = source.keywords.length > 0 ? source.keywords : [''];
  const cities = source.cities.length > 0 ? source.cities : [undefined];
  const postings: Posting[] = [];
  const rejected: CollectResult['rejected'] = [];
  const seen = new Set<string>();
  let fetched = 0;

  outer: for (const kw of keywords) {
    for (const city of cities) {
      // **先记账再开页。** 反过来的话，崩在半路那次不算数，
      // 于是「崩溃 → 重试」循环能完整绕开预算。
      try {
        reserve(db, source.site, { stage: 'list', action: 'search', budget: opts.budget });
      } catch (e) {
        if (e instanceof GuardBlocked) {
          rejected.push({ reason: `闸门拦下：${e.message.split('\n')[0] ?? ''}` });
          break outer;
        }
        throw e;
      }

      const url = m.searchUrl(kw, city);
      opts.onProgress?.(`打开 ${url}`);
      const tab = await bridge.open(url);
      try {
        await bridge.startCapture(tab.tabId);
        for (let i = 0; i < scrolls; i++) {
          await sleep(pace(paceRange));
          // 滚动触发页面自己去加载下一页 —— 我们不发请求，只让页面发。
          await bridge.exec(tab.tabId, 'window.scrollTo(0, document.body.scrollHeight); true');
        }
        await sleep(pace(paceRange));

        const responses = await bridge.capturedResponses(tab.tabId, matchHint(m));
        for (const res of responses) {
          if (!m.matches(res.url)) continue;
          fetched += 1;

          const verdict = m.risk(res);
          if (verdict.blocked) {
            // 命中即停并上锁。**绝不尝试绕过。**
            trip(db, source.site, verdict.code ? 'code_37' : 'rate_limited', verdict.reason ?? '未知');
            throw new RiskTripped(m.label, verdict.reason ?? '未知');
          }

          try {
            for (const p of m.parse(res)) {
              if (seen.has(p.platform_job_id)) continue;
              seen.add(p.platform_job_id);
              postings.push(p);
              if (postings.length >= limit) break;
            }
          } catch (e) {
            // 结构不认识不硬猜，但也不因此上锁 —— 改版和风控是两回事，
            // 混在一起会让「平台改版」误触发一个只能手动解的锁。
            rejected.push({ reason: (e as Error).message.split('\n')[0] ?? '解析失败' });
          }
        }
        record(db, source.site, 'ok', `${postings.length} 条`);
      } finally {
        await bridge.stopCapture(tab.tabId);
        await bridge.close(tab.tabId);
      }
      if (postings.length >= limit) break outer;
    }
  }

  return { postings, rejected, fetched };
}

/** 给桥的 URL 过滤词。取 matcher 认的那个路径里最有辨识度的一段。 */
function matchHint(m: SiteMatcher): string {
  return m.site === 'boss' ? 'joblist.json' : 'search-pc';
}
