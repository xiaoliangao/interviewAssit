import fs from 'node:fs';
import path from 'node:path';

/**
 * 结构层：从仓库目录结构和 import 语句推出模块划分与依赖边。
 *
 * **这一层不调模型。** 模块划分和依赖关系是可以算出来的事实，
 * 让模型来「看一眼觉得」会得到一个每次都不一样、且无法验证的答案。
 * 模型只在解读层出现（这个模块是干什么的、技术选型为什么这么定）。
 *
 * 为什么不用 madge / dependency-cruiser / go list：
 * 它们精确，但各自只覆盖一种语言，而且多数要求仓库能被构建 ——
 * 你三年前那个项目现在还能 `go build` 吗？这里用正则抽 import，
 * 边解析得没那么准，但对「我碰过哪些模块、它们之间怎么连」这个问题够用，
 * 而且对任何语言、任何年代的仓库都能跑出结果。准确性换可用性，这里换得值。
 */

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target',
  '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'coverage', '.turbo',
  '.idea', '.vscode', 'Pods', 'DerivedData', '.gradle', 'bin', 'obj',
  'third_party', 'testdata', 'fixtures', '__snapshots__', '.pnpm-store',
]);

const SOURCE_EXT = new Set([
  '.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.java', '.kt', '.scala', '.rs', '.rb', '.php', '.cs', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm', '.ex', '.exs', '.erl',
  '.dart', '.lua', '.sh', '.sql', '.proto', '.graphql',
]);

/** 测试文件单独标记：它们算贡献，但不适合作为简历素材的主要证据。 */
const TEST_RE = /(^|[/.])(test|tests|spec|__tests__|_test|\.test|\.spec)([/.]|$)/i;

export interface SourceFile {
  /** 相对仓库根的路径，一律用 / 分隔 */
  rel: string;
  ext: string;
  isTest: boolean;
  bytes: number;
}

export interface RepoModule {
  path: string;
  files: string[];
  fileCount: number;
  testFileCount: number;
  /** 该模块里出现过的语言，按文件数降序 */
  languages: string[];
}

export interface StructureGraph {
  root: string;
  files: SourceFile[];
  modules: RepoModule[];
  /** 模块间依赖边：from -> to[]（已去重、已去自环） */
  edges: { from: string; to: string; weight: number }[];
}

