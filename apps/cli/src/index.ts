#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  buildProvider,
  ensureDir,
  explainModule,
  findChrome,
  generateResume,
  isGitRepo,
  listAuthors,
  loadFactsOrThrow,
  loadReposOnly,
  openDb,
  paths,
  persistExplanation,
  persistScan,
  proposeClaims,
  scanRepo,
  syncFacts,
  validateFacts,
  type Finding,
} from '@assit/core';
import { GuardViolation, PrivacyBlocked } from '@assit/core';
import { scaffold } from './scaffold.js';

const program = new Command();
program
  .name('assit')
  .description('个人求职工作台 · M0 命令行入口（事实库 → 定制简历）')
  .version('0.0.1');

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function printFindings(findings: Finding[]): void {
  const order = { error: 0, warn: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of sorted) {
    const tag =
      f.severity === 'error' ? C.red('ERROR') : f.severity === 'warn' ? C.yellow(' WARN') : C.dim(' INFO');
    const where = f.where ? C.dim(` ${f.where}`) : '';
    console.log(`${tag}  ${f.file}${where}`);
    console.log(`       ${f.message}`);
    if (f.hint) console.log(C.dim(`       ↳ ${f.hint}`));
  }
}

program
  .command('init')
  .description('在 data/facts/ 生成事实库模板（档案、一条示例主张、仓库清单）')
  .option('--force', '覆盖已存在的文件')
  .action((opts) => {
    const created = scaffold(Boolean(opts.force));
    if (created.length === 0) {
      console.log('事实库已存在，没有覆盖任何文件。要重来加 --force。');
      return;
    }
    created.forEach((f) => console.log(`${C.green('created')}  ${path.relative(process.cwd(), f)}`));
    console.log('');
    console.log(C.bold('下一步：'));
    console.log('  1. 用编辑器填 data/facts/profile.yaml —— 登记字段照抄真实信息，这些永不被改写');
    console.log('  2. 在 data/facts/claims/ 里写 2–3 条主张（照着示例改）');
    console.log('  3. assit validate');
    console.log('');
    console.log(C.dim('  data/facts/ 建议单独做成一个私有 git 仓库：这是整个项目唯一不可重建的数据。'));
  });

program
  .command('validate')
  .description('校验事实库：schema、必填、日期、证书有效期、主张状态一致性')
  .option('--stale-months <n>', '超过多少个月未复核就提示转「已过期」', '12')
  .option('--json', '输出 JSON（给 agent 用）')
  .action((opts) => {
    const res = validateFacts({ staleMonths: Number(opts.staleMonths) });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.ok ? 0 : 1);
    }
    const errs = res.findings.filter((f) => f.severity === 'error').length;
    const warns = res.findings.filter((f) => f.severity === 'warn').length;
    const infos = res.findings.length - errs - warns;
    if (res.findings.length > 0) printFindings(res.findings);
    console.log('');
    console.log(
      res.ok
        ? C.green(`通过 · ${warns} 个警告 / ${infos} 条提示`)
        : C.red(`未通过 · ${errs} 个错误 / ${warns} 个警告`),
    );
    if (res.ok && res.facts) {
      console.log(C.dim(`  主张 ${res.facts.claims.length} 条，仓库 ${res.facts.repos.repos.length} 个`));
    }
    process.exit(res.ok ? 0 : 1);
  });

program
  .command('sync')
  .description('把事实库文件导入 SQLite（文件是真源，SQLite 只是索引层）')
  .action(() => {
    const facts = loadFactsOrThrow();
    const db = openDb();
    const r = syncFacts(db, facts);
    console.log(`档案字段 ${r.profileFields} · 档案记录 ${r.profileRecords} · 仓库 ${r.repos}`);
    console.log(
      `主张：新增 ${r.claimsInserted} · 更新 ${r.claimsUpdated} · 未变 ${r.claimsUnchanged}`,
    );
    if (r.events > 0) console.log(C.yellow(`记录了 ${r.events} 条状态变更事件（claim_events）`));
    console.log(C.dim(`  ${paths.db}`));
    db.close();
  });

