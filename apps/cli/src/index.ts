#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  buildProvider,
  complete,
  collect,
  addQuestion,
  addTurn,
  CATEGORY_TO_EVENT,
  claimDrillStats,
  claimsToReview,
  classifyBySubject,
  clearLock,
  currentProfileVersion,
  detectEngine,
  detectBackend,
  drillBoard,
  dueToday,
  endSession,
  ensureDir,
  explainModule,
  findChrome,
  generateResume,
  fetchRecent,
  funnel,
  guardStatus,
  ignoreJob,
  ingestPosting,
  isGitRepo,
  listAuthors,
  loadFactsOrThrow,
  loadReposOnly,
  loadRubric,
  deleteRecordingAudio,
  gatherProbeContext,
  getPassword,
  gradeQuestion,
  knownDomainsFromApplications,
  generateProbes,
  listRecordings,
  AgentBrowserCliBridge,
  applicationSnapshot,
  applyRegistrySync,
  doctorRegistry,
  fetchUpstreamEntries,
  loadRegistry,
  loadSources,
  logApplicationEvent,
  setPassword,
  openDb,
  pastedPosting,
  parseSplitOutput,
  paths,
  pipeline,
  readDataPointer,
  preflight,
  pruneRecordings,
  persistExplanation,
  persistScan,
  proposeClaims,
  registryStats,
  registryToSourcesYaml,
  recordAnswer,
  recordApplication,
  recoverStale,
  planRegistrySync,
  reparseJobs,
  rubricReview,
  runSource,
  scanRepo,
  sessionSummary,
  startSession,
  scoreAllJobs,
  sourceHealth,
  writeBackRegistry,
  userConfigFile,
  writeDataPointer,
  writeIcs,
  syncFacts,
  transcribeRecording,
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

/**
 * `assit sources doctor`。
 *
 * 输出里刻意把「真采到了」和「只是主页能开」分成两栏显示 ——
 * 把后者当成前者，是这个功能最容易骗自己的地方。
 */
async function sourcesDoctor(opts: {
  only?: string;
  homepages?: boolean;
  write?: boolean;
}): Promise<void> {
  const entries = loadRegistry();
  if (entries.length === 0) {
    console.log('注册表是空的。');
    return;
  }
  const only = opts.only ? String(opts.only).split(',').map((x) => x.trim()) : undefined;

  // 用户在 sources.yaml 里怎么配的，doctor 就怎么打 —— 验的必须是他真实的采集路径。
  const overrides = new Map<string, { browserUa?: boolean }>();
  try {
    for (const src of loadSources()) {
      if (src.platform === 'api') overrides.set(src.id, { browserUa: src.browser_ua });
    }
  } catch {
    /* 没配 sources.yaml 也能 doctor，只是全用诚实 UA */
  }

  const results = await doctorRegistry(entries, {
    only,
    sourceOverrides: overrides,
    probeHomepages: opts.homepages !== false,
    onProgress: (done, total, cur) => {
      if (cur) process.stderr.write(`\r  探测 ${done + 1}/${total} ${cur.padEnd(16)}`);
      else process.stderr.write('\r'.padEnd(40) + '\r');
    },
  });

  const collect = results.filter((r) => r.kind === 'collect');
  const reach = results.filter((r) => r.kind === 'reachability');

  console.log(C.bold('真跑了一次采集'));
  if (collect.length === 0) console.log(C.dim('  （没有配了采集路径的条目）'));
  for (const r of collect) {
    const mark = r.ok ? C.green(' ✓') : r.status === 'needs_browser_ua' ? C.yellow(' !') : C.red(' ✗');
    console.log(`${mark}  ${r.id.padEnd(14)} ${String(r.ms + 'ms').padStart(7)}  ${r.detail}`);
  }

  if (reach.length > 0) {
    console.log('');
    console.log(C.bold('只探了主页') + C.dim('  —— 这说明不了能不能采到岗位'));
    const bad = reach.filter((r) => !r.ok);
    console.log(C.dim(`  ${reach.length - bad.length} 个主页正常`));
    for (const r of bad) console.log(`${C.red(' ✗')}  ${r.id.padEnd(14)} ${r.detail}`);
  }

  if (!opts.write) {
    console.log('');
    console.log(C.dim('  只是看看，没有写回。加 --write 把 status / verified_at 写进注册表。'));
    return;
  }
  const wrote = writeBackRegistry(results);
  const n = wrote.reduce((a, w) => a + w.updated.length, 0);
  console.log('');
  if (n === 0) {
    console.log('注册表没有需要改的。');
  } else {
    for (const w of wrote) {
      for (const u of w.updated) console.log(`${C.yellow('updated')} ${u.id}: ${u.from} → ${u.to}`);
    }
  }
  console.log(C.dim('  verified_at 只在**真采到岗位**时才更新 —— 主页能开不算验证过。'));
}

