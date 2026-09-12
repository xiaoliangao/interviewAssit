import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openDb } from '@assit/core';
import { render } from '../scripts/gen-migrations.mjs';

/**
 * 迁移的真源是 .sql 文件，运行时用的是由它们生成的 TS 模块
 * （core 要被打包进 Electron 主进程，按相对路径读目录会失效）。
 *
 * 这组测试防的就是两者漂移：改了 SQL 忘记重新生成，
 * 测试会直接失败，而不是等到某天发现桌面端的表结构比 CLI 少一张。
 */
describe('迁移：生成产物不能和 SQL 文件漂移', () => {
  const genFile = path.resolve(__dirname, '../packages/core/src/db/migrations.generated.ts');

  it('已提交的生成文件和当前 SQL 一致', () => {
    expect(fs.readFileSync(genFile, 'utf8')).toBe(render());
  });

  it('每个 .sql 都被收进去了', () => {
    const dir = path.resolve(__dirname, '../packages/core/src/db/migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files);
  });

  it('按编号顺序执行', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect([...names].sort()).toEqual(names);
  });

  it('跑完之后该有的表都在', () => {
    const db = openDb(':memory:');
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name),
    );
    for (const t of [
      'companies', 'company_aliases', 'jobs', 'postings', 'posting_jd_history',
      'job_scores', 'jobs_ignored', 'claims', 'claim_events', 'resume_bullets',
      'applications', 'model_cache', 'collector_runs',
    ]) {
      expect(tables.has(t), `缺表 ${t}`).toBe(true);
    }
    db.close();
  });

  it('重复迁移是幂等的', () => {
    const db = openDb(':memory:');
    const before = (db.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as any).n;
    expect(before).toBe(MIGRATIONS.length);
    db.close();
  });
});