program
  .command('providers')
  .description('探测可用的模型 provider，并显示各自能处理的最高敏感级')
  .action(async () => {
    console.log(C.bold('provider              类型    最高敏感级  可用  说明'));
    for (const spec of DEFAULT_PROVIDERS) {
      const p = buildProvider(spec);
      const ok = await p.isAvailable();
      const note =
        spec.max_visibility === 'nda'
          ? '内容不出本机'
          : spec.kind === 'cli'
            ? '注意：CLI 同样把内容发到云端'
            : `需要 ${spec.credential_ref ?? 'API key'}`;
      console.log(
        `${spec.id.padEnd(21)} ${spec.kind.padEnd(7)} ${spec.max_visibility.padEnd(11)} ` +
          `${ok ? C.green(' ✓  ') : C.dim(' ✗  ')}  ${C.dim(note)}`,
      );
    }
    console.log('');
    console.log(C.bold('任务路由'));
    for (const [task, r] of Object.entries(DEFAULT_ROUTES)) {
      console.log(`  ${task.padEnd(16)} ${r.provider} ${C.dim(`→ ${r.fallback.join(' → ')}`)}`);
    }
    console.log('');
    console.log(
      C.dim(
        '  private / nda 的载荷只有 local:* 能处理。没配本地模型时，私有仓库解析会硬失败 —— 这是设计如此。',
      ),
    );
  });

program
  .command('resume')
  .description('按 JD 生成定制简历（PDF + bullet↔证据对照表）')
  .requiredOption('--jd <file>', 'JD 文件路径，用 - 表示从 stdin 读')
  .option('--target <role>', '目标岗位标签，用于 allowed_uses 过滤与文件命名')
  .option('--label <name>', '这一版的名字')
  .option('--draft', '草稿模式：允许「待确认」主张进来，并标出 claim id', false)
  .option('--rewrite', '调模型改写措辞（受责任等级与占位符校验约束）', false)
  .option('--max <n>', '最多选几条主张', '8')
  .option('--out <dir>', '输出目录')
  .action(async (opts) => {
    const jdText =
      opts.jd === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(opts.jd), 'utf8');
    if (!jdText.trim()) throw new Error('JD 是空的');

    const facts = loadFactsOrThrow();
    const db = openDb();
    try {
      const r = await generateResume(db, facts, {
        jdText,
        targetRole: opts.target,
        label: opts.label,
        mode: opts.draft ? 'draft' : 'final',
        rewrite: Boolean(opts.rewrite),
        max: Number(opts.max),
        outDir: opts.out ? path.resolve(opts.out) : undefined,
        model: { db },
      });

      console.log(C.bold(`选中 ${r.bullets.length} 条主张`));
      r.bullets.forEach((b, i) => {
        console.log(
          `  ${String(i + 1).padStart(2)}. [${b.claimId}] ${C.dim(`分 ${b.score}`)}` +
            `${b.rewritten ? C.dim(' · 已改写') : ''}`,
        );
        console.log(`      ${b.text}`);
      });
      if (r.rewriteSkipped.length > 0) {
        console.log('');
        console.log(C.yellow('以下改写被回退（越级用词或丢失占位符）：'));
        r.rewriteSkipped.forEach((s) => console.log(`  ${s.claimId}: ${s.reason}`));
      }
      if (r.droppedMetrics.length > 0) {
        console.log('');
        console.log(C.yellow('这一版没提的数字（还没确认）：'));
        r.droppedMetrics.forEach((d) => console.log(`  ${d.claimId}: ${d.names.join('、')}`));
        console.log(C.dim('  补上它们，这几条会明显更有分量。'));
      }
      if (r.violations.length > 0) {
        console.log('');
        console.log(C.yellow('闸门提示：'));
        r.violations.forEach((v) => console.log(`  [${v.kind}] ${v.message}`));
      }
      console.log('');
      if (r.pdfPath) console.log(`${C.green('PDF')}        ${r.pdfPath}`);
      else console.log(`${C.yellow('PDF 跳过')}   ${r.pdfError}`);
      console.log(`${C.green('HTML')}       ${r.htmlPath}`);
      console.log(`${C.green('对照表')}     ${r.mappingPath}`);
      console.log(C.dim(`JD 快照     ${r.jdSha256.slice(0, 16)}`));
      console.log('');
      console.log(C.dim('面试前一晚看对照表，不要看简历本身。'));
    } catch (e) {
      if (e instanceof GuardViolation) {
        console.error(C.red('诚实性闸门拦下了这次渲染：'));
        e.violations.forEach((v) => console.error(`  [${v.kind}] ${v.message}${v.detail ? `\n      ${C.dim(v.detail)}` : ''}`));
        console.error('');
        console.error(C.dim('加 --draft 可以先出一版草稿看看效果，但草稿不该投出去。'));
        process.exit(2);
      }
      throw e;
    } finally {
      db.close();
    }
  });

