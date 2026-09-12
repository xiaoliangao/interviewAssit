import { ipcMain, shell } from 'electron';
import {
  currentProfileVersion,
  facets,
  ignoreJob,
  jobDetail,
  loadRubric,
  loadSources,
  openDb,
  paths,
  queryJobs,
  runSource,
  scoreAllJobs,
  sourceHealth,
  todaySummary,
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
