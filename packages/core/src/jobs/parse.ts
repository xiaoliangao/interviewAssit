import type { Confidence, Tristate } from '@assit/contract';

/**
 * JD 的三态解析（DESIGN §6.1 / §6.2）。
 *
 * 贯穿这个文件的一条规则：**推不出来就是 unknown，不填默认值。**
 *
 * 最容易犯的错是「JD 没写学历要求 → 默认不限」。真实情况是国内 JD 大量回避
 * 大小周、加班、外包这些信息，而回避本身就是信号。把 unknown 当成「否」，
 * 等于系统性地给信息披露少的岗位加分 —— 那正好是你最该警惕的一批岗位。
 */

function t<T>(value: T | null, confidence: Confidence, source: string | null = null): Tristate<T> {
  return { value, confidence, source };
}

const UNKNOWN = <T>(): Tristate<T> => ({ value: null, confidence: 'unknown', source: null });

/** 截取命中关键词周围的一小段原文作为 source —— 打分要能指回 JD 原文。 */
function excerpt(text: string, index: number, len = 24): string {
  const start = Math.max(0, index - 8);
  return text.slice(start, start + len).replace(/\s+/g, ' ').trim();
}

// ── 薪资 ───────────────────────────────────────────────────────────────────

export interface SalaryParse {
  min: number | null;
  max: number | null;
  months: number | null;
  /** months 是从 JD 读到的还是按 12 推的 */
  monthsConfidence: Confidence;
  raw: string;
}

const WAN = 10_000;

/**
 * 薪资解析。这是全场最脏的一块 —— 每个平台写法都不一样，
 * 而它又直接决定你要不要点进去看。
 *
 * 解析不出来一律返回 null，绝不猜。「面议」就是面议，硬编一个中位数
 * 会让这个岗位混进你的高分列表里。
 */
export function parseSalary(raw: string): SalaryParse {
  const s = (raw ?? '').replace(/\s+/g, '').replace(/，/g, ',').replace(/[，,](?=\d{3}\b)/g, '');
  const base: SalaryParse = { min: null, max: null, months: null, monthsConfidence: 'unknown', raw };
  if (!s || /面议|待遇从优|薪资面谈|competitive|negotiable/i.test(s)) return base;

  // 数字后面跟的是人数、年限、年龄 —— 不是钱。
  // 采集到脏数据（或粘错字段）时，「3-5人团队」会被读成 ¥3000-5000，
  // 然后这个错数字一路参与打分。宁可 unknown。
  if (/\d\s*[-~–至到]?\s*\d*\s*(人|名|位|岁|年(?!薪)|个月(?!薪))/.test(s)) return base;

  // 没有任何金额单位时，只有数值本身已经是「元」的量级才敢认。
  const hasMoneyMarker = /[kK千wW万元¥￥$]|薪|月薪|年薪|salary|per\s*month/i.test(s);
  const bareNumbers = (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!hasMoneyMarker && !bareNumbers.every((n) => n >= 1000)) return base;

  // 薪数：15薪 / ·16薪 / 13-16薪
  const monthsM = s.match(/(\d{2})\s*薪/) ?? s.match(/(\d{2})\s*个?月/);
  if (monthsM) {
    base.months = Number(monthsM[1]);
    base.monthsConfidence = 'explicit_jd';
  }

  const toYuan = (n: number, unit: string, annual: boolean): number => {
    let v = n;
    if (/[wW万]/.test(unit)) v = n * WAN;
    else if (/[kK千]/.test(unit)) v = n * 1000;
    // 没单位的大数（30000）按元算；小数（30）在年薪语境下按万算
    else if (!annual && n < 1000) v = n * 1000;
    else if (annual && n < 500) v = n * WAN;
    if (annual) v = Math.round(v / (base.months ?? 12));
    return Math.round(v);
  };

  const annual = /年薪|\/年|per\s*year|annual/i.test(s);

  // 区间：25-40K / 2.5-4万 / 25000-40000 / 8k~12k
  const range = s.match(/(\d+(?:\.\d+)?)\s*([kK千wW万]?)\s*[-~–至到]\s*(\d+(?:\.\d+)?)\s*([kK千wW万]?)/);
  if (range) {
    const [, a, ua, b, ub] = range;
    const unit = ub || ua || '';
    base.min = toYuan(Number(a), ua || unit, annual);
    base.max = toYuan(Number(b), unit, annual);
  } else {
    // 单值：月薪 30K / 30万年薪
    const single = s.match(/(\d+(?:\.\d+)?)\s*([kK千wW万])/);
    if (single) {
      base.min = base.max = toYuan(Number(single[1]), single[2]!, annual);
    }
  }

  if (base.min !== null && base.max !== null && base.min > base.max) {
    [base.min, base.max] = [base.max, base.min];
  }
  // 明显不合理的结果宁可丢掉：宁可 unknown，也不要一个错的数字参与打分
  if (base.min !== null && (base.min < 1000 || base.min > 2_000_000)) {
    base.min = base.max = null;
  }

  if (base.months === null && base.min !== null) {
    base.months = 12;
    base.monthsConfidence = 'inferred';
  }
  return base;
}

