import fs from 'node:fs';
import path from 'node:path';
import { Claim } from '@assit/contract';
import { ensureDir, paths } from '../util/paths.js';
import type { ModuleExplanation } from './explain.js';
import type { ModuleAttribution, RepoScan } from './intersect.js';

/**
 * 把解读结果落成「待确认」的候选主张 + 一份复核清单。
 *
 * 两个产物，两个用途：
 *   - claims/*.json  进事实库，状态一律「待确认」—— 它们进不了最终 PDF，
 *                    直到你逐条看过、改过、把 last_verified 填上。
 *   - proposals/*.md 复核清单。上面有算出来的归因事实、模型的解读、
 *                    以及一组等你回答的追问题。
 *
 * 为什么不直接生成「已确认」的主张：因为模型不知道你当时为什么那么做。
 * 它能看出你改了 lock.go，看不出你是被压测数据逼着改的还是拍脑袋改的 ——
 * 而后者恰恰是面试官真正要问的。这一步的产物是**待办**，不是成品。
 */

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'root';
}

/**
 * boundary 由归因算出来，不问模型。
 * 「这块一共 5 个人改过，我占 62%」是可核实的事实；
 * 让模型猜「团队负责整体、我负责核心」是编的。
 */
export function computeBoundary(mod: ModuleAttribution): string {
  const parts = [
    `模块共 ${mod.fileCount} 个文件`,
    mod.totalCommits > 0 ? `${mod.totalCommits} 次提交` : null,
    mod.otherAuthors > 0
      ? `另有 ${mod.otherAuthors} 位作者参与`
      : mod.totalCommits > 0
        ? '历史上只有我提交过'
        : null,
  ].filter(Boolean);

  const mine =
    `我的部分：${mod.myCommits} 次提交、+${mod.myAdded}/-${mod.myDeleted} 行，` +
    `占该模块全部改动的 ${(mod.myShare * 100).toFixed(0)}%` +
    (mod.myFiles.length ? `，主要在 ${mod.myFiles.slice(0, 3).map((f) => path.basename(f.path)).join('、')}` : '');

  return `${parts.join('、')}。${mine}。【请改写成一句你能在面试里说出口的话】`;
}

export interface ProposeResult {
  claimFiles: string[];
  worksheetPath: string;
  proposed: number;
  skipped: { module: string; reason: string }[];
}

export interface ProposeOptions {
  outDir?: string;
  claimsDir?: string;
  /** 已存在同名文件时覆盖 */
  force?: boolean;
  now?: Date;
}

export function proposeClaims(
  scan: RepoScan,
  explanations: ModuleExplanation[],
  opts: ProposeOptions = {},
): ProposeResult {
  const claimsDir = ensureDir(opts.claimsDir ?? paths.claimsDir);
  const outDir = ensureDir(path.join(opts.outDir ?? paths.out, 'proposals'));
  const repoSlug = slug(scan.repo.full_name.split('/').pop() ?? scan.repo.full_name);
  const byPath = new Map(scan.modules.map((m) => [m.path, m]));

  const claimFiles: string[] = [];
  const skipped: { module: string; reason: string }[] = [];
  let seq = 0;

  for (const ex of explanations) {
    const mod = byPath.get(ex.modulePath);
    if (!mod) continue;
    if (ex.claims.length === 0) {
      skipped.push({
        module: ex.modulePath,
        reason:
          ex.discarded.length > 0
            ? `模型的结论都指不回具体文件（${ex.discarded.length} 条已丢弃）`
            : '模型没有给出候选要点',
      });
      continue;
    }

    for (const d of ex.claims) {
      seq += 1;
      const id = `claim-${repoSlug}-${String(seq).padStart(3, '0')}`;
      const commits = mod.myTopCommits.map((c) => c.sha);
      const draft = {
        id,
        source_fact: d.source_fact,
        candidate_wording: d.candidate_wording,
        // 模型给的等级只是建议，且已经在 explain 层做过保守化。
        // 这个字段最终只能由你确认 —— 行数和提交占比推不出责任等级。
        responsibility_level: d.suggested_level,
        verification_status: '待确认',
        boundary: computeBoundary(mod),
        visibility: scan.repo.visibility,
        code_evidence: {
          repo: scan.repo.full_name,
          prs: [],
          commits,
          files_touched: d.evidence_files,
          modules: [mod.path],
          loc: { added: mod.myAdded, deleted: mod.myDeleted },
          author_share_in_pr: Number(mod.myShare.toFixed(2)),
          is_core_path: mod.dependedBy.length > 0,
          visibility: scan.repo.visibility,
        },
        // 刻意留空：这四项只有你知道。模型能看出你改了什么，
        // 看不出你当时在权衡什么 —— 而那才是面试真正问的。
        interview_details: {},
        metrics: [],
        allowed_uses: [],
        tags: [...new Set([...mod.languages.map((e) => e.replace('.', '')), mod.path])].slice(0, 8),
        risk_notes: `由 assit propose 生成，尚未复核。${d.boundary_hint ? `模型对边界的猜测：${d.boundary_hint}` : ''}`,
        last_verified: null,
      };

      const parsed = Claim.safeParse(draft);
      if (!parsed.success) {
        skipped.push({
          module: ex.modulePath,
          reason: `生成的候选没通过 schema：${parsed.error.issues[0]?.message ?? '?'}`,
        });
        continue;
      }

      const file = path.join(claimsDir, `${id}.json`);
      if (fs.existsSync(file) && !opts.force) {
        skipped.push({ module: ex.modulePath, reason: `${id}.json 已存在，没有覆盖（加 --force）` });
        continue;
      }
      fs.writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
      claimFiles.push(file);
    }
  }

  const worksheetPath = path.join(outDir, `${repoSlug}.md`);
  fs.writeFileSync(worksheetPath, renderWorksheet(scan, explanations, claimFiles, opts.now), 'utf8');

  return { claimFiles, worksheetPath, proposed: claimFiles.length, skipped };
}

