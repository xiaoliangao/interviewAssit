import { ipcMain, shell } from 'electron';
import {
  appendChunk,
  applicationSnapshot,
  claimDrillStats,
  currentProfileVersion,
  drillBoard,
  dueToday,
  facets,
  funnel,
  gradeQuestion,
  ignoreJob,
  jobDetail,
  loadRubric,
  listRecordings,
  liveRecordings,
  loadFactsOrThrow,
  loadSources,
  openDb,
  pipeline,
  readProfileDraft,
  readRubricDraft,
  preflight,
  paths,
  pruneRecordings,
  queryJobs,
  recordApplication,
  recoverStale,
  runSource,
  saveProfileDraft,
  saveRubricDraft,
  scoreAllJobs,
  setRecordingJob,
  setRecordingKeep,
  sourceHealth,
  syncFacts,
  startRecording,
  stopRecording,
  todaySummary,
  deleteRecordingAudio,
  unignoreJob,
  validateFacts,
  type Db,
  type JobFilter,
} from '@assit/core';

/**
 * 主进程直接 import core，没有 sidecar、没有本地 HTTP 服务。
 *
 * core 不知道自己跑在哪：它不 import Electron，也不起服务。
 * 这一层只做三件事 —— 开库、把调用转给 core、把异常转成结构化结果。
 * 任何领域逻辑写到这里都是错的，那会让 CLI 和 UI 的行为开始分叉。
 */

let db: Db | null = null;
function getDb(): Db {
  if (!db) db = openDb();
  return db;
}

interface Versions {
  profileVersion: string;
  rubricVersion: string;
}

function versions(): Versions {
  return { profileVersion: currentProfileVersion(), rubricVersion: loadRubric().version };
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * 每个 handler 都包一层。
 *
 * 不包的话，rubric 文件没配好这类再正常不过的情况会变成渲染进程里
 * 一个没人接的 rejected promise —— 界面卡在 loading，控制台里什么也没有。
 * 错误是要显示给人看的，不是要吞掉的。
 */
function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) } satisfies Result<T>;
    } catch (e) {
      return { ok: false, error: (e as Error).message } satisfies Result<T>;
    }
  });
}