/** 年总包，用于跨「15薪 vs 12薪」比较。months 未知时按 12 算并标 inferred。 */
export function annualTotal(s: SalaryParse): number | null {
  if (s.min === null) return null;
  const mid = (s.min + (s.max ?? s.min)) / 2;
  return Math.round(mid * (s.months ?? 12));
}

// ── 学历 / 经验 ────────────────────────────────────────────────────────────

const DEGREE_ORDER = ['不限', '大专', '本科', '硕士', '博士'] as const;
export type Degree = (typeof DEGREE_ORDER)[number];

export function degreeRank(d: string | null): number {
  const i = DEGREE_ORDER.indexOf(d as Degree);
  return i === -1 ? 0 : i;
}

export function parseEducation(jd: string): Tristate<string> {
  const pats: [RegExp, Degree][] = [
    [/博士(?:及以上|以上|学历)?/, '博士'],
    [/硕士|研究生/, '硕士'],
    [/本科(?:及以上|以上|学历)?|学士/, '本科'],
    [/大专|专科/, '大专'],
    [/学历不限|不限学历|不限专业和学历/, '不限'],
  ];
  for (const [re, deg] of pats) {
    const m = jd.match(re);
    if (m?.index !== undefined) return t(deg, 'explicit_jd', excerpt(jd, m.index));
  }
  // 未写就是未知，**不要默认「不限」**。国内 JD 不写学历，
  // 既可能是真不限，也可能是 HR 在筛简历时才卡 —— 这两件事对你完全不同。
  return UNKNOWN<string>();
}

export function parseExperience(jd: string): Tristate<number> {
  const m1 = jd.match(/(\d+)\s*[-~到至]\s*(\d+)\s*年/);
  if (m1?.index !== undefined) return t(Number(m1[1]), 'explicit_jd', excerpt(jd, m1.index));
  const m2 = jd.match(/(\d+)\s*年(?:以上|及以上|\+)/);
  if (m2?.index !== undefined) return t(Number(m2[1]), 'explicit_jd', excerpt(jd, m2.index));
  const m3 = jd.match(/经验不限|不限经验|应届|实习/);
  if (m3?.index !== undefined) return t(0, 'explicit_jd', excerpt(jd, m3.index));
  return UNKNOWN<number>();
}

// ── 作息 ───────────────────────────────────────────────────────────────────

const SCHEDULE_PATS: [RegExp, string][] = [
  [/大小周/, '大小周'],
  [/单双休/, '大小周'],
  [/单休/, '单休'],
  [/9\s*9\s*6|996/, '996'],
  [/10\s*10\s*6|1[01]-?\d-?6/, '强制加班'],
  [/双休|周末双休|五天八小时|965|955/, '双休'],
  [/弹性工作|弹性上下班|flexible\s*hours/i, '弹性'],
];

export function parseSchedule(jd: string): Tristate<string> {
  for (const [re, v] of SCHEDULE_PATS) {
    const m = jd.match(re);
    if (m?.index !== undefined) return t(v, 'explicit_jd', excerpt(jd, m.index));
  }
  // 国内 JD 大量回避这一项。回避本身是信号，但不是「双休」的证据。
  return UNKNOWN<string>();
}

// ── 外包 ───────────────────────────────────────────────────────────────────

export interface OutsourcingSignal {
  signal: string;
  weight: number;
  source: string;
}

const COMPANY_SIGNALS: [RegExp, number, string][] = [
  [/信息技术服务|人力资源|外服|人才服务|劳务|技术服务有限公司/, 0.35, '公司名含服务类字样'],
  [/软件技术|系统集成|信息系统集成/, 0.15, '公司名含集成类字样'],
];

