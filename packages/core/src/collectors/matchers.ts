import fs from 'node:fs';
import path from 'node:path';
import { Posting } from '@assit/contract';
import type { CapturedResponse, RiskVerdict, SiteMatcher } from './cdp.js';
import { riskFromMessage } from './cdp.js';
import { paths } from '../util/paths.js';

/**
 * 每个平台的 matcher（DESIGN §4.2 / §4.3）。
 *
 * 内核是平台无关的，这里只放「这个平台长什么样」：
 * 旁听哪个 URL、响应 JSON 怎么翻成 Posting、风控码是哪些。
 *
 * 一条硬规矩：**认不出来要抛异常，不许返回空数组。**
 * 静默产出半截数据比显式失败难查得多 —— 你要等到某天发现
 * 「这批岗位怎么都没有薪资」才会想起来。
 */

const now = (): string => new Date().toISOString();

export class UnrecognizedResponse extends Error {
  constructor(site: string, url: string, detail: string) {
    super(
      `${site} 的响应结构不认识：${detail}\n  ${url}\n` +
        '  平台大概率改了接口。**不要硬猜字段** —— 去看一眼真实响应再改 matcher。',
    );
    this.name = 'UnrecognizedResponse';
  }
}

function pushPosting(raw: unknown, out: Posting[], site: string, url: string): void {
  const r = Posting.safeParse(raw);
  if (r.success) out.push(r.data);
  else throw new UnrecognizedResponse(site, url, r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
}

// ── BOSS 直聘 ──────────────────────────────────────────────────────────────
//
// 旁听 /wapi/zpgeek/search/joblist.json —— 页面自己发的那一个。
// 薪资在接口返回里是明文：字体混淆是**渲染层**的防护，
// 读响应既不用解字体，也不算破解什么（数据早就送到用户自己的浏览器里了）。

interface BossJob {
  encryptJobId?: string;
  jobName?: string;
  salaryDesc?: string;
  cityName?: string;
  areaDistrict?: string;
  brandName?: string;
  jobLabels?: string[];
  skills?: string[];
  jobExperience?: string;
  jobDegree?: string;
  jobValidStatus?: number;
  encryptBossId?: string;
}

/** 「25-40K·15薪」→ 月薪区间 + 薪资月数。认不出就全 null，不猜。 */
export function parseBossSalary(desc: string | undefined): {
  min: number | null;
  max: number | null;
  months: number | null;
} {
  if (!desc) return { min: null, max: null, months: null };
  const months = Number(desc.match(/·\s*(\d{2})\s*薪/)?.[1] ?? '') || null;
  const m = desc.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*([KkWw千万元])/);
  if (!m) return { min: null, max: null, months };
  const unit = m[3]!.toLowerCase();
  const mul = unit === 'k' || unit === '千' ? 1000 : unit === 'w' || unit === '万' ? 10_000 : 1;
  return { min: Math.round(Number(m[1]) * mul), max: Math.round(Number(m[2]) * mul), months };
}

export const BOSS_RISK_CODES = [31, 37] as const;

/**
 * 城市名 → BOSS 城市码（vendor/boss-city-codes/，取自 boss-zhipin-scraper，MIT）。
 *
 * 搜索 URL 要的是 `101210100` 不是「杭州」。自己整不难，但没必要重造 ——
 * 而且这张表会随平台变，vendor 一份带出处的比散落在代码里的字面量强。
 */
let cityCodes: Record<string, string> | null = null;
export function bossCityCode(city: string | undefined): string | undefined {
  if (!city) return undefined;
  if (/^\d{6,}$/.test(city)) return city; // 已经是码就原样用
  if (!cityCodes) {
    const file = path.join(paths.registry, '..', 'boss-city-codes', 'city_codes.json');
    try {
      cityCodes = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      cityCodes = {};
    }
  }
  // 「杭州市」也要能查到
  return cityCodes[city] ?? cityCodes[city.replace(/[市省]$/, '')];
}

export const bossMatcher: SiteMatcher = {
  site: 'boss',
  label: 'BOSS 直聘',
  searchUrl(keyword, city) {
    const p = new URLSearchParams({ query: keyword });
    // 城市要码不要名。查不到就**不带这个参数** —— 把「杭州」原样塞进去
    // 会得到一个静默的全国结果，那比报错难发现得多。
    const code = bossCityCode(city);
    if (code) p.set('city', code);
    return `https://www.zhipin.com/web/geek/job?${p.toString()}`;
  },
  matches(url) {
    return url.includes('/wapi/zpgeek/search/joblist.json');
  },
  riskCodes: BOSS_RISK_CODES,
  risk(res) {
    let body: any;
    try {
      body = JSON.parse(res.bodyText);
    } catch {
      return { blocked: false };
    }
    if (BOSS_RISK_CODES.includes(body?.code)) {
      return { blocked: true, code: body.code, reason: `响应 code=${body.code}：${body.message ?? ''}` };
    }
    // 码表永远追不上平台。message 关键字兜底，否则新码会被当成
    // 「登录失败」而不是「被限流」，然后你会去反复重登 —— 最糟的反应。
    return riskFromMessage(body?.message);
  },
  parse(res: CapturedResponse) {
    let body: any;
    try {
      body = JSON.parse(res.bodyText);
    } catch {
      throw new UnrecognizedResponse('BOSS', res.url, '不是合法 JSON');
    }
    const list: BossJob[] | undefined = body?.zpData?.jobList;
    if (!Array.isArray(list)) {
      throw new UnrecognizedResponse('BOSS', res.url, 'zpData.jobList 不是数组');
    }
    const out: Posting[] = [];
    for (const j of list) {
      if (!j.encryptJobId || !j.jobName || !j.brandName) continue;
      if (j.jobValidStatus === 0) continue;
      const sal = parseBossSalary(j.salaryDesc);
      const tech = [...(j.skills ?? []), ...(j.jobLabels ?? [])].filter(Boolean);
      pushPosting(
        {
          platform: 'boss',
          platform_job_id: j.encryptJobId,
          url: `https://www.zhipin.com/job_detail/${j.encryptJobId}.html`,
          company_name: j.brandName,
          title: j.jobName,
          city: [j.cityName, j.areaDistrict].filter(Boolean).join(' ') || null,
          salary_raw: j.salaryDesc ?? null,
          salary_min_yuan: sal.min,
          salary_max_yuan: sal.max,
          salary_months: sal.months,
          // 列表接口只有摘要。JD 全文要开详情页 —— 那是另一次 reserve，
          // 由内核按预算决定开不开，matcher 不替它决定。
          jd_text: [j.jobName, tech.join('、'), j.jobExperience, j.jobDegree]
            .filter(Boolean).join('\n') || j.jobName,
          apply_channel: 'chat',
          attrs: {
            ...(tech.length > 0 ? { tech_stack: { value: tech, confidence: 'explicit_jd' } } : {}),
            ...(j.jobDegree ? { education: { value: j.jobDegree, confidence: 'explicit_jd' } } : {}),
          },
          collected_by: 'boss-cdp@1',
          collected_at: now(),
        },
        out, 'BOSS', res.url,
      );
    }
    return out;
  },
};

