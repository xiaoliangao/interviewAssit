import fs from 'node:fs';
import path from 'node:path';
import type { Visibility } from '@assit/contract';
import type { Db } from '../db/index.js';
import { complete, type CompleteOptions } from '../models/complete.js';
import { redact } from '../models/redact.js';
import type { ModuleAttribution, RepoScan } from './intersect.js';

/**
 * 解读层：唯一调模型的一层。
 *
 * 它拿到的不是整个仓库，而是「你碰过的那个模块」的脱敏上下文 ——
 * 结构层和归因层求交之后的结果。这既是隐私边界，也是质量边界：
 * 把整个仓库丢给模型，它会给你一段谁看了都点头、但对面试毫无用处的概述。
 *
 * 反幻觉机制和打分那边是同一套思路：**每条结论必须能指回具体文件。**
 * 打分那边要求 evidence 是 JD 原文的子串；这里要求 evidence_refs 里的每个
 * 路径都真实存在于这个模块。指不回去的结论一律丢弃并标「未识别」。
 * AI 读代码画架构的幻觉率很高，而简历上一句编造的技术描述，
 * 在面试第二轮就会被拆穿。
 */

export const UNIDENTIFIED = '未识别';

export interface TechPick {
  name: string;
  why: string;
  evidence: string[];
}

export interface ClaimDraft {
  source_fact: string;
  candidate_wording: string;
  suggested_level: string;
  boundary_hint: string;
  evidence_files: string[];
}

export interface FollowUpQuestion {
  question: string;
  why_they_ask: string;
  evidence: string[];
}

export interface ModuleExplanation {
  modulePath: string;
  role: string | null;
  roleEvidence: string[];
  dataFlow: string | null;
  tech: TechPick[];
  claims: ClaimDraft[];
  questions: FollowUpQuestion[];
  /** 因为指不回具体文件而被丢弃的结论，展示出来让你知道模型想说什么但没证据 */
  discarded: string[];
  provider: string;
  cacheHit: boolean;
}

const SYSTEM = `你在阅读一个代码模块的脱敏结构信息，目标是帮使用者准备简历与面试。

严格遵守：
1. **每条结论必须能指回给定文件列表里的具体文件。** 指不回去的结论不要输出。
   宁可输出空数组，也不要输出一条「看起来很合理但是猜的」结论。
2. 推不出来的字段填 null，不要用常识补全。这个模块看不出用了什么数据库，就是看不出。
3. 你看到的是脱敏后的签名与控制流，函数体已被移除。不要假装看到了实现细节。
4. 不要评价代码质量，不要给改进建议。使用者要的是「怎么把这段经历讲清楚」。
5. 候选要点(claims)的 suggested_level 只能从这四个里选：参与 / 负责模块 / 主导方案或交付 / 项目负责人。
   **按给定的提交占比保守估计** —— 宁可低估，使用者会自己往上改，但高估会让他在面试里被问穿。
6. 候选追问题要问到具体的技术决策上（为什么选 A 不选 B、这个值怎么定的、
   并发/失败时会怎样），不要问「介绍一下这个项目」这种空问题。

只输出 JSON，不要 markdown 代码块，不要解释。格式：
{
  "role": "这个模块负责什么，一句话" | null,
  "role_evidence": ["文件路径"],
  "data_flow": "一条主链路的端到端数据流" | null,
  "tech": [{"name":"技术名","why":"为什么这么选（能从代码推出的才写）","evidence":["文件路径"]}],
  "claims": [{
    "source_fact":"原始事实，不做包装",
    "candidate_wording":"可用于简历的一句话",
    "suggested_level":"参与|负责模块|主导方案或交付|项目负责人",
    "boundary_hint":"团队做了什么、使用者做了什么的分界",
    "evidence_files":["文件路径"]
  }],
  "questions": [{"question":"面试官会问什么","why_they_ask":"为什么会问这个","evidence":["文件路径"]}]
}`;

function buildContext(
  root: string,
  mod: ModuleAttribution,
  visibility: Visibility,
  maxFiles: number,
): { text: string; fileList: string[] } {
  const level = visibility === 'public' ? 'none' : 'signatures';
  const picked = mod.myFiles.slice(0, maxFiles);
  const parts: string[] = [];

  parts.push(`模块路径：${mod.path}`);
  parts.push(`语言：${mod.languages.join('、')}　文件数：${mod.fileCount}（其中测试 ${mod.testFileCount}）`);
  parts.push(
    `使用者在此模块的贡献：${mod.myCommits} 次提交，+${mod.myAdded}/-${mod.myDeleted} 行，` +
      `占该模块全部改动的 ${(mod.myShare * 100).toFixed(0)}%` +
      `${mod.firstTouch ? `，时间跨度 ${mod.firstTouch.slice(0, 10)} ~ ${mod.lastTouch?.slice(0, 10)}` : ''}`,
  );
  if (mod.dependsOn.length) parts.push(`依赖：${mod.dependsOn.join('、')}`);
  if (mod.dependedBy.length) parts.push(`被依赖：${mod.dependedBy.join('、')}`);

  if (mod.myTopCommits.length) {
    parts.push('', '使用者在此模块的提交（按改动量降序）：');
    for (const c of mod.myTopCommits) {
      parts.push(`  ${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} ${c.subject}`);
    }
  }

  parts.push('', `可引用的文件列表（evidence 只能从这里面选）：`);
  for (const f of mod.myFiles) parts.push(`  ${f.path}`);

  parts.push('', '脱敏后的代码结构：');
  for (const f of picked) {
    let src = '';
    try {
      src = fs.readFileSync(path.join(root, f.path), 'utf8').slice(0, 60_000);
    } catch {
      continue;
    }
    const { text } = redact(src, level);
    parts.push('', `--- ${f.path} ---`, text.slice(0, 6000));
  }

  return { text: parts.join('\n'), fileList: mod.myFiles.map((f) => f.path) };
}

