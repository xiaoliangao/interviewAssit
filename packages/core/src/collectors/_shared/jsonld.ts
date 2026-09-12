/**
 * schema.org JobPosting 的 JSON-LD 抽取。
 *
 * 这是覆盖面最大的一条通道：Moka、北森、大易、以及大量大厂自建招聘站
 * 都在页面里输出 JSON-LD（因为搜索引擎的 Google for Jobs 要求它）。
 * 与其逐个逆向各家 ATS 的私有接口 —— 那些接口没有兼容承诺、随时会变、
 * 而且每家都要单独写一套 —— 不如吃这个公开标准。
 *
 * 代价是字段没有私有接口那么全，但拿到的是**公开发布、面向搜索引擎的**
 * 招聘信息，这条通道本身也就没有任何风控风险。
 */

export interface JobPostingLd {
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string | string[];
  hiringOrganization?: { name?: string; sameAs?: string } | string;
  jobLocation?: unknown;
  baseSalary?: unknown;
  identifier?: unknown;
  url?: string;
  [k: string]: unknown;
}

/** 从 HTML 里抠出所有 `<script type="application/ld+json">` 的内容。 */
export function extractLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // 有些站点会在 JSON-LD 里塞注释或尾逗号。清一遍再试一次，
      // 失败就跳过 —— 一个坏块不该让整页作废。
      try {
        out.push(JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*([}\]])/g, '$1')));
      } catch {
        /* 跳过这一块 */
      }
    }
  }
  return out;
}

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  visit(o);
  // @graph 是 JSON-LD 常见的容器，JobPosting 往往藏在里面
  for (const key of ['@graph', 'itemListElement', 'mainEntity']) {
    if (o[key]) walk(o[key], visit);
  }
}

export function findJobPostings(blocks: unknown[]): JobPostingLd[] {
  const found: JobPostingLd[] = [];
  for (const b of blocks) {
    walk(b, (o) => {
      const type = o['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting')) {
        found.push(o as JobPostingLd);
      }
    });
  }
  return found;
}

export function parseJobPostingHtml(html: string): JobPostingLd[] {
  return findJobPostings(extractLdBlocks(html));
}

// ── 字段归一化 ─────────────────────────────────────────────────────────────

export function orgName(ld: JobPostingLd): string | null {
  const org = ld.hiringOrganization;
  if (typeof org === 'string') return org.trim() || null;
  if (org && typeof org === 'object' && typeof org.name === 'string') return org.name.trim() || null;
  return null;
}

export function locationCity(ld: JobPostingLd): string | null {
  const pick = (n: unknown): string | null => {
    if (!n || typeof n !== 'object') return null;
    const o = n as Record<string, any>;
    const addr = o.address ?? o;
    const city = addr?.addressLocality ?? addr?.addressRegion;
    return typeof city === 'string' && city.trim() ? city.trim() : null;
  };
  const loc = ld.jobLocation;
  if (Array.isArray(loc)) {
    for (const l of loc) {
      const c = pick(l);
      if (c) return c;
    }
    return null;
  }
  return pick(loc);
}

/** HTML 描述转纯文本。JD 里的换行结构对后续解析很重要，要保住。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '· ')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface LdSalary {
  raw: string | null;
  min: number | null;
  max: number | null;
  /** 原始单位：HOUR / DAY / WEEK / MONTH / YEAR */
  unit: string | null;
  currency: string | null;
}

export function ldSalary(ld: JobPostingLd): LdSalary {
  const bs = ld.baseSalary as Record<string, any> | undefined;
  if (!bs || typeof bs !== 'object') return { raw: null, min: null, max: null, unit: null, currency: null };
  const v = bs.value ?? bs;
  const min = Number(v?.minValue ?? v?.value);
  const max = Number(v?.maxValue ?? v?.value);
  const unit = typeof v?.unitText === 'string' ? v.unitText.toUpperCase() : null;
  const currency = typeof bs.currency === 'string' ? bs.currency : null;
  const has = Number.isFinite(min) || Number.isFinite(max);
  if (!has) return { raw: null, min: null, max: null, unit, currency };
  const lo = Number.isFinite(min) ? min : null;
  const hi = Number.isFinite(max) ? max : null;
  return {
    raw: `${currency ?? ''}${lo ?? ''}${hi && hi !== lo ? `-${hi}` : ''}${unit ? `/${unit}` : ''}`.trim() || null,
    min: lo, max: hi, unit, currency,
  };
}

/** 把 JSON-LD 的薪资折成人民币月薪。换算不了就返回 null —— 不猜汇率。 */
export function ldMonthlySalary(s: LdSalary): { min: number | null; max: number | null } {
  if (s.min === null && s.max === null) return { min: null, max: null };
  if (s.currency && !['CNY', 'RMB', '¥'].includes(s.currency.toUpperCase())) {
    // 外币不做汇率换算：汇率会变，而一个写死的汇率会让历史分数不可比
    return { min: null, max: null };
  }
  const div: Record<string, number> = { HOUR: 1 / 174, DAY: 1 / 21.75, WEEK: 1 / 4.35, MONTH: 1, YEAR: 12 };
  const d = div[s.unit ?? 'MONTH'];
  if (!d) return { min: null, max: null };
  const conv = (n: number | null) => (n === null ? null : Math.round(n / d));
  return { min: conv(s.min), max: conv(s.max) };
}