// ── 51job（前程无忧）──────────────────────────────────────────────────────
//
// 它的接口要 acw_sc__v2（阿里云 WAF 的 JS cookie）+ 瑞数系动态参数 +
// HMAC 签名头，全部由页面混淆 JS 现算。被动捕获**根本不需要面对这个**：
// 浏览器自己执行了那段 JS，我只读已经回到页面里的响应。

interface JobItem {
  jobId?: string;
  jobName?: string;
  companyName?: string;
  provideSalaryString?: string;
  jobAreaString?: string;
  workYearString?: string;
  degreeString?: string;
  jobTags?: string[];
  jobDescribe?: string;
}

/** 「2.5-4万/月」「15-25K·13薪」都要认。认不出全 null。 */
export function parse51Salary(s: string | undefined): {
  min: number | null;
  max: number | null;
  months: number | null;
} {
  if (!s) return { min: null, max: null, months: null };
  const months = Number(s.match(/·?\s*(\d{2})\s*薪/)?.[1] ?? '') || null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*([千万KkWw])/);
  if (!m) return { min: null, max: null, months };
  const u = m[3]!.toLowerCase();
  const mul = u === '千' || u === 'k' ? 1000 : 10_000;
  const perYear = /\/\s*年/.test(s);
  const f = (n: number): number => Math.round((n * mul) / (perYear ? 12 : 1));
  return { min: f(Number(m[1])), max: f(Number(m[2])), months };
}

export const job51Matcher: SiteMatcher = {
  site: '51job',
  label: '前程无忧',
  searchUrl(keyword, city) {
    const p = new URLSearchParams({ keyword, searchType: '2' });
    if (city) p.set('jobArea', city);
    return `https://we.51job.com/pc/search?${p.toString()}`;
  },
  matches(url) {
    return url.includes('/api/job/search-pc') || url.includes('/open/noauth/search-pc');
  },
  riskCodes: [],
  risk(res) {
    let body: any;
    try {
      body = JSON.parse(res.bodyText);
    } catch {
      return { blocked: false };
    }
    // 51job 没有公开的风控码表，全靠 message 关键字。
    // 这正是「码表 + 关键字兜底」里兜底那一半存在的理由。
    return riskFromMessage(body?.message ?? body?.msg);
  },
  parse(res) {
    let body: any;
    try {
      body = JSON.parse(res.bodyText);
    } catch {
      throw new UnrecognizedResponse('51job', res.url, '不是合法 JSON');
    }
    const list: JobItem[] | undefined = body?.resultbody?.job?.items ?? body?.resultbody?.items;
    if (!Array.isArray(list)) {
      throw new UnrecognizedResponse('51job', res.url, 'resultbody.job.items 不是数组');
    }
    const out: Posting[] = [];
    for (const j of list) {
      if (!j.jobId || !j.jobName || !j.companyName) continue;
      const sal = parse51Salary(j.provideSalaryString);
      const tags = (j.jobTags ?? []).filter(Boolean);
      pushPosting(
        {
          platform: '51job',
          platform_job_id: j.jobId,
          url: `https://jobs.51job.com/${j.jobId}.html`,
          company_name: j.companyName,
          title: j.jobName,
          city: j.jobAreaString ?? null,
          salary_raw: j.provideSalaryString ?? null,
          salary_min_yuan: sal.min,
          salary_max_yuan: sal.max,
          salary_months: sal.months,
          jd_text: j.jobDescribe?.trim()
            ? j.jobDescribe
            : [j.jobName, tags.join('、'), j.workYearString, j.degreeString].filter(Boolean).join('\n'),
          apply_channel: 'form',
          attrs: {
            ...(tags.length > 0 ? { tech_stack: { value: tags, confidence: 'inferred' } } : {}),
            ...(j.degreeString ? { education: { value: j.degreeString, confidence: 'explicit_jd' } } : {}),
          },
          collected_by: '51job-cdp@1',
          collected_at: now(),
        },
        out, '51job', res.url,
      );
    }
    return out;
  },
};

export function riskOf(m: SiteMatcher, res: CapturedResponse): RiskVerdict {
  return m.risk(res);
}
