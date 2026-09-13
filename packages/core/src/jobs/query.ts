import { readArtifact } from '../artifacts.js';
import type { Db } from '../db/index.js';
import type { ScoreTrace } from '../scoring/score.js';
import type { StoredAttrs } from './parse.js';

/**
 * 岗位池的只读查询层。
 *
 * 放在 core 而不是桌面壳里：它是领域逻辑，CLI 和 UI 用的是同一份。
 * 桌面壳只负责把它画出来 —— 这样「换个前端」永远不会变成「把筛选逻辑再实现一遍」。
 */

export interface JobRow {
  jobId: string;
  company: string;
  title: string;
  city: string | null;
  salaryRaw: string | null;
  roleFamily: string | null;
  finalScore: number | null;
  rawScore: number | null;
  coverage: number | null;
  hardGaps: string[];
  caps: string[];
  cappedBy: string | null;
  unknownDims: string[];
  injectionFlags: string[];
  platforms: string[];
  urls: string[];
  firstSeenAt: string;
  lastSeenAt: string | null;
  jdVersions: number;
  ignoredReason: string | null;
  applied: boolean;
}

export interface JobFilter {
  minScore?: number;
  minCoverage?: number;
  roleFamilies?: string[];
  platforms?: string[];
  /** 公司名或职位名的模糊匹配 */
  search?: string;
  /** 默认不显示已忽略的 */
  includeIgnored?: boolean;
  /** 默认显示硬门槛未过的（只是沉底），JD 门槛常常虚标 */
  hideHardGaps?: boolean;
  limit?: number;
  offset?: number;
}

interface Versions {
  profileVersion: string;
  rubricVersion: string;
}

const BASE_SELECT = `
  SELECT j.id AS jobId, j.title_raw AS title, j.city, j.salary_raw AS salaryRaw,
         j.role_family AS roleFamily, j.first_seen_at AS firstSeenAt, j.last_seen_at AS lastSeenAt,
         c.canonical_name AS company,
         s.final_score AS finalScore, s.raw_score AS rawScore,
         s.coverage AS coverage, s.trace_json AS traceJson,
         i.reason AS ignoredReason,
         (SELECT group_concat(DISTINCT p.platform) FROM postings p WHERE p.job_id = j.id) AS platforms,
         (SELECT group_concat(p.url, char(10)) FROM postings p WHERE p.job_id = j.id AND p.url IS NOT NULL) AS urls,
         (SELECT COUNT(*) FROM posting_jd_history h
            JOIN postings p2 ON p2.id = h.posting_id WHERE p2.job_id = j.id) AS jdVersions,
         (SELECT COUNT(*) FROM applications a
            JOIN postings p3 ON p3.id = a.posting_id WHERE p3.job_id = j.id) AS appliedCount
  FROM jobs j
  JOIN companies c ON c.id = j.company_id
  LEFT JOIN job_scores s ON s.job_id = j.id
       AND s.profile_version = @profileVersion AND s.rubric_version = @rubricVersion
  LEFT JOIN jobs_ignored i ON i.job_id = j.id
`;

function toRow(r: any): JobRow {
  const trace: Partial<ScoreTrace> = r.traceJson ? JSON.parse(r.traceJson) : {};
  return {
    jobId: r.jobId,
    company: r.company,
    title: r.title,
    city: r.city,
    salaryRaw: r.salaryRaw,
    roleFamily: r.roleFamily,
    finalScore: r.finalScore,
    rawScore: r.rawScore,
    coverage: r.coverage,
    hardGaps: trace.hard_gaps ?? [],
    caps: trace.caps ?? [],
    cappedBy: trace.capped_by ?? null,
    unknownDims: trace.unknown_dims ?? [],
    injectionFlags: trace.injection_flags ?? [],
    platforms: r.platforms ? String(r.platforms).split(',') : [],
    urls: r.urls ? String(r.urls).split('\n').filter(Boolean) : [],
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    jdVersions: r.jdVersions ?? 0,
    ignoredReason: r.ignoredReason ?? null,
    applied: (r.appliedCount ?? 0) > 0,
  };
}

