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
};

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
