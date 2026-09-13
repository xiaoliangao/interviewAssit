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
  jobsGrouped: (filter: JobFilter) => invoke<ChannelGroup[]>('jobs:grouped', filter),
  ignore: (jobId: string, reason: string, score: number | null) =>
    invoke<boolean>('jobs:ignore', jobId, reason, score),
  unignore: (jobId: string) => invoke<boolean>('jobs:unignore', jobId),
  sources: () => invoke<SourceHealth[]>('sources:health'),
  collect: (sourceId?: string) => invoke<SourceRunResult[]>('sources:collect', sourceId),
  score: (force?: boolean) => invoke<{ count: number; rubricVersion: string }>('score:run', force),
  // 面试录音。chunk 用 send 不用 invoke —— 每 100ms 一帧，不需要往返确认
  recStart: (input: { label: string; jobId?: string | null; sources?: string }) =>
    invoke<RecordingHandle>('rec:start', input),
  recChunk: (id: string, pcm: ArrayBuffer) => ipcRenderer.send('rec:chunk', id, pcm),
  recStop: (id: string) => invoke<StoppedRecording>('rec:stop', id),
  recLive: () => invoke<RecordingHandle[]>('rec:live'),
  recList: () => invoke<RecordingRow[]>('rec:list'),
  recKeep: (id: string, keep: boolean) => invoke<boolean>('rec:keep', id, keep),
  recLinkJob: (id: string, jobId: string | null) => invoke<boolean>('rec:link-job', id, jobId),
  recDeleteAudio: (id: string) => invoke<boolean>('rec:delete-audio', id),

  // 投递管线
  applyPreflight: (postingId: string) => invoke<Preflight>('apply:preflight', postingId),
  applyPipeline: () => invoke<PipelineRow[]>('apply:pipeline'),
  applyFunnel: (dim: 'score' | 'channel' | 'role') => invoke<FunnelBucket[]>('apply:funnel', dim),
  applySnapshot: (id: string) => invoke<AppSnapshot>('apply:snapshot', id),
  applyRecord: (input: { postingId: string; channel: string; resumePath: string; greeting?: string; overrideCooldown?: boolean }) =>
    invoke<{ id: string; snapshots: { kind: string; sha256: string }[] }>('apply:record', input),

  // 题库与复习
  drillDue: (limit?: number) => invoke<DueQuestion[]>('drill:due', limit),
  drillBoard: () => invoke<DrillBoard>('drill:board'),
  drillGrade: (id: string, grade: number) =>
    invoke<{ dueInDays: number; nextReviewAt: string }>('drill:grade', id, grade),
  drillClaims: () => invoke<ClaimDrillStat[]>('drill:claims'),

  // 事实库
  factsRead: () => invoke<FactsView>('facts:read'),
  factsSaveProfile: (d: ProfileDraft) => invoke<SaveResult>('facts:save-profile', d),
  factsSaveRubric: (d: RubricDraft) => invoke<SaveResult>('facts:save-rubric', d),
  factsSync: () => invoke<SyncReport>('facts:sync'),
  factsFieldStatus: (key: string, status: 'pending' | 'filled' | 'ignored') =>
    invoke<boolean>('facts:field-status', key, status),
  settings: () => invoke<SettingsView>('settings:read'),

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

export interface RecordingHandle {
  id: string;
  file: string;
  startedAt: string;
  format: { sampleRate: number; channels: number; bitsPerSample: number };
}

export interface StoppedRecording {
  id: string;
  sha256: string;
  file: string;
  bytes: number;
  durationSec: number;
  deduped: boolean;
}

export interface RecordingRow {
  id: string;
  jobId: string | null;
  label: string;
  status: string;
  sources: string;
  consentConfirmedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  durationSec: number;
  bytes: number;
  sha256: string | null;
  file: string | null;
  purgeAfter: string | null;
  keep: boolean;
  hasTranscript: boolean;
  note: string | null;
  error: string | null;
  fileExists: boolean;
}