function renderWorksheet(
  scan: RepoScan,
  explanations: ModuleExplanation[],
  claimFiles: string[],
  now = new Date(),
): string {
  const byPath = new Map(scan.modules.map((m) => [m.path, m]));
  const L: string[] = [];

  L.push(`# 复核清单 · ${scan.repo.full_name}`);
  L.push('');
  L.push(
    `扫描于 ${now.toISOString().slice(0, 16).replace('T', ' ')}　` +
      `HEAD \`${(scan.headSha ?? '').slice(0, 8)}\`　可见性 ${scan.repo.visibility}`,
  );
  L.push('');
  L.push(
    `结构：${scan.graph.files.length} 个源文件 / ${scan.graph.modules.length} 个模块。` +
      `归因：匹配到你的 ${scan.attribution.myCommits.length} 次提交（全仓 ${scan.attribution.totalCommits} 次）。` +
      `求交：${scan.modules.filter((m) => m.touchedByMe).length} 个模块算「你碰过」。`,
  );
  L.push('');
  L.push('> 生成的候选主张状态都是**待确认**，进不了最终 PDF。');
  L.push('> 这份清单是待办，不是成品 —— 逐条做完下面三件事，它们才算数：');
  L.push('> 1. 改 `boundary`：把算出来的数字改写成一句你能在面试里说出口的话');
  L.push('> 2. 填 `interview_details`：决策 / 难点 / 怎么验证的 / 结果 —— 模型猜不出这四项');
  L.push('> 3. 确认 `responsibility_level`，然后把 `verification_status` 改成「已确认」并填 `last_verified`');
  L.push('');

  if (scan.diagnostics.length > 0) {
    L.push('## ⚠️ 扫描诊断');
    L.push('');
    scan.diagnostics.forEach((d) => L.push(`- ${d}`));
    L.push('');
  }

  for (const ex of explanations) {
    const mod = byPath.get(ex.modulePath);
    if (!mod) continue;
    L.push(`## ${ex.modulePath}`);
    L.push('');
    L.push(
      `\`${mod.fileCount}\` 文件 · 我 \`${mod.myCommits}\` 次提交 \`+${mod.myAdded}/-${mod.myDeleted}\` · ` +
        `占比 \`${(mod.myShare * 100).toFixed(0)}%\` · ` +
        (mod.otherAuthors > 0 ? `另有 ${mod.otherAuthors} 位作者` : '只有我提交过') +
        (mod.firstTouch ? ` · ${mod.firstTouch.slice(0, 7)} ~ ${mod.lastTouch?.slice(0, 7)}` : ''),
    );
    L.push('');
    L.push(`**职责**：${ex.role ?? `_${'未识别'}_ —— 模型没能从代码里推出来，别编`}`);
    if (ex.dataFlow) L.push(`**主链路**：${ex.dataFlow}`);
    if (mod.dependsOn.length) L.push(`**依赖**：${mod.dependsOn.join('、')}`);
    if (mod.dependedBy.length) L.push(`**被依赖**：${mod.dependedBy.join('、')}`);
    L.push('');

    if (ex.tech.length) {
      L.push('| 技术 | 为什么 | 证据 |');
      L.push('|---|---|---|');
      for (const t of ex.tech) {
        L.push(`| ${t.name} | ${t.why} | ${t.evidence.map((e) => `\`${e}\``).join(' ')} |`);
      }
      L.push('');
    }

    if (mod.myTopCommits.length) {
      L.push('<details><summary>我在这个模块的提交</summary>');
      L.push('');
      for (const c of mod.myTopCommits) {
        L.push(`- \`${c.sha.slice(0, 8)}\` ${c.date.slice(0, 10)} ${c.subject}`);
      }
      L.push('');
      L.push('</details>');
      L.push('');
    }

    if (ex.questions.length) {
      L.push('### 等你回答的追问题');
      L.push('');
      L.push('答不上来的，就不要把对应的主张写进简历 —— 那正是这套东西存在的意义。');
      L.push('');
      for (const q of ex.questions) {
        L.push(`**Q：${q.question}**`);
        L.push('');
        L.push(`> 为什么会问：${q.why_they_ask}　证据：${q.evidence.map((e) => `\`${e}\``).join(' ')}`);
        L.push('');
        L.push('A：');
        L.push('');
      }
    }

    if (ex.discarded.length) {
      L.push('<details><summary>被丢弃的结论（指不回具体文件）</summary>');
      L.push('');
      ex.discarded.forEach((d) => L.push(`- ${d}`));
      L.push('');
      L.push('</details>');
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push(`生成了 ${claimFiles.length} 条候选主张：`);
  L.push('');
  claimFiles.forEach((f) => L.push(`- \`${path.basename(f)}\``));
  L.push('');
  L.push('改完跑 `assit validate && assit sync`。');
  return L.join('\n');
}
