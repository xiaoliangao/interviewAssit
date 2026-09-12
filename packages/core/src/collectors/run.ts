import fs from 'node:fs';
import YAML from 'yaml';
import { SourcesFile, type JobSource } from '@assit/contract';
import type { Db } from '../db/index.js';
import { ingestPosting, type IngestOptions } from '../jobs/ingest.js';
import { paths } from '../util/paths.js';
import { collect, type CollectOptions } from './platforms.js';

export function loadSources(file = `${paths.facts}/sources.yaml`): JobSource[] {
  if (!fs.existsSync(file)) return [];
  const parsed = SourcesFile.safeParse(YAML.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      'facts/sources.yaml 格式有问题：\n' +
        parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }
  return parsed.data.sources;
}

export interface SourceRunResult {
  sourceId: string;
  platform: string;
  ok: boolean;
  fetched: number;
  ingested: number;
  newJobs: number;
  rejected: { reason: string; sample?: string }[];
  error?: string;
  durationMs: number;
}

/**
 * 跑一个采集源并落库。
 *
 * **单源失败不影响其他源。** 采集器坏掉是常态不是意外，
 * 所以异常在这里就被接住并记进 collector_runs，让「智联已经 5 天没抓到东西了」
 * 在岗位池面板上一眼可见 —— 而不是等到某天你发现岗位池不再增长。
 */
export async function runSource(
  db: Db,
  source: JobSource,
  opts: CollectOptions & IngestOptions = {},
): Promise<SourceRunResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base: SourceRunResult = {
    sourceId: source.id, platform: source.platform, ok: false,
    fetched: 0, ingested: 0, newJobs: 0, rejected: [], durationMs: 0,
  };

  try {
    const r = await collect(source, { ...opts, db });
    base.fetched = r.fetched;
    base.rejected = r.rejected;
    for (const p of r.postings) {
      const ing = ingestPosting(db, p, { extraTech: opts.extraTech });
      base.ingested += 1;
      if (ing.outcome === 'new_job') base.newJobs += 1;
    }
    base.ok = true;
  } catch (e) {
    base.error = (e as Error).message.slice(0, 500);
  }

  base.durationMs = Date.now() - t0;
  db.prepare(
    `INSERT INTO collector_runs
       (source_id, platform, started_at, finished_at, ok, fetched, ingested, new_jobs, error, duration_ms)
     VALUES (?,?,?,datetime('now'),?,?,?,?,?,?)`,
  ).run(
    source.id, source.platform, startedAt, base.ok ? 1 : 0,
    base.fetched, base.ingested, base.newJobs, base.error ?? null, base.durationMs,
  );
  return base;
}

export interface SourceHealth {
  sourceId: string;
  platform: string;
  lastRunAt: string | null;
  lastOkAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  totalJobs: number;
}

/** 采集源健康度。放在岗位池面板里，不藏进设置页 —— 这是运营数据不是配置。 */
export function sourceHealth(db: Db, sources: JobSource[]): SourceHealth[] {
  return sources.map((s) => {
    const runs = db
      .prepare('SELECT * FROM collector_runs WHERE source_id = ? ORDER BY id DESC LIMIT 50')
      .all(s.id) as any[];
    let consecutiveFailures = 0;
    for (const r of runs) {
      if (r.ok) break;
      consecutiveFailures += 1;
    }
    const lastOk = runs.find((r) => r.ok);
    const totals = db
      .prepare(
        `SELECT COUNT(DISTINCT p.job_id) n FROM postings p
         WHERE p.collected_by LIKE ? OR p.platform = ?`,
      )
      .get(`${s.platform}@%`, s.platform) as { n: number };
    return {
      sourceId: s.id,
      platform: s.platform,
      lastRunAt: runs[0]?.finished_at ?? null,
      lastOkAt: lastOk?.finished_at ?? null,
      consecutiveFailures,
      lastError: runs[0]?.ok ? null : (runs[0]?.error ?? null),
      totalJobs: totals.n,
    };
  });
}
