import type { Posting } from '@assit/contract';
import { putArtifact } from '../artifacts.js';
import type { Db } from '../db/index.js';
import { identityKey, normalizeTitle, resolveCompany, salaryConflict } from '../dedup/index.js';
import { newId, sha256 } from '../util/hash.js';
import { coverage, parseJob, type ParsedAttrs, type StoredAttrs } from './parse.js';

/**
 * 岗位入库：归一化 → 公司归并 → 去重 → 三态解析 → 落库。
 *
 * 所有采集通道（粘贴、ATS 接口、浏览器扩展、CDP）都汇到这里，
 * 走的是同一条路径。这样「换一个采集通道」永远只是换数据来源，
 * 不会变成「又要把下游逻辑重写一遍」。
 */

/** 职能族。投递去重用的是它，不是职位名 —— 你可能想投同一家的后端和 SRE。 */
const ROLE_FAMILIES: [RegExp, string][] = [
  [/(sre|运维|devops|基础架构|平台工程|infra)/i, 'sre'],
  [/(前端|frontend|web开发|h5|小程序|客户端|android|ios|移动端)/i, 'frontend'],
  [/(算法|machine\s*learning|深度学习|nlp|cv|推荐|搜索算法|大模型|llm)/i, 'algo'],
  [/(数据开发|数仓|大数据|data\s*engineer|etl|bi)/i, 'data'],
  [/(测试|qa|quality|测开)/i, 'qa'],
  [/(安全|security|渗透)/i, 'security'],
  [/(产品经理|product\s*manager|\bpm\b)/i, 'pm'],
  [/(架构师|architect)/i, 'architect'],
  [/(后端|服务端|backend|java|golang|\bgo\b|python|服务器开发)/i, 'backend'],
  [/(全栈|fullstack)/i, 'fullstack'],
];

export function roleFamily(title: string): string {
  const t = normalizeTitle(title);
  for (const [re, fam] of ROLE_FAMILIES) if (re.test(t)) return fam;
  return 'other';
}

export type IngestOutcome =
  | 'new_job'
  | 'merged_into_existing'
  | 'posting_updated'
  | 'jd_changed'
  | 'unchanged';

export interface IngestResult {
  outcome: IngestOutcome;
  jobId: string;
  postingId: string;
  companyId: string;
  identityKey: string;
  /** 公司名是第一次见到的写法，需要你确认它是不是已有公司的别名 */
  newCompanyAlias: boolean;
  fingerprintMatch?: string;
  attrs: StoredAttrs;
  coverage: { known: number; total: number; ratio: number };
  salaryConflict: boolean;
  jdVersions: number;
  notes: string[];
}

export interface IngestOptions {
  /** 你自己账本里的技术 tag，用来扩展技术词表 */
  extraTech?: string[];
}