program
  .command('sources [action]')
  .description('采集源健康度（action=doctor 时逐条真打一次并回写注册表）')
  .option('--only <ids>', 'doctor：只查这几个，逗号分隔')
  .option('--no-homepages', 'doctor：跳过只能探主页的那些，快很多')
  .option('--write', 'doctor：把结果写回注册表', false)
  .action(async (action: string | undefined, opts: any) => {
    if (action === 'doctor') {
      await sourcesDoctor(opts);
      return;
    }
    if (action) throw new Error(`不认识的动作 ${action}。可用：doctor`);
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
  .command('registry-sync')
  .description('从上游同步雇主注册表：拉取 → 显示 diff → 人工确认后才写入')
  .requiredOption('--repo <owner/name>', 'GitHub 仓库')
  .requiredOption('--commit <sha>', '**完整 40 位 commit sha**，不接受分支名')
  .option('--path <file>', '仓库内路径', 'vendor/employer-registry/cn.yaml')
  .option('--apply', '已经看过 diff，执行写入', false)
  .option('--include-edited', '连本地手改过的条目也覆盖（默认跳过）', false)
  .option('--only <ids>', '只应用这几个，逗号分隔')
  .action(async (opts) => {
    const src = { repo: opts.repo, commit: opts.commit, filePath: opts.path };
    const plan = await planRegistrySync(src, loadRegistry());

    console.log(C.dim(`上游 ${plan.url}`));
    console.log(`上游 ${plan.upstreamCount} 家 · 本地 ${plan.localCount} 家`);
    if (plan.changes.length === 0) {
      console.log(C.green('没有差异。'));
      return;
    }
    console.log('');
    for (const c of plan.changes) {
      const tag = c.kind === 'add' ? C.green('+ 新增') : c.kind === 'remove' ? C.dim('- 上游已无') : C.yellow('~ 变更');
      const note = c.locallyEdited && c.kind !== 'remove' ? C.dim('（本地手改过，默认跳过）') : '';
      console.log(`${tag} ${c.id} ${note}`);
      for (const f of c.fields) {
        console.log(C.dim(`      ${f.key}: ${JSON.stringify(f.from) ?? '—'} → ${JSON.stringify(f.to)}`));
      }
    }

    if (!opts.apply) {
      console.log('');
      console.log(C.bold('没有写入任何东西。'));
      console.log(C.dim('  注册表里存的是采集器接下来要去请求的 URL —— 被污染的条目会让采集器'));
      console.log(C.dim('  去打攻击者的服务器，抓回来的东西还会以可信来源的身份进池、进打分、进简历。'));
      console.log(C.dim('  所以这一步必须有人看。看完了加 --apply。'));
      return;
    }

    const entries = await fetchUpstreamEntries(src);
    const r = applyRegistrySync(plan, entries, {
      includeLocallyEdited: Boolean(opts.includeEdited),
      only: opts.only ? String(opts.only).split(',').map((x: string) => x.trim()) : undefined,
    });
    console.log('');
    console.log(`写入 ${path.relative(process.cwd(), r.file)}：新增 ${r.added.length}、更新 ${r.updated.length}、跳过 ${r.skipped.length}`);
    if (r.skipped.length > 0) {
      console.log(C.dim(`  跳过的是本地手改过的：${r.skipped.join('、')}　（要覆盖加 --include-edited）`));
    }
    console.log(C.dim('  上游条目一律标 unverified —— 别人说它能采，不等于你这里能采。'));
    console.log(C.dim('  跑一次 `assit sources doctor --write` 才会变成真实状态。'));
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
  .command('apply <postingId>')
  .description('记录一次投递：四份内容寻址快照 + 去重 + 冷却检查')
  .option('--resume <pdf>', '实际发出去的那个 PDF 路径')
  .option('--channel <c>', 'chat / form / email / external', 'chat')
  .option('--greeting <text>', '实际发出的话术')
  .option('--confirm', '我已经真的投出去了，记录它', false)
  .option('--override-cooldown', '冷却期内仍要投（换了部门之类）', false)
  .action((postingId, opts) => {
    const db = openDb();
    try {
      const pre = preflight(db, { jobId: '', postingId });
      console.log(C.bold(`${pre.company} · ${pre.title}`));
      console.log(`  职能 ${pre.roleFamily}　分数 ${pre.finalScore ?? '—'}　投递键 ${pre.applicationKey}`);
      if (pre.alreadyApplied) {
        console.log(C.red(`  这个挂牌已经投过：${pre.alreadyApplied.sentAt}（${pre.alreadyApplied.id}）`));
        return;
      }
      if (pre.cooldown.blocked) {
        console.log(C.yellow(`  ⚠ ${pre.cooldown.reason}`));
      }
      if (!pre.jdSha256) console.log(C.red('  没有 JD 存档 —— 投了也还原不出当时看到的 JD'));

      if (!opts.confirm) {
        console.log('');
        console.log(C.bold('没有记录任何东西。'));
        console.log(C.dim('  这个命令不会替你投递 —— 它记录你**已经**投出去的那一次。'));
        console.log(C.dim('  真投完了再回来加 --confirm --resume <你实际发出的 PDF>。'));
        return;
      }
      if (!opts.resume) throw new Error('--confirm 必须同时给 --resume：没有快照的投递记录三个月后什么也还原不出来');

      const r = recordApplication(db, {
        postingId,
        channel: opts.channel,
        resumePdf: fs.readFileSync(opts.resume),
        greeting: opts.greeting,
        confirmedByUser: true,
        overrideCooldown: Boolean(opts.overrideCooldown),
      });
      console.log('');
      console.log(`${C.green('recorded')} ${r.id}`);
      r.snapshots.forEach((s2) => console.log(C.dim(`  ${s2.kind.padEnd(9)} ${s2.sha256.slice(0, 12)}`)));
    } finally {
      db.close();
    }
  });

program
  .command('applications')
  .description('投递管线与漏斗')
  .option('--funnel <dim>', 'score / channel / role')
  .option('--show <id>', '还原一条投递当时发出去的东西')
  .action((opts) => {
    const db = openDb();
    try {
      if (opts.show) {
        const s2 = applicationSnapshot(db, opts.show);
        console.log(C.bold('简历'), s2.resume ? `${s2.resume.length} 字节` : C.red('读不到了'));
        console.log(C.bold('话术'), s2.greeting ?? C.dim('—'));
        s2.forms.forEach((f) => console.log(C.bold('表单'), f.domain, JSON.stringify(f.data).slice(0, 200)));
        console.log(C.bold('当时的 JD'));
        console.log(C.dim((s2.jd ?? '(读不到了)').slice(0, 600)));
        return;
      }
      if (opts.funnel) {
        const rows = funnel(db, opts.funnel);
        if (rows.length === 0) { console.log('还没有投递记录。'); return; }
        console.log(C.bold('分组        投出   回复   面试   offer   回复率'));
        for (const b of rows) {
          const rate = b.replyRate === null
            ? C.dim('样本不足')
            : `${Math.round(b.replyRate * 100)}%`;
          console.log(
            `${b.label.padEnd(11)} ${String(b.sent).padStart(4)} ${String(b.replied).padStart(6)} ` +
              `${String(b.interviewed).padStart(6)} ${String(b.offered).padStart(7)}   ${rate}`,
          );
        }
        console.log('');
        console.log(C.dim('  样本 <5 不给比率：3 投 1 回不是 33%，是「还不知道」——'));
        console.log(C.dim('  而那个数字会让你真的据此改策略。'));
        return;
      }

      const rows = pipeline(db);
      if (rows.length === 0) {
        console.log('还没有投递记录。');
        console.log(C.dim('  投完一家之后：assit apply <postingId> --confirm --resume out/xxx.pdf'));
        return;
      }
      console.log(C.bold('投出时间        天前  分数  状态       公司 · 职位'));
      for (const r of rows) {
        const flag = r.unconfirmedEvents > 0 ? C.yellow(` ●${r.unconfirmedEvents}`) : '';
        console.log(
          `${r.sentAt.slice(0, 16).replace('T', ' ')}  ${String(r.daysSince).padStart(4)}  ` +
            `${String(r.finalScore ?? '—').padStart(4)}  ${r.status.padEnd(10)} ${r.company} · ${r.title}${flag}`,
        );
      }
      console.log('');
      console.log(C.dim('  ● = 有未确认的事件（邮件解析出来的要人点过才算数）'));
    } finally {
      db.close();
    }
  });

program
  .command('guard [action] [platform]')
  .description('平台访问闸门：今天用了多少预算、有没有被风控锁住（action=unlock 解锁）')
  .action((action: string | undefined, platform: string | undefined) => {
    const db = openDb();
    try {
      if (action === 'unlock') {
        if (!platform) throw new Error('要解锁哪个平台？如 `assit guard unlock boss`（全局是 `*`）');
        clearLock(db, platform);
        console.log(`${C.green('unlocked')} ${platform}`);
        console.log(C.dim('  被风控过几次仍然记着 —— 那是要能查的。'));
        return;
      }
      if (action) throw new Error(`不认识的动作 ${action}。可用：unlock`);

      const platforms = (db
        .prepare("SELECT DISTINCT platform FROM platform_access_events UNION SELECT platform FROM platform_safety_state")
        .all() as { platform: string }[]).map((r) => r.platform);
      if (platforms.length === 0) { console.log('还没有任何平台访问记录。'); return; }

      for (const p of platforms) {
        const st = guardStatus(db, p);
        const head = p === '*' ? C.bold('（全局）') : C.bold(p);
        const lock = st.locked
          ? C.red(`已锁 · ${st.kind} · ${st.reason ?? ''}`)
          : st.hits > 0 ? C.dim(`未锁（历史命中 ${st.hits} 次）`) : C.dim('未锁');
        console.log(`${head}  今日 ${st.usedToday}/${st.dailyLimit}　${lock}`);
        for (const s2 of st.byStage) {
          console.log(C.dim(`    ${s2.stage.padEnd(8)} ${s2.used}${s2.limit !== null ? `/${s2.limit}` : ''}`));
        }
      }
      console.log('');
      console.log(C.dim('  锁是按平台的：BOSS 被限流说明不了 51job 的任何事。'));
      console.log(C.dim('  解锁要人来做，不会自动恢复 —— 平台刚告诉过你它注意到你了。'));
    } finally {
      db.close();
    }
  });

program
  .command('bridge')
  .description('检查浏览器桥（通道 B 用它接管你自己已登录的 Chrome）')
  .action(async () => {
    const b = new AgentBrowserCliBridge();
    const h = await b.health();
    console.log(`${h.ok ? C.green(' ✓') : C.yellow(' ✗')}  ${b.name}  ${C.dim(h.detail)}`);
    if (!h.ok) {
      console.log('');
      console.log(C.dim('  桥装不上也不影响主流程：BOSS / 51job 用 `assit ingest` 手动粘贴，'));
      console.log(C.dim('  去重、解析、打分、投递记录，下游处理完全一样。'));
    }
  });

program
  .command('transcribe <recordingId>')
  .description('本地转写一份面试录音。**音频不出本机，没有云端兜底**')
  .option('--lang <l>', '语言', 'zh')
  .action(async (id, opts) => {
    const e = detectEngine();
    if (!e) {
      console.log(C.yellow('没有本地转写引擎。'));
      console.log(C.dim('  brew install whisper-cpp    然后下个模型放到 ~/.cache/whisper/'));
      console.log(C.dim('  pipx install faster-whisper'));
      console.log(C.dim('  不会有云端兜底 —— 面试录音里有对方的声音，那是别人的个人信息。'));
      return;
    }
    console.log(C.dim(`引擎 ${e.engine} · ${e.bin}`));
    const db = openDb();
    try {
      const r = await transcribeRecording(db, id, { language: opts.lang });
      console.log(`${C.green('ok')} ${r.chars} 字 · ${r.segments} 段 · ${r.sha256.slice(0, 12)}`);
      console.log(C.dim('  音频 30 天后自动删，转写留着 —— 结构化文本不含声纹，却是复盘唯一需要的东西。'));
    } finally {
      db.close();
    }
  });

program
  .command('probe <claimId>')
  .description('项目深挖：按 claim 的真实 commit 出追问题（private/nda 只走本地模型）')
  .option('--repo <path>', '仓库本地路径')
  .option('--count <n>', '出几个问题', '4')
  .option('--session <label>', '把这些问题记进一个会话，之后可以逐个作答')
  .action(async (claimId, opts) => {
    const facts = loadFactsOrThrow();
    const claim = facts.claims.find((c) => c.id === claimId);
    if (!claim) throw new Error(`事实库里没有主张 ${claimId}`);
    const repo = opts.repo
      ?? loadReposOnly().repos.find((r) => r.full_name === claim.code_evidence?.repo)?.local_path;
    if (!repo) throw new Error('不知道仓库在哪。给 --repo，或者在 repos.yaml 里配上 local_path');

    const ctx = gatherProbeContext(claim, repo);
    console.log(C.dim(`${ctx.diffs.length} 个 commit · visibility=${ctx.visibility}`));
    const db = openDb();
    try {
      const qs = await generateProbes(ctx, { db, count: Number(opts.count) });
      if (qs.length === 0) {
        console.log(C.yellow('模型没出题（或者出的题都没有依据，被丢掉了）。'));
        return;
      }
      let sessionId: string | null = null;
      if (opts.session) {
        sessionId = startSession(db, { kind: 'mock', label: opts.session });
      }
      qs.forEach((q, i) => {
        console.log('');
        console.log(C.bold(`${i + 1}. ${q.question}`));
        console.log(C.dim(`   依据：${q.basis}`));
        if (sessionId) {
          const t = addTurn(db, { sessionId, question: q.question, claimId, questionBasis: q.basis });
          console.log(C.dim(`   ${t}`));
        }
      });
      if (sessionId) {
        console.log('');
        console.log(C.dim(`  作答：assit answer <turnId> --verdict solid|shaky|failed|skipped`));
      }
    } finally {
      db.close();
    }
  });

program
  .command('answer <turnId>')
  .description('记录一次作答与自评。**自评由你填，不是模型判的**')
  .requiredOption('--verdict <v>', 'solid | shaky | failed | skipped')
  .option('--text <t>', '你的回答')
  .action((turnId, opts) => {
    const ok = ['solid', 'shaky', 'failed', 'skipped'];
    if (!ok.includes(opts.verdict)) throw new Error(`verdict 只能是 ${ok.join(' / ')}`);
    const db = openDb();
    try {
      const fx = recordAnswer(db, { turnId, answer: opts.text ?? '', verdict: opts.verdict });
      if (fx.length === 0) {
        console.log(C.green('已记录。') + C.dim(' 账本没有变化。'));
        return;
      }
      console.log(C.yellow('账本发生了变化 —— 这是这个系统唯一的闭环：'));
      for (const f of fx) {
        console.log(`  ${f.claimId}　${f.field}：${f.from} → ${C.bold(f.to)}`);
        console.log(C.dim(`    ${f.reason}`));
      }
      console.log(C.dim('  下一份简历不会再那样写了。要撤销就编辑 claims/ 里的文件再 assit sync。'));
    } finally {
      db.close();
    }
  });

program
  .command('drill-stats')
  .description('每条主张被追问的历史 —— 简历上哪几条你其实讲不清楚')
  .action(() => {
    const db = openDb();
    try {
      const rows = claimDrillStats(db);
      if (rows.length === 0) { console.log('事实库里还没有主张（或者还没 assit sync）。'); return; }
      console.log(C.bold('问过  答住  答砸  状态      等级              主张'));
      for (const r of rows) {
        const fail = r.failed > 0 ? C.red(String(r.failed).padStart(4)) : C.dim('   0');
        console.log(
          `${String(r.asked).padStart(4)} ${String(r.solid).padStart(5)} ${fail}  ` +
            `${r.status.padEnd(8)} ${r.level.padEnd(16)} ${r.fact.slice(0, 40)}`,
        );
      }
      console.log('');
      console.log(C.dim('  答砸最多的排最前 —— 那正是下一场最该准备的。'));
      console.log(C.dim('  「问过 0 次」的也值得注意：没被追问过的主张，可信度没有被验证过。'));
    } finally {
      db.close();
    }
  });

program
  .command('quiz')
  .description('今天该复习什么。真实面试答错的题排最前')
  .option('--limit <n>', '', '20')
  .option('--grade <spec>', '记一次评分：<questionId>:<0-5>')
  .action((opts) => {
    const db = openDb();
    try {
      if (opts.grade) {
        const [qid, g] = String(opts.grade).split(':');
        const grade = Number(g);
        if (!qid || Number.isNaN(grade) || grade < 0 || grade > 5) {
          throw new Error('格式是 --grade <questionId>:<0-5>');
        }
        const r = gradeQuestion(db, qid, grade as 0 | 1 | 2 | 3 | 4 | 5);
        console.log(`${C.green('ok')} 下次 ${r.dueInDays} 天后（${r.nextReviewAt.slice(0, 10)}）`);
        if (grade < 3) console.log(C.dim('  <3 算没答上来：重复次数归零，明天再来。'));
        return;
      }
      const rows = dueToday(db, Number(opts.limit));
      if (rows.length === 0) {
        const b = drillBoard(db);
        console.log(b.total === 0 ? '题库是空的。' : C.green('今天没有到期的题。'));
        return;
      }
      for (const q of rows) {
        const cred = q.credibility === 'verified' ? C.green('[真题]')
          : q.credibility === 'secondhand' ? C.yellow('[二手]') : C.dim('[未核实]');
        console.log('');
        console.log(`${cred} ${C.bold(q.content)}`);
        console.log(C.dim(`  ${q.topic ?? '未分类'} · 来源 ${q.sourceRef} · 复习过 ${q.repetitions} 次`));
        console.log(C.dim(`  assit quiz --grade ${q.id}:<0-5>`));
      }
    } finally {
      db.close();
    }
  });

program
  .command('questions [action]')
  .description('题库：add 录入一道题，split 把整段面经拆成候选题（不自动入库）')
  .option('--content <c>', '题目')
  .option('--topic <t>', '主题')
  .option('--source-type <t>', 'web_scrape | manual | real_interview | claim_derived | official_doc', 'manual')
  .option('--source-ref <r>', '**必填**：URL、面经出处、或「2026-09-12 某某一面」')
  .option('--file <f>', 'split：面经原文文件')
  .action(async (action, opts) => {
    const db = openDb();
    try {
      if (action === 'add') {
        const r = addQuestion(db, {
          content: opts.content ?? '', topic: opts.topic,
          sourceType: opts.sourceType, sourceRef: opts.sourceRef ?? '',
        });
        console.log(r.created ? `${C.green('added')} ${r.id}`
          : r.upgraded ? `${C.yellow('已存在，可信度提升了')} ${r.id}`
          : `${C.dim('已存在，跳过')} ${r.id}`);
        return;
      }
      if (action === 'split') {
        if (!opts.file) throw new Error('--file 指向面经原文');
        if (!opts.sourceRef) throw new Error('--source-ref 必填：没有来源的题进了库就再也分不清');
        const text = fs.readFileSync(opts.file, 'utf8');
        const r = await complete(
          {
            task: 'question_answer',
            visibility: 'public',
            system: '把面经原文里的面试题逐条抽出来。只要题目，不要「面试官人很好」这类句子。'
              + '输出 JSON 数组：[{"content":"...","topic":"..."}]，不要别的。',
            prompt: text.slice(0, 12000),
          },
          { db },
        );
        const cands = parseSplitOutput(r.text);
        console.log(C.bold(`拆出 ${cands.length} 道候选题。**没有入库** —— 挑你要的逐条 add：`));
        cands.forEach((c, i) => {
          console.log('');
          console.log(`${i + 1}. ${c.content}`);
          console.log(C.dim(`   assit questions add --content ${JSON.stringify(c.content)} `
            + `--topic ${JSON.stringify(c.topic ?? '')} --source-type manual --source-ref ${JSON.stringify(opts.sourceRef)}`));
        });
        console.log('');
        console.log(C.dim('  不自动入库是故意的：模型会把「面试官人很好」也拆成一道题，'));
        console.log(C.dim('  而那种噪音进了库就很难清。'));
        return;
      }

      const b = drillBoard(db);
      console.log(`题库 ${b.total} 道 · 今天到期 ${b.dueNow} 道`);
      console.log(C.dim(`  可信度：${Object.entries(b.byCredibility).map(([k, v]) => `${k} ${v}`).join('　') || '—'}`));
      if (b.byTopic.length > 0) {
        console.log('');
        console.log(C.bold('主题        总数  到期'));
        for (const t of b.byTopic) {
          console.log(`${t.topic.padEnd(11)} ${String(t.total).padStart(4)} ${String(t.due).padStart(5)}`);
        }
      }
      if (b.weakest.length > 0) {
        console.log('');
        console.log(C.bold('错题本') + C.dim('（真实面试答错的排最前）'));
        for (const w of b.weakest.slice(0, 10)) {
          console.log(`  ${w.origin === 'real_interview' ? C.red('真题') : C.dim('刷题')} ${w.content.slice(0, 50)}`);
        }
      }
    } finally {
      db.close();
    }
  });

program
  .command('mail [action] [arg]')
  .description('邮箱：login 存凭据到系统钥匙串，scan 只读扫一遍并提议事件')
  .option('--host <h>', 'IMAP 主机，如 imap.qq.com')
  .option('--days <n>', 'scan：看最近几天', '7')
  .option('--apply', 'scan：把提议的事件写进 application_events（仍是**待确认**）', false)
  .action(async (action, arg, opts) => {
    if (action === 'login') {
      if (!arg) throw new Error('用法：assit mail login <邮箱>');
      if (detectBackend() === 'none') {
        console.log(C.red('找不到系统钥匙串。'));
        console.log(C.dim('  不会退化成明文文件 —— data/ 会被备份、同步到云盘、'));
        console.log(C.dim('  在你打包日志发给别人排查时一起出去。'));
        console.log(C.dim('  Linux：apt install libsecret-tools'));
        return;
      }
      const pw = await new Promise<string>((resolve) => {
        process.stdout.write('应用专用密码（不回显，直接粘贴后回车）：');
        const stdin = process.stdin;
        stdin.setRawMode?.(true);
        let buf = '';
        stdin.on('data', (d) => {
          const s2 = d.toString();
          if (s2 === '\r' || s2 === '\n') {
            stdin.setRawMode?.(false);
            stdin.pause();
            process.stdout.write('\n');
            resolve(buf);
          } else if (s2 === '\u0003') {
            process.exit(1);
          } else if (s2 === '\u007f') {
            buf = buf.slice(0, -1);
          } else {
            buf += s2;
          }
        });
      });
      setPassword(arg, pw);
      console.log(`${C.green('ok')} 已存入系统钥匙串（服务名 assit-interview）`);
      console.log(C.dim('  凭据不进 SQLite、不进配置文件、不进环境变量。'));
      console.log(C.dim(`  扫信：assit mail scan --host imap.xxx.com ${arg}`));
      return;
    }

    if (action === 'scan') {
      if (!arg) throw new Error('用法：assit mail scan --host <imap 主机> <邮箱>');
      if (!opts.host) throw new Error('--host 必填，如 imap.qq.com / imap.gmail.com');
      if (!getPassword(arg)) throw new Error(`钥匙串里没有 ${arg} 的密码。先跑 assit mail login ${arg}`);

      const db = openDb();
      try {
        const known = knownDomainsFromApplications(db);
        const r = await fetchRecent(
          { user: arg, host: opts.host },
          { since: new Date(Date.now() - Number(opts.days) * 86400000), knownDomains: known },
        );
        console.log(`扫过 ${r.seen} 封，白名单放行 ${r.kept} 封。`);
        const skipped = Object.entries(r.skippedReasons);
        if (skipped.length > 0) {
          console.log(C.dim('  被挡掉的（只留统计，正文一个字都没带出来）：'));
          skipped.forEach(([why, n]) => console.log(C.dim(`    ${n} 封 · ${why}`)));
        }
        if (r.kept === 0) return;

        console.log('');
        for (const m of r.mails) {
          const cat = classifyBySubject(m.subject);
          const ev = cat ? CATEGORY_TO_EVENT[cat] : null;
          console.log(C.bold(m.subject));
          console.log(C.dim(`  ${m.from} · ${m.date.slice(0, 10)} · ${m.filterReason}`));
          console.log(C.dim(`  规则判定：${cat ?? '判不了（该问模型了）'}${ev ? ` → 事件 ${ev}` : ''}`));
          if (m.redacted.length > 0) console.log(C.dim(`  已脱敏：${m.redacted.join('、')}`));
        }
        console.log('');
        console.log(C.dim('  这里只提议，不改状态。邮件解析出来的事件一律是**待确认**，'));
        console.log(C.dim('  要你在投递管线里点过才会改投递状态 —— 一封「很遗憾」可能是另一个岗位的。'));
      } finally {
        db.close();
      }
      return;
    }

    console.log('用法：assit mail login <邮箱> | assit mail scan --host <imap> <邮箱>');
    console.log(C.dim('  IMAP 只读：不标已读、不移动、不删除 —— 这是别人也在用的邮箱。'));
  });

program
  .command('calendar <applicationId>')
  .description('为一场面试生成 .ics，带上这场该复习哪几条主张')
  .requiredOption('--at <iso>', '开始时间，如 2026-10-01T14:00:00+08:00')
  .option('--title <t>', '标题')
  .option('--minutes <n>', '时长', '60')
  .option('--location <l>', '地点或会议链接')
  .action((appId, opts) => {
    const db = openDb();
    try {
      const a = db
        .prepare(
          `SELECT a.id, c.canonical_name company, j.title_raw title FROM applications a
             JOIN companies c ON c.id = a.company_id
             JOIN postings p ON p.id = a.posting_id JOIN jobs j ON j.id = p.job_id
            WHERE a.id = ?`,
        )
        .get(appId) as any;
      if (!a) throw new Error(`找不到投递记录 ${appId}`);
      const claims = claimsToReview(db, appId);
      const file = writeIcs([{
        uid: `${appId}@assit`,
        title: opts.title ?? `${a.company} · ${a.title} 面试`,
        startAt: new Date(opts.at).toISOString(),
        durationMin: Number(opts.minutes),
        location: opts.location,
        claimIds: claims,
        applicationId: appId,
      }]);
      console.log(`${C.green('ok')} ${path.relative(process.cwd(), file)}`);
      if (claims.length > 0) {
        console.log(C.dim(`  带上了 ${claims.length} 条要复习的主张：${claims.join('、')}`));
        console.log(C.dim('  提前一小时提醒 —— 那是复习它们的最后窗口。'));
      } else {
        console.log(C.dim('  没找到要复习的主张（这条投递还没关联简历版本，也还没答砸过什么）。'));
      }
      console.log(C.dim('  双击导入。刻意不用 osascript 直接写日历 —— 一个悄悄往你工作日历里'));
      console.log(C.dim('  塞条目的工具，第一次塞错地方你就再也不会信它。'));
    } finally {
      db.close();
    }
  });

program
  .command('link-data [dir]')
  .description('告诉打包后的桌面应用「我的数据在哪」（写一个指针文件，不搬动数据）')
  .action((dir) => {
    if (!dir) {
      const cur = readDataPointer();
      console.log(`当前数据目录：${paths.data}`);
      console.log(cur ? `指针文件：${userConfigFile()} → ${cur}` : C.dim(`没有指针文件（${userConfigFile()}）`));
      console.log('');
      console.log(C.dim('  打包后的应用 cwd 是 `/`，推不出任何仓库路径，所以需要这个指针。'));
      console.log(C.dim('  指向当前数据目录：assit link-data .'));
      return;
    }
    const target = dir === '.' ? paths.data : dir;
    const file = writeDataPointer(target);
    console.log(`${C.green('ok')} ${file}`);
    console.log(C.dim(`  → ${path.resolve(target.replace(/^~/, process.env.HOME ?? '~'))}`));
    console.log(C.dim('  **数据一个字节都没动。** 删掉这个文件就回到默认位置。'));
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