function pickRepos(name?: string) {
  const all = loadReposOnly().repos;
  if (all.length === 0) {
    throw new Error(
      'data/facts/repos.yaml 里没有仓库。填上你手选的 3–5 个（别全量），每个要有 local_path、visibility 和 authors。',
    );
  }
  if (!name) return all;
  const hit = all.filter((r) => r.full_name === name || r.full_name.endsWith(`/${name}`));
  if (hit.length === 0) {
    throw new Error(`repos.yaml 里没有 ${name}。现有：${all.map((r) => r.full_name).join('、')}`);
  }
  return hit;
}

program
  .command('authors')
  .description('列出一个仓库里出现过的 git 身份，用来填 repos.yaml 的 authors')
  .argument('<path>', '仓库本地路径')
  .option('--since <date>', '只看这个日期之后的提交')
  .action((repoPath: string, opts) => {
    const dir = path.resolve(repoPath.replace(/^~/, process.env.HOME ?? '~'));
    if (!isGitRepo(dir)) throw new Error(`${dir} 不是 git 仓库`);
    const rows = listAuthors(dir, opts.since);
    console.log(C.bold('提交数   身份'));
    for (const r of rows.slice(0, 20)) {
      console.log(`${String(r.commits).padStart(6)}   ${r.identity}`);
    }
    console.log('');
    console.log(C.dim('  把你用过的都填进 repos.yaml 的 authors —— 人在不同时期用不同 git 邮箱是常态，'));
    console.log(C.dim('  只填一个会让归因少算一半。'));
  });

program
  .command('scan')
  .description('扫描仓库：结构层 + 归因层 + 求交（不调模型）')
  .option('--repo <name>', '只扫这一个，默认全部')
  .option('--min-share <n>', '模块里我的改动占比低于此值不算「碰过」', '0.15')
  .option('--min-commits <n>', '也要求至少这么多次提交', '2')
  .option('--max-commits <n>', '最多读多少个提交（大仓库用）')
  .action((opts) => {
    const db = openDb();
    try {
      for (const repo of pickRepos(opts.repo)) {
        const scan = scanRepo(repo, {
          minShare: Number(opts.minShare),
          minCommits: Number(opts.minCommits),
          maxCommits: opts.maxCommits ? Number(opts.maxCommits) : undefined,
        });
        const { modules } = persistScan(db, scan);
        const touched = scan.modules.filter((m) => m.touchedByMe);

        console.log(C.bold(`\n${repo.full_name}`) + C.dim(`  ${repo.visibility}`));
        console.log(
          `  结构 ${scan.graph.files.length} 文件 / ${modules} 模块 · ` +
            `归因 ${scan.attribution.myCommits.length}/${scan.attribution.totalCommits} 次提交是你的 · ` +
            C.green(`求交 ${touched.length} 个模块算你碰过`),
        );
        for (const d of scan.diagnostics) console.log(C.yellow(`  ⚠ ${d}`));
        if (touched.length > 0) console.log('');
        for (const m of touched.slice(0, 15)) {
          console.log(
            `  ${C.green('●')} ${m.path.padEnd(34)} ` +
              C.dim(
                `${m.myCommits} 提交 +${m.myAdded}/-${m.myDeleted} · 占比 ${(m.myShare * 100).toFixed(0)}% · ` +
                  (m.otherAuthors > 0 ? `另有 ${m.otherAuthors} 人` : '只有你'),
              ),
          );
        }
      }
      console.log('');
      console.log(C.dim('  下一步：assit propose --repo <name>（这一步会调模型，受 visibility 拦截）'));
    } finally {
      db.close();
    }
  });

