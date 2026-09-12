import path from 'node:path';
import fs from 'node:fs';
import { VIS_RANK, type Claim, type Visibility } from '@assit/contract';
import { putArtifact } from '../artifacts.js';
import type { Db } from '../db/index.js';
import type { FactBase } from '../facts/load.js';
import { complete, type CompleteOptions } from '../models/complete.js';
import { newId, sha256 } from '../util/hash.js';
import { ensureDir, paths } from '../util/paths.js';
import { assertRenderable, type BulletDraft, type RenderMode, type Violation } from './guard.js';
import { checkLevelOverreach } from './guard.js';
import { htmlToPdf, renderHtml } from './render.js';
import { baselineBullet, droppedMetrics, selectClaims, type ScoredClaim } from './select.js';

export interface GenerateOptions {
  jdText: string;
  targetRole?: string;
  label?: string;
  mode?: RenderMode;
  max?: number;
  /** 调模型改写措辞。不开就用 candidate_wording 原文。 */
  rewrite?: boolean;
  outDir?: string;
  model?: CompleteOptions;
  now?: Date;
}

export interface GenerateResult {
  resumeVersionId: string;
  bullets: (BulletDraft & { score: number; matched: string[]; rewritten: boolean })[];
  violations: Violation[];
  htmlPath: string;
  pdfPath?: string;
  mappingPath: string;
  jdSha256: string;
  resumeSha256?: string;
  pdfError?: string;
  rewriteSkipped: { claimId: string; reason: string }[];
  /** 最终稿里因为数字未确认而被略过的指标 */
  droppedMetrics: { claimId: string; names: string[] }[];
}

/** 一批 claim 的敏感级取最大值：只要有一条是 private，整个请求就按 private 走。 */
function maxVisibility(claims: Claim[]): Visibility {
  let v: Visibility = 'public';
  for (const c of claims) if (VIS_RANK[c.visibility] > VIS_RANK[v]) v = c.visibility;
  return v;
}

const REWRITE_SYSTEM = `你在按目标 JD 改写简历要点。严格遵守：
1. 只改措辞，不改事实。不得新增任何数字、比例、时间、规模、职级。
2. 不得提升责任等级。给你的每条要点都标了等级，「参与」就不能写成「主导/负责/牵头/led/owned」。
3. 待补占位符 __（需补充：…）__ 原样保留，绝不代填。
4. 输出与输入等量的行，每行一条，不要编号、不要解释、不要 Markdown 标记。
5. 用 JD 里出现的术语替换同义表述，但不要堆砌关键词。`;

function buildRewritePrompt(
  picked: ScoredClaim[],
  jdText: string,
  textOpts: { includePlaceholders: boolean },
  target?: string,
): string {
  const lines = picked.map((p, i) => {
    const c = p.claim;
    return [
      `[${i + 1}] 责任等级：${c.responsibility_level}`,
      `原始事实：${c.source_fact}`,
      `现有表述：${baselineBullet(c, textOpts)}`,
      `边界：${c.boundary}`,
    ].join('\n');
  });
  return [
    `目标岗位：${target ?? '（未指定）'}`,
    '',
    'JD：',
    jdText.slice(0, 6000),
    '',
    '待改写的要点：',
    lines.join('\n\n'),
    '',
    `请输出 ${picked.length} 行改写结果。`,
  ].join('\n');
}

function sectionFor(c: Claim, facts: FactBase): string {
  // 主张能对上某段任职经历就挂过去，否则进项目经历
  const repo = c.code_evidence?.repo ?? '';
  for (const e of facts.profile.records.employment) {
    if (c.tags.includes(e.company) || repo.includes(e.company)) return e.company;
  }
  const tagged = c.tags.find((t) =>
    facts.profile.records.employment.some((e) => e.company === t),
  );
  return tagged ?? '项目';
}

