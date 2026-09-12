import { Posting } from '@assit/contract';
import { BROWSER_UA, fetchJson, type FetchOptions } from './_shared/http.js';
import type { CollectOptions, CollectResult } from './platforms.js';

/**
 * 国内大厂自建招聘站的**公开**接口（DESIGN §4.1 通道 A2）。
 *
 * 这些站不用 Greenhouse，各建各的。但其中一部分的搜索接口完全公开：
 * 无需登录、无需凭据、无需签名。对这几家来说，写一个薄适配器远比
 * 接管浏览器划算 —— 零风控、可无人值守轮询、JD 是全文。
 *
 * **加一家 = 加一个函数 + registry 里一行。** 不要把不同站的参数往同一个
 * 配置结构里塞，各站的分页、城市码、字段命名毫无共性，强行统一只会得到
 * 一堆 if。
 *
 * 打不通的（百度 illegal-visit、网易 500、美团/京东/小米 SSR）**不在这里硬试**，
 * 它们在 registry 里标 `needs_cdp`，等通道 B。逆向签名不是这个项目做的事。
 */

const now = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function push(
  raw: unknown,
  postings: Posting[],
  rejected: CollectResult['rejected'],
  label: string,
): void {
  const r = Posting.safeParse(raw);
  if (r.success) {
    postings.push(r.data);
    return;
  }
  rejected.push({
    reason: `${label}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    sample: JSON.stringify(raw).slice(0, 200),
  });
}

/** 「两年以上工作经验」→ 2。认不出来就返回 null，**不猜**。 */
const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
export function parseExpYears(text: string | null | undefined): number | null {
  if (!text) return null;
  if (/应届|实习|不限|无经验/.test(text)) return 0;
  const arabic = text.match(/(\d+)\s*年/);
  if (arabic) return Number(arabic[1]);
  const cn = text.match(/([零一二两三四五六七八九十])\s*年/);
  if (cn) return CN_NUM[cn[1]!] ?? null;
  return null;
}

export interface PortalOptions extends CollectOptions {
  keywords?: string[];
  cities?: string[];
  pages?: number;
  /** 见 sources.ts 的 browser_ua：由配置传进来，适配器自己不做这个决定 */
  browserUa?: boolean;
}

function net(opts: PortalOptions): FetchOptions {
  return {
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    backoffBaseMs: opts.backoffBaseMs,
    fetchImpl: opts.fetchImpl,
    userAgent: opts.browserUa ? BROWSER_UA : undefined,
  };
}

// ── 腾讯 ───────────────────────────────────────────────────────────────────
//
// careers.tencent.com/tencentcareer/api/post/Query —— 公开 GET，零凭据。
// 实测（2026-09-12）连 timestamp 参数都可以不带。
//
// 唯一的麻烦：列表只给 Responsibility（岗位职责），**不给 Requirement（任职要求）**。
// 而任职要求才是打分真正要看的那一半（技术栈、年限都在里面）。
// 所以必须逐条打一次详情接口。串行 + 间隔，别并发。

interface TxPost {
  PostId: string;
  RecruitPostName: string;
  LocationName?: string;
  CategoryName?: string;
  ProductName?: string;
  BGName?: string;
  Responsibility?: string;
  PostURL?: string;
  RequireWorkYearsName?: string;
  LastUpdateTime?: string;
}

const TX_API = 'https://careers.tencent.com/tencentcareer/api/post';

export async function collectTencent(opts: PortalOptions = {}): Promise<CollectResult> {
  const keywords = opts.keywords?.length ? opts.keywords : [''];
  const pages = opts.pages ?? 3;
  const limit = opts.limit ?? 200;
  const interval = opts.intervalMs ?? 700;

  const postings: Posting[] = [];
  const rejected: CollectResult['rejected'] = [];
  const seen = new Set<string>();
  let fetched = 0;

  outer: for (const kw of keywords) {
    for (let page = 1; page <= pages; page++) {
      const url =
        `${TX_API}/Query?keyword=${encodeURIComponent(kw)}` +
        `&pageIndex=${page}&pageSize=10&language=zh-cn&area=cn`;
      const data = await fetchJson<{ Code?: number; Data?: { Count?: number; Posts?: TxPost[] } }>(
        url,
        net(opts),
      );
      const posts = data.Data?.Posts ?? [];
      fetched += posts.length;
      if (posts.length === 0) break; // 翻到底了，不用把 pages 跑满

      for (const p of posts) {
        if (seen.has(p.PostId)) continue;
        seen.add(p.PostId);
        if (opts.cities?.length && !opts.cities.some((c) => (p.LocationName ?? '').includes(c))) {
          continue;
        }

        await sleep(interval);
        const detail = await fetchJson<{ Data?: TxPost & { Requirement?: string } }>(
          `${TX_API}/ByPostId?postId=${encodeURIComponent(p.PostId)}&language=zh-cn`,
          net(opts),
        ).catch(() => null);

        const resp = (detail?.Data?.Responsibility ?? p.Responsibility ?? '').trim();
        const req = (detail?.Data?.Requirement ?? '').trim();
        // 只有职责没有要求的岗位照收，但 JD 会明显偏短 —— coverage 会如实反映这件事，
        // 不用在这里兜底编一段。
        // 所属产品 / BG 放进 JD 抬头，**不拼进 title**。
        // 拼进去会出两个问题：① 职能分类器把 ProductName 里的词当成职位词 ——
        // 实测「NQF-手游小程序 · QQ 经典农场服务器开发工程师」因为「小程序」
        // 被判成 frontend，而它是个服务器岗；② title 进 identity_key 参与去重，
        // 同一个岗位换个产品线挂牌就会被当成两个。
        const ctx = [p.BGName && `事业群：${p.BGName}`, p.ProductName && `所属产品：${p.ProductName}`]
          .filter(Boolean)
          .join('　');
        const jd = [ctx, resp && `岗位职责\n${resp}`, req && `任职要求\n${req}`]
          .filter(Boolean)
          .join('\n\n');
        if (!jd) {
          rejected.push({ reason: `腾讯 ${p.PostId} 详情里没有 JD 正文` });
          continue;
        }

        const years = parseExpYears(detail?.Data?.RequireWorkYearsName ?? p.RequireWorkYearsName);
        push(
          {
            platform: 'tencent',
            platform_job_id: p.PostId,
            // 站点自己返回的是 http://，统一升到 https
            url: (p.PostURL ?? `https://careers.tencent.com/jobdesc.html?postId=${p.PostId}`)
              .replace(/^http:/, 'https:'),
            company_name: '腾讯',
            title: p.RecruitPostName,
            city: p.LocationName ?? null,
            salary_raw: null, salary_min_yuan: null, salary_max_yuan: null, salary_months: null,
            jd_text: jd,
            apply_channel: 'form',
            // 年限是站点结构化字段给的，不是从 JD 正文里猜的 —— 所以是 explicit_jd
            attrs: years === null ? {} : { exp_years_min: { value: years, confidence: 'explicit_jd' } },
            collected_by: 'tencent@1',
            collected_at: now(),
          },
          postings,
          rejected,
          `腾讯 ${p.PostId}`,
        );
        if (postings.length >= limit) break outer;
      }
      opts.onProgress?.(postings.length, limit);
      await sleep(interval);
    }
  }
  return { postings, rejected, fetched };
}

