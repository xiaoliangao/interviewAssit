import path from 'node:path';
import type { RepoEntry } from '@assit/contract';
import type { Db } from '../db/index.js';
import { newId } from '../util/hash.js';
import { attribute, headSha, isGitRepo, readCommits, type Attribution, type CommitTouch } from './blame.js';
import { analyzeStructure, type RepoModule, type StructureGraph } from './structure.js';

/**
 * 求交：结构层 × 归因层。
 *
 * 这一步是整个 M0b 的核心，也是最容易被跳过的一步。
 *
 * 只有结构图 —— 你会把整个项目吹成自己的，账本里的 boundary 直接就错了。
 * 只有 git 归因 —— 你看到一堆零散 commit，看不出它们的架构意义，
 *                  写出来的简历是「修复了若干 bug」这种废话。
 *
 * 求交出来的那块，正好就是账本里 boundary 字段该填的内容：
 * 「这个模块整体是团队做的，其中这几个文件、这些提交是我的」。
 * 这个交集本身就是「团队成果 vs 个人贡献」的计算结果，不是让你凭印象写。
 */

export interface ModuleAttribution {
  path: string;
  fileCount: number;
  testFileCount: number;
  languages: string[];
  /** 我在这个模块里的提交数 */
  myCommits: number;
  myAdded: number;
  myDeleted: number;
  /** 我改的行数 / 全部人改的行数。只用于排序，绝不用于判定责任等级。 */
  myShare: number;
  /** 我碰过的文件（按我改动量降序） */
  myFiles: { path: string; myAdded: number; myDeleted: number; myCommits: number }[];
  /** 我在这个模块里最有代表性的提交 */
  myTopCommits: { sha: string; date: string; subject: string; touched: number }[];
  touchedByMe: boolean;
  /** 这个模块一共有多少次提交、来自多少个不同的人 —— boundary 就是从这里算出来的 */
  totalCommits: number;
  otherAuthors: number;
  /** 这个模块依赖谁、谁依赖它 —— 解读层判断「它在系统里是什么位置」的依据 */
  dependsOn: string[];
  dependedBy: string[];
  firstTouch: string | null;
  lastTouch: string | null;
}

export interface RepoScan {
  repo: RepoEntry;
  graph: StructureGraph;
  attribution: Attribution;
  modules: ModuleAttribution[];
  headSha: string | null;
  /** 归因一无所获时的诊断信息 —— 十有八九是 authors 填错了 */
  diagnostics: string[];
}

export interface ScanOptions {
  /** 低于这个占比的模块不算「你碰过」，避免一次格式化提交把整个仓库算成你的 */
  minShare?: number;
  /** 也要求至少有这么多次提交 */
  minCommits?: number;
  maxCommits?: number;
  /** 增量：只看这个 commit 之后的（配合 repos.last_scanned_commit） */
  sinceCommit?: string;
}

function fileToModule(modules: RepoModule[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const mod of modules) for (const f of mod.files) m.set(f, mod.path);
  return m;
}

