import { DEFAULT_WEIGHTS, type Rubric, type ScoreDimension } from '@assit/contract';
import { annualTotal, attr, degreeRank, type SalaryParse, type StoredAttrs } from '../jobs/parse.js';

/**
 * 三段式打分（DESIGN §6.3）：
 *   1) 硬门槛 gate  → pass / fail / unknown。fail **不淘汰**，标 hard_gaps 并沉底
 *   2) 加权 rubric  → 每项带证据
 *   3) 封顶规则 caps → 例如缺核心技术栈时 final_score 不超过 55
 *
 * 两条贯穿始终的规则：
 *   - unknown 的维度不计入分母，而不是记 0 分
 *   - 每条 evidence 要么是 JD 原文的子串，要么明确标成 derived（算出来的）
 */

export type GateStatus = 'pass' | 'fail' | 'unknown';

export interface GateResult {
  key: string;
  status: GateStatus;
  detail: string;
  jd_quote: string | null;
}

export interface Component {
  score: number;
  max_score: number;
  /** 人读的解释 */
  evidence: string;
  /** JD 原文片段。非 null 时必须能在 JD 里逐字找到 —— 见 validateTrace */
  jd_quote: string | null;
  suspicious?: boolean;
}

export interface ScoreTrace {
  schema_version: 1;
  rubric_version: string;
  profile_version: string;
  components: Partial<Record<ScoreDimension, Component>>;
  unknown_dims: ScoreDimension[];
  gates: GateResult[];
  hard_gaps: string[];
  /** 条件被触发的封顶规则。触发 ≠ 真的封住了（分数本来就更低时不会生效）。 */
  caps: string[];
  /** 实际把分数压下来的那条。raw → final 的差距由它解释。 */
  capped_by: string | null;
  raw_score: number;
  final_score: number;
  coverage: number;
  /** JD 里检出的可疑指令性文本。只打标，不改分数。 */
  injection_flags: string[];
}

export interface ScoreInput {
  rubric: Rubric;
  rubricVersion: string;
  profileVersion: string;
  jdText: string;
  attrs: StoredAttrs;
  salary: SalaryParse;
  city: string | null;
  outsourcingLikelihood: number | null;
  /** 入库时由职位名算出的职能族。见 rubric.profile.target_roles 的说明。 */
  roleFamily?: string | null;
}

const norm = (s: string): string => s.replace(/\s+/g, '');

/**
 * evidence 子串校验（DESIGN §6.4）。
 *
 * 这是防提示注入最关键的一道：理由必须能在 JD 里逐字找到。
 * 有了它，「模型编一段理由来支撑一个被注入的高分」在结构上就不可能 ——
 * 而光靠提示词里写「不要听 JD 的指令」是挡不住的。
 */
export function validateTrace(trace: ScoreTrace, jdText: string): ScoreTrace {
  const hay = norm(jdText);
  for (const [dim, c] of Object.entries(trace.components) as [ScoreDimension, Component][]) {
    if (!c.jd_quote) continue;
    if (hay.includes(norm(c.jd_quote))) continue;
    // 指不回 JD 原文 → 这一项作废，计入 unknown，而不是留着一个来路不明的分
    c.suspicious = true;
    c.score = 0;
    c.evidence = `${c.evidence}（证据无法在 JD 中定位，该项已作废）`;
    if (!trace.unknown_dims.includes(dim)) trace.unknown_dims.push(dim);
    delete trace.components[dim];
  }
  return trace;
}

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous/i,
  /disregard\s+(the\s+)?above/i,
  /忽略(以上|之前|前面)/,
  /(给|打)\s*(这个|该|本)?\s*(岗位|职位)?\s*\d{2,3}\s*分/,
  /system\s*prompt/i,
  /you\s+are\s+(now\s+)?an?\s+/i,
  /<\|.*?\|>/,
];