export async function generateResume(
  db: Db | null,
  facts: FactBase,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const mode: RenderMode = opts.mode ?? 'final';
  const now = opts.now ?? new Date();
  const outDir = ensureDir(opts.outDir ?? paths.out);

  const picked = selectClaims(facts.claims, opts.jdText, {
    target: opts.targetRole,
    max: opts.max ?? 8,
    includeUnconfirmed: mode === 'draft',
  });

  if (picked.length === 0) {
    throw new Error(
      '没有任何主张匹配这份 JD。\n' +
        '可能是事实库还太薄（先补 2–3 条 claim），也可能这个岗位确实不该投 —— 后者也是有用的信号。',
    );
  }

  const rewriteSkipped: { claimId: string; reason: string }[] = [];
  // 草稿保留占位符（给你自己看的 TODO），最终稿直接不提没确认的数字
  const textOpts = { includePlaceholders: mode === 'draft' };
  const dropped = picked
    .map((p) => ({ claimId: p.claim.id, names: droppedMetrics(p.claim) }))
    .filter((d) => d.names.length > 0 && !textOpts.includePlaceholders);
  let texts = picked.map((p) => baselineBullet(p.claim, textOpts));
  let rewrittenFlags = picked.map(() => false);

  if (opts.rewrite) {
    const visibility = maxVisibility(picked.map((p) => p.claim));
    const res = await complete(
      {
        task: 'resume_rewrite',
        visibility,
        system: REWRITE_SYSTEM,
        prompt: buildRewritePrompt(picked, opts.jdText, textOpts, opts.targetRole),
        maxTokens: 2000,
      },
      opts.model ?? {},
    );
    const lines = res.text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:\[\d+\]|\d+[.)、]|[-*])\s*/, '').trim())
      .filter(Boolean);

    if (lines.length !== picked.length) {
      rewriteSkipped.push({
        claimId: '*',
        reason: `模型返回 ${lines.length} 行，期望 ${picked.length} 行，整批回退到原表述`,
      });
    } else {
      texts = picked.map((p, i) => {
        const candidate = lines[i]!;
        // 模型越级用词的，这一条回退，不是整批失败，也不是放行
        const over = checkLevelOverreach(candidate, p.claim);
        if (over) {
          rewriteSkipped.push({ claimId: p.claim.id, reason: over.message });
          return baselineBullet(p.claim, textOpts);
        }
        // 占位符被吃掉了说明模型动了数字，同样回退
        const hadPlaceholder = /__（需补充/.test(baselineBullet(p.claim, textOpts));
        if (hadPlaceholder && !/__（需补充/.test(candidate)) {
          rewriteSkipped.push({ claimId: p.claim.id, reason: '改写丢失了待补占位符，疑似代填数字' });
          return baselineBullet(p.claim, textOpts);
        }
        rewrittenFlags[i] = true;
        return candidate;
      });
    }
  }

  const bullets: BulletDraft[] = picked.map((p, i) => ({
    claimId: p.claim.id,
    section: sectionFor(p.claim, facts),
    text: texts[i]!,
  }));

  // 闸门。final 模式下任何问题都在这里抛出来，不会有半合法的 PDF 落地。
  const violations = assertRenderable({
    mode,
    claims: picked.map((p) => p.claim),
    bullets,
    profile: facts.profile,
    now,
  });

  const label = opts.label ?? `${opts.targetRole ?? 'general'}-${now.toISOString().slice(0, 10)}`;
  const versionId = newId('resume-');
  const jd = putArtifact(db, 'jd', 'jd.md', opts.jdText);

  const html = renderHtml(
    { profile: facts.profile, bullets, targetRole: opts.targetRole, now },
    { showClaimRefs: mode === 'draft' },
  );
  const htmlPath = path.join(outDir, `${label}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  const pdfPath = path.join(outDir, `${label}.pdf`);
  const pdf = await htmlToPdf(html, pdfPath);

  let resumeSha256: string | undefined;
  if (pdf.ok) {
    const stored = putArtifact(db, 'resume_pdf', 'resume.pdf', fs.readFileSync(pdfPath));
    resumeSha256 = stored.sha256;
  } else {
    resumeSha256 = putArtifact(db, 'resume_html', 'resume.html', html).sha256;
  }

  const mapping = renderMapping(picked, bullets, rewrittenFlags, {
    label,
    target: opts.targetRole,
    mode,
    jdSha: jd.sha256,
    violations,
    rewriteSkipped,
    dropped,
  });
  const mappingPath = path.join(outDir, `${label}.bullets.md`);
  fs.writeFileSync(mappingPath, mapping, 'utf8');

  if (db) {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO resume_versions (id, label, target_role, format, jd_sha256, rendered_sha256)
         VALUES (?,?,?,'pdf',?,?)`,
      ).run(versionId, label, opts.targetRole ?? null, jd.sha256, resumeSha256 ?? null);
      const ins = db.prepare(
        `INSERT INTO resume_bullets (id, resume_version_id, claim_id, section, text, sort_order)
         VALUES (?,?,?,?,?,?)`,
      );
      bullets.forEach((b, i) => ins.run(newId('bullet-'), versionId, b.claimId, b.section, b.text, i));
    })();
  }

  return {
    resumeVersionId: versionId,
    bullets: bullets.map((b, i) => ({
      ...b,
      score: picked[i]!.score,
      matched: picked[i]!.matched,
      rewritten: rewrittenFlags[i]!,
    })),
    violations,
    htmlPath,
    pdfPath: pdf.ok ? pdfPath : undefined,
    pdfError: pdf.ok ? undefined : pdf.reason,
    mappingPath,
    jdSha256: jd.sha256,
    resumeSha256,
    rewriteSkipped,
    droppedMetrics: dropped,
  };
}