const JD_SIGNALS: [RegExp, number, string][] = [
  [/驻场|入驻甲方|客户现场办公/, 0.4, 'JD 提到驻场'],
  [/甲方|乙方/, 0.2, 'JD 出现甲乙方表述'],
  [/外包|人力外派|项目外派/, 0.5, 'JD 直接写了外包'],
  [/(银行|运营商|国网|电网|保险|证券)项目/, 0.25, 'JD 提到特定行业项目制'],
  [/长期项目|项目周期|按项目结算/, 0.15, 'JD 提到项目制'],
  [/合同工|派遣/, 0.35, 'JD 提到派遣'],
];

/**
 * 外包做成概率，不做布尔。
 *
 * 单信号误判率很高：很多正经公司名字里也有「信息技术」。给概率 + 命中的
 * 信号列表，让用户自己判断 —— 这比一个可能错的布尔值有用得多。
 */
export function parseOutsourcing(
  jd: string,
  companyName: string,
): { likelihood: number | null; signals: OutsourcingSignal[] } {
  const signals: OutsourcingSignal[] = [];
  for (const [re, weight, name] of COMPANY_SIGNALS) {
    const m = companyName.match(re);
    if (m) signals.push({ signal: name, weight, source: m[0] });
  }
  for (const [re, weight, name] of JD_SIGNALS) {
    const m = jd.match(re);
    if (m?.index !== undefined) signals.push({ signal: name, weight, source: excerpt(jd, m.index) });
  }
  if (signals.length === 0) return { likelihood: null, signals: [] }; // 无信号 = 未知，不是 0

  // 并联累积：多个弱信号叠加，但不会因为一个强信号就直接封顶
  const p = 1 - signals.reduce((acc, s) => acc * (1 - s.weight), 1);
  return { likelihood: Math.min(0.97, Number(p.toFixed(2))), signals };
}

// ── 技术栈 ─────────────────────────────────────────────────────────────────

/**
 * 技术词表。刻意只收「JD 里会当硬要求写」的词，不收泛概念（微服务、高并发）——
 * 后者谁都会写，放进匹配里只会让所有岗位看起来都命中。
 */
const TECH_LEXICON = [
  'go', 'golang', 'java', 'python', 'rust', 'c++', 'c#', 'php', 'ruby', 'scala', 'kotlin', 'swift',
  'typescript', 'javascript', 'node.js', 'nodejs', 'deno',
  'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'flutter', 'react native',
  'spring', 'spring boot', 'spring cloud', 'gin', 'echo', 'django', 'flask', 'fastapi',
  'laravel', 'rails', '.net', 'dubbo', 'grpc', 'thrift', 'graphql',
  'mysql', 'postgresql', 'postgres', 'oracle', 'sqlserver', 'mongodb', 'redis', 'memcached',
  'elasticsearch', 'clickhouse', 'hbase', 'cassandra', 'tidb', 'oceanbase', 'doris', 'starrocks',
  'kafka', 'rabbitmq', 'rocketmq', 'pulsar', 'nats',
  'kubernetes', 'k8s', 'docker', 'helm', 'istio', 'terraform', 'ansible', 'jenkins', 'gitlab ci',
  'argocd', 'prometheus', 'grafana', 'elk', 'skywalking', 'opentelemetry',
  'aws', 'gcp', 'azure', 'aliyun', '阿里云', '腾讯云', '华为云',
  'hadoop', 'spark', 'flink', 'hive', 'airflow', 'dbt',
  'pytorch', 'tensorflow', 'langchain', 'llm', 'rag', 'transformer',
  'nginx', 'linux', 'shell', 'git',
];

const ALIAS: Record<string, string> = {
  golang: 'go', k8s: 'kubernetes', nodejs: 'node.js', postgres: 'postgresql',
};

function canon(term: string): string {
  const k = term.toLowerCase();
  return ALIAS[k] ?? k;
}

/**
 * 从 JD 抽技术栈。extra 传入你自己账本里的 tag，
 * 这样你用过但不在通用词表里的东西（内部框架、小众库）也能命中。
 */