function parseJson(raw: string): any | null {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // 模型偶尔会在 JSON 前后带一句话，捞出最外层的花括号再试一次
    const a = cleaned.indexOf('{');
    const b = cleaned.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try {
      return JSON.parse(cleaned.slice(a, b + 1));
    } catch {
      return null;
    }
  }
}

/**
 * 证据校验：evidence 里的路径必须真实存在于这个模块。
 * 这是这一层唯一的防线，比提示词里那句「必须能指回文件」可靠得多。
 */
function keepIfGrounded<T>(
  items: unknown,
  valid: Set<string>,
  discarded: string[],
  spec: {
    getEvidence: (t: any) => unknown;
    withEvidence: (t: any, ev: string[]) => T;
    describe: (t: any) => string;
  },
): T[] {
  if (!Array.isArray(items)) return [];
  const out: T[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const raw = spec.getEvidence(it);
    const ev = (Array.isArray(raw) ? raw : []).filter(
      (p): p is string => typeof p === 'string' && valid.has(p),
    );
    if (ev.length === 0) {
      discarded.push(spec.describe(it));
      continue;
    }
    out.push(spec.withEvidence(it, ev));
  }
  return out;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

const LEVELS = ['参与', '负责模块', '主导方案或交付', '项目负责人'];

export interface ExplainOptions {
  db?: Db | null;
  model?: CompleteOptions;
  /** 每个模块最多读几个文件进上下文 */
  maxFiles?: number;
}

export async function explainModule(
  scan: RepoScan,
  mod: ModuleAttribution,
  opts: ExplainOptions = {},
): Promise<ModuleExplanation> {
  const root = path.resolve(scan.repo.local_path.replace(/^~/, process.env.HOME ?? '~'));
  const { text, fileList } = buildContext(root, mod, scan.repo.visibility, opts.maxFiles ?? 6);
  const valid = new Set(fileList);

  const res = await complete(
    {
      task: 'code_analysis',
      visibility: scan.repo.visibility,
      system: SYSTEM,
      prompt: text,
      maxTokens: 3000,
      temperature: 0,
    },
    { db: opts.db ?? null, ...(opts.model ?? {}) },
  );

  const discarded: string[] = [];
  const json = parseJson(res.text);
  if (!json) {
    return {
      modulePath: mod.path,
      role: null, roleEvidence: [], dataFlow: null,
      tech: [], claims: [], questions: [],
      discarded: ['模型没有返回可解析的 JSON'],
      provider: res.provider, cacheHit: res.cacheHit,
    };
  }

  const roleEvidence = (json.role_evidence ?? []).filter((p: string) => valid.has(p));
  const role = roleEvidence.length > 0 && typeof json.role === 'string' ? json.role : null;
  if (json.role && roleEvidence.length === 0) {
    discarded.push(`模块职责「${String(json.role).slice(0, 60)}」指不回具体文件`);
  }

  const tech = keepIfGrounded<TechPick>(json.tech, valid, discarded, {
    getEvidence: (t) => t.evidence,
    withEvidence: (t, evidence) => ({ name: str(t.name), why: str(t.why), evidence }),
    describe: (t) => `技术选型「${str(t.name, '?')}」指不回具体文件`,
  });

  const claims = keepIfGrounded<ClaimDraft>(json.claims, valid, discarded, {
    getEvidence: (c) => c.evidence_files,
    withEvidence: (c, evidence_files) => ({
      source_fact: str(c.source_fact),
      candidate_wording: str(c.candidate_wording),
      // 模型给的等级只要不在枚举里就降到最低档。宁可让你自己往上改，
      // 也不要因为模型写了个「核心负责人」就把一个越级说法带进事实库。
      suggested_level: LEVELS.includes(str(c.suggested_level)) ? str(c.suggested_level) : '参与',
      boundary_hint: str(c.boundary_hint),
      evidence_files,
    }),
    describe: (c) => `候选要点「${str(c.source_fact, '?').slice(0, 50)}」指不回具体文件`,
  });

  const questions = keepIfGrounded<FollowUpQuestion>(json.questions, valid, discarded, {
    getEvidence: (q) => q.evidence,
    withEvidence: (q, evidence) => ({
      question: str(q.question),
      why_they_ask: str(q.why_they_ask),
      evidence,
    }),
    describe: (q) => `追问题「${str(q.question, '?').slice(0, 50)}」指不回具体文件`,
  });

  return {
    modulePath: mod.path,
    role,
    roleEvidence,
    dataFlow: typeof json.data_flow === 'string' ? json.data_flow : null,
    tech,
    claims,
    questions,
    discarded,
    provider: res.provider,
    cacheHit: res.cacheHit,
  };
}

/** 把解读结果写回 repo_modules。指不回文件的结论不落库。 */
export function persistExplanation(db: Db, repoId: string, ex: ModuleExplanation): void {
  db.prepare(
    `UPDATE repo_modules SET role = ?, tech = ?, evidence_refs = ?
     WHERE repo_id = ? AND path = ?`,
  ).run(
    ex.role,
    ex.tech.length ? JSON.stringify(ex.tech) : null,
    ex.roleEvidence.length ? JSON.stringify(ex.roleEvidence) : null,
    repoId,
    ex.modulePath,
  );
}
