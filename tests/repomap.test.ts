import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Claim } from '@assit/contract';
import {
  analyzeStructure,
  attribute,
  computeBoundary,
  explainModule,
  extractImports,
  isMine,
  listAuthors,
  pickModules,
  readCommits,
  resolveRenamedPath,
  resolveToModule,
  scanRepo,
  proposeClaims,
  type ModuleAttribution,
  type ModuleExplanation,
  type Provider,
  type RepoScan,
} from '@assit/core';

let dir: string;

function write(rel: string, content: string): void {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-repo-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('结构层：不调模型，模块划分是算出来的', () => {
  it('小仓库整体算一个模块，不切碎', () => {
    for (let i = 0; i < 5; i++) write(`src/a${i}.ts`, 'export const x = 1;');
    const g = analyzeStructure(dir);
    expect(g.modules).toHaveLength(1);
    expect(g.modules[0]!.fileCount).toBe(5);
  });

  it('大仓库拆到有意义的粒度', () => {
    for (const mod of ['inventory', 'order', 'payment', 'user']) {
      for (let i = 0; i < 12; i++) write(`internal/${mod}/f${i}.go`, 'package x');
    }
    const g = analyzeStructure(dir);
    const paths = g.modules.map((m) => m.path).sort();
    expect(paths).toEqual([
      'internal/inventory', 'internal/order', 'internal/payment', 'internal/user',
    ]);
  });

  it('直通目录不消耗深度预算', () => {
    // Maven 布局：src/main/java/com/company 全是包装层。
    // 按字面层数算的话深度预算会全花在这上面，整个工程被切成一个巨块。
    for (const mod of ['billing', 'catalog', 'shipping']) {
      for (let i = 0; i < 12; i++) {
        write(`src/main/java/com/acme/${mod}/C${i}.java`, 'package com.acme;');
      }
    }
    const g = analyzeStructure(dir);
    const paths = g.modules.map((m) => m.path).sort();
    expect(paths).toEqual([
      'src/main/java/com/acme/billing',
      'src/main/java/com/acme/catalog',
      'src/main/java/com/acme/shipping',
    ]);
  });

  it('忽略构建产物、依赖目录和超大文件', () => {
    write('src/real.ts', 'export const x = 1;');
    write('node_modules/pkg/index.js', 'module.exports = {}');
    write('dist/bundle.js', 'var a=1');
    write('vendor/lib/x.go', 'package lib');
    write('src/generated.pb.go', 'x'.repeat(600 * 1024));
    const g = analyzeStructure(dir);
    expect(g.files.map((f) => f.rel)).toEqual(['src/real.ts']);
  });

  it('标记测试文件但不排除它们', () => {
    write('src/a.ts', 'x');
    write('src/a.test.ts', 'x');
    write('src/__tests__/b.ts', 'x');
    const g = analyzeStructure(dir);
    const mod = g.modules[0]!;
    expect(mod.fileCount).toBe(3);
    expect(mod.testFileCount).toBe(2);
  });

  it('抽取各语言的 import', () => {
    expect(extractImports('.ts', `import { a } from './x';\nconst b = require("../y");`))
      .toEqual(expect.arrayContaining(['./x', '../y']));
    expect(extractImports('.go', 'import (\n\t"fmt"\n\t"org/repo/internal/inventory"\n)'))
      .toEqual(expect.arrayContaining(['fmt', 'org/repo/internal/inventory']));
    expect(extractImports('.py', 'from app.services import x\nimport os'))
      .toEqual(expect.arrayContaining(['app.services', 'os']));
    expect(extractImports('.java', 'import com.acme.billing.Invoice;'))
      .toEqual(['com.acme.billing.Invoice']);
  });

  it('算出模块间依赖边，外部依赖不进图', () => {
    for (let i = 0; i < 15; i++) write(`internal/order/o${i}.go`, 'package order');
    for (let i = 0; i < 15; i++) write(`internal/inventory/i${i}.go`, 'package inventory');
    write(
      'internal/order/o0.go',
      'package order\nimport (\n\t"fmt"\n\t"github.com/acme/svc/internal/inventory"\n)',
    );
    const g = analyzeStructure(dir);
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: 'internal/order', to: 'internal/inventory' }),
    );
    // fmt 是标准库，不该出现在模块图里
    expect(g.edges.every((e) => e.to.startsWith('internal/'))).toBe(true);
  });

  it('相对路径 import 能解析到模块', () => {
    const mods = ['a/mod1', 'a/mod2'];
    const files = new Set(['a/mod1/x.ts', 'a/mod2/y.ts']);
    expect(resolveToModule('a/mod1/x.ts', '../mod2/y', mods, files)).toBe('a/mod2');
    // 解析不到就返回 null，而不是硬塞一个最像的
    expect(resolveToModule('a/mod1/x.ts', 'react', mods, files)).toBeNull();
  });

  it('pickModules 的阈值可调', () => {
    for (let i = 0; i < 40; i++) write(`src/g${i % 4}/f${i}.ts`, 'x');
    const files = analyzeStructure(dir).files;
    expect(pickModules(files, { splitThreshold: 100 })).toHaveLength(1);
    expect(pickModules(files, { splitThreshold: 5 }).length).toBeGreaterThan(1);
  });
});