export function parseTechStack(jd: string, extra: string[] = []): Tristate<string[]> {
  const lower = jd.toLowerCase();
  const vocab = [...new Set([...TECH_LEXICON, ...extra.map((e) => e.toLowerCase())])]
    // 长词优先，避免 "go" 抢在 "mongodb" 前面
    .sort((a, b) => b.length - a.length);

  const hits = new Set<string>();
  let firstIdx = -1;
  for (const term of vocab) {
    if (term.length < 2) continue;
    // 纯 ASCII 词要求词边界，否则 "go" 会命中 "django"、"algorithm"
    const pattern = /^[\x20-\x7e]+$/.test(term)
      ? new RegExp(`(?<![a-z0-9.+#])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9+#])`, 'i')
      : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const m = lower.match(pattern);
    if (m?.index !== undefined) {
      hits.add(canon(term));
      if (firstIdx === -1) firstIdx = m.index;
    }
  }
  if (hits.size === 0) return UNKNOWN<string[]>();
  return t([...hits].sort(), 'explicit_jd', excerpt(jd, firstIdx));
}

// ── 远程 / 城市 ────────────────────────────────────────────────────────────

export function parseRemote(jd: string): Tristate<string> {
  const m = jd.match(/全职远程|远程办公|remote[- ]?first|可远程/i);
  if (m?.index !== undefined) return t('remote', 'explicit_jd', excerpt(jd, m.index));
  const h = jd.match(/混合办公|hybrid/i);
  if (h?.index !== undefined) return t('hybrid', 'explicit_jd', excerpt(jd, h.index));
  return UNKNOWN<string>();
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

export interface ParsedAttrs {
  education: Tristate<string>;
  exp_years_min: Tristate<number>;
  work_schedule: Tristate<string>;
  tech_stack: Tristate<string[]>;
  remote: Tristate<string>;
  outsourcing: Tristate<number>;
}

export interface ParseJobInput {
  jdText: string;
  companyName: string;
  salaryRaw?: string | null;
  /** 你自己账本里的技术 tag，用来扩展词表 */
  extraTech?: string[];
}

export function parseJob(input: ParseJobInput): {
  attrs: ParsedAttrs;
  salary: SalaryParse;
  outsourcingSignals: OutsourcingSignal[];
} {
  const jd = input.jdText;
  const out = parseOutsourcing(jd, input.companyName);
  return {
    salary: parseSalary(input.salaryRaw ?? ''),
    outsourcingSignals: out.signals,
    attrs: {
      education: parseEducation(jd),
      exp_years_min: parseExperience(jd),
      work_schedule: parseSchedule(jd),
      tech_stack: parseTechStack(jd, input.extraTech ?? []),
      remote: parseRemote(jd),
      outsourcing:
        out.likelihood === null
          ? UNKNOWN<number>()
          : t(out.likelihood, 'inferred', out.signals.map((s) => s.signal).join('；')),
    },
  };
}

export const ATTR_KEYS = [
  'education', 'exp_years_min', 'work_schedule', 'tech_stack', 'remote', 'outsourcing',
] as const;
export type AttrKey = (typeof ATTR_KEYS)[number];

/**
 * 落库时的 attrs。除了六个可打分维度，还带一些跟着走的出处信息。
 * coverage 只数这六个维度 —— 附加字段不是「披露的信息」。
 */
export interface StoredAttrs extends Partial<ParsedAttrs> {
  salary_months_confidence?: Confidence;
  salary_conflict?: boolean;
}

const UNKNOWN_TRI: Tristate<never> = { value: null, confidence: 'unknown', source: null };

/**
 * 安全读取一个维度。
 *
 * 历史数据、只填了部分字段的采集器、schema 演进 —— 都会让 attrs 缺键。
 * 缺键时返回 unknown，而不是让打分在 `undefined.confidence` 上崩掉。
 */
export function attr<T>(attrs: StoredAttrs | undefined, key: AttrKey): Tristate<T> {
  const v = attrs?.[key] as Tristate<T> | undefined;
  return v && typeof v === 'object' && 'confidence' in v ? v : (UNKNOWN_TRI as Tristate<T>);
}

/** 已披露的维度数 / 总维度数。UI 上的「置信度」就是这个。 */
export function coverage(attrs: StoredAttrs): { known: number; total: number; ratio: number } {
  const known = ATTR_KEYS.filter((k) => attr(attrs, k).confidence !== 'unknown').length;
  return { known, total: ATTR_KEYS.length, ratio: known / ATTR_KEYS.length };
}