export function ingestPosting(db: Db, p: Posting, opts: IngestOptions = {}): IngestResult {
  const notes: string[] = [];
  const company = resolveCompany(db, p.company_name);
  const parsed = parseJob({
    jdText: p.jd_text,
    companyName: p.company_name,
    salaryRaw: p.salary_raw,
    extraTech: opts.extraTech,
  });

  // 平台给的结构化薪资优先；平台没给（粘贴通道常见）才用解析结果
  const salMin = p.salary_min_yuan ?? parsed.salary.min;
  const salMax = p.salary_max_yuan ?? parsed.salary.max;
  const salMonths = p.salary_months ?? parsed.salary.months;

  const key = identityKey(company.companyId, p.title, p.city);
  const attrs: StoredAttrs = {
    ...parsed.attrs,
    ...(p.attrs as Partial<ParsedAttrs>),
    // 薪数的来源要跟着走：jobs.salary_months 存了 12 之后，就分不清
    // 「JD 明写 12 薪」和「没写，我们按 12 估的」—— 后者在打分证据里必须说明。
    salary_months_confidence:
      p.salary_months !== null && p.salary_months !== undefined
        ? 'explicit_jd'
        : parsed.salary.monthsConfidence,
  };
  const cov = coverage(attrs);

  let jobIsNew = false;
  let postingIsNew = false;
  let jdChanged = false;
  let conflict = false;
  let jobId = '';
  let postingId = '';
  let jdVersions = 0;

  db.transaction(() => {
    // ── 公司的外包信号 ──
    if (parsed.outsourcingSignals.length > 0) {
      const p2 = 1 - parsed.outsourcingSignals.reduce((a, s) => a * (1 - s.weight), 1);
      db.prepare(
        'UPDATE companies SET outsourcing_signals = ?, outsourcing_likelihood = ? WHERE id = ?',
      ).run(JSON.stringify(parsed.outsourcingSignals), Number(p2.toFixed(2)), company.companyId);
    }

    // ── 岗位身份 ──
    const existing = db.prepare('SELECT * FROM jobs WHERE identity_key = ?').get(key) as any;
    if (existing) {
      jobId = existing.id;
      conflict = salaryConflict(
        { min: existing.salary_min_yuan, max: existing.salary_max_yuan },
        { min: salMin, max: salMax },
      );
      if (conflict) {
        notes.push(
          `薪资与已有记录不一致：${existing.salary_raw ?? '?'} vs ${p.salary_raw ?? '?'}。` +
            '两条都留着，你自己看 —— 薪资不参与身份判定，正是为了避免因为写法不同而漏合。',
        );
      }
      // 合并时保留更完整的信息：已有的为空才补上
      db.prepare(
        `UPDATE jobs SET
           last_seen_at = datetime('now'),
           salary_min_yuan = COALESCE(salary_min_yuan, ?),
           salary_max_yuan = COALESCE(salary_max_yuan, ?),
           salary_months   = COALESCE(salary_months, ?),
           salary_raw      = COALESCE(salary_raw, ?),
           attrs = ?
         WHERE id = ?`,
      ).run(
        salMin, salMax, salMonths, p.salary_raw,
        JSON.stringify(mergeAttrs(JSON.parse(existing.attrs || '{}'), attrs, conflict)),
        jobId,
      );
    } else {
      jobIsNew = true;
      jobId = newId('job-');
      db.prepare(
        `INSERT INTO jobs
          (id, company_id, identity_key, title_norm, title_raw, role_family, city,
           salary_min_yuan, salary_max_yuan, salary_months, salary_raw, attrs, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      ).run(
        jobId, company.companyId, key, normalizeTitle(p.title), p.title,
        roleFamily(p.title), p.city, salMin, salMax, salMonths, p.salary_raw,
        JSON.stringify(attrs),
      );
    }

    // ── JD 存档 ──
    // 每次采集都写 artifacts，postings 只存最新 hash。
    // 副产品：「这个岗位两周内改了 3 次 JD」本身就是个信号。
    const jd = putArtifact(db, 'jd', 'jd.md', p.jd_text);

    const prevPosting = db
      .prepare('SELECT * FROM postings WHERE platform = ? AND platform_job_id = ?')
      .get(p.platform, p.platform_job_id) as any;

    if (prevPosting) {
      postingId = prevPosting.id;
      if (prevPosting.jd_sha256 !== jd.sha256) {
        jdChanged = true;
        notes.push('JD 内容与上次采集不同，已存档新版本');
      }
      db.prepare(
        `UPDATE postings SET job_id=?, url=?, jd_sha256=?, apply_channel=?,
           collected_by=?, collected_at=datetime('now'), is_active=1 WHERE id=?`,
      ).run(jobId, p.url ?? null, jd.sha256, p.apply_channel, p.collected_by, postingId);
    } else {
      postingIsNew = true;
      postingId = newId('post-');
      db.prepare(
        `INSERT INTO postings
          (id, job_id, platform, platform_job_id, url, jd_sha256, apply_channel, collected_by)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        postingId, jobId, p.platform, p.platform_job_id, p.url ?? null,
        jd.sha256, p.apply_channel, p.collected_by,
      );
    }

    const lastHist = db
      .prepare('SELECT jd_sha256 FROM posting_jd_history WHERE posting_id = ? ORDER BY id DESC LIMIT 1')
      .get(postingId) as { jd_sha256: string } | undefined;
    if (lastHist?.jd_sha256 !== jd.sha256) {
      db.prepare('INSERT INTO posting_jd_history (posting_id, jd_sha256) VALUES (?,?)').run(
        postingId, jd.sha256,
      );
    }
    jdVersions = (
      db.prepare('SELECT COUNT(*) n FROM posting_jd_history WHERE posting_id = ?').get(postingId) as any
    ).n;
  })();

  // 结论由三个独立事实合成，读起来就是它字面的意思
  const outcome: IngestOutcome = jdChanged
    ? 'jd_changed'
    : postingIsNew
      ? jobIsNew
        ? 'new_job'
        : 'merged_into_existing'
      : 'unchanged';

  if (company.isNewAlias) {
    notes.push(
      company.fingerprintMatch
        ? `公司名「${p.company_name}」按指纹归并到「${company.fingerprintMatch.canonicalName}」，请确认是否同一家`
        : `第一次见到公司「${p.company_name}」`,
    );
  }
  if (cov.ratio < 0.5) {
    notes.push(
      `只披露了 ${cov.known}/${cov.total} 个维度，打分置信度低 —— ` +
        '不是这个岗位差，是你看不清它。',
    );
  }

  return {
    outcome, jobId, postingId, companyId: company.companyId, identityKey: key,
    newCompanyAlias: company.isNewAlias,
    fingerprintMatch: company.fingerprintMatch?.canonicalName,
    attrs, coverage: cov, salaryConflict: conflict, jdVersions, notes,
  };
}