describe('归因层：git log 就是答案，不需要猜', () => {
  beforeEach(() => {
    git('init', '-q');
    git('config', 'user.email', 'me@example.com');
    git('config', 'user.name', 'Me');
    write('internal/inventory/deduct.go', 'package inventory\nfunc Deduct() {}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: 库存扣减');
  });

  it('读出提交与逐文件行数', () => {
    const commits = readCommits(dir, { authors: ['me@example.com'] });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe('feat: 库存扣减');
    expect(commits[0]!.files[0]!.path).toBe('internal/inventory/deduct.go');
    expect(commits[0]!.files[0]!.added).toBe(2);
  });

  it('按邮箱或姓名子串匹配身份', () => {
    const c = readCommits(dir, { authors: [] })[0]!;
    expect(isMine(c, ['me@example.com'])).toBe(true);
    expect(isMine(c, ['ME@EXAMPLE.COM'])).toBe(true); // 大小写不敏感
    expect(isMine(c, ['Me'])).toBe(true);
    expect(isMine(c, ['someone@else.com'])).toBe(false);
    expect(isMine(c, [])).toBe(false); // 没填 authors 就不该瞎认
  });

  it('列出仓库里的所有身份 —— authors 填错时的补救', () => {
    expect(listAuthors(dir)[0]).toEqual({ identity: 'Me <me@example.com>', commits: 1 });
  });

  it('重命名后按新路径归因', () => {
    // 一次目录改名不该让你的历史贡献全部对不上模块
    expect(resolveRenamedPath('old/a.go => new/b.go')).toBe('new/b.go');
    expect(resolveRenamedPath('src/{old => new}/a.go')).toBe('src/new/a.go');
    expect(resolveRenamedPath('plain/path.go')).toBe('plain/path.go');
  });

  it('真实的 git mv 能被归因追上', () => {
    git('mv', 'internal/inventory/deduct.go', 'internal/inventory/stock.go');
    git('commit', '-q', '-m', 'refactor: 改名');
    const commits = readCommits(dir, { authors: ['me@example.com'] });
    const a = attribute(commits, ['me@example.com']);
    expect(a.byFile.has('internal/inventory/stock.go')).toBe(true);
  });

  it('多作者时分别计数', () => {
    write('internal/inventory/lock.go', 'package inventory\n');
    git('add', '-A');
    git('-c', 'user.email=other@example.com', '-c', 'user.name=Other', 'commit', '-q', '-m', 'other');
    const commits = readCommits(dir, { authors: ['me@example.com'] });
    const a = attribute(commits, ['me@example.com']);
    expect(a.totalCommits).toBe(2);
    expect(a.myCommits).toHaveLength(1);
    expect(a.topAuthors.map((x) => x.identity).sort()).toEqual([
      'Me <me@example.com>', 'Other <other@example.com>',
    ]);
  });
});

