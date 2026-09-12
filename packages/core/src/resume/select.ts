import type { Claim } from '@assit/contract';
import { renderMetric } from './guard.js';

/**
 * 按 JD 选主张。
 *
 * 这一步刻意是确定性的，不调模型。理由：选哪几条 claim 决定了这份简历讲什么故事，
 * 必须可复现、可解释、可以在 bullet 对照表里指着说「它为什么被选中」。
 * 模型只在下一步动措辞。
 */

const LATIN_STOP = new Set([
  'the', 'and', 'for', 'with', 'you', 'our', 'are', 'will', 'have', 'this', 'that', 'from',
  'work', 'team', 'about', 'role', 'years', 'year', 'experience', 'skills', 'ability', 'strong',
  'good', 'able', 'plus', 'etc', 'job', 'company', 'business', 'requirements', 'responsibilities',
]);

const CJK_STOP = new Set([
  '我们', '公司', '岗位', '负责', '工作', '要求', '相关', '以上', '能力', '经验', '优先',
  '熟悉', '具备', '良好', '以及', '并且', '能够', '任职', '职责', '团队', '业务', '进行',
  '完成', '参与', '提供', '这个', '其他', '包括', '一起', '沟通', '学习', '问题', '方案',
]);

export function extractTokens(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (t: string, w: number) => out.set(t, (out.get(t) ?? 0) + w);

  for (const m of text.toLowerCase().match(/[a-z][a-z0-9+#._-]{1,}/g) ?? []) {
    const t = m.replace(/[._-]+$/, '');
    if (t.length < 2 || LATIN_STOP.has(t)) continue;
    // 拉丁词多为技术名词，区分度高
    bump(t, 2);
  }
  for (const seg of text.match(/[一-龥]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const bg = seg.slice(i, i + 2);
      if (CJK_STOP.has(bg)) continue;
      bump(bg, 1);
    }
  }
  return out;
}

export interface ScoredClaim {
  claim: Claim;
  score: number;
  matched: string[];
}

const BIGRAM_RE = /^[一-龥]{2}$/;

/**
 * 把重叠的中文 bigram 接回成词，只用于展示。
 *
 * 打分用 bigram 是对的（不需要分词器就能跨中英文匹配），但对照表是你面试前
 * 要看的东西 —— 上面印着「分布、布式、式锁」而不是「分布式锁」，会让人怀疑
 * 这个工具到底懂不懂自己在算什么。
 */
export function mergeBigrams(tokens: string[]): string[] {
  const cjk = tokens.filter((t) => BIGRAM_RE.test(t)).sort();
  const rest = tokens.filter((t) => !BIGRAM_RE.test(t));
  const pool = new Set(cjk);
  const out: string[] = [];

  for (const start of cjk) {
    if (!pool.has(start)) continue;
    // 有前驱的先跳过，让链条从头开始接
    if (cjk.some((t) => t !== start && pool.has(t) && t[1] === start[0])) continue;
    pool.delete(start);
    let word = start;
    let tail = start[1]!;
    for (;;) {
      const next = cjk.find((t) => pool.has(t) && t[0] === tail);
      if (!next) break;
      pool.delete(next);
      word += next[1];
      tail = next[1]!;
    }
    out.push(word);
  }
  // 成环的（如「循环环循」）接不出头，原样保留
  for (const t of cjk) if (pool.has(t)) out.push(t);

  return [...rest, ...out.sort((a, b) => b.length - a.length)];
}

function claimText(c: Claim): string {
  return [
    c.source_fact,
    c.candidate_wording ?? '',
    c.candidate_wording_en ?? '',
    c.tags.join(' '),
    c.code_evidence?.repo ?? '',
    (c.code_evidence?.modules ?? []).join(' '),
    (c.code_evidence?.files_touched ?? []).join(' '),
    Object.values(c.interview_details ?? {}).join(' '),
  ].join('\n');
}

export interface SelectOptions {
  /** 目标岗位标签，用于 allowed_uses 过滤 */
  target?: string;
  max?: number;
  /** draft 模式下允许「待确认」的主张进来（带占位标记） */
  includeUnconfirmed?: boolean;
}

export function selectClaims(
  claims: Claim[],
  jdText: string,
  opts: SelectOptions = {},
): ScoredClaim[] {
  const jd = extractTokens(jdText);
  const max = opts.max ?? 8;

  const eligible = claims.filter((c) => {
    if (c.verification_status === '不采用') return false;
    if (!opts.includeUnconfirmed && c.verification_status !== '已确认') return false;
    if (opts.target && c.allowed_uses.length > 0 && !c.allowed_uses.includes(opts.target)) {
      return false;
    }
    return true;
  });

  const scored: ScoredClaim[] = eligible.map((c) => {
    const ct = extractTokens(claimText(c));
    let score = 0;
    const matched: string[] = [];
    for (const [tok, w] of ct) {
      const jw = jd.get(tok);
      if (!jw) continue;
      score += Math.min(w, 4) * Math.min(jw, 4);
      if (tok.length > 1) matched.push(tok);
    }
    // 加分只在「已经和 JD 有交集」之后生效，否则它就成了入场券：
    // 一条八竿子打不着的主张会仅仅因为责任等级高就挤进简历。
    // 这两项是同分时的排序依据，不是相关性本身。
    if (score > 0) {
      if (c.code_evidence && (c.code_evidence.commits.length || c.code_evidence.prs.length)) {
        score += 3; // 经得起追问的排前面
      }
      if (c.responsibility_level === '主导方案或交付' || c.responsibility_level === '项目负责人') {
        score += 2;
      }
    }
    return { claim: c, score, matched: mergeBigrams(matched).slice(0, 10) };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id))
    .slice(0, max);
}

export interface BulletTextOptions {
  /**
   * 待补指标怎么处理：
   *   true  —— 渲染成 __（需补充：…）__，草稿模式用，是给你自己看的 TODO
   *   false —— 直接不提这个数字，最终 PDF 用
   *
   * 注意第二种不是「放松要求」：缺一个数字不是说谎，只是少一点说服力。
   * 真正不能放行的是「待确认 / 已过期的主张」和「越级用词」，那两类才是诚实性问题。
   * 把缺数字也做成致命错误，结果是你为了出一版简历去改事实库 —— 那才是真正危险的习惯。
   */
  includePlaceholders: boolean;
}

/**
 * 不调模型时的兜底表述。
 * candidate_wording 是你自己写过的句子，永远比模型现编的可信。
 */
export function baselineBullet(
  c: Claim,
  opts: BulletTextOptions = { includePlaceholders: true },
): string {
  const base = (c.candidate_wording ?? c.source_fact).trim().replace(/[。.]$/, '');
  const usable = opts.includePlaceholders
    ? c.metrics
    : c.metrics.filter((m) => m.status !== '待补' && m.after !== null);
  const metrics = usable.map(renderMetric).filter(Boolean);
  return metrics.length > 0 ? `${base}（${metrics.join('；')}）` : base;
}

/** 最终稿里被略过的指标。不拦你，但要告诉你留了多少分在桌上。 */
export function droppedMetrics(c: Claim): string[] {
  return c.metrics.filter((m) => m.status === '待补' || m.after === null).map((m) => m.name);
}