/**
 * bullet ↔ claim 对照表。
 *
 * 这张表才是 M0 真正的产出 —— PDF 谁都能生成，但「这句话凭什么这么写、
 * 证据在哪个 commit、面试被追问时从哪开口」只有这张表回答得了。
 */
function renderMapping(
  picked: ScoredClaim[],
  bullets: BulletDraft[],
  rewritten: boolean[],
  meta: {
    label: string;
    target?: string;
    mode: RenderMode;
    jdSha: string;
    violations: Violation[];
    rewriteSkipped: { claimId: string; reason: string }[];
    dropped: { claimId: string; names: string[] }[];
  },
): string {
  const lines: string[] = [
    `# bullet ↔ 证据对照表 · ${meta.label}`,
    '',
    `目标岗位：${meta.target ?? '（未指定）'}　模式：${meta.mode}　JD 快照：\`${meta.jdSha.slice(0, 12)}\``,
    '',
    '面试前一晚看这张表，不要看简历本身。',
    '',
  ];

  picked.forEach((p, i) => {
    const c = p.claim;
    const b = bullets[i]!;
    const ce = c.code_evidence;
    lines.push(`## ${i + 1}. ${b.text}`);
    lines.push('');
    lines.push(`| 项 | 内容 |`);
    lines.push(`|---|---|`);
    lines.push(`| 主张 | \`${c.id}\` |`);
    lines.push(`| 责任等级 | ${c.responsibility_level} |`);
    lines.push(`| 核实状态 | ${c.verification_status}${c.last_verified ? `（${c.last_verified}）` : ''} |`);
    lines.push(`| 边界 | ${c.boundary} |`);
    lines.push(`| 原始事实 | ${c.source_fact} |`);
    lines.push(`| 表述来源 | ${rewritten[i] ? '模型改写（已过越级检查）' : '账本原文' } |`);
    lines.push(`| 命中 JD 关键词 | ${p.matched.length ? p.matched.join('、') : '（无直接命中，靠证据加权入选）'} |`);
    lines.push(`| 匹配分 | ${p.score} |`);
    if (ce) {
      lines.push(`| 代码证据 | ${ce.repo}${ce.prs.length ? ` PR ${ce.prs.join(' ')}` : ''}${ce.commits.length ? ` commit ${ce.commits.map((s) => s.slice(0, 7)).join(' ')}` : ''} |`);
      if (ce.files_touched.length) lines.push(`| 涉及文件 | ${ce.files_touched.join('、')} |`);
      lines.push(`| 可见性 | ${ce.visibility} |`);
    }
    const d = c.interview_details ?? {};
    const qa = [
      d.decision && `**为什么这么做**：${d.decision}`,
      d.difficulty && `**难点**：${d.difficulty}`,
      d.verification && `**怎么验证的**：${d.verification}`,
      d.result && `**结果**：${d.result}`,
    ].filter(Boolean);
    if (qa.length) {
      lines.push('');
      lines.push('追问时从这里开口：');
      lines.push('');
      qa.forEach((q) => lines.push(`- ${q}`));
    } else {
      lines.push('');
      lines.push('> ⚠️ 这条主张没有追问素材。被问「具体讲讲」时你会卡住 —— 现在补，别等面试前一晚。');
    }
    if (c.risk_notes) {
      lines.push('');
      lines.push(`> 风险备注：${c.risk_notes}`);
    }
    lines.push('');
  });

  if (meta.dropped.length > 0) {
    lines.push('## 最终稿里略过的数字');
    lines.push('');
    lines.push('这些指标还没确认，所以这一版简历没提。补上它们，这几条会明显更有分量：');
    lines.push('');
    meta.dropped.forEach((d) => lines.push(`- \`${d.claimId}\`：${d.names.join('、')}`));
    lines.push('');
  }

  if (meta.rewriteSkipped.length > 0) {
    lines.push('## 改写被回退的条目');
    lines.push('');
    meta.rewriteSkipped.forEach((r) => lines.push(`- \`${r.claimId}\`：${r.reason}`));
    lines.push('');
  }

  if (meta.violations.length > 0) {
    lines.push('## 闸门提示');
    lines.push('');
    meta.violations.forEach((v) => lines.push(`- [${v.kind}] ${v.message}`));
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`生成于 ${new Date().toISOString()}　对照表 hash \`${sha256(lines.join('\n')).slice(0, 12)}\``);
  return lines.join('\n');
}
