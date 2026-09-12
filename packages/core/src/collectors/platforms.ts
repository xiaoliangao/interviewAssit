import { Posting, type JobSource } from '@assit/contract';
import { fetchJson, fetchText, serialMap, type FetchOptions } from './_shared/http.js';
import { PORTAL_ADAPTERS } from './cn-portals.js';
import {
  htmlToText,
  ldMonthlySalary,
  ldSalary,
  locationCity,
  orgName,
  parseJobPostingHtml,
  type JobPostingLd,
} from './_shared/jsonld.js';

/**
 * 每个平台一个采集函数，输出统一的 Posting 契约。
 *
 * 契约测试锁住这个输出格式：平台改版时是**显式失败**，
 * 而不是悄悄产出半截数据污染岗位池 —— 后者才是真正难查的问题，
 * 因为你要等到某天发现「这批岗位怎么都没有薪资」才会想起来。
 */

export interface CollectResult {
  postings: Posting[];
  /** 抓到但没能转成合法 Posting 的条数与原因 */
  rejected: { reason: string; sample?: string }[];
  fetched: number;
}

export interface CollectOptions extends FetchOptions {
  /**
   * 通道 B 要用的数据库句柄。
   *
   * 只有 cdp 分支需要它 —— `AccessGuard` 的预算和风险锁必须跨进程持久化，
   * 内存里的闸门重启一次就形同虚设。其余通道是无状态的公开接口，不需要。
   */
  db?: unknown;
  /** 单次最多取多少条，防止一个大板子把岗位池冲掉 */
  limit?: number;
  intervalMs?: number;
  onProgress?: (done: number, total: number) => void;
}

const now = () => new Date().toISOString();