// ── 字节跳动 ───────────────────────────────────────────────────────────────
//
// jobs.bytedance.com/api/v1/search/job/posts —— 公开 POST，零凭据，
// 而且**列表就直出 JD 全文**（description + requirement），不用翻详情。
//
// 一个坑：对非浏览器 UA 直接返回 405（实测确认是 UA，与 Referer 无关）。
// 所以需要 sources.yaml 里显式 browser_ua: true —— 见那里的注释。

interface BdPost {
  id: string;
  title: string;
  sub_title?: string | null;
  description?: string;
  requirement?: string;
  city_info?: { name?: string } | null;
  job_category?: { name?: string } | null;
  recruit_type?: { name?: string; parent?: { name?: string } } | null;
  code?: string;
}

export class BrowserUaRequired extends Error {
  constructor(public site: string) {
    super(
      `${site} 的接口对非浏览器 UA 返回 405。\n` +
        `在 data/facts/sources.yaml 里给这个源加一行 browser_ua: true 才会采集。\n` +
        '默认不开：UA 如实声明是这个项目的一条原则，改它应该是你的一次明确选择，而不是采集器替你决定。',
    );
    this.name = 'BrowserUaRequired';
  }
}

export async function collectBytedance(opts: PortalOptions = {}): Promise<CollectResult> {
  if (!opts.browserUa) throw new BrowserUaRequired('字节跳动');

  const keywords = opts.keywords?.length ? opts.keywords : [''];
  const pages = opts.pages ?? 3;
  const limit = opts.limit ?? 200;
  const pageSize = 20;
  const interval = opts.intervalMs ?? 700;

  const postings: Posting[] = [];
  const rejected: CollectResult['rejected'] = [];
  const seen = new Set<string>();
  let fetched = 0;

  outer: for (const kw of keywords) {
    for (let page = 0; page < pages; page++) {
      const data = await fetchJson<{ code?: number; message?: string; data?: { job_post_list?: BdPost[] } }>(
        'https://jobs.bytedance.com/api/v1/search/job/posts',
        {
          ...net(opts),
          method: 'POST',
          body: JSON.stringify({
            keyword: kw,
            limit: pageSize,
            offset: page * pageSize,
            job_category_id_list: [],
            location_code_list: [],
          }),
          headers: { referer: 'https://jobs.bytedance.com/experienced/position' },
        },
      );
      if (data.code !== 0) {
        rejected.push({ reason: `字节返回 code=${data.code}：${data.message ?? ''}` });
        break;
      }
      const posts = data.data?.job_post_list ?? [];
      fetched += posts.length;
      if (posts.length === 0) break;

      for (const p of posts) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const city = p.city_info?.name ?? null;
        if (opts.cities?.length && !opts.cities.some((c) => (city ?? '').includes(c))) continue;

        const jd = [
          p.description?.trim() && `岗位职责\n${p.description.trim()}`,
          p.requirement?.trim() && `任职要求\n${p.requirement.trim()}`,
        ].filter(Boolean).join('\n\n');
        if (!jd) {
          rejected.push({ reason: `字节 ${p.id} 没有 JD 正文` });
          continue;
        }

        push(
          {
            platform: 'bytedance',
            platform_job_id: p.id,
            url: `https://jobs.bytedance.com/experienced/position/${p.id}/detail`,
            company_name: '字节跳动',
            title: [p.title, p.sub_title].filter(Boolean).join(' · '),
            city,
            salary_raw: null, salary_min_yuan: null, salary_max_yuan: null, salary_months: null,
            jd_text: jd,
            apply_channel: 'form',
            attrs: {},
            collected_by: 'bytedance@1',
            collected_at: now(),
          },
          postings,
          rejected,
          `字节 ${p.id}`,
        );
        if (postings.length >= limit) break outer;
      }
      opts.onProgress?.(postings.length, limit);
      await sleep(interval);
    }
  }
  return { postings, rejected, fetched };
}

export const PORTAL_ADAPTERS = {
  tencent: collectTencent,
  bytedance: collectBytedance,
} satisfies Record<string, (o: PortalOptions) => Promise<CollectResult>>;