program
  .command('propose')
  .description('解读你碰过的模块，生成「待确认」候选主张 + 复核清单（调模型）')
  .requiredOption('--repo <name>', '仓库名')
  .option('--module <path>', '只解读这一个模块')
  .option('--max-modules <n>', '最多解读几个模块', '6')
  .option('--min-share <n>', '与 scan 保持一致的「碰过」门槛', '0.15')
  .option('--min-commits <n>', '同上', '2')
  .option('--max-files <n>', '每个模块最多读几个文件进上下文', '6')
  .option('--force', '覆盖已存在的候选主张文件', false)
  .action(async (opts) => {
    const db = openDb();
    try {
      const repo = pickRepos(opts.repo)[0]!;
      const scan = scanRepo(repo, {
        minShare: Number(opts.minShare),
        minCommits: Number(opts.minCommits),
      });
      const { repoId } = persistScan(db, scan);

      let targets = scan.modules.filter((m) => m.touchedByMe);
      if (opts.module) targets = targets.filter((m) => m.path === opts.module);
      if (targets.length === 0) {
        console.log(C.yellow('没有可解读的模块。'));
        scan.diagnostics.forEach((d) => console.log(`  ⚠ ${d}`));
        console.log(C.dim('  先跑 assit scan 看归因结果，多半是 repos.yaml 的 authors 没填对。'));
        return;
      }
      targets = targets.slice(0, Number(opts.maxModules));

      console.log(
        C.dim(`解读 ${targets.length} 个模块（visibility=${repo.visibility}，走任务路由 code_analysis）…`),
      );
      const explanations = [];
      for (const m of targets) {
        process.stdout.write(`  ${m.path} … `);
        const ex = await explainModule(scan, m, { db, maxFiles: Number(opts.maxFiles) });
        persistExplanation(db, repoId, ex);
        explanations.push(ex);
        console.log(
          `${ex.claims.length} 个候选要点，${ex.questions.length} 个追问题` +
            (ex.discarded.length ? C.yellow(`，丢弃 ${ex.discarded.length} 条无证据结论`) : '') +
            C.dim(` [${ex.provider}${ex.cacheHit ? ' 命中缓存' : ''}]`),
        );
      }

      const r = proposeClaims(scan, explanations, { force: Boolean(opts.force) });
      console.log('');
      console.log(`${C.green('候选主张')}   ${r.proposed} 条 → data/facts/claims/`);
      console.log(`${C.green('复核清单')}   ${r.worksheetPath}`);
      if (r.skipped.length > 0) {
        console.log('');
        console.log(C.yellow('跳过：'));
        r.skipped.forEach((s) => console.log(`  ${s.module}: ${s.reason}`));
      }
      console.log('');
      console.log(C.dim('  这些主张状态都是「待确认」，进不了最终 PDF。'));
      console.log(C.dim('  打开复核清单，回答上面的追问题，然后改 boundary / interview_details，'));
      console.log(C.dim('  最后把 verification_status 改成「已确认」并填 last_verified。'));
    } catch (e) {
      if (e instanceof PrivacyBlocked) {
        console.error(C.red(e.message));
        console.error('');
        console.error(C.dim('  这是设计如此：私有仓库的代码不走云端模型。'));
        console.error(C.dim('  装个 ollama（brew install ollama && ollama pull qwen2.5-coder:7b）后重试。'));
        process.exit(2);
      }
      throw e;
    } finally {
      db.close();
    }
  });

program
  .command('doctor')
  .description('环境自检')
  .action(async () => {
    const rows: [string, boolean, string][] = [];
    rows.push(['事实库 data/facts/profile.yaml', fs.existsSync(paths.profile), paths.profile]);
    rows.push(['SQLite', fs.existsSync(paths.db), paths.db]);
    const chrome = findChrome();
    rows.push(['Chrome（PDF 渲染）', Boolean(chrome), chrome ?? '装一个，或设 CHROME_PATH']);
    let anyLocal = false;
    for (const spec of DEFAULT_PROVIDERS) {
      const ok = await buildProvider(spec).isAvailable();
      if (ok && spec.kind === 'local') anyLocal = true;
    }
    rows.push([
      '本地模型（处理 private/nda 的唯一途径）',
      anyLocal,
      anyLocal ? 'ok' : '没有本地模型时，私有仓库解析会被路由层拦下',
    ]);
    for (const [name, ok, note] of rows) {
      console.log(`${ok ? C.green(' ✓') : C.yellow(' ✗')}  ${name.padEnd(40)} ${C.dim(note)}`);
    }
    ensureDir(paths.data);
  });

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(C.red(e.message));
  process.exit(1);
});
