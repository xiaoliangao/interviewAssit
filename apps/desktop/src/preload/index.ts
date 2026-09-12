import { contextBridge, ipcRenderer } from 'electron';

/**
 * 白名单式暴露。渲染进程拿不到 ipcRenderer 本身，只能调下面这几个方法。
 *
 * 这不是形式主义：岗位池里显示的 JD 是第三方写的文本，
 * 而其中一部分是针对 AI 的注入尝试（打分层已经见过）。
 * 把 Node 能力开给渲染进程没有任何收益。
 */
const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const res = (await ipcRenderer.invoke(channel, ...args)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

const api = {
  context: () => invoke<AppContext>('app:context'),
  today: (threshold?: number) => invoke<TodaySummary>('today:get', threshold),
  jobs: (filter: JobFilter) => invoke<JobRow[]>('jobs:query', filter),
  jobDetail: (jobId: string) => invoke<JobDetail | null>('jobs:detail', jobId),
  facets: () => invoke<Facets>('jobs:facets'),
  ignore: (jobId: string, reason: string, score: number | null) =>
    invoke<boolean>('jobs:ignore', jobId, reason, score),
  unignore: (jobId: string) => invoke<boolean>('jobs:unignore', jobId),
  sources: () => invoke<SourceHealth[]>('sources:health'),
  collect: (sourceId?: string) => invoke<SourceRunResult[]>('sources:collect', sourceId),
  score: (force?: boolean) => invoke<{ count: number; rubricVersion: string }>('score:run', force),
  openExternal: (url: string) => invoke<boolean>('shell:open', url),
  reveal: (p: string) => invoke<boolean>('shell:reveal', p),
};

contextBridge.exposeInMainWorld('assit', api);

export type AssitApi = typeof api;

// ── 渲染进程要用的类型。刻意在这里重声明而不是 import @assit/core：
//    preload 打包进的是渲染侧，不该把领域包整个拖进来。
export interface AppContext {
  dataDir: string;
  dbPath: string;
  rubricFile: string | null;
  rubricVersion: string | null;
  rubricError: string | null;
  profileVersion: string;
  factsOk: boolean;
  factsErrors: number;
  claimCount: number;
  sourceCount: number;
}

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

export interface Component {
  score: number;
  max_score: number;
  evidence: string;
  jd_quote: string | null;
  suspicious?: boolean;
}

export interface ScoreTrace {
  rubric_version: string;
  profile_version: string;
  components: Record<string, Component>;
  unknown_dims: string[];
  gates: { key: string; status: 'pass' | 'fail' | 'unknown'; detail: string; jd_quote: string | null }[];
  hard_gaps: string[];
  caps: string[];
  capped_by: string | null;
  raw_score: number;
  final_score: number;
  coverage: number;
  injection_flags: string[];
}

export interface JobDetail extends JobRow {
  trace: ScoreTrace | null;
  attrs: Record<string, { value: unknown; confidence: string; source: string | null } | unknown>;
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

export interface JobFilter {
  minScore?: number;
  minCoverage?: number;
  roleFamilies?: string[];
  platforms?: string[];
  search?: string;
  includeIgnored?: boolean;
  hideHardGaps?: boolean;
  limit?: number;
  offset?: number;
}

export interface Facets {
  roleFamilies: string[];
  platforms: string[];
  cities: string[];
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

export interface TodaySummary {
  newToday: number;
  newHighScore: number;
  highScoreThreshold: number;
  unscored: number;
  brokenSources: { sourceId: string; consecutiveFailures: number; lastError: string | null }[];
  pendingAliases: number;
  topNew: JobRow[];
}