/**
 * 合并两个平台的三态字段：已知的盖过未知的，explicit 盖过 inferred。
 * 两边都 explicit 但值不同时保留旧的并标冲突 —— 这种情况值得人看一眼。
 */
function mergeAttrs(
  old: Record<string, any>,
  fresh: StoredAttrs,
  salaryConflictFlag: boolean,
): Record<string, any> {
  const rank: Record<string, number> = {
    unknown: 0, inferred: 1, user_provided: 2, explicit_jd: 3,
  };
  const out: Record<string, any> = { ...old };
  for (const [k, v] of Object.entries(fresh)) {
    if (!v || typeof v !== 'object' || !('confidence' in v)) {
      out[k] = v; // 附加字段（如 salary_months_confidence）直接覆盖
      continue;
    }
    const prev = old[k];
    if (!prev || (rank[(v as any).confidence] ?? 0) > (rank[String(prev.confidence)] ?? 0)) {
      out[k] = v;
    }
  }
  if (salaryConflictFlag) out.salary_conflict = true;
  return out;
}

// ── 粘贴入库 ───────────────────────────────────────────────────────────────

export interface PasteInput {
  url?: string;
  title?: string;
  company?: string;
  city?: string;
  salaryRaw?: string;
  jdText: string;
}

/**
 * 从一段粘贴的文本构造 Posting。
 *
 * 这条通道零风险、零维护、覆盖一切平台 —— 包括 BOSS。
 * 它的存在意味着：**浏览器扩展做出来之前，所有平台的岗位就都能进岗位池了。**
 * 手动复制一次 JD 的成本，远低于为此写一个会被反爬打断的采集器。
 */
export function pastedPosting(input: PasteInput): Posting {
  const platform = input.url ? platformFromUrl(input.url) : 'paste';
  // 粘贴没有平台 id，用内容 hash 当 id：同一份 JD 粘两次不会重复入库
  const idSeed = input.url ?? `${input.company ?? ''}|${input.title ?? ''}|${input.jdText.slice(0, 500)}`;
  return {
    platform,
    platform_job_id: sha256(idSeed).slice(0, 16),
    url: input.url,
    company_name: (input.company ?? '').trim() || '（未填写公司）',
    title: (input.title ?? '').trim() || '（未填写职位）',
    city: input.city?.trim() || null,
    salary_raw: input.salaryRaw?.trim() || null,
    salary_min_yuan: null,
    salary_max_yuan: null,
    salary_months: null,
    jd_text: input.jdText,
    apply_channel: platform === 'paste' ? 'unknown' : 'external',
    attrs: {},
    collected_by: 'paste@1',
    collected_at: new Date().toISOString(),
  };
}

const PLATFORM_HOSTS: [RegExp, string][] = [
  [/zhipin\.com/i, 'boss'],
  [/51job\.com|jobs\.51job/i, 'job51'],
  [/liepin\.com/i, 'liepin'],
  [/zhaopin\.com/i, 'zhilian'],
  [/lagou\.com/i, 'lagou'],
  [/boards\.greenhouse\.io|greenhouse\.io/i, 'greenhouse'],
  [/jobs\.lever\.co|lever\.co/i, 'lever'],
  [/ashbyhq\.com/i, 'ashby'],
  [/mokahr\.com|moka\.cn/i, 'moka'],
  [/beisen\.com|italent\.cn/i, 'beisen'],
];

export function platformFromUrl(url: string): string {
  for (const [re, name] of PLATFORM_HOSTS) if (re.test(url)) return name;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'paste';
  } catch {
    return 'paste';
  }
}