describe('求交：结构 × 归因', () => {
  function setupRepo(): void {
    git('init', '-q');
    git('config', 'user.email', 'me@example.com');
    git('config', 'user.name', 'Me');
    for (let i = 0; i < 15; i++) write(`internal/mine/f${i}.go`, `package mine\n// ${i}\n`);
    for (let i = 0; i < 15; i++) write(`internal/theirs/f${i}.go`, `package theirs\n// ${i}\n`);
    git('add', 'internal/mine');
    git('commit', '-q', '-m', 'mine 1');
    write('internal/mine/f0.go', 'package mine\n// changed\n// again\n');
    git('add', 'internal/mine');
    git('commit', '-q', '-m', 'mine 2');
    git('add', 'internal/theirs');
    git('-c', 'user.email=other@example.com', '-c', 'user.name=Other', 'commit', '-q', '-m', 'theirs');
  }

  const repoEntry = () => ({
    full_name: 'acme/svc',
    local_path: dir,
    visibility: 'public' as const,
    authors: ['me@example.com'],
    exclude: [],
  });

  it('只有我碰过的模块被标记', () => {
    setupRepo();
    const scan = scanRepo(repoEntry());
    const mine = scan.modules.find((m) => m.path === 'internal/mine')!;
    const theirs = scan.modules.find((m) => m.path === 'internal/theirs')!;
    expect(mine.touchedByMe).toBe(true);
    expect(theirs.touchedByMe).toBe(false);
    expect(mine.myShare).toBeGreaterThan(0.9);
    expect(theirs.myShare).toBe(0);
  });

  it('门槛需要同时满足占比和提交数', () => {
    setupRepo();
    // 只改一次就不算「碰过」：避免一次 gofmt 把整个仓库算成你的
    const strict = scanRepo(repoEntry(), { minCommits: 5 });
    expect(strict.modules.every((m) => !m.touchedByMe)).toBe(true);
    const loose = scanRepo(repoEntry(), { minCommits: 1, minShare: 0.01 });
    expect(loose.modules.some((m) => m.touchedByMe)).toBe(true);
  });

  it('authors 填错时给出可行动的诊断，而不是静默返回空', () => {
    setupRepo();
    const scan = scanRepo({ ...repoEntry(), authors: ['nobody@nowhere.com'] });
    expect(scan.diagnostics.join('\n')).toContain('Me <me@example.com>');
  });

  it('boundary 由归因算出来，不问模型', () => {
    setupRepo();
    const scan = scanRepo(repoEntry());
    const mine = scan.modules.find((m) => m.path === 'internal/mine')!;
    const b = computeBoundary(mine);
    // 「团队 vs 个人」应该是可核实的数字，不是凭印象写的形容词
    expect(b).toMatch(/模块共 \d+ 个文件/);
    expect(b).toMatch(/我的部分：\d+ 次提交/);
    expect(b).toContain('请改写成一句你能在面试里说出口的话');
  });

  it('记录模块的其他参与者数量', () => {
    setupRepo();
    const scan = scanRepo(repoEntry());
    expect(scan.modules.find((m) => m.path === 'internal/mine')!.otherAuthors).toBe(0);
    expect(scan.modules.find((m) => m.path === 'internal/theirs')!.otherAuthors).toBe(1);
  });
});

