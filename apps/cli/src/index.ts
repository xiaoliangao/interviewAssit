#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  buildProvider,
  collect,
  currentProfileVersion,
  ensureDir,
  explainModule,
  findChrome,
  generateResume,
  ignoreJob,
  ingestPosting,
  isGitRepo,
  listAuthors,
  loadFactsOrThrow,
  loadReposOnly,
  loadRubric,
  deleteRecordingAudio,
  listRecordings,
  loadRegistry,
  loadSources,
  openDb,
  pastedPosting,
  paths,
  pruneRecordings,
  persistExplanation,
  persistScan,
  proposeClaims,
  registryStats,
  registryToSourcesYaml,
  recoverStale,
  reparseJobs,
  rubricReview,
  runSource,
  scanRepo,
  scoreAllJobs,
  sourceHealth,
  syncFacts,
  validateFacts,
  validateRubricFile,
  type Finding,
} from '@assit/core';
import { GuardViolation, PrivacyBlocked } from '@assit/core';
import { TEMPLATE_NAMES, scaffold } from './scaffold.js';

const program = new Command();
program
  .name('assit')
  .description('个人求职工作台 · 事实库 → 定制简历 → 岗位池 → 可解释打分')
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
  .option('--force', '覆盖已存在的文件（会先备份成 .bak-<时间戳>）')
  .option('--only <names>', `只生成这几份，逗号分隔：${TEMPLATE_NAMES.join(' / ')}`)
  .action((opts) => {
    const only = opts.only ? String(opts.only).split(',').map((x: string) => x.trim()) : undefined;
    const { created, backedUp } = scaffold(Boolean(opts.force), only);
    if (created.length === 0) {
      console.log('这些文件都已存在，没有覆盖任何东西。要重来加 --force。');
      console.log(C.dim(`  只想重新生成某一份：assit init --force --only rubric`));
      return;
    }
    backedUp.forEach(([f, bak]) =>
      console.log(`${C.yellow('backup ')}  ${path.relative(process.cwd(), f)} → ${path.basename(bak)}`),
    );
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
  .command('ingest')
  .description('粘贴入库：零风险、覆盖一切平台（包括 BOSS），扩展做出来之前就能用')
  .option('--file <path>', 'JD 文本文件；不给则从 stdin 读')
  .option('--clipboard', '从剪贴板读（macOS pbpaste）', false)
  .option('--url <url>', '岗位链接，用来识别平台')
  .option('--company <name>', '公司名')
  .option('--title <title>', '职位名')
  .option('--city <city>', '城市')
  .option('--salary <raw>', '薪资原文，如 25-40K·15薪')
  .action((opts) => {
    let jdText = '';
    if (opts.clipboard) jdText = execFileSync('pbpaste', { encoding: 'utf8' });
    else if (opts.file) jdText = fs.readFileSync(path.resolve(opts.file), 'utf8');
    else jdText = fs.readFileSync(0, 'utf8');
    if (!jdText.trim()) throw new Error('JD 是空的');

    const db = openDb();
    try {
      // 技术词表的扩展来自 rubric 的 profile.stack，**不是 claim tags**。
      // claim tags 是自由文本，里面混着「高并发」「订单」这种业务概念；
      // 把它们当技术词会污染 JD 的要求列表，进而虚增分母、压低匹配分。
      // rubric stack 是你显式维护的一份「我的技术栈」，正好适合干这个。
      let extraTech: string[] = [];
      try {
        extraTech = loadRubric().rubric.profile.stack;
      } catch {
        /* 还没配 rubric 也能入库，只是不扩展词表 */
      }
      const posting = pastedPosting({
        url: opts.url, company: opts.company, title: opts.title,
        city: opts.city, salaryRaw: opts.salary, jdText,
      });
      const r = ingestPosting(db, posting, { extraTech });

      const label: Record<string, string> = {
        new_job: C.green('新岗位'),
        merged_into_existing: C.yellow('合并到已有岗位'),
        posting_updated: C.dim('挂牌已更新'),
        jd_changed: C.yellow('JD 有变更'),
        unchanged: C.dim('无变化'),
      };
      console.log(`${label[r.outcome]}  ${posting.company_name} · ${posting.title}`);
      console.log(C.dim(`  平台 ${posting.platform} · identity ${r.identityKey.slice(0, 12)}`));
      console.log(
        `  已披露 ${r.coverage.known}/${r.coverage.total} 个维度` +
          (r.jdVersions > 1 ? C.yellow(` · 这个岗位已有 ${r.jdVersions} 个 JD 版本`) : ''),
      );
      for (const [k, v] of Object.entries(r.attrs)) {
        const t = v as { value: unknown; confidence: string };
        const shown = t.confidence === 'unknown'
          ? C.dim('未披露')
          : Array.isArray(t.value) ? (t.value as string[]).join('、') : String(t.value);
        console.log(`    ${k.padEnd(16)} ${shown}`);
      }
      r.notes.forEach((n) => console.log(C.yellow(`  ⚠ ${n}`)));
      console.log('');
      console.log(C.dim('  下一步：assit score'));
    } finally {
      db.close();
    }
  });

program
  .command('reparse')
  .description('用当前解析器重算已入库岗位的三态字段（改了解析器之后跑）')
  .option('--job <id>', '只重算一个')
  .action((opts) => {
    let extraTech: string[] = [];
    try { extraTech = loadRubric().rubric.profile.stack; } catch { /* 可选 */ }
    const db = openDb();
    try {
      const r = reparseJobs(db, { extraTech, jobId: opts.job });
      console.log(`扫描 ${r.scanned} 个 · ${C.green(`更新 ${r.changed}`)}` +
        (r.noJd > 0 ? C.yellow(` · ${r.noJd} 个没有 JD 存档，已跳过`) : ''));
      if (r.changed > 0) console.log(C.dim('  三态字段变了，分数需要重算：assit score --force'));
    } finally {
      db.close();
    }
  });

program
  .command('score')
  .description('给岗位池打分：硬门槛 → 加权 rubric → 封顶，产出可解释 trace')
  .option('--rubric <name>', '用哪个 rubric 文件')
  .option('--force', '重算已有分数', false)
  .option('--job <id>', '只打这一个')
  .option('--top <n>', '列出前几个', '20')
  .action((opts) => {
    const loaded = loadRubric(opts.rubric);
    const pv = currentProfileVersion();
    const db = openDb();
    try {
      const scored = scoreAllJobs(db, loaded, {
        profileVersion: pv, force: Boolean(opts.force), jobId: opts.job,
      });
      if (scored.length === 0) {
        console.log('岗位池是空的。先 `assit ingest` 粘一个进来。');
        return;
      }
      console.log(
        C.dim(`rubric ${path.basename(loaded.file)}@${loaded.version} · profile ${pv}`),
      );
      console.log('');
      console.log(C.bold(' 分数  覆盖   公司 · 职位'));
      for (const s of scored.slice(0, Number(opts.top))) {
        const t = s.trace;
        const gap = t.hard_gaps.length > 0 ? C.red(' ⚑') : '  ';
        const low = t.coverage < 0.5 ? C.yellow(`${(t.coverage * 100).toFixed(0)}%`) : `${(t.coverage * 100).toFixed(0)}%`;
        console.log(
          `${String(t.final_score).padStart(4)}${gap} ${low.padStart(5)}   ` +
            `${s.company} · ${s.title}` + C.dim(`  ${s.salaryRaw ?? '薪资未披露'}`),
        );
        if (t.capped_by) console.log(C.yellow(`        被「${t.capped_by}」封顶（原始分 ${t.raw_score}）`));
        else if (t.caps.length) console.log(C.dim(`        触发规则：${t.caps.join('、')}（未影响分数）`));
        if (t.hard_gaps.length) console.log(C.red(`        硬缺口：${t.hard_gaps.join('；')}`));
        if (t.injection_flags.length) {
          console.log(C.red(`        ⚠ JD 里检出可疑指令性文本：${t.injection_flags.join(' / ')}（已打标，未改分数）`));
        }
      }
      console.log('');
      console.log(C.dim('  ⚑ = 有硬门槛未过（不淘汰，只沉底 —— JD 门槛常常虚标）'));
      console.log(C.dim('  覆盖率低不代表岗位差，代表你看不清它。用 assit why <job-id> 看逐项证据。'));
    } finally {
      db.close();
    }
  });

program
  .command('why')
  .description('展开一个岗位的完整打分证据')
  .argument('<jobId>')
  .action((jobId: string) => {
    const loaded = loadRubric();
    const db = openDb();
    try {
      const [s] = scoreAllJobs(db, loaded, { profileVersion: currentProfileVersion(), jobId });
      if (!s) throw new Error(`没有 job ${jobId}`);
      const t = s.trace;
      console.log(C.bold(`${s.company} · ${s.title}`) + C.dim(`  ${s.city ?? ''} ${s.salaryRaw ?? ''}`));
      console.log('');
      console.log(`原始分 ${t.raw_score} → 最终分 ${C.bold(String(t.final_score))}` +
        (t.capped_by ? C.yellow(`（被「${t.capped_by}」封顶）`) : ''));
      if (t.caps.length) {
        const idle = t.caps.filter((c) => c !== t.capped_by);
        if (idle.length) {
          console.log(C.dim(`触发但未影响分数的规则：${idle.join('、')}` +
            '  —— 条件确实成立，只是分数本来就更低'));
        }
      }
      console.log(C.dim(`覆盖 ${(t.coverage * 100).toFixed(0)}% · rubric@${t.rubric_version} · profile ${t.profile_version}`));
      console.log('');
      for (const [dim, c] of Object.entries(t.components)) {
        console.log(`  ${C.green(dim.padEnd(12))} ${String(c.score).padStart(3)}/${c.max_score}  ${c.evidence}`);
        if (c.jd_quote) console.log(C.dim(`               JD 原文：「${c.jd_quote}」`));
      }
      for (const d of t.unknown_dims) {
        console.log(`  ${C.dim(d.padEnd(12))}   — ${C.dim('未披露，不计入分母')}`);
      }
      if (t.gates.length) {
        console.log('');
        console.log(C.bold('  硬门槛'));
        for (const g of t.gates) {
          const mark = g.status === 'pass' ? C.green('✓') : g.status === 'fail' ? C.red('✗') : C.dim('?');
          console.log(`  ${mark} ${g.key.padEnd(14)} ${g.detail}`);
        }
      }
      if (t.injection_flags.length) {
        console.log('');
        console.log(C.red(`  ⚠ 可疑指令性文本：${t.injection_flags.join(' / ')}`));
        console.log(C.dim('    已打标但未改分数 —— 自动降分反而会被用来攻击竞品岗位的排序。'));
      }
    } finally {
      db.close();
    }
  });

program
  .command('ignore')
  .description('忽略一个岗位并记下原因（原因会被 rubric-review 消费）')
  .argument('<jobId>')
  .requiredOption('--reason <text>', '为什么不投')
  .action((jobId: string, opts) => {
    const db = openDb();
    try {
      const row = db
        .prepare('SELECT final_score FROM job_scores WHERE job_id=? ORDER BY created_at DESC LIMIT 1')
        .get(jobId) as { final_score: number } | undefined;
      ignoreJob(db, jobId, opts.reason, row?.final_score ?? null);
      console.log(`已忽略 ${jobId}：${opts.reason}`);
      console.log(C.dim('  每周跑一次 assit rubric-review，看你的 rubric 和真实偏好差在哪。'));
    } finally {
      db.close();
    }
  });

program
  .command('rubric-review')
  .description('每周复盘：高分被忽略 / 低分被投递的岗位，指出 rubric 的偏差')
  .option('--high <n>', '「高分」阈值', '75')
  .option('--low <n>', '「低分」阈值', '55')
  .action((opts) => {
    const loaded = loadRubric();
    const db = openDb();
    try {
      const r = rubricReview(db, currentProfileVersion(), loaded.version, {
        highThreshold: Number(opts.high), lowThreshold: Number(opts.low),
      });
      console.log(C.bold(`高分（≥${opts.high}）却被你忽略的岗位`));
      if (r.highScoreIgnored.length === 0) console.log(C.dim('  （无）'));
      for (const x of r.highScoreIgnored) {
        console.log(`  ${String(x.score ?? '?').padStart(3)}  ${x.company} · ${x.title}`);
        console.log(C.dim(`       原因：${x.reason}`));
      }
      console.log('');
      console.log(C.bold(`低分（<${opts.low}）却被你投了的岗位`));
      if (r.lowScoreApplied.length === 0) console.log(C.dim('  （无）'));
      for (const x of r.lowScoreApplied) {
        console.log(`  ${String(x.score ?? '?').padStart(3)}  ${x.company} · ${x.title}`);
      }
      if (r.reasonClusters.length > 0) {
        console.log('');
        console.log(C.bold('忽略原因聚类'));
        for (const c of r.reasonClusters) {
          console.log(`  ${String(c.count).padStart(3)} 次  ${c.reason}` + C.dim(`  平均分 ${c.avgScore ?? '?'}`));
        }
      }
      console.log('');
      console.log(C.dim('  这两张表指出 rubric 和你真实偏好的偏差。'));
      console.log(C.dim('  改 data/facts/rubric/*.yaml 仍然由你手动做 —— 自动调参会把'));
      console.log(C.dim('  「这周心情不好多忽略了几个」固化成规则。改完 rubric_version 会变，自动触发重算。'));
    } finally {
      db.close();
    }
  });

program
  .command('collect')
  .description('从公开招聘接口采集岗位（无需登录、无封号风险）')
  .option('--source <id>', '只跑这一个源')
  .option('--limit <n>', '单源最多取多少条', '200')
  .option('--dry', '只抓不入库，看看格式对不对', false)
  .action(async (opts) => {
    const all = loadSources();
    if (all.length === 0) {
      console.log('data/facts/sources.yaml 里没有采集源。');
      console.log(C.dim('  跑 `assit init` 会生成带注释的模板。'));
      console.log(C.dim('  国内平台（BOSS / 51job / 猎聘）要登录，不走这条通道 ——'));
      console.log(C.dim('  在扩展做出来之前用 `assit ingest` 手动粘贴，效果一样。'));
      return;
    }
    const targets = (opts.source ? all.filter((s) => s.id === opts.source) : all)
      .filter((s) => s.enabled);
    if (targets.length === 0) throw new Error(`没有启用的采集源匹配 ${opts.source ?? '(全部)'}`);

    let extraTech: string[] = [];
    try { extraTech = loadRubric().rubric.profile.stack; } catch { /* 可选 */ }

    const db = openDb();
    try {
      for (const src of targets) {
        process.stdout.write(`${src.id.padEnd(28)} `);
        if (opts.dry) {
          const r = await collect(src, { limit: Number(opts.limit) });
          console.log(`抓到 ${r.postings.length} 条（未入库）`);
          r.postings.slice(0, 3).forEach((p) =>
            console.log(C.dim(`    ${p.company_name} · ${p.title} · ${p.city ?? '?'}`)));
          r.rejected.slice(0, 3).forEach((x) => console.log(C.yellow(`    拒绝：${x.reason}`)));
          continue;
        }
        const r = await runSource(db, src, { limit: Number(opts.limit), extraTech });
        if (!r.ok) {
          // 单源失败不影响其他源 —— 采集器坏掉是常态不是意外
          console.log(C.red(`失败：${r.error}`));
          continue;
        }
        console.log(
          `${C.green('ok')} 抓 ${r.fetched} · 入库 ${r.ingested} · ${C.green(`新增 ${r.newJobs}`)}` +
            C.dim(` · ${r.durationMs}ms`),
        );
        if (r.rejected.length > 0) {
          console.log(C.yellow(`    ${r.rejected.length} 条被拒绝：${r.rejected[0]!.reason}`));
        }
      }
      console.log('');
      console.log(C.dim('  下一步：assit score'));
    } finally {
      db.close();
    }
  });

program
  .command('sources')
  .description('采集源健康度。采集器坏掉是常态，这张表要能一眼看到')
  .action(() => {
    const all = loadSources();
    if (all.length === 0) { console.log('还没有配置采集源。'); return; }
    const db = openDb();
    try {
      const health = sourceHealth(db, all);
      console.log(C.bold('源                            平台        上次成功            连续失败  岗位数'));
      for (const h of health) {
        const fail = h.consecutiveFailures > 0
          ? C.red(String(h.consecutiveFailures).padStart(8))
          : C.dim('       0');
        const okAt = h.lastOkAt ?? C.dim('从未');
        console.log(
          `${h.sourceId.padEnd(29)} ${h.platform.padEnd(11)} ${String(okAt).padEnd(19)} ${fail}  ${String(h.totalJobs).padStart(6)}`,
        );
        if (h.lastError) console.log(C.red(`    最近错误：${h.lastError.slice(0, 120)}`));
      }
      console.log('');
      console.log(C.dim('  连续失败 ≥3 通常意味着对方改版了。别硬猜页面结构 —— 去看一眼再改采集器。'));
    } finally {
      db.close();
    }
  });

program
  .command('registry')
  .description('雇主注册表：哪家公司该走哪条采集通道')
  .option('--status <s>', '只看这个状态（ok / needs_cdp / unverified / ...）')
  .option('--emit-sources', '把能直接采的那些打印成 sources.yaml 片段', false)
  .option('--keywords <list>', '生成片段时带上的关键词，逗号分隔', '')
  .action((opts) => {
    const all = loadRegistry();
    if (all.length === 0) {
      console.log(`${paths.registry} 下没有注册表文件。`);
      return;
    }

    if (opts.emitSources) {
      const kws = String(opts.keywords).split(',').map((x) => x.trim()).filter(Boolean);
      const snippet = registryToSourcesYaml(all, { keywords: kws });
      if (!snippet) {
        console.log(C.yellow('注册表里还没有「能直接采」的条目。'));
        console.log(C.dim('  unverified 的那些要先试通了才会出现在这里 —— 没试过就是没试过。'));
        return;
      }
      console.log(C.dim('# 粘进 data/facts/sources.yaml 的 sources: 下面。'));
      console.log(C.dim('# 刻意不直接写文件：采哪几家是你的订阅，不该由注册表替你决定。'));
      console.log(snippet);
      return;
    }

    const rows = opts.status ? all.filter((e) => e.status === opts.status) : all;
    const mark: Record<string, string> = {
      ok: C.green('ok'),
      needs_browser_ua: C.yellow('需开 UA'),
      needs_cdp: C.yellow('待通道B'),
      unverified: C.dim('未验证'),
      broken: C.red('已坏'),
    };
    for (const e of rows) {
      const via = e.channel === 'api' ? `api:${e.adapter}` : e.ats ? `ats:${e.ats.kind}` : e.channel;
      console.log(
        `${e.id.padEnd(14)} ${(mark[e.status] ?? e.status).padEnd(18)} ${via.padEnd(14)} ` +
          `${C.dim(e.verified_at ?? '—')}  ${e.name}`,
      );
      if (e.note) console.log(C.dim(`               ${e.note}`));
    }

    const st = registryStats(all);
    console.log('');
    console.log(
      `共 ${st.total} 家：` +
        Object.entries(st.byStatus).map(([k, v]) => `${k} ${v}`).join('　') +
        `　${C.dim(`${st.stale} 家超过 90 天没验证`)}`,
    );
    console.log(C.dim('  「未验证」不是缺陷，是诚实 —— 没试过的路径就不该写成能走。'));
    console.log(C.dim('  下一步：assit registry --emit-sources'));
  });

program
  .command('recordings')
  .description('面试录音：清单与保留期。录制本身在桌面端（需要浏览器音频 API）')
  .option('--prune', '立即执行过期清理', false)
  .option('--delete <id>', '删掉某一份的音频（记录行保留）')
  .action((opts) => {
    const db = openDb();
    try {
      // 和桌面端启动时做的是同一件事：上次崩溃留下的半截录音要么入库要么判失败
      const rec = recoverStale(db);
      if (rec.recovered.length) console.log(C.yellow(`恢复了 ${rec.recovered.length} 份上次异常退出的录音`));
      if (rec.failed.length) console.log(C.red(`${rec.failed.length} 份没有留下可用音频`));

      if (opts.delete) {
        const ok = deleteRecordingAudio(db, opts.delete);
        console.log(ok ? C.green('音频已删，记录行保留') : C.yellow('没有找到可删的音频'));
        return;
      }
      if (opts.prune) {
        const r = pruneRecordings(db);
        console.log(`清理 ${r.purged.length} 份过期音频，跳过 ${r.keptByFlag} 份已标保留`);
        return;
      }

      const rows = listRecordings(db);
      if (rows.length === 0) {
        console.log('还没有录音。');
        console.log(C.dim('  录制在桌面端：pnpm desktop → 面试录音。'));
        console.log(C.dim('  CLI 录不了 —— 采集用的是浏览器的音频 API，不是 Node 能做的事。'));
        return;
      }
      console.log(C.bold('开始时间            时长      大小      状态      名称'));
      for (const r of rows) {
        const dur = `${String(Math.floor(r.durationSec / 60)).padStart(2, '0')}:${String(Math.floor(r.durationSec % 60)).padStart(2, '0')}`;
        const size = r.bytes > 1 << 20 ? `${(r.bytes / (1 << 20)).toFixed(1)}MB` : `${Math.round(r.bytes / 1024)}KB`;
        const state = !r.fileExists ? C.dim('音频已删') : r.keep ? C.green('永久保留') : `到期 ${r.purgeAfter?.slice(5, 10) ?? '—'}`;
        console.log(
          `${r.startedAt.slice(0, 16).replace('T', ' ')}  ${dur.padStart(6)}  ${size.padStart(8)}  ${state.padEnd(9)} ${r.label}`,
        );
        if (r.error) console.log(C.yellow(`    ${r.error}`));
      }
      console.log('');
      console.log(C.dim('  音频默认 30 天后自动删，记录行永远保留 —— 行里不含音频内容，'));
      console.log(C.dim('  但「哪天、哪个岗位、录了多久」正是复盘时唯一还需要的东西。'));
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
    // rubric 坏掉的表现是「岗位都没有分数」，非常不像一个配置问题 ——
    // 所以它必须出现在自检里，而不是只在打分时抛一次异常。
    const rubricFindings = validateRubricFile();
    const rubricErr = rubricFindings.find((f) => f.severity === 'error');
    rows.push([
      '打分规则 rubric',
      !rubricErr,
      rubricErr ? `${rubricErr.file}：${rubricErr.message}` : (() => {
        try {
          return `${path.basename(loadRubric().file)}@${loadRubric().version}`;
        } catch {
          return '未配置（岗位仍可入库，只是没有分数）';
        }
      })(),
    ]);
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