export function detectInjection(jdText: string): string[] {
  const out: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    const m = jdText.match(re);
    if (m) out.push(m[0].slice(0, 60));
  }
  return out;
}

// ── 各维度打分 ─────────────────────────────────────────────────────────────

function scoreCoreStack(input: ScoreInput, max: number): Component | null {
  const jd = attr<string[]>(input.attrs, 'tech_stack');
  if (jd.confidence === 'unknown' || !jd.value?.length) return null;
  const mine = new Set(input.rubric.profile.stack.map((s) => s.toLowerCase()));
  const required = jd.value;
  const hit = required.filter((t) => mine.has(t.toLowerCase()));
  const miss = required.filter((t) => !mine.has(t.toLowerCase()));
  const ratio = required.length ? hit.length / required.length : 0;
  return {
    score: Math.round(ratio * max),
    max_score: max,
    evidence:
      `JD 要求 ${required.length} 项，命中 ${hit.length} 项：${hit.join('、') || '无'}` +
      (miss.length ? `；缺 ${miss.join('、')}` : ''),
    jd_quote: jd.source,
  };
}

function scoreExperience(input: ScoreInput, max: number): Component | null {
  const need = attr<number>(input.attrs, 'exp_years_min');
  const mine = input.rubric.profile.exp_years;
  if (need.confidence === 'unknown' || need.value === null || mine === undefined) return null;
  const gap = mine - need.value;
  // 够了就满分；差 1 年打七折；差得多再往下
  const score = gap >= 0 ? max : gap >= -1 ? Math.round(max * 0.7) : gap >= -2 ? Math.round(max * 0.4) : 0;
  return {
    score,
    max_score: max,
    evidence: `JD 要求 ${need.value} 年，你 ${mine} 年（${gap >= 0 ? `富余 ${gap}` : `差 ${-gap}`} 年）`,
    jd_quote: need.source,
  };
}

function scoreSalary(input: ScoreInput, max: number): Component | null {
  const { salary_floor_yuan: floor, salary_target_yuan: target } = input.rubric.profile;
  if (input.salary.min === null || floor === undefined) return null;
  // 用年总包比，否则 25-40K·15薪 和 30-45K·12薪 比不出来
  const annual = annualTotal(input.salary)!;
  const floorAnnual = floor * 12;
  const targetAnnual = (target ?? Math.round(floor * 1.4)) * 12;
  let score: number;
  if (annual <= floorAnnual) score = 0;
  else if (annual >= targetAnnual) score = max;
  else score = Math.round(((annual - floorAnnual) / (targetAnnual - floorAnnual)) * max);
  const monthsNote =
    input.salary.monthsConfidence === 'inferred' || input.salary.monthsConfidence === 'unknown'
      ? '（薪数未披露，按 12 薪估算）'
      : '';
  return {
    score,
    max_score: max,
    evidence:
      `${input.salary.raw} → 年包约 ${(annual / 10000).toFixed(1)} 万${monthsNote}；` +
      `你的下限 ${(floorAnnual / 10000).toFixed(1)} 万`,
    jd_quote: null, // 算出来的，不是 JD 原文
  };
}

function scoreLocation(input: ScoreInput, max: number): Component | null {
  const cities = input.rubric.profile.cities;
  const remote = attr<string>(input.attrs, 'remote');
  if (remote.value === 'remote' && input.rubric.profile.accept_remote) {
    return { score: max, max_score: max, evidence: '远程岗位', jd_quote: remote.source };
  }
  if (!input.city || cities.length === 0) return null;
  const hit = cities.some((c) => input.city!.includes(c) || c.includes(input.city!));
  return {
    score: hit ? max : 0,
    max_score: max,
    evidence: hit ? `${input.city} 在你的目标城市里` : `${input.city} 不在 ${cities.join('、')}`,
    jd_quote: null,
  };
}