describe('解读层：指不回文件的结论一律丢弃', () => {
  function fakeScan(): { scan: RepoScan; mod: ModuleAttribution } {
    write('internal/inventory/deduct.go', 'package inventory\nfunc Deduct() {}\n');
    write('internal/inventory/lock.go', 'package inventory\nfunc Lock() {}\n');
    const mod: ModuleAttribution = {
      path: 'internal/inventory',
      fileCount: 2, testFileCount: 0, languages: ['.go'],
      myCommits: 3, myAdded: 340, myDeleted: 180, myShare: 0.86,
      myFiles: [
        { path: 'internal/inventory/deduct.go', myAdded: 200, myDeleted: 100, myCommits: 2 },
        { path: 'internal/inventory/lock.go', myAdded: 140, myDeleted: 80, myCommits: 1 },
      ],
      myTopCommits: [{ sha: 'a1b2c3d4e5f6', date: '2026-03-01T00:00:00Z', subject: '库存扣减', touched: 300 }],
      touchedByMe: true, totalCommits: 5, otherAuthors: 1,
      dependsOn: [], dependedBy: ['internal/order'],
      firstTouch: '2026-03-01T00:00:00Z', lastTouch: '2026-05-01T00:00:00Z',
    };
    const scan = {
      repo: { full_name: 'acme/svc', local_path: dir, visibility: 'public', authors: [], exclude: [] },
      graph: { root: dir, files: [], modules: [], edges: [] },
      attribution: { byFile: new Map(), myCommits: [], totalCommits: 5, matchedAuthors: [], topAuthors: [] },
      modules: [mod], headSha: 'deadbeef', diagnostics: [],
    } as unknown as RepoScan;
    return { scan, mod };
  }

  function stub(payload: unknown) {
    const provider: Provider = {
      spec: { id: 'local:stub', kind: 'local', max_visibility: 'nda', model: 'stub' },
      isAvailable: () => true,
      async complete() {
        return { text: typeof payload === 'string' ? payload : JSON.stringify(payload) };
      },
    };
    return {
      registry: new Map([['local:stub', provider]]),
      routes: { code_analysis: { provider: 'local:stub', fallback: [] } },
    };
  }

  it('有证据的结论保留，无证据的被丢弃', async () => {
    const { scan, mod } = fakeScan();
    const ex = await explainModule(scan, mod, {
      model: stub({
        role: '库存扣减与并发控制',
        role_evidence: ['internal/inventory/deduct.go'],
        tech: [
          { name: 'Redis 分布式锁', why: '热点 SKU 争用', evidence: ['internal/inventory/lock.go'] },
          { name: 'Kafka', why: '异步解耦', evidence: ['internal/mq/producer.go'] },
        ],
        claims: [],
        questions: [],
      }),
    });
    expect(ex.role).toBe('库存扣减与并发控制');
    expect(ex.tech.map((t) => t.name)).toEqual(['Redis 分布式锁']);
    // Kafka 那条指向的文件不在这个模块里 —— 模型在编
    expect(ex.discarded.join()).toContain('Kafka');
  });

  it('模块职责指不回文件时置空，不硬留', async () => {
    const { scan, mod } = fakeScan();
    const ex = await explainModule(scan, mod, {
      model: stub({ role: '这是一个微服务网关', role_evidence: ['src/gateway.go'], tech: [] }),
    });
    expect(ex.role).toBeNull();
    expect(ex.discarded.join()).toContain('指不回具体文件');
  });

  it('模型给的责任等级越界时降到最低档', async () => {
    const { scan, mod } = fakeScan();
    const ex = await explainModule(scan, mod, {
      model: stub({
        role: null, role_evidence: [], tech: [], questions: [],
        claims: [
          {
            source_fact: '重构库存扣减',
            candidate_wording: '重构库存扣减链路',
            suggested_level: '核心架构负责人', // 不在枚举里
            boundary_hint: '核心实现是我',
            evidence_files: ['internal/inventory/deduct.go'],
          },
        ],
      }),
    });
    // 宁可低估让你自己往上改，也不要把一个越级说法带进事实库
    expect(ex.claims[0]!.suggested_level).toBe('参与');
  });

  it('模型返回非 JSON 时不抛错，如实报告', async () => {
    const { scan, mod } = fakeScan();
    const ex = await explainModule(scan, mod, { model: stub('抱歉，我无法分析这段代码。') });
    expect(ex.claims).toEqual([]);
    expect(ex.discarded.join()).toContain('JSON');
  });

  it('JSON 外面裹了一层解释文字也能捞出来', async () => {
    const { scan, mod } = fakeScan();
    const ex = await explainModule(scan, mod, {
      model: stub(
        '```json\n{"role":"库存","role_evidence":["internal/inventory/deduct.go"],"tech":[]}\n```',
      ),
    });
    expect(ex.role).toBe('库存');
  });
});

