import { execFileSync } from 'node:child_process';
import type { Claim, Visibility } from '@assit/contract';
import type { Db } from '../db/index.js';
import { complete } from '../models/index.js';

/**
 * 项目深挖（DESIGN §8.2）。
 *
 * 这是必须自建的一块：通用面试题工具问不出「你这条主张说主导了库存扣减重构，
 * 那当时怎么处理并发下的超卖」。而**恰恰是这种问题能暴露一条主张是不是真的**。
 *
 * 三步，顺序不能换：
 *   1. 从 claim 的 code_evidence 取真实 diff（本地 `git show`，不调模型）
 *   2. 按 claim 的 visibility 走路由 —— private/nda 只能本地模型
 *   3. 模型只负责**出题**，不负责判断你答得对不对
 */

export interface ProbeContext {
  claimId: string;
  fact: string;
  boundary: string;
  level: string;
  visibility: Visibility;
  diffs: { commit: string; text: string }[];
  modules: string[];
}

export class NoCodeEvidence extends Error {
  constructor(claimId: string) {
    super(
      `主张 ${claimId} 没有可用的 code_evidence.commits，深挖不了。\n` +
        '  先跑 `assit scan` + `assit propose` 让它长出证据，或者手动补上 commit ——\n' +
        '  没有证据的主张，追问也只能问得很空。',
    );
    this.name = 'NoCodeEvidence';
  }
}

/** 单个 commit 最多带多少字符。整份 diff 会把预算烧光且带不来更多信息。 */
const DIFF_BUDGET = 4000;

export function gatherProbeContext(
  claim: Claim,
  repoPath: string,
  opts: { maxCommits?: number; runGit?: (args: string[], cwd: string) => string } = {},
): ProbeContext {
  const commits = claim.code_evidence?.commits ?? [];
  if (commits.length === 0) throw new NoCodeEvidence(claim.id);

  const git =
    opts.runGit ??
    ((args: string[], cwd: string): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

  const diffs: ProbeContext['diffs'] = [];
  for (const c of commits.slice(0, opts.maxCommits ?? 3)) {
    try {
      // --stat 放前面：即使 patch 被截断，「改了哪些文件、各多少行」也还在，
      // 而那往往比 diff 正文更能支撑一个好问题。
      const text = git(['show', '--stat', '--patch', '--no-color', c], repoPath);
      diffs.push({ commit: c, text: text.slice(0, DIFF_BUDGET) });
    } catch {
      // commit 找不到（仓库换了、rebase 过）不是致命错误 —— 少一条依据而已
    }
  }
  if (diffs.length === 0) throw new NoCodeEvidence(claim.id);

  return {
    claimId: claim.id,
    fact: claim.source_fact,
    boundary: claim.boundary,
    level: claim.responsibility_level,
    visibility: claim.visibility,
    diffs,
    modules: claim.code_evidence?.modules ?? [],
  };
}

export interface ProbeQuestion {
  question: string;
  /** 出题依据：哪个 commit、哪段改动。**没有依据的追问不该被问出来** */
  basis: string;
}

const SYSTEM = `你是一位技术面试官，正在针对候选人简历里的一条具体主张追问。

规则：
1. 只能基于给出的 diff 和模块信息提问。**不要问 diff 里看不出来的东西。**
2. 每个问题必须带一个 basis，指明它是从哪段改动来的。
3. 问「当时为什么这么做」「换一种做法会怎样」「这里的边界条件是什么」，
   不要问八股概念题 —— 那种题网上到处都是，问不出这个人做没做过这件事。
4. 候选人自述的责任等级是「{{level}}」，边界是「{{boundary}}」。
   如果 diff 显示的工作量明显对不上这个等级，就直接问那个落差。
5. 输出 JSON 数组：[{"question": "...", "basis": "..."}]，不要别的。`;

export async function generateProbes(
  ctx: ProbeContext,
  opts: { db?: Db; count?: number } = {},
): Promise<ProbeQuestion[]> {
  const prompt = [
    `主张：${ctx.fact}`,
    `责任等级：${ctx.level}`,
    `边界：${ctx.boundary}`,
    ctx.modules.length > 0 ? `涉及模块：${ctx.modules.join('、')}` : '',
    '',
    ...ctx.diffs.map((d) => `--- commit ${d.commit} ---\n${d.text}`),
    '',
    `请出 ${opts.count ?? 4} 个追问。`,
  ].filter(Boolean).join('\n');

  const r = await complete(
    {
      task: 'interview_chat',
      // **按 claim 的 visibility 走路由。** private/nda 的代码只能本地模型 ——
      // 这不是配置项，是 route() 里的硬拦截。
      visibility: ctx.visibility,
      system: SYSTEM.replace('{{level}}', ctx.level).replace('{{boundary}}', ctx.boundary),
      prompt,
    },
    { db: opts.db ?? null },
  );

  return parseProbes(r.text);
}

/** 单独抽出来是为了能脱离模型测「模型乱返回时会怎样」。 */
export function parseProbes(text: string): ProbeQuestion[] {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`模型没有返回合法 JSON（前 200 字）：${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('模型返回的不是数组');

  return (parsed as any[])
    .filter((q) => typeof q?.question === 'string' && q.question.trim())
    // **没有 basis 的问题直接丢掉。** 一个指不回具体改动的追问，
    // 和网上那些八股题没有区别 —— 而那正是这个功能要避免的。
    .filter((q) => typeof q?.basis === 'string' && q.basis.trim())
    .map((q) => ({ question: String(q.question).trim(), basis: String(q.basis).trim() }));
}