function walk(root: string, extraExclude: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  const excluded = new Set(extraExclude.map((e) => e.replace(/^\.?\//, '').replace(/\/$/, '')));

  const visit = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (excluded.has(childRel)) continue;
      if (e.isSymbolicLink()) continue; // 软链会绕回来，直接跳过
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        visit(path.join(dir, e.name), childRel);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!SOURCE_EXT.has(ext)) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(dir, e.name)).size;
      } catch {
        continue;
      }
      // 超大文件通常是生成的（pb.go、bundle、migration dump），不代表你写的东西
      if (bytes > 512 * 1024) continue;
      out.push({ rel: childRel, ext, isTest: TEST_RE.test(childRel), bytes });
    }
  };

  visit(root, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export interface ModuleOptions {
  /** 子树文件数低于这个值就不再往下拆，整个目录算一个模块 */
  splitThreshold?: number;
  /** 最深拆到第几层 */
  maxDepth?: number;
}

/**
 * 自顶向下拆模块：子树文件数还很多就继续往下拆，少了就停。
 *
 * 这样 10 个文件的小仓库整体是一个模块，500 个文件的仓库会拆到
 * `internal/inventory` 这种粒度 —— 正好是简历上「我负责了什么」的说话单位。
 * 按固定层数切会在两头都出错：小仓库切碎，大仓库切不开。
 */
export function pickModules(files: SourceFile[], opts: ModuleOptions = {}): RepoModule[] {
  const splitThreshold = opts.splitThreshold ?? 25;
  const maxDepth = opts.maxDepth ?? 3;
  if (files.length === 0) return [];

  const byDir = new Map<string, SourceFile[]>();
  for (const f of files) {
    const dir = path.posix.dirname(f.rel);
    const key = dir === '.' ? '' : dir;
    (byDir.get(key) ?? byDir.set(key, []).get(key)!).push(f);
  }

  const subtree = (prefix: string): SourceFile[] =>
    files.filter((f) => (prefix === '' ? true : f.rel.startsWith(`${prefix}/`)));

  const childDirs = (prefix: string): string[] => {
    const set = new Set<string>();
    for (const f of files) {
      if (prefix !== '' && !f.rel.startsWith(`${prefix}/`)) continue;
      const tail = prefix === '' ? f.rel : f.rel.slice(prefix.length + 1);
      const seg = tail.split('/')[0]!;
      if (tail.includes('/')) set.add(prefix === '' ? seg : `${prefix}/${seg}`);
    }
    return [...set].sort();
  };

  const modules: RepoModule[] = [];
  const make = (p: string, fs_: SourceFile[]): void => {
    if (fs_.length === 0) return;
    const langs = new Map<string, number>();
    for (const f of fs_) langs.set(f.ext, (langs.get(f.ext) ?? 0) + 1);
    modules.push({
      path: p === '' ? '.' : p,
      files: fs_.map((f) => f.rel),
      fileCount: fs_.length,
      testFileCount: fs_.filter((f) => f.isTest).length,
      languages: [...langs.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e),
    });
  };

  const descend = (prefix: string, depth: number): void => {
    const sub = subtree(prefix);
    const kids = childDirs(prefix);
    const directFiles = (byDir.get(prefix) ?? []).length;

    // 直通目录不消耗深度预算：`src/`、`main/java/com/company/` 这种只起包装作用，
    // 本身不是一个「模块」。按字面层数算的话，一个 Maven 项目的深度预算会全花在
    // src/main/java 上，最后整个工程被切成一个巨块 —— 那就什么也没说。
    const passThrough = prefix !== '' && kids.length === 1 && directFiles === 0;

    if (sub.length <= splitThreshold || kids.length === 0 || (!passThrough && depth >= maxDepth)) {
      make(prefix, sub);
      return;
    }
    for (const k of kids) descend(k, passThrough ? depth : depth + 1);
    // 直接躺在本层、没被子目录收走的文件，单独成一个模块
    const loose = (byDir.get(prefix) ?? []).filter((f) => sub.includes(f));
    if (loose.length > 0) make(prefix === '' ? '(root)' : `${prefix}/(root)`, loose);
  };

  descend('', 0);
  return modules.sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path));
}

// ── import 抽取 ────────────────────────────────────────────────────────────

const IMPORT_PATTERNS: { exts: string[]; res: RegExp[] }[] = [
  {
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'],
    res: [
      /(?:^|\n)\s*import\s+[^'"`;]*?from\s*['"]([^'"]+)['"]/g,
      /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
      /(?:^|\n)\s*export\s+[^'"`;]*?from\s*['"]([^'"]+)['"]/g,
    ],
  },
  {
    exts: ['.go'],
    res: [/(?:^|\n)\s*import\s+\(([\s\S]*?)\)/g, /(?:^|\n)\s*import\s+(?:\w+\s+)?"([^"]+)"/g],
  },
  {
    exts: ['.py'],
    res: [
      /(?:^|\n)\s*from\s+([.\w]+)\s+import\s/g,
      /(?:^|\n)\s*import\s+([.\w]+)/g,
    ],
  },
  { exts: ['.java', '.kt', '.scala'], res: [/(?:^|\n)\s*import\s+(?:static\s+)?([\w.]+)/g] },
  { exts: ['.rs'], res: [/(?:^|\n)\s*use\s+([\w:]+)/g, /(?:^|\n)\s*(?:pub\s+)?mod\s+(\w+)/g] },
  { exts: ['.rb'], res: [/\brequire(?:_relative)?\s+['"]([^'"]+)['"]/g] },
  { exts: ['.php'], res: [/(?:^|\n)\s*use\s+([\w\\]+)/g, /\brequire(?:_once)?\s+['"]([^'"]+)['"]/g] },
  { exts: ['.cs'], res: [/(?:^|\n)\s*using\s+([\w.]+)\s*;/g] },
  { exts: ['.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm'], res: [/#include\s+"([^"]+)"/g] },
  { exts: ['.swift'], res: [/(?:^|\n)\s*import\s+(\w+)/g] },
  { exts: ['.dart'], res: [/\bimport\s+['"]([^'"]+)['"]/g] },
  { exts: ['.ex', '.exs'], res: [/(?:^|\n)\s*(?:alias|import|use)\s+([\w.]+)/g] },
];

function patternsFor(ext: string): RegExp[] {
  return IMPORT_PATTERNS.find((p) => p.exts.includes(ext))?.res ?? [];
}

export function extractImports(ext: string, source: string): string[] {
  const out: string[] = [];
  for (const re of patternsFor(ext)) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      const raw = m[1];
      if (!raw) continue;
      if (ext === '.go' && raw.includes('\n')) {
        // Go 的分组 import：import ( "a" \n "b" )
        for (const line of raw.split('\n')) {
          const q = line.match(/"([^"]+)"/);
          if (q?.[1]) out.push(q[1]);
        }
      } else {
        out.push(raw.trim());
      }
    }
  }
  return out;
}

