import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, paths } from '../util/paths.js';
import { MIGRATIONS } from './migrations.generated.js';

export type Db = Database.Database;

/**
 * better-sqlite3 的原生模块是按 ABI 编译的，Node 和 Electron 的 ABI 不同。
 * 同一个 .node 文件不可能同时服务两边 —— 给 Electron 重编译一次，
 * CLI 和测试当场全挂（实测过）。
 *
 * 所以：仓库里保留 Node ABI 那份，Electron ABI 单独放在 apps/desktop/native/，
 * 由桌面主进程通过这个环境变量指过去。core 本身不需要知道自己跑在哪。
 */
function nativeBinding(): string | undefined {
  const p = process.env.ASSIT_SQLITE_NATIVE_BINDING;
  return p && fs.existsSync(p) ? p : undefined;
}

export function openDb(file?: string): Db {
  const target = file ?? paths.db;
  if (target !== ':memory:') ensureDir(path.dirname(target));
  const binding = nativeBinding();
  const db = binding ? new Database(target, { nativeBinding: binding }) : new Database(target);
  db.pragma('journal_mode = WAL');
  // SQLite 默认不开外键。不开的话所有 REFERENCES 都只是注释。
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * 编号 SQL 文件迁移。本地单用户场景下，可读的 SQL 比 ORM 魔法好排查。
 *
 * SQL 的真源是 db/migrations/*.sql；运行时用的是由它们生成的
 * migrations.generated.ts —— core 会被打包进 Electron 主进程，
 * 打包之后按相对路径读目录会失效（实测：ENOENT scandir out/main/chunks/migrations）。
 */
export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r: any) => r.name as string),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(m.name);
    })();
  }
}

export * from './migrations.generated.js';
