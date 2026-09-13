import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 数据根目录。优先级：`ASSIT_DATA_DIR` → 仓库下的 `data/` → `~/.assit-interview/data`。
 *
 * 三层的理由是 **CLI 和桌面端必须看到同一个库**。不然你会
 * `assit collect` 采了 200 个岗位，打开应用发现一个都没有 —— 而这种不一致
 * 极难自己想明白（两边都「正常工作」，只是各看各的）。
 *
 * data/ 整个 gitignore；data/facts/ 自己是一个独立的私有 git 仓库。
 */
export function dataDir(): string {
  const env = process.env.ASSIT_DATA_DIR;
  if (env) return path.resolve(env.replace(/^~/, homedir()));

  // 仓库里已经有 data/ 就用它：从源码跑的时候，CLI 和桌面端必须看到同一个库 ——
  // 不然你会 `assit collect` 采了 200 个岗位，打开应用发现一个都没有。
  const local = path.resolve(process.cwd(), 'data');
  if (fs.existsSync(local)) return local;

  // 打包后的应用没有「仓库根」这个概念，cwd 是 `/`。
  // 指针文件让它能找到你真正的数据目录 —— 见 userConfigFile() 那段。
  const pointed = readDataPointer();
  if (pointed) return pointed;

  // 都没有就落到用户目录下一个固定位置。
  // 刻意不用 Electron 的 app.getPath('userData')：core 不认识 Electron，
  // 而且那个路径 CLI 猜不到 —— 两边必须能算出同一个答案。
  return path.join(homedir(), '.assit-interview', 'data');
}

/** `~/.assit-interview/config.json`。只放「数据在哪」，不放别的。 */
export function userConfigFile(): string {
  return path.join(homedir(), '.assit-interview', 'config.json');
}

/**
 * 打包后的应用怎么找到你的数据。
 *
 * 它的 cwd 是 `/`，推不出任何仓库路径。解决办法是一个指针文件，
 * 而不是把数据搬走 —— **搬动用户的数据目录不该是安装一个应用的副作用**。
 * 指针是可逆的：删掉文件就回到默认位置，数据一个字节都没动过。
 */
export function readDataPointer(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(userConfigFile(), 'utf8')) as { dataDir?: string };
    if (!raw.dataDir) return null;
    const p = path.resolve(raw.dataDir.replace(/^~/, homedir()));
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export function writeDataPointer(dir: string): string {
  const abs = path.resolve(dir.replace(/^~/, homedir()));
  if (!fs.existsSync(abs)) throw new Error(`目录不存在：${abs}`);
  const file = userConfigFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ dataDir: abs }, null, 2)}\n`, 'utf8');
  return file;
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