/**
 * 把一个 import 目标解析到模块。
 * 解析不了就返回 null —— 外部依赖（react、fmt）本来就不该出现在模块图里。
 */
export function resolveToModule(
  fromFile: string,
  spec: string,
  modulePaths: string[],
  fileSet: Set<string>,
): string | null {
  const inModule = (p: string): string | null => {
    let best: string | null = null;
    for (const m of modulePaths) {
      const base = m.endsWith('/(root)') ? m.slice(0, -7) : m === '.' ? '' : m;
      if (base === '' || p === base || p.startsWith(`${base}/`)) {
        if (best === null || base.length > (best === '.' ? 0 : best.length)) best = m;
      }
    }
    return best;
  };

  // 相对路径：直接解析
  if (spec.startsWith('.')) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    if (resolved.startsWith('..')) return null;
    // 补扩展名 / index 文件
    const candidates = [resolved, ...['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rb'].flatMap((e) => [
      `${resolved}${e}`, `${resolved}/index${e}`, `${resolved}/__init__${e}`,
    ])];
    const hit = candidates.find((c) => fileSet.has(c));
    return inModule(hit ?? resolved);
  }

  // 包路径（go / java / python 点分）：按后缀去匹配仓库内的路径
  const asPath = spec.replace(/[.:\\]+/g, '/').replace(/^\/+/, '');
  const segs = asPath.split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const tail = segs.slice(i).join('/');
    if (tail.length < 3) continue;
    const m = inModule(tail);
    // 必须真的有文件落在这个前缀下，否则「com/example」这种会乱命中
    if (m && [...fileSet].some((f) => f === tail || f.startsWith(`${tail}/`))) return m;
  }
  return null;
}

export interface AnalyzeOptions extends ModuleOptions {
  exclude?: string[];
  /** 抽 import 时每个文件最多读多少字节 */
  maxReadBytes?: number;
}

export function analyzeStructure(root: string, opts: AnalyzeOptions = {}): StructureGraph {
  const files = walk(root, opts.exclude ?? []);
  const modules = pickModules(files, opts);
  const modulePaths = modules.map((m) => m.path);
  const fileSet = new Set(files.map((f) => f.rel));
  const fileToModule = new Map<string, string>();
  for (const m of modules) for (const f of m.files) fileToModule.set(f, m.path);

  const edgeWeight = new Map<string, number>();
  const maxRead = opts.maxReadBytes ?? 200 * 1024;

  for (const f of files) {
    if (patternsFor(f.ext).length === 0) continue;
    let src: string;
    try {
      src = fs.readFileSync(path.join(root, f.rel), 'utf8').slice(0, maxRead);
    } catch {
      continue;
    }
    const from = fileToModule.get(f.rel);
    if (!from) continue;
    for (const spec of extractImports(f.ext, src)) {
      const to = resolveToModule(f.rel, spec, modulePaths, fileSet);
      if (!to || to === from) continue;
      const key = `${from} ${to}`;
      edgeWeight.set(key, (edgeWeight.get(key) ?? 0) + 1);
    }
  }

  const edges = [...edgeWeight.entries()]
    .map(([k, weight]) => {
      const [from, to] = k.split(' ') as [string, string];
      return { from, to, weight };
    })
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));

  return { root, files, modules, edges };
}
