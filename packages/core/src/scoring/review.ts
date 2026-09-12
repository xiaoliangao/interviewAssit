import type { Db } from '../db/index.js';

/**
 * 消费「忽略原因」（DESIGN §11.5）。
 *
 * `jobs_ignored` 记了原因但没有消费方，就只是个垃圾桶。
 * 这两张表直接指出 rubric 和你真实偏好的偏差在哪：
 * 高分却被你忽略的，说明 rubric 高估了某些维度；低分却被你投的，说明低估了。
 *
 * **改 rubric 仍然由你手动做。** 不做自动调参 —— 你的偏好会变，
 * 而自动调参会把「这周心情不好多忽略了几个」固化成规则。
 */

export interface ReviewRow {
  jobId: string;
  company: string;
  title: string;
  score: number | null;
  reason?: string;
  at: string;
}

export interface RubricReview {
  highScoreIgnored: ReviewRow[];
  lowScoreApplied: ReviewRow[];
  reasonClusters: { reason: string; count: number; avgScore: number | null }[];
  profileVersion: string;
  rubricVersion: string;
}

export function rubricReview(
  db: Db,
  profileVersion: string,
  rubricVersion: string,
  opts: { highThreshold?: number; lowThreshold?: number } = {},
): RubricReview {
  const high = opts.highThreshold ?? 75;
  const low = opts.lowThreshold ?? 55;

  const highScoreIgnored = db
    .prepare(
      `SELECT j.id AS jobId, c.canonical_name AS company, j.title_raw AS title,
              s.final_score AS score, i.reason, i.ignored_at AS at
       FROM jobs_ignored i
       JOIN jobs j ON j.id = i.job_id
       JOIN companies c ON c.id = j.company_id
       LEFT JOIN job_scores s ON s.job_id = j.id
            AND s.profile_version = ? AND s.rubric_version = ?
       WHERE COALESCE(s.final_score, i.score_at_ignore) >= ?
       ORDER BY score DESC`,
    )
    .all(profileVersion, rubricVersion, high) as ReviewRow[];

  const lowScoreApplied = db
    .prepare(
      `SELECT j.id AS jobId, c.canonical_name AS company, j.title_raw AS title,
              s.final_score AS score, a.sent_at AS at
       FROM applications a
       JOIN postings p ON p.id = a.posting_id
       JOIN jobs j ON j.id = p.job_id
       JOIN companies c ON c.id = j.company_id
       LEFT JOIN job_scores s ON s.job_id = j.id
            AND s.profile_version = ? AND s.rubric_version = ?
       WHERE s.final_score < ?
       ORDER BY s.final_score ASC`,
    )
    .all(profileVersion, rubricVersion, low) as ReviewRow[];

  const clusters = db
    .prepare(
      `SELECT i.reason AS reason, COUNT(*) AS count, AVG(COALESCE(s.final_score, i.score_at_ignore)) AS avgScore
       FROM jobs_ignored i
       LEFT JOIN job_scores s ON s.job_id = i.job_id
            AND s.profile_version = ? AND s.rubric_version = ?
       GROUP BY i.reason ORDER BY count DESC`,
    )
    .all(profileVersion, rubricVersion) as { reason: string; count: number; avgScore: number | null }[];

  return {
    highScoreIgnored,
    lowScoreApplied,
    reasonClusters: clusters.map((c) => ({
      ...c,
      avgScore: c.avgScore === null ? null : Math.round(c.avgScore),
    })),
    profileVersion,
    rubricVersion,
  };
}

export function ignoreJob(db: Db, jobId: string, reason: string, scoreAtIgnore: number | null): void {
  db.prepare(
    `INSERT INTO jobs_ignored (job_id, reason, score_at_ignore) VALUES (?,?,?)
     ON CONFLICT(job_id) DO UPDATE SET reason=excluded.reason, ignored_at=datetime('now')`,
  ).run(jobId, reason, scoreAtIgnore);
}