function safePosting(raw: unknown, rejected: CollectResult['rejected'], label: string): Posting | null {
  const r = Posting.safeParse(raw);
  if (r.success) return r.data;
  rejected.push({
    reason: `${label}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    sample: JSON.stringify(raw).slice(0, 200),
  });
  return null;
}

// ── Greenhouse ─────────────────────────────────────────────────────────────

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  content?: string;
  location?: { name?: string };
  metadata?: unknown;
}

export async function collectGreenhouse(
  board: string,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
  const data = await fetchJson<{ jobs?: GhJob[] }>(url, opts);
  const jobs = (data.jobs ?? []).slice(0, opts.limit ?? 500);
  const rejected: CollectResult['rejected'] = [];
  const postings: Posting[] = [];

  for (const j of jobs) {
    // content 是 HTML 转义过的
    const jd = htmlToText(decodeEntities(j.content ?? ''));
    if (!jd.trim()) {
      rejected.push({ reason: `job ${j.id} 没有 JD 正文` });
      continue;
    }
    const p = safePosting(
      {
        platform: 'greenhouse',
        platform_job_id: String(j.id),
        url: j.absolute_url,
        company_name: board,
        title: j.title,
        city: j.location?.name ?? null,
        salary_raw: null, salary_min_yuan: null, salary_max_yuan: null, salary_months: null,
        jd_text: jd,
        apply_channel: 'form',
        attrs: {},
        collected_by: 'greenhouse@1',
        collected_at: now(),
      },
      rejected,
      `greenhouse job ${j.id}`,
    );
    if (p) postings.push(p);
  }
  return { postings, rejected, fetched: jobs.length };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// ── Lever ──────────────────────────────────────────────────────────────────

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  descriptionPlain?: string;
  description?: string;
  lists?: { text: string; content: string }[];
  categories?: { location?: string; team?: string; commitment?: string };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export async function collectLever(company: string, opts: CollectOptions = {}): Promise<CollectResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
  const jobs = (await fetchJson<LeverJob[]>(url, opts)).slice(0, opts.limit ?? 500);
  const rejected: CollectResult['rejected'] = [];
  const postings: Posting[] = [];

  for (const j of jobs) {
    // lists 是「任职要求 / 岗位职责」这些分节，不拼进来会丢掉 JD 的一半
    const sections = (j.lists ?? [])
      .map((l) => `${l.text}\n${htmlToText(l.content)}`)
      .join('\n\n');
    const jd = [j.descriptionPlain ?? htmlToText(j.description ?? ''), sections]
      .filter((x) => x.trim()).join('\n\n');
    if (!jd.trim()) {
      rejected.push({ reason: `job ${j.id} 没有 JD 正文` });
      continue;
    }
    const sr = j.salaryRange;
    const monthly =
      sr && sr.currency && ['CNY', 'RMB'].includes(sr.currency.toUpperCase())
        ? ldMonthlySalary({
            raw: null, min: sr.min ?? null, max: sr.max ?? null,
            unit: (sr.interval ?? 'year').toUpperCase(), currency: sr.currency,
          })
        : { min: null, max: null };

    const p = safePosting(
      {
        platform: 'lever',
        platform_job_id: j.id,
        url: j.hostedUrl,
        company_name: company,
        title: j.text,
        city: j.categories?.location ?? null,
        salary_raw: sr ? `${sr.currency ?? ''}${sr.min ?? ''}-${sr.max ?? ''}/${sr.interval ?? ''}` : null,
        salary_min_yuan: monthly.min, salary_max_yuan: monthly.max, salary_months: null,
        jd_text: jd,
        apply_channel: 'form',
        attrs: {},
        collected_by: 'lever@1',
        collected_at: now(),
      },
      rejected,
      `lever job ${j.id}`,
    );
    if (p) postings.push(p);
  }
  return { postings, rejected, fetched: jobs.length };
}

// ── Ashby ──────────────────────────────────────────────────────────────────

interface AshbyJob {
  id: string;
  title: string;
  jobUrl?: string;
  applyUrl?: string;
  location?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  department?: string;
  isListed?: boolean;
}

export async function collectAshby(board: string, opts: CollectOptions = {}): Promise<CollectResult> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
  const data = await fetchJson<{ jobs?: AshbyJob[] }>(url, opts);
  const jobs = (data.jobs ?? []).filter((j) => j.isListed !== false).slice(0, opts.limit ?? 500);
  const rejected: CollectResult['rejected'] = [];
  const postings: Posting[] = [];

  for (const j of jobs) {
    const jd = j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? '');
    if (!jd.trim()) {
      rejected.push({ reason: `job ${j.id} 没有 JD 正文` });
      continue;
    }
    const p = safePosting(
      {
        platform: 'ashby',
        platform_job_id: j.id,
        url: j.jobUrl ?? j.applyUrl,
        company_name: board,
        title: j.title,
        city: j.location ?? null,
        salary_raw: null, salary_min_yuan: null, salary_max_yuan: null, salary_months: null,
        jd_text: jd,
        apply_channel: 'form',
        attrs: {},
        collected_by: 'ashby@1',
        collected_at: now(),
      },
      rejected,
      `ashby job ${j.id}`,
    );
    if (p) postings.push(p);
  }
  return { postings, rejected, fetched: jobs.length };
}

// ── 通用 JSON-LD ───────────────────────────────────────────────────────────

export function ldToPosting(
  ld: JobPostingLd,
  pageUrl: string,
  fallbackCompany?: string,
): unknown {
  const sal = ldSalary(ld);
  const monthly = ldMonthlySalary(sal);
  const jd = htmlToText(String(ld.description ?? ''));
  const id =
    (typeof ld.identifier === 'object' && ld.identifier
      ? String((ld.identifier as Record<string, unknown>).value ?? '')
      : String(ld.identifier ?? '')) || pageUrl;
  return {
    platform: 'jsonld',
    platform_job_id: id,
    url: ld.url ?? pageUrl,
    company_name: orgName(ld) ?? fallbackCompany ?? new URL(pageUrl).hostname,
    title: ld.title ?? '',
    city: locationCity(ld),
    salary_raw: sal.raw,
    salary_min_yuan: monthly.min,
    salary_max_yuan: monthly.max,
    salary_months: null,
    jd_text: jd,
    apply_channel: 'external',
    attrs: {},
    collected_by: 'jsonld@1',
    collected_at: now(),
  };
}

export async function collectJsonLd(
  urls: string[],
  fallbackCompany: string | undefined,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const rejected: CollectResult['rejected'] = [];
  const postings: Posting[] = [];
  let fetched = 0;

  await serialMap(
    urls.slice(0, opts.limit ?? 200),
    async (u) => {
      const res = await fetchText(u, { ...opts, headers: { accept: 'text/html,*/*' } });
      const lds = parseJobPostingHtml(res.body);
      fetched += lds.length;
      if (lds.length === 0) {
        // 页面结构不认识就报出来，不硬猜 —— 硬猜出来的半截数据比没有更糟
        rejected.push({ reason: `${u} 里没有找到 schema.org JobPosting 的 JSON-LD` });
        return;
      }
      for (const ld of lds) {
        const p = safePosting(ldToPosting(ld, u, fallbackCompany), rejected, u);
        if (p) postings.push(p);
      }
    },
    { intervalMs: opts.intervalMs ?? 800, onProgress: opts.onProgress },
  );

  return { postings, rejected, fetched };
}

// ── 分发 ───────────────────────────────────────────────────────────────────

export function collect(source: JobSource, opts: CollectOptions = {}): Promise<CollectResult> {
  switch (source.platform) {
    case 'greenhouse':
      return collectGreenhouse(source.board, opts);
    case 'lever':
      return collectLever(source.company, opts);
    case 'ashby':
      return collectAshby(source.board, opts);
    case 'jsonld':
      return collectJsonLd(source.urls, source.company, opts);
    case 'api':
      return PORTAL_ADAPTERS[source.adapter]({
        ...opts,
        keywords: source.keywords,
        cities: source.cities,
        pages: source.pages,
        browserUa: source.browser_ua,
      });
    case 'cdp': {
      if (!opts.db) {
        throw new Error(
          '通道 B 需要数据库句柄（AccessGuard 的预算和风险锁要持久化）。\n' +
            '  用 runSource() 而不是直接调 collect()。',
        );
      }
      // 动态 import 打断循环依赖：cdp-run 要 platforms 的 CollectResult 类型
      return import('./cdp-run.js').then((m) =>
        m.collectViaCdp(opts.db as never, source, { limit: opts.limit }),
      );
    }
  }
}