export function scanRepo(repo: RepoEntry, opts: ScanOptions = {}): RepoScan {
  const root = path.resolve(repo.local_path.replace(/^~/, process.env.HOME ?? '~'));
  const diagnostics: string[] = [];

  const graph = analyzeStructure(root, { exclude: repo.exclude });
  if (graph.files.length === 0) {
    diagnostics.push('没有扫到任何源码文件。确认 local_path 指向仓库根目录，且没有被 exclude 排掉。');
  }

  let commits: CommitTouch[] = [];
  if (!isGitRepo(root)) {
    diagnostics.push('这个目录不是 git 仓库，无法做归因 —— 只能得到结构，得不到「哪些是你写的」。');
  } else {
    commits = readCommits(root, {
      authors: repo.authors,
      since: repo.since,
      maxCommits: opts.maxCommits,
    });
  }

  const attribution = attribute(commits, repo.authors);

  if (repo.authors.length === 0) {
    diagnostics.push(
      'repos.yaml 里没填 authors，归因结果为空。跑 `assit authors <repo>` 看这个仓库里有哪些身份，把你用过的都填进去（人在不同时期用不同 git 邮箱是常态）。',
    );
  } else if (attribution.myCommits.length === 0 && commits.length > 0) {
    diagnostics.push(
      `authors=${JSON.stringify(repo.authors)} 没有匹配到任何提交。这个仓库里最活跃的身份是：` +
        attribution.topAuthors.slice(0, 4).map((a) => `${a.identity}(${a.commits})`).join('、'),
    );
  }

  const f2m = fileToModule(graph.modules);
  const minShare = opts.minShare ?? 0.15;
  const minCommits = opts.minCommits ?? 2;

  const depsOut = new Map<string, Set<string>>();
  const depsIn = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    (depsOut.get(e.from) ?? depsOut.set(e.from, new Set()).get(e.from)!).add(e.to);
    (depsIn.get(e.to) ?? depsIn.set(e.to, new Set()).get(e.to)!).add(e.from);
  }

  // 提交 → 模块：一次提交可能横跨多个模块，各记各的
  const commitsByModule = new Map<string, Map<string, { date: string; subject: string; touched: number }>>();
  for (const c of attribution.myCommits) {
    for (const f of c.files) {
      const mod = f2m.get(f.path);
      if (!mod) continue; // 改的是被忽略的文件（锁文件、配置、生成物）
      const byMod = commitsByModule.get(mod) ?? commitsByModule.set(mod, new Map()).get(mod)!;
      const cur = byMod.get(c.sha) ?? { date: c.date, subject: c.subject, touched: 0 };
      cur.touched += f.added + f.deleted;
      byMod.set(c.sha, cur);
    }
  }

  // 每个模块的全部参与者。boundary 字段（团队 vs 个人）要的就是这个数 ——
  // 「这块一共 5 个人改过，我是其中之一」和「从头到尾只有我」是完全不同的两句话，
  // 而这个区别不该靠回忆。
  const allByModule = new Map<string, { commits: Set<string>; authors: Set<string> }>();
  for (const c of commits) {
    for (const f of c.files) {
      const mod = f2m.get(f.path);
      if (!mod) continue;
      const cur =
        allByModule.get(mod) ?? allByModule.set(mod, { commits: new Set(), authors: new Set() }).get(mod)!;
      cur.commits.add(c.sha);
      cur.authors.add(c.authorEmail || c.authorName);
    }
  }

  const modules: ModuleAttribution[] = graph.modules.map((mod) => {
    let myAdded = 0, myDeleted = 0, totalChanged = 0;
    const myFiles: ModuleAttribution['myFiles'] = [];
    for (const f of mod.files) {
      const a = attribution.byFile.get(f);
      if (!a) continue;
      totalChanged += a.totalAdded + a.totalDeleted;
      if (a.myCommits === 0) continue;
      myAdded += a.myAdded;
      myDeleted += a.myDeleted;
      myFiles.push({ path: f, myAdded: a.myAdded, myDeleted: a.myDeleted, myCommits: a.myCommits });
    }
    myFiles.sort((a, b) => b.myAdded + b.myDeleted - (a.myAdded + a.myDeleted));

    const shaMap = commitsByModule.get(mod.path) ?? new Map();
    const myTopCommits = [...shaMap.entries()]
      .map(([sha, v]) => ({ sha, ...v }))
      .sort((a, b) => b.touched - a.touched)
      .slice(0, 8);
    const dates = [...shaMap.values()].map((v) => v.date).filter(Boolean).sort();

    const myChanged = myAdded + myDeleted;
    const myShare = totalChanged > 0 ? myChanged / totalChanged : 0;
    const myCommits = shaMap.size;

    return {
      path: mod.path,
      fileCount: mod.fileCount,
      testFileCount: mod.testFileCount,
      languages: mod.languages,
      myCommits,
      myAdded,
      myDeleted,
      myShare,
      myFiles: myFiles.slice(0, 25),
      myTopCommits,
      // 两个条件都要满足：改得够多，且不是一次性路过。
      // 只看 share 会把「跑了一次 gofmt」算成你的模块；
      // 只看 commits 会把「每次都改一行配置」算成你的模块。
      touchedByMe: myShare >= minShare && myCommits >= minCommits,
      totalCommits: allByModule.get(mod.path)?.commits.size ?? 0,
      otherAuthors: Math.max(
        0,
        (allByModule.get(mod.path)?.authors.size ?? 0) - (myCommits > 0 ? 1 : 0),
      ),
      dependsOn: [...(depsOut.get(mod.path) ?? [])].sort(),
      dependedBy: [...(depsIn.get(mod.path) ?? [])].sort(),
      firstTouch: dates[0] ?? null,
      lastTouch: dates[dates.length - 1] ?? null,
    };
  });

  const touched = modules.filter((m) => m.touchedByMe);
  if (attribution.myCommits.length > 0 && touched.length === 0) {
    diagnostics.push(
      `匹配到 ${attribution.myCommits.length} 个你的提交，但没有模块达到「碰过」的门槛（占比 ≥ ${minShare}、提交数 ≥ ${minCommits}）。` +
        '可能是你的改动分散在很多模块，试试 --min-share 0.05。',
    );
  }

  return { repo, graph, attribution, modules, headSha: headSha(root), diagnostics };
}

/** 落库。文件仍是事实库的真源，这里存的是可重算的派生结果。 */
export function persistScan(db: Db, scan: RepoScan): { repoId: string; modules: number } {
  const r = scan.repo;
  let repoId = '';
  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM repos WHERE full_name = ?').get(r.full_name) as
      | { id: string }
      | undefined;
    repoId = existing?.id ?? newId('repo-');
    if (existing) {
      db.prepare(
        `UPDATE repos SET local_path=?, visibility=?, analyzed_at=datetime('now'), last_scanned_commit=?
         WHERE id=?`,
      ).run(r.local_path, r.visibility, scan.headSha, repoId);
    } else {
      db.prepare(
        `INSERT INTO repos (id, full_name, local_path, visibility, analyzed_at, last_scanned_commit)
         VALUES (?,?,?,?,datetime('now'),?)`,
      ).run(repoId, r.full_name, r.local_path, r.visibility, scan.headSha);
    }

    // 模块是可重算的派生数据，整体替换。
    // 但 role / tech / evidence_refs 是解读层的产物，重扫不该把它们冲掉。
    const kept = new Map<string, { role: string | null; tech: string | null; evidence_refs: string | null }>(
      (
        db
          .prepare('SELECT path, role, tech, evidence_refs FROM repo_modules WHERE repo_id = ?')
          .all(repoId) as any[]
      ).map((x) => [x.path, { role: x.role, tech: x.tech, evidence_refs: x.evidence_refs }]),
    );
    db.prepare('DELETE FROM repo_modules WHERE repo_id = ?').run(repoId);
    const ins = db.prepare(
      `INSERT INTO repo_modules
        (id, repo_id, path, role, tech, evidence_refs, my_commits, my_share, touched_by_me)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const m of scan.modules) {
      const k = kept.get(m.path);
      ins.run(
        newId('mod-'), repoId, m.path,
        k?.role ?? null, k?.tech ?? null, k?.evidence_refs ?? null,
        m.myCommits, m.myShare, m.touchedByMe ? 1 : 0,
      );
    }
  })();
  return { repoId, modules: scan.modules.length };
}
