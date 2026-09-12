import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 数据根目录。默认是仓库下的 data/，可用 ASSIT_DATA_DIR 覆盖（测试用临时目录）。
 * data/ 整个 gitignore；data/facts/ 自己是一个独立的私有 git 仓库。
 */
export function dataDir(): string {
  const env = process.env.ASSIT_DATA_DIR;
  if (env) return path.resolve(env.replace(/^~/, homedir()));
  return path.resolve(process.cwd(), 'data');
}

/**
 * 雇主注册表目录（`vendor/employer-registry/`）。
 *
 * 它和 data/ 不同：**注册表进 git、随代码分发**，是共享事实而不是你的私人数据。
 * 所以不能挂在 ASSIT_DATA_DIR 下面。从 cwd 往上找，Electron 里由主进程显式设环境变量。
 */
export function registryDir(): string {
  const env = process.env.ASSIT_REGISTRY_DIR;
  if (env) return path.resolve(env.replace(/^~/, homedir()));
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    const c = path.join(d, 'vendor', 'employer-registry');
    if (fs.existsSync(c)) return c;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(process.cwd(), 'vendor', 'employer-registry');
}

export const paths = {
  get data() { return dataDir(); },
  get db() { return path.join(dataDir(), 'assit.sqlite'); },
  get artifacts() { return path.join(dataDir(), 'artifacts'); },
  get facts() { return path.join(dataDir(), 'facts'); },
  get profile() { return path.join(dataDir(), 'facts', 'profile.yaml'); },
  get claimsDir() { return path.join(dataDir(), 'facts', 'claims'); },
  get reposFile() { return path.join(dataDir(), 'facts', 'repos.yaml'); },
  get rubricDir() { return path.join(dataDir(), 'facts', 'rubric'); },
  get out() { return path.join(dataDir(), 'out'); },
  get registry() { return registryDir(); },
};

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 本地时区的 YYYY-MM-DD。
 *
 * **不要用 `toISOString().slice(0,10)`** —— 那是 UTC 日期。
 * 在 UTC+8，凌晨到早上 8 点之间它会给出「昨天」，
 * 于是 `verified_at` 显示成前一天，而这个字段的全部意义就是回答
 * 「这条还新不新」。一个会偶尔差一天的日期字段，比没有更糟。
 */
export function todayLocal(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