export function registerIpc(): void {
  // 启动先收拾上次的残局：崩溃留下的半截录音入库，过期的音频删掉。
  // 放在这里而不是懒加载，是因为这两件事都不该等到用户点进某个面板才发生。
  try {
    const r = recoverStale(getDb());
    if (r.recovered.length || r.failed.length) {
      console.log(`[rec] 恢复 ${r.recovered.length} 份，判定失败 ${r.failed.length} 份`);
    }
    const p = pruneRecordings(getDb());
    if (p.purged.length) console.log(`[rec] 过期清理 ${p.purged.length} 份音频`);
  } catch (e) {
    console.error('[rec] 启动清理失败：', (e as Error).message);
  }

  handle('app:context', () => {
    const facts = validateFacts();
    let rubricFile: string | null = null;
    let rubricVersion: string | null = null;
    let rubricError: string | null = null;
    try {
      const r = loadRubric();
      rubricFile = r.file;
      rubricVersion = r.version;
    } catch (e) {
      rubricError = (e as Error).message;
    }
    return {
      dataDir: paths.data,
      dbPath: paths.db,
      rubricFile,
      rubricVersion,
      rubricError,
      profileVersion: currentProfileVersion(),
      factsOk: facts.ok,
      factsErrors: facts.findings.filter((f) => f.severity === 'error').length,
      claimCount: facts.facts?.claims.length ?? 0,
      sourceCount: (() => {
        try {
          return loadSources().length;
        } catch {
          return 0;
        }
      })(),
    };
  });

  handle('today:get', (threshold?: number) =>
    todaySummary(getDb(), versions(), { threshold: threshold ?? 70 }),
  );

  handle('jobs:query', (filter: JobFilter) => queryJobs(getDb(), versions(), filter ?? {}));
  handle('jobs:detail', (jobId: string) => jobDetail(getDb(), versions(), jobId));
  handle('jobs:facets', () => facets(getDb()));

  handle('jobs:ignore', (jobId: string, reason: string, score: number | null) => {
    ignoreJob(getDb(), jobId, reason, score);
    return true;
  });
  handle('jobs:unignore', (jobId: string) => {
    unignoreJob(getDb(), jobId);
    return true;
  });

  handle('sources:health', () => sourceHealth(getDb(), loadSources()));

  handle('sources:collect', async (sourceId?: string) => {
    const all = loadSources().filter((s) => s.enabled && (!sourceId || s.id === sourceId));
    if (all.length === 0) throw new Error('没有启用的采集源。先在 data/facts/sources.yaml 里配置。');
    let extraTech: string[] = [];
    try {
      extraTech = loadRubric().rubric.profile.stack;
    } catch {
      /* 没配 rubric 也能采集，只是不扩展技术词表 */
    }
    const results = [];
    for (const s of all) {
      // 单源失败不中断其他源 —— 采集器坏掉是常态不是意外
      results.push(await runSource(getDb(), s, { limit: 200, extraTech }));
    }
    return results;
  });

  handle('score:run', (force?: boolean) => {
    const loaded = loadRubric();
    const scored = scoreAllJobs(getDb(), loaded, {
      profileVersion: currentProfileVersion(),
      force: Boolean(force),
    });
    return { count: scored.length, rubricVersion: loaded.version };
  });

  // ── 面试录音（DESIGN §8.5）─────────────────────────────────────────────
  //
  // 采集在渲染进程（getDisplayMedia / getUserMedia 是 Web API），
  // 落盘在主进程。PCM 分片经 IPC 过来，**不经过任何模型、不出本机**。

  handle('rec:start', (input: { label: string; jobId?: string | null; sources?: string }) =>
    // 同意时间戳在主进程盖章，不接受渲染层传进来的值 ——
    // 它是一条将来可能要拿出来说事的记录，不能由被它约束的那一方自己填。
    startRecording(getDb(), { ...input, consentConfirmedAt: new Date().toISOString() }),
  );

  // chunk 走 ipcMain.on 而不是 handle：一场面试每 100ms 一帧，
  // 逐帧等一个 ack 毫无意义，而且会把渲染层的音频回调拖慢。
  ipcMain.on('rec:chunk', (_e, id: string, chunk: ArrayBuffer) => {
    try {
      appendChunk(id, Buffer.from(chunk));
    } catch {
      // 会话已停止时残留的几帧会走到这里。录音已经收尾了，丢掉是对的。
    }
  });

  handle('rec:stop', (id: string) => stopRecording(getDb(), id));
  handle('rec:live', () => liveRecordings());
  handle('rec:list', () => listRecordings(getDb()));
  handle('rec:keep', (id: string, keep: boolean) => {
    setRecordingKeep(getDb(), id, keep);
    return true;
  });
  handle('rec:link-job', (id: string, jobId: string | null) => {
    setRecordingJob(getDb(), id, jobId);
    return true;
  });
  handle('rec:delete-audio', (id: string) => deleteRecordingAudio(getDb(), id));

  // ── 投递管线（DESIGN §7.1）────────────────────────────────────────────
  handle('apply:preflight', (postingId: string) => preflight(getDb(), { jobId: '', postingId }));
  handle('apply:pipeline', () => pipeline(getDb()));
  handle('apply:funnel', (dim: 'score' | 'channel' | 'role') => funnel(getDb(), dim));
  handle('apply:snapshot', (id: string) => {
    const s = applicationSnapshot(getDb(), id);
    // 简历是二进制，不往渲染层送 —— 那一屏要的是「当时写了什么」，不是 PDF 字节
    return { hasResume: s.resume !== null, resumeBytes: s.resume?.length ?? 0,
      jd: s.jd, greeting: s.greeting, forms: s.forms };
  });
  handle('apply:record', (input: {
    postingId: string; channel: string; resumePath: string;
    greeting?: string; overrideCooldown?: boolean;
  }) => {
    const fs2 = require('node:fs') as typeof import('node:fs');
    return recordApplication(getDb(), {
      postingId: input.postingId,
      channel: input.channel,
      resumePdf: fs2.readFileSync(input.resumePath),
      greeting: input.greeting,
      overrideCooldown: input.overrideCooldown,
      // 到这一步的唯一路径是用户在确认对话框里点过了 —— 见 Apply.tsx
      confirmedByUser: true,
    });
  });

  // ── 题库与复习（DESIGN §9）────────────────────────────────────────────
  handle('drill:due', (limit?: number) => dueToday(getDb(), limit ?? 20));
  handle('drill:board', () => drillBoard(getDb()));
  handle('drill:grade', (id: string, grade: number) =>
    gradeQuestion(getDb(), id, grade as 0 | 1 | 2 | 3 | 4 | 5),
  );
  handle('drill:claims', () => claimDrillStats(getDb()));

  // ── 事实库（DESIGN §5）───────────────────────────────────────────────
  //
  // 写的是 data/facts/*.yaml，**不是 SQLite**。文件是真源 ——
  // 一旦分叉你就有两份档案，而且永远说不清哪份是对的。
  handle('facts:read', () => {
    const validation = validateFacts();
    const rubric = readRubricDraft();
    let claims: { id: string; fact: string; level: string; status: string }[] = [];
    try {
      claims = loadFactsOrThrow().claims.map((c) => ({
        id: c.id, fact: c.source_fact,
        level: c.responsibility_level, status: c.verification_status,
      }));
    } catch {
      // 档案没填完时 loadFactsOrThrow 会拒绝 —— 那正是这一屏要解决的问题，
      // 不该因此整页打不开
    }
    return {
      profile: readProfileDraft(),
      profileFile: paths.profile,
      rubric: rubric.profile,
      rubricFile: rubric.file,
      claims,
      findings: validation.findings,
    };
  });
  handle('facts:save-profile', (draft: any) => saveProfileDraft(draft));
  handle('facts:save-rubric', (draft: any) => saveRubricDraft(draft));
  // 同步是「文件 → SQLite」。档案不合法时 loadFactsOrThrow 会拒绝，
  // 错误信息直接回到界面上 —— 那正是你要修的东西。
  handle('facts:sync', () => syncFacts(getDb(), loadFactsOrThrow()));

  handle('shell:open', async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http(s) 链接');
    await shell.openExternal(url);
    return true;
  });

  handle('shell:reveal', (p: string) => {
    shell.showItemInFolder(p);
    return true;
  });
}

export function closeDb(): void {
  db?.close();
  db = null;
}