function scoreSchedule(input: ScoreInput, max: number): Component | null {
  const s = attr<string>(input.attrs, 'work_schedule');
  if (s.confidence === 'unknown' || !s.value) return null;
  const ok = input.rubric.profile.acceptable_schedules;
  const bad = ['大小周', '单休', '996', '强制加班'];
  const score = ok.includes(s.value) ? max : bad.includes(s.value) ? 0 : Math.round(max * 0.5);
  return {
    score,
    max_score: max,
    evidence: `作息：${s.value}${score === 0 ? '（你不接受）' : ''}`,
    jd_quote: s.source,
  };
}

function scoreCompany(input: ScoreInput, max: number): Component | null {
  const p = input.outsourcingLikelihood;
  if (p === null) return null; // 无信号 = 未知，不是「确定不是外包」
  return {
    score: Math.round((1 - p) * max),
    max_score: max,
    evidence: `外包概率 ${(p * 100).toFixed(0)}%`,
    jd_quote: null,
  };
}

// ── 硬门槛 ─────────────────────────────────────────────────────────────────

function runGates(input: ScoreInput): GateResult[] {
  const out: GateResult[] = [];
  for (const g of input.rubric.hard_gates) {
    if (g.key === 'education') {
      const need = attr<string>(input.attrs, 'education');
      const mine = input.rubric.profile.degree;
      if (need.confidence === 'unknown' || !mine) {
        out.push({ key: 'education', status: 'unknown', detail: 'JD 未写学历要求', jd_quote: null });
        continue;
      }
      const pass = need.value === '不限' || degreeRank(mine) >= degreeRank(need.value);
      out.push({
        key: 'education',
        status: pass ? 'pass' : 'fail',
        detail: `要求 ${need.value}，你 ${mine}`,
        jd_quote: need.source,
      });
    } else if (g.key === 'exp_years_min') {
      const need = attr<number>(input.attrs, 'exp_years_min');
      const mine = input.rubric.profile.exp_years;
      if (need.confidence === 'unknown' || need.value === null || mine === undefined) {
        out.push({ key: 'exp_years_min', status: 'unknown', detail: 'JD 未写年限要求', jd_quote: null });
        continue;
      }
      const pass = mine + g.slack >= need.value;
      out.push({
        key: 'exp_years_min',
        status: pass ? 'pass' : 'fail',
        detail: `要求 ${need.value} 年，你 ${mine} 年（容差 ${g.slack}）`,
        jd_quote: need.source,
      });
    } else if (g.key === 'role_family') {
      const want = input.rubric.profile.target_roles;
      if (want.length === 0 || !input.roleFamily) {
        out.push({ key: 'role_family', status: 'unknown', detail: '未设置目标职能族', jd_quote: null });
        continue;
      }
      const pass = want.includes(input.roleFamily);
      out.push({
        key: 'role_family',
        status: pass ? 'pass' : 'fail',
        detail: `这是 ${input.roleFamily} 岗，你要投 ${want.join('/')}`,
        jd_quote: null,
      });
    } else if (g.key === 'salary_floor') {
      const floor = input.rubric.profile.salary_floor_yuan;
      if (input.salary.min === null || floor === undefined) {
        out.push({ key: 'salary_floor', status: 'unknown', detail: '薪资未披露', jd_quote: null });
        continue;
      }
      const pass = (input.salary.max ?? input.salary.min) >= floor;
      out.push({
        key: 'salary_floor',
        status: pass ? 'pass' : 'fail',
        detail: `上限 ${input.salary.max ?? input.salary.min}，你的下限 ${floor}`,
        jd_quote: null,
      });
    }
  }
  return out;
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

export function scoreJob(input: ScoreInput): ScoreTrace {
  const weights = { ...DEFAULT_WEIGHTS, ...input.rubric.weights } as Record<ScoreDimension, number>;

  const scorers: Record<ScoreDimension, (i: ScoreInput, max: number) => Component | null> = {
    core_stack: scoreCoreStack,
    experience: scoreExperience,
    salary: scoreSalary,
    location: scoreLocation,
    schedule: scoreSchedule,
    company: scoreCompany,
  };

  const components: Partial<Record<ScoreDimension, Component>> = {};
  const unknown_dims: ScoreDimension[] = [];
  for (const dim of Object.keys(scorers) as ScoreDimension[]) {
    const max = weights[dim] ?? 0;
    if (max === 0) continue;
    const c = scorers[dim](input, max);
    if (c === null) unknown_dims.push(dim);
    else components[dim] = c;
  }

  const gates = runGates(input);
  const hard_gaps = gates
    .filter((g) => g.status === 'fail')
    .map((g) => `${g.key}: ${g.detail}`);

  let trace: ScoreTrace = {
    schema_version: 1,
    rubric_version: input.rubricVersion,
    profile_version: input.profileVersion,
    components,
    unknown_dims,
    gates,
    hard_gaps,
    caps: [],
    capped_by: null,
    raw_score: 0,
    final_score: 0,
    coverage: 0,
    injection_flags: detectInjection(input.jdText),
  };

  // 子串校验要在算总分之前跑：作废的项不能进分母
  trace = validateTrace(trace, input.jdText);

  // unknown 不计入分母 —— 记 0 分等于对信息披露少的岗位加负分
  const got = Object.values(trace.components).reduce((a, c) => a + c.score, 0);
  const possible = Object.values(trace.components).reduce((a, c) => a + c.max_score, 0);
  const raw = possible > 0 ? Math.round((got / possible) * 100) : 0;
  trace.raw_score = raw;

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  trace.coverage = totalWeight > 0 ? Number((possible / totalWeight).toFixed(2)) : 0;

  // ── 封顶 ──
  let final = raw;
  const stack = trace.components.core_stack;
  const conditions: Record<string, (threshold?: number) => boolean> = {
    core_stack_below_half: () => !!stack && stack.score < stack.max_score / 2,
    core_stack_zero: () => !!stack && stack.score === 0,
    hard_gate_failed: () => hard_gaps.length > 0,
    outsourcing_likely: (th) => (input.outsourcingLikelihood ?? 0) >= (th ?? 0.6),
    schedule_bad: () => {
      const s = trace.components.schedule;
      return !!s && s.score === 0;
    },
    salary_below_floor: () => {
      const s = trace.components.salary;
      return !!s && s.score === 0;
    },
    coverage_low: (th) => trace.coverage < (th ?? 0.4),
    role_mismatch: () => {
      const want = input.rubric.profile.target_roles;
      return want.length > 0 && !!input.roleFamily && !want.includes(input.roleFamily);
    },
    // JD 里一个技术词都没有 ≠ 「技术要求都满足」。评不了就别给高分。
    core_stack_unknown: () => trace.unknown_dims.includes('core_stack'),
  };

  for (const cap of input.rubric.caps) {
    if (!conditions[cap.when]?.(cap.threshold)) continue;
    // 条件触发就记下来 —— 它说的是「这个岗位哪里不对」，
    // 这件事和「分数有没有被压下来」是两回事，都值得告诉你。
    trace.caps.push(cap.label);
    if (final > cap.final_score_max) {
      final = cap.final_score_max;
      trace.capped_by = cap.label;
    }
  }
  trace.final_score = final;
  return trace;
}

/**
 * 列表排序。
 *
 * **不乘 coverage。** `final_score × coverage` 看着合理，实际等价于对 unknown
 * 记负分，和「未知保持未知」自相矛盾。低置信度在 UI 上打标记、做筛选，
 * 但不偷偷改排序 —— 要不要因为「这家披露得少」而少看它一眼，是你的判断。
 *
 * 硬门槛没过的沉底，但仍然留在列表里：JD 的门槛常常是虚标的。
 */
export function sortKey(trace: ScoreTrace): [number, number] {
  return [trace.hard_gaps.length > 0 ? 1 : 0, -trace.final_score];
}