describe('候选主张：产物是待办，不是成品', () => {
  function fixture() {
    const mod: ModuleAttribution = {
      path: 'internal/inventory',
      fileCount: 8, testFileCount: 2, languages: ['.go'],
      myCommits: 6, myAdded: 340, myDeleted: 180, myShare: 0.62,
      myFiles: [{ path: 'internal/inventory/deduct.go', myAdded: 200, myDeleted: 100, myCommits: 4 }],
      myTopCommits: [{ sha: 'a1b2c3d4e5f6', date: '2026-03-01T00:00:00Z', subject: '库存扣减', touched: 300 }],
      touchedByMe: true, totalCommits: 21, otherAuthors: 3,
      dependsOn: ['internal/db'], dependedBy: ['internal/order'],
      firstTouch: '2026-03-01T00:00:00Z', lastTouch: '2026-05-01T00:00:00Z',
    };
    const scan = {
      repo: { full_name: 'acme/order-service', local_path: dir, visibility: 'private', authors: [], exclude: [] },
      graph: { root: dir, files: [], modules: [], edges: [] },
      attribution: { byFile: new Map(), myCommits: [], totalCommits: 21, matchedAuthors: [], topAuthors: [] },
      modules: [mod], headSha: 'deadbeef', diagnostics: [],
    } as unknown as RepoScan;
    const ex: ModuleExplanation = {
      modulePath: 'internal/inventory',
      role: '库存扣减与并发控制', roleEvidence: ['internal/inventory/deduct.go'],
      dataFlow: null,
      tech: [{ name: 'Redis 分布式锁', why: '热点 SKU 争用', evidence: ['internal/inventory/deduct.go'] }],
      claims: [{
        source_fact: '重构库存扣减，解决超卖',
        candidate_wording: '重构库存扣减链路，消除并发超卖',
        suggested_level: '负责模块',
        boundary_hint: '核心实现是我',
        evidence_files: ['internal/inventory/deduct.go'],
      }],
      questions: [{
        question: '为什么用分布式锁而不是乐观锁？',
        why_they_ask: '这是该模块最关键的技术取舍',
        evidence: ['internal/inventory/deduct.go'],
      }],
      discarded: [], provider: 'local:stub', cacheHit: false,
    };
    return { scan, ex };
  }

  it('生成的候选主张必须通过 Claim schema，且状态是「待确认」', () => {
    const { scan, ex } = fixture();
    const r = proposeClaims(scan, [ex], { claimsDir: path.join(dir, 'claims'), outDir: dir });
    expect(r.proposed).toBe(1);

    const raw = JSON.parse(fs.readFileSync(r.claimFiles[0]!, 'utf8'));
    const parsed = Claim.safeParse(raw);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

    // 进不了最终 PDF —— 这正是它该有的状态
    expect(raw.verification_status).toBe('待确认');
    expect(raw.last_verified).toBeNull();
    // 四项追问素材刻意留空：模型看得出你改了什么，看不出你当时在权衡什么
    expect(raw.interview_details).toEqual({});
  });

  it('visibility 从仓库继承到主张和代码证据，两处必须一致', () => {
    const { scan, ex } = fixture();
    const r = proposeClaims(scan, [ex], { claimsDir: path.join(dir, 'claims'), outDir: dir });
    const raw = JSON.parse(fs.readFileSync(r.claimFiles[0]!, 'utf8'));
    // 不一致会让路由层的拦截失效，validate 里有一条专门查这个
    expect(raw.visibility).toBe('private');
    expect(raw.code_evidence.visibility).toBe('private');
  });

  it('code_evidence 指回真实的 commit 与文件', () => {
    const { scan, ex } = fixture();
    const r = proposeClaims(scan, [ex], { claimsDir: path.join(dir, 'claims'), outDir: dir });
    const raw = JSON.parse(fs.readFileSync(r.claimFiles[0]!, 'utf8'));
    expect(raw.code_evidence.commits).toContain('a1b2c3d4e5f6');
    expect(raw.code_evidence.files_touched).toEqual(['internal/inventory/deduct.go']);
    expect(raw.code_evidence.modules).toEqual(['internal/inventory']);
  });

  it('boundary 写的是算出来的事实，不是模型的形容词', () => {
    const { scan, ex } = fixture();
    const r = proposeClaims(scan, [ex], { claimsDir: path.join(dir, 'claims'), outDir: dir });
    const raw = JSON.parse(fs.readFileSync(r.claimFiles[0]!, 'utf8'));
    expect(raw.boundary).toContain('8 个文件');
    expect(raw.boundary).toContain('另有 3 位作者参与');
    expect(raw.boundary).toContain('62%');
    // 模型的猜测降级到 risk_notes，不冒充事实
    expect(raw.risk_notes).toContain('核心实现是我');
  });

  it('默认不覆盖已存在的候选文件', () => {
    const { scan, ex } = fixture();
    const claimsDir = path.join(dir, 'claims');
    proposeClaims(scan, [ex], { claimsDir, outDir: dir });
    const second = proposeClaims(scan, [ex], { claimsDir, outDir: dir });
    expect(second.proposed).toBe(0);
    expect(second.skipped[0]!.reason).toContain('已存在');
    expect(proposeClaims(scan, [ex], { claimsDir, outDir: dir, force: true }).proposed).toBe(1);
  });

  it('复核清单把追问题列出来等你回答', () => {
    const { scan, ex } = fixture();
    const r = proposeClaims(scan, [ex], { claimsDir: path.join(dir, 'claims'), outDir: dir });
    const md = fs.readFileSync(r.worksheetPath, 'utf8');
    expect(md).toContain('为什么用分布式锁而不是乐观锁？');
    expect(md).toContain('答不上来的，就不要把对应的主张写进简历');
    expect(md).toContain('待确认');
  });

  it('模型一条有证据的结论都没给时，不硬造主张', () => {
    const { scan, ex } = fixture();
    const empty = { ...ex, claims: [], discarded: ['技术选型「Kafka」指不回具体文件'] };
    const r = proposeClaims(scan, [empty], { claimsDir: path.join(dir, 'claims'), outDir: dir });
    expect(r.proposed).toBe(0);
    expect(r.skipped[0]!.reason).toContain('指不回具体文件');
  });
});