export function queryJobs(db: Db, v: Versions, filter: JobFilter = {}): JobRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { ...v };

  if (!filter.includeIgnored) where.push('i.job_id IS NULL');
  if (filter.minScore !== undefined) {
    where.push('COALESCE(s.final_score, -1) >= @minScore');
    params.minScore = filter.minScore;
  }
  if (filter.minCoverage !== undefined) {
    where.push('COALESCE(s.coverage, 0) >= @minCoverage');
    params.minCoverage = filter.minCoverage;
  }
  if (filter.roleFamilies?.length) {
    where.push(`j.role_family IN (${filter.roleFamilies.map((_, i) => `@rf${i}`).join(',')})`);
    filter.roleFamilies.forEach((f, i) => (params[`rf${i}`] = f));
  }
  if (filter.search) {
    where.push('(c.canonical_name LIKE @search OR j.title_raw LIKE @search)');
    params.search = `%${filter.search}%`;
  }

  const sql =
    BASE_SELECT +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    // 排序刻意**不乘 coverage**：final_score × coverage 看着合理，实际等价于
    // 对 unknown 记负分，和「未知保持未知」自相矛盾。
    // 硬门槛没过的沉底但不消失 —— JD 的门槛常常是虚标的。
    `
    ORDER BY (CASE WHEN json_extract(COALESCE(s.trace_json,'{}'), '$.hard_gaps') IN ('[]','') THEN 0 ELSE 1 END) ASC,
             COALESCE(s.final_score, -1) DESC,
             j.first_seen_at DESC
    LIMIT @limit OFFSET @offset`;

  params.limit = filter.limit ?? 200;
  params.offset = filter.offset ?? 0;

  let rows = db.prepare(sql).all(params) as any[];
  if (filter.hideHardGaps) {
    rows = rows.filter((r) => {
      const t = r.traceJson ? JSON.parse(r.traceJson) : {};
      return (t.hard_gaps ?? []).length === 0;
    });
  }
  if (filter.platforms?.length) {
    const want = new Set(filter.platforms);
    rows = rows.filter((r) => String(r.platforms ?? '').split(',').some((p) => want.has(p)));
  }
  return rows.map(toRow);
}

export interface JobDetail extends JobRow {
  /** 最近一次挂牌。记录投递要的是具体哪一次挂牌，不是 job */
  postingId: string | null;
  applyChannel: string | null;
  trace: ScoreTrace | null;
  attrs: StoredAttrs;
  jdText: string | null;
  jdSha256: string | null;
  postings: {
    platform: string;
    url: string | null;
    collectedAt: string;
    collectedBy: string | null;
    jdVersions: number;
  }[];
}

export function jobDetail(db: Db, v: Versions, jobId: string): JobDetail | null {
  const row = db.prepare(`${BASE_SELECT} WHERE j.id = @jobId`).get({ ...v, jobId }) as any;
  if (!row) return null;

  const job = db.prepare('SELECT attrs FROM jobs WHERE id = ?').get(jobId) as { attrs: string };
  const postings = db
    .prepare(
      `SELECT p.id AS postingId, p.platform, p.url, p.apply_channel AS applyChannel,
              p.collected_at AS collectedAt, p.collected_by AS collectedBy,
              p.jd_sha256 AS jdSha256,
              (SELECT COUNT(*) FROM posting_jd_history h WHERE h.posting_id = p.id) AS jdVersions
       FROM postings p WHERE p.job_id = ? ORDER BY p.collected_at DESC`,
    )
    .all(jobId) as any[];

  const jdSha = postings[0]?.jdSha256 ?? null;
  let jdText: string | null = null;
  if (jdSha) {
    try {
      jdText = readArtifact(jdSha, 'jd.md').toString('utf8');
    } catch {
      jdText = null; // 存档丢了不该让详情页打不开
    }
  }

  return {
    ...toRow(row),
    // 记录投递要的是**具体哪一次挂牌**，不是 job —— 同一个岗位可能在
    // 两个平台各挂一次，而你只投了其中一个。取最近采到的那条。
    postingId: postings[0]?.postingId ?? null,
    applyChannel: postings[0]?.applyChannel ?? null,
    trace: row.traceJson ? JSON.parse(row.traceJson) : null,
    attrs: JSON.parse(job?.attrs ?? '{}'),
    jdText,
    jdSha256: jdSha,
    postings: postings.map((p) => ({
      platform: p.platform,
      url: p.url,
      collectedAt: p.collectedAt,
      collectedBy: p.collectedBy,
      jdVersions: p.jdVersions,
    })),
  };
}

