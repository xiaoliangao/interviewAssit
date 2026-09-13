import { dialog, ipcMain, shell } from 'electron';
import {
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  appendChunk,
  applicationSnapshot,
  claimDrillStats,
  currentProfileVersion,
  drillBoard,
  dueToday,
  buildProvider,
  facets,
  funnel,
  groupedJobs,
  gradeQuestion,
  ignoreJob,
  jobDetail,
  loadRubric,
  listRecordings,
  liveRecordings,
  loadFactsOrThrow,
  loadSources,
  openDb,
  listFieldRequests,
  pipeline,
  readProfileDraft,
  readRubricDraft,
  preflight,
  paths,
  pastedPosting,
  pruneRecordings,
  queryJobs,
  recordApplication,
  recoverStale,
  runSource,
  reconcileFieldRequests,
  saveProfileDraft,
  saveRubricDraft,
  scaffold,
  scoreAllJobs,
  setFieldRequestStatus,
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
  handle('jobs:grouped', (filter: JobFilter) => groupedJobs(getDb(), versions(), filter ?? {}));

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
      fieldRequests: listFieldRequests(getDb()),
      rubric: rubric.profile,
      rubricFile: rubric.file,
      claims,
      findings: validation.findings,
    };
  });
  handle('facts:save-profile', (draft: any) => {
    const r = saveProfileDraft(draft);
    // 存完对一次账：填上的标成已填，被清空的变回待填。
    // 「待填写」的真源是档案文件里有没有值，不是那张提醒表。
    reconcileFieldRequests(getDb(), draft.fields ?? {});
    return r;
  });
  handle('facts:field-status', (key: string, status: 'pending' | 'filled' | 'ignored') => {
    setFieldRequestStatus(getDb(), key, status);
    return true;
  });
  handle('facts:save-rubric', (draft: any) => saveRubricDraft(draft));
  // 同步是「文件 → SQLite」。档案不合法时 loadFactsOrThrow 会拒绝，
  // 错误信息直接回到界面上 —— 那正是你要修的东西。
  handle('facts:sync', () => syncFacts(getDb(), loadFactsOrThrow()));

  // ── 设置（DESIGN §10）─────────────────────────────────────────────────
  // 打包后的应用没有命令行，所以「缺了就补一份」必须能在界面里发生。
  // 只补缺的，绝不覆盖已有文件。
  handle('facts:ensure', (which: string[]) => {
    const r = scaffold(false, which);
    return { created: r.created.length, backedUp: r.backedUp.length };
  });

  // 通道 0：粘贴入库。零风险、覆盖一切平台，而且是桌面端唯一
  // 不依赖采集器就能往池子里加岗位的路径。
  handle('jobs:paste', (input: {
    jdText: string; url?: string; company?: string; title?: string; city?: string; salaryRaw?: string;
  }) => {
    if (!input.jdText?.trim()) throw new Error('JD 正文不能为空');
    let extraTech: string[] = [];
    try {
      extraTech = loadRubric().rubric.profile.stack;
    } catch {
      /* 没配 rubric 也能入库，只是不扩展技术词表 */
    }
    const r = ingestPosting(getDb(), pastedPosting(input), { extraTech });
    return { outcome: r.outcome, jobId: r.jobId, postingId: r.postingId };
  });

  // 原生文件选择框。渲染进程拿不到真实路径（浏览器的 File 只给文件名），
  // 而记录一次投递需要读那个 PDF 的字节。
  handle('dialog:pick-file', async (opts: { title?: string; extensions?: string[] }) => {
    const r = await dialog.showOpenDialog({
      title: opts?.title ?? '选择文件',
      properties: ['openFile'],
      filters: opts?.extensions ? [{ name: '文件', extensions: opts.extensions }] : undefined,
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle('drill:add', (input: {
    content: string; topic?: string; sourceType: string; sourceRef: string;
    answerStandard?: string; answerMine?: string;
  }) => addQuestion(getDb(), { ...input, sourceType: input.sourceType as never }));

  handle('settings:read', async () => {
    const providers = [];
    for (const spec of DEFAULT_PROVIDERS) {
      let available = false;
      let detail = '';
      try {
        available = await buildProvider(spec).isAvailable();
      } catch (e) {
        detail = (e as Error).message.slice(0, 160);
      }
      providers.push({
        id: spec.id,
        kind: spec.kind,
        model: spec.model,
        maxVisibility: spec.max_visibility,
        credentialRef: (spec as { credential_ref?: string }).credential_ref ?? null,
        available,
        detail,
      });
    }
    return {
      providers,
      routes: Object.entries(DEFAULT_ROUTES).map(([task, r]) => ({
        task, provider: r.provider, fallback: r.fallback,
      })),
      // 只回 dbPath，而且只给「在访达中显示」用。
      // 打包后的应用不该把文件系统路径印在界面上 —— 那是开发者视角。
      dbPath: paths.db,
    };
  });

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
