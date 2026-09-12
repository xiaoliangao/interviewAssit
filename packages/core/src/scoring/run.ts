import { readArtifact } from '../artifacts.js';
import type { Db } from '../db/index.js';
import type { SalaryParse, StoredAttrs } from '../jobs/parse.js';
import { newId } from '../util/hash.js';
import type { LoadedRubric } from './rubric.js';
import { scoreJob, sortKey, type ScoreTrace } from './score.js';

/**
 * 对库里的岗位打分并落库。
 *
 * 分数与岗位解耦：`job_scores` 的唯一键是 (job_id, profile_version, rubric_version)。
 * 换简历版本或改 rubric → 新增一行，旧分数保留可对比。
 * 这让「我把简历改成架构方向之后，岗位池的匹配分整体涨了多少」
 * 变成一个可以直接查的问题，而不是一次不可逆的覆盖。
 */

export interface ScoredJob {
  jobId: string;
  title: string;
  company: string;
  city: string | null;
  salaryRaw: string | null;
  trace: ScoreTrace;
}

export interface ScoreRunOptions {
  profileVersion: string;
  /** 已有同版本分数时重算 */
  force?: boolean;
  /** 只打这一个岗位 */
  jobId?: string;
}

export function scoreAllJobs(db: Db, loaded: LoadedRubric, opts: ScoreRunOptions): ScoredJob[] {
  const where = opts.jobId ? 'WHERE j.id = ?' : '';
  const rows = db
    .prepare(
      `SELECT j.*, c.canonical_name AS company, c.outsourcing_likelihood AS outsourcing,
              (SELECT p.jd_sha256 FROM postings p WHERE p.job_id = j.id
               ORDER BY p.collected_at DESC LIMIT 1) AS jd_sha256
       FROM jobs j JOIN companies c ON c.id = j.company_id ${where}`,
    )
    .all(...(opts.jobId ? [opts.jobId] : [])) as any[];

  const out: ScoredJob[] = [];
  const insert = db.prepare(
    `INSERT INTO job_scores
       (id, job_id, profile_version, rubric_version, final_score, raw_score, coverage, trace_json)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(job_id, profile_version, rubric_version) DO UPDATE SET
       final_score=excluded.final_score, raw_score=excluded.raw_score,
       coverage=excluded.coverage, trace_json=excluded.trace_json,
       created_at=datetime('now')`,
  );

  for (const r of rows) {
    if (!opts.force) {
      const existing = db
        .prepare(
          'SELECT trace_json FROM job_scores WHERE job_id=? AND profile_version=? AND rubric_version=?',
        )
        .get(r.id, opts.profileVersion, loaded.version) as { trace_json: string } | undefined;
      if (existing) {
        out.push(toScored(r, JSON.parse(existing.trace_json)));
        continue;
      }
    }

    let jdText = '';
    if (r.jd_sha256) {
      try {
        jdText = readArtifact(r.jd_sha256, 'jd.md').toString('utf8');
      } catch {
        jdText = '';
      }
    }

    const attrs = JSON.parse(r.attrs || '{}') as StoredAttrs;
    const salary: SalaryParse = {
      min: r.salary_min_yuan, max: r.salary_max_yuan, months: r.salary_months,
      // 薪数的出处入库时就跟着 attrs 走了。少了它，「JD 明写 12 薪」
      // 和「没写，我们按 12 估的」在库里长得一模一样。
      monthsConfidence: attrs.salary_months_confidence ?? (r.salary_months ? 'inferred' : 'unknown'),
      raw: r.salary_raw ?? '',
    };

    const trace = scoreJob({
      rubric: loaded.rubric,
      rubricVersion: loaded.version,
      profileVersion: opts.profileVersion,
      jdText,
      attrs,
      salary,
      city: r.city,
      outsourcingLikelihood: r.outsourcing ?? null,
    });

    insert.run(
      newId('score-'), r.id, opts.profileVersion, loaded.version,
      trace.final_score, trace.raw_score, trace.coverage, JSON.stringify(trace),
    );
    out.push(toScored(r, trace));
  }

  return out.sort((a, b) => {
    const [ga, sa] = sortKey(a.trace);
    const [gb, sb] = sortKey(b.trace);
    return ga - gb || sa - sb || a.jobId.localeCompare(b.jobId);
  });
}

function toScored(r: any, trace: ScoreTrace): ScoredJob {
  return {
    jobId: r.id, title: r.title_raw, company: r.company,
    city: r.city, salaryRaw: r.salary_raw, trace,
  };
}