// ── 今日 ───────────────────────────────────────────────────────────────────

export interface TodaySummary {
  /** 今天新入库的岗位 */
  newToday: number;
  /** 其中达到高分线的 */
  newHighScore: number;
  highScoreThreshold: number;
  /** 还没打分的（改了 rubric 或刚采集完） */
  unscored: number;
  /** 连续失败的采集源，需要你去看一眼 */
  brokenSources: { sourceId: string; consecutiveFailures: number; lastError: string | null }[];
  /** 待你确认的公司别名 —— 别让系统悄悄把两家公司合成一家 */
  pendingAliases: number;
  topNew: JobRow[];
}

/**
 * 今日面板的数据。
 *
 * 每一条都要能点进去有明确下一步 —— 放了折线图的今日页，第三天就没人开了。
 * M1 只做「新增高分岗位」这一张卡，其余等后面阶段再补。
 */
export function todaySummary(
  db: Db,
  v: Versions,
  opts: { threshold?: number; now?: Date } = {},
): TodaySummary {
  const threshold = opts.threshold ?? 70;
  const since = new Date((opts.now ?? new Date()).getTime() - 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const newToday = (
    db.prepare('SELECT COUNT(*) n FROM jobs WHERE first_seen_at >= ?').get(since) as any
  ).n as number;

  const newHighScore = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM jobs j
         JOIN job_scores s ON s.job_id = j.id
              AND s.profile_version = @profileVersion AND s.rubric_version = @rubricVersion
         LEFT JOIN jobs_ignored i ON i.job_id = j.id
         WHERE j.first_seen_at >= @since AND s.final_score >= @threshold AND i.job_id IS NULL`,
      )
      .get({ ...v, since, threshold }) as any
  ).n as number;

  const unscored = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM jobs j
         LEFT JOIN job_scores s ON s.job_id = j.id
              AND s.profile_version = @profileVersion AND s.rubric_version = @rubricVersion
         WHERE s.id IS NULL`,
      )
      .get(v) as any
  ).n as number;

  const broken = db
    .prepare(
      `SELECT source_id AS sourceId, ok, error FROM collector_runs
       WHERE id IN (SELECT MAX(id) FROM collector_runs GROUP BY source_id)`,
    )
    .all() as any[];
  const brokenSources = broken
    .filter((r) => !r.ok)
    .map((r) => {
      const runs = db
        .prepare('SELECT ok FROM collector_runs WHERE source_id = ? ORDER BY id DESC LIMIT 20')
        .all(r.sourceId) as any[];
      let n = 0;
      for (const x of runs) {
        if (x.ok) break;
        n += 1;
      }
      return { sourceId: r.sourceId, consecutiveFailures: n, lastError: r.error ?? null };
    });

  const pendingAliases = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM company_aliases
         WHERE confirmed_by_user = 0 AND alias NOT LIKE 'fp:%'`,
      )
      .get() as any
  ).n as number;

  const topNew = queryJobs(db, v, { minScore: threshold, limit: 10 }).filter(
    (j) => j.firstSeenAt >= since,
  );

  return {
    newToday,
    newHighScore,
    highScoreThreshold: threshold,
    unscored,
    brokenSources,
    pendingAliases,
    topNew,
  };
}

/** 筛选器要用的可选值。空的选项不该出现在下拉里。 */
export function facets(db: Db): { roleFamilies: string[]; platforms: string[]; cities: string[] } {
  const col = (sql: string) => (db.prepare(sql).all() as any[]).map((r) => r.v).filter(Boolean);
  return {
    roleFamilies: col('SELECT DISTINCT role_family v FROM jobs ORDER BY v'),
    platforms: col('SELECT DISTINCT platform v FROM postings ORDER BY v'),
    cities: col('SELECT DISTINCT city v FROM jobs ORDER BY v'),
  };
}

export function unignoreJob(db: Db, jobId: string): void {
  db.prepare('DELETE FROM jobs_ignored WHERE job_id = ?').run(jobId);
}

// ── 按渠道 → 公司分组 ──────────────────────────────────────────────────────

/**
 * 投递渠道。**用 `apply_channel` 而不是 `platform` 分组。**
 *
 * 因为决定「这个岗位怎么投」的不是它从哪采来的，而是投出去要做什么动作：
 * BOSS 是打招呼聊天，网申是填一张表。这两件事在你的日程上完全不同 ——
 * 打招呼是 30 秒，网申是 15 分钟。按平台分组会把腾讯官网和 Greenhouse
 * 拆成两堆，而它们对你是同一件事。
 */
export const CHANNEL_LABELS: Record<string, string> = {
  chat: 'BOSS / 直聊',
  form: '网申表单',
  email: '邮件投递',
  external: '跳转外部',
  unknown: '方式未知',
};

export const CHANNEL_HINTS: Record<string, string> = {
  chat: '打招呼即可，一次约 30 秒 —— 但要登录态，走通道 B',
  form: '要填一张表，一次约 15 分钟。自动填表能省掉大半',
  email: '发邮件附简历',
  external: '跳到公司自己的系统',
  unknown: '采集时没能判断出投递方式',
};

export interface CompanyGroup {
  companyId: string;
  company: string;
  count: number;
  /** 这家公司里最高的分数。分组要按它排 —— 你关心的是「哪家有好岗位」 */
  topScore: number | null;
  applied: number;
  jobs: JobRow[];
}

export interface ChannelGroup {
  channel: string;
  label: string;
  hint: string;
  count: number;
  companies: CompanyGroup[];
}

/**
 * 岗位池的分组视图：渠道 → 公司 → 岗位。
 *
 * 复用 `queryJobs` 而不是另写一条 SQL —— 排序规则（不乘 coverage、
 * 硬门槛沉底）和筛选逻辑只该有一处实现，两份必然漂移。
 */
export function groupedJobs(db: Db, v: Versions, filter: JobFilter = {}): ChannelGroup[] {
  const rows = queryJobs(db, v, { ...filter, limit: filter.limit ?? 500 });

  const chanOf = new Map(
    (db.prepare(
      `SELECT job_id, COALESCE(MAX(apply_channel), 'unknown') ch FROM postings GROUP BY job_id`,
    ).all() as { job_id: string; ch: string }[]).map((r) => [r.job_id, r.ch || 'unknown']),
  );
  const companyOf = new Map(
    (db.prepare('SELECT j.id, j.company_id, c.canonical_name FROM jobs j JOIN companies c ON c.id = j.company_id')
      .all() as { id: string; company_id: string; canonical_name: string }[])
      .map((r) => [r.id, { id: r.company_id, name: r.canonical_name }]),
  );

  const byChannel = new Map<string, Map<string, CompanyGroup>>();
  for (const j of rows) {
    const ch = chanOf.get(j.jobId) ?? 'unknown';
    const co = companyOf.get(j.jobId) ?? { id: 'unknown', name: j.company };
    if (!byChannel.has(ch)) byChannel.set(ch, new Map());
    const companies = byChannel.get(ch)!;
    if (!companies.has(co.id)) {
      companies.set(co.id, { companyId: co.id, company: co.name, count: 0, topScore: null, applied: 0, jobs: [] });
    }
    const g = companies.get(co.id)!;
    g.jobs.push(j);
    g.count += 1;
    if (j.applied) g.applied += 1;
    if (j.finalScore !== null && (g.topScore === null || j.finalScore > g.topScore)) g.topScore = j.finalScore;
  }

  return [...byChannel.entries()]
    .map(([channel, companies]) => ({
      channel,
      label: CHANNEL_LABELS[channel] ?? channel,
      hint: CHANNEL_HINTS[channel] ?? '',
      count: [...companies.values()].reduce((a, c) => a + c.count, 0),
      // 公司按「最高分」排，不按岗位数 —— 一家有 1 个 85 分的岗位，
      // 比一家有 20 个 40 分的岗位值得先看。
      companies: [...companies.values()].sort(
        (a, b) => (b.topScore ?? -1) - (a.topScore ?? -1) || b.count - a.count,
      ),
    }))
    .sort((a, b) => b.count - a.count);
}
