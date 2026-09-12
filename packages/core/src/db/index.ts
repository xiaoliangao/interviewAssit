import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, paths } from '../util/paths.js';

export type Db = Database.Database;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(file?: string): Db {
  const target = file ?? paths.db;
  if (target !== ':memory:') ensureDir(path.dirname(target));
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  // SQLite 默认不开外键。不开的话所有 REFERENCES 都只是注释。
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** 编号 SQL 文件迁移。本地单用户场景下，可读的 SQL 比 ORM 魔法好排查。 */
export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r: any) => r.name as string),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
    })();
  }
}
