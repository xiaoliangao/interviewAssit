import { execFileSync } from 'node:child_process';

/**
 * 归因层：从 git log 算出「哪些文件是你动的、动了多少」。
 *
 * 这一层也不调模型。`git log --numstat` 就是答案本身。
 *
 * 一个贯穿全项目的约束在这里第一次落地：**行数不等于贡献。**
 * `loc` 和 `share` 只用来给候选排序，绝不用来自动判定 responsibility_level。
 * 一个 20 行的并发 bug 修复可能比 2000 行模板代码重要得多，而 git 看不出这个差别。
 */

export interface CommitTouch {
  sha: string;
  authorEmail: string;
  authorName: string;
  date: string;
  subject: string;
  files: { path: string; added: number; deleted: number }[];
}

export interface BlameOptions {
  /** 你的 author 身份（邮箱或姓名片段），大小写不敏感，子串匹配 */
  authors: string[];
  since?: string;
  /** 安全阀：超过这个数就只取最近的 N 个提交 */
  maxCommits?: number;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function isGitRepo(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export function headSha(dir: string): string | null {
  try {
    return git(dir, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

/** 仓库里出现过的 author，用来提示你该往 repos.yaml 的 authors 里填什么。 */
export function listAuthors(dir: string, since?: string): { identity: string; commits: number }[] {
  const args = ['log', '--pretty=format:%ae\t%an'];
  if (since) args.push(`--since=${since}`);
  const counts = new Map<string, number>();
  for (const line of git(dir, args).split('\n')) {
    if (!line.trim()) continue;
    const [email, name] = line.split('\t');
    const key = `${name ?? ''} <${email ?? ''}>`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([identity, commits]) => ({ identity, commits }))
    .sort((a, b) => b.commits - a.commits);
}

const RECORD = '\x1e';
const FIELD = '\x1f';

/**
 * 重命名后的路径解析。`--numstat -M` 会输出两种形态：
 *   old/a.go => new/b.go
 *   src/{old => new}/a.go
 * 两种都只取「现在的」路径 —— 否则一次目录改名会让你的历史贡献全部对不上模块。
 */
export function resolveRenamedPath(raw: string): string {
  const brace = raw.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
  if (brace) {
    const [, pre, , to, post] = brace;
    return `${pre ?? ''}${to ?? ''}${post ?? ''}`.replace(/\/{2,}/g, '/');
  }
  const arrow = raw.split(' => ');
  return (arrow.length === 2 ? arrow[1]! : raw).trim();
}

export function readCommits(dir: string, opts: BlameOptions): CommitTouch[] {
  const args = [
    'log',
    '--numstat',
    '-M',
    '--no-merges',
    `--pretty=format:${RECORD}%H${FIELD}%ae${FIELD}%an${FIELD}%aI${FIELD}%s`,
  ];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.maxCommits) args.push(`--max-count=${opts.maxCommits}`);

  let raw: string;
  try {
    raw = git(dir, args);
  } catch (e) {
    throw new Error(`读取 git 历史失败（${dir}）：${(e as Error).message.slice(0, 200)}`);
  }

  const commits: CommitTouch[] = [];
  for (const chunk of raw.split(RECORD)) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const header = nl === -1 ? chunk : chunk.slice(0, nl);
    const body = nl === -1 ? '' : chunk.slice(nl + 1);
    const [sha, authorEmail, authorName, date, subject] = header.split(FIELD);
    if (!sha) continue;
    const files: CommitTouch['files'] = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [a, d, p] = parts;
      // 二进制文件是 "-"，计 0 行但仍算一次触碰
      files.push({
        path: resolveRenamedPath(p ?? ''),
        added: a === '-' ? 0 : Number(a) || 0,
        deleted: d === '-' ? 0 : Number(d) || 0,
      });
    }
    commits.push({
      sha,
      authorEmail: authorEmail ?? '',
      authorName: authorName ?? '',
      date: date ?? '',
      subject: subject ?? '',
      files,
    });
  }
  return commits;
}

export function isMine(c: CommitTouch, authors: string[]): boolean {
  if (authors.length === 0) return false;
  const hay = `${c.authorEmail} ${c.authorName}`.toLowerCase();
  return authors.some((a) => a.trim() !== '' && hay.includes(a.trim().toLowerCase()));
}

export interface FileAttribution {
  path: string;
  myAdded: number;
  myDeleted: number;
  myCommits: number;
  totalAdded: number;
  totalDeleted: number;
  totalCommits: number;
}

export interface Attribution {
  byFile: Map<string, FileAttribution>;
  myCommits: CommitTouch[];
  totalCommits: number;
  matchedAuthors: string[];
  /** 仓库里最活跃的几个身份，authors 填错时用来提示 */
  topAuthors: { identity: string; commits: number }[];
}

export function attribute(commits: CommitTouch[], authors: string[]): Attribution {
  const byFile = new Map<string, FileAttribution>();
  const mine: CommitTouch[] = [];
  const matched = new Set<string>();
  const authorCounts = new Map<string, number>();

  for (const c of commits) {
    const key = `${c.authorName} <${c.authorEmail}>`;
    authorCounts.set(key, (authorCounts.get(key) ?? 0) + 1);
    const ours = isMine(c, authors);
    if (ours) {
      mine.push(c);
      matched.add(key);
    }
    for (const f of c.files) {
      const cur =
        byFile.get(f.path) ??
        {
          path: f.path,
          myAdded: 0, myDeleted: 0, myCommits: 0,
          totalAdded: 0, totalDeleted: 0, totalCommits: 0,
        };
      cur.totalAdded += f.added;
      cur.totalDeleted += f.deleted;
      cur.totalCommits += 1;
      if (ours) {
        cur.myAdded += f.added;
        cur.myDeleted += f.deleted;
        cur.myCommits += 1;
      }
      byFile.set(f.path, cur);
    }
  }

  return {
    byFile,
    myCommits: mine,
    totalCommits: commits.length,
    matchedAuthors: [...matched],
    topAuthors: [...authorCounts.entries()]
      .map(([identity, c]) => ({ identity, commits: c }))
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 8),
  };
}