export interface Preflight {
  jobId: string;
  postingId: string;
  company: string;
  companyId: string;
  title: string;
  roleFamily: string;
  applicationKey: string;
  alreadyApplied: { id: string; sentAt: string } | null;
  cooldown: { blocked: boolean; reason: string; daysAgo?: number };
  scoreId: string | null;
  finalScore: number | null;
  jdSha256: string | null;
}

export interface PipelineRow {
  id: string;
  company: string;
  title: string;
  channel: string;
  sentAt: string;
  status: string;
  finalScore: number | null;
  daysSince: number;
  lastEvent: { type: string; at: string; confirmed: boolean } | null;
  unconfirmedEvents: number;
}

export interface FunnelBucket {
  key: string;
  label: string;
  sent: number;
  replied: number;
  interviewed: number;
  offered: number;
  replyRate: number | null;
}

export interface AppSnapshot {
  hasResume: boolean;
  resumeBytes: number;
  jd: string | null;
  greeting: string | null;
  forms: { domain: string; url: string | null; data: unknown }[];
}

export interface DueQuestion {
  id: string;
  content: string;
  topic: string | null;
  sourceType: string;
  sourceRef: string;
  credibility: 'verified' | 'secondhand' | 'unverified';
  claimId: string | null;
  answerStandard: string | null;
  answerMine: string | null;
  origin: string | null;
  repetitions: number;
  nextReviewAt: string;
}

export interface DrillBoard {
  total: number;
  dueNow: number;
  byTopic: { topic: string; total: number; due: number }[];
  byCredibility: Record<string, number>;
  weakest: { id: string; content: string; origin: string | null; lastGrade: number | null }[];
  todayGraded: number;
}

export interface ClaimDrillStat {
  claimId: string;
  fact: string;
  level: string;
  status: string;
  asked: number;
  solid: number;
  failed: number;
  lastAsked: string | null;
}

export interface ProfileDraft {
  fields: Record<string, string>;
  records: {
    education: Record<string, any>[];
    employment: Record<string, any>[];
    certificate: Record<string, any>[];
    language: Record<string, any>[];
    award: Record<string, any>[];
  };
  preferences: Record<string, any>;
}

export interface RubricDraft {
  degree?: string;
  exp_years?: number;
  cities?: string[];
  accept_remote?: boolean;
  salary_floor_yuan?: number;
  salary_target_yuan?: number;
  stack?: string[];
  target_roles?: string[];
  acceptable_schedules?: string[];
}

export interface SaveResult {
  file: string;
  issues: { path: string; message: string }[];
}

export interface Finding {
  severity: 'error' | 'warn' | 'info';
  file: string;
  where?: string;
  message: string;
  hint?: string;
}

export interface SyncReport {
  profileFields: number;
  profileRecords: number;
  claimsInserted: number;
  claimsUpdated: number;
  claimsUnchanged: number;
  events: number;
  repos: number;
}

export interface FactsView {
  profile: ProfileDraft;
  profileFile: string;
  fieldRequests: FieldRequest[];
  rubric: RubricDraft;
  rubricFile: string | null;
  claims: { id: string; fact: string; level: string; status: string }[];
  findings: Finding[];
}

export interface CompanyGroup {
  companyId: string;
  company: string;
  count: number;
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

export interface FieldRequest {
  key: string;
  label: string;
  fieldClass: string;
  firstDomain: string | null;
  lastDomain: string | null;
  seenCount: number;
  example: string | null;
  status: 'pending' | 'filled' | 'ignored';
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SettingsView {
  providers: {
    id: string;
    kind: string;
    model: string;
    maxVisibility: 'public' | 'private' | 'nda';
    credentialRef: string | null;
    available: boolean;
    detail: string;
  }[];
  routes: { task: string; provider: string; fallback: string[] }[];
  dataDir: string;
  dbPath: string;
  registryDir: string;
  dataPointer: string | null;
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
