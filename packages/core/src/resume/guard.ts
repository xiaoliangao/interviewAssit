import {
  LEVEL_FORBIDDEN_TERMS,
  type Claim,
  type Metric,
  type Profile,
} from '@assit/contract';

/**
 * 诚实性闸门（DESIGN §13.7）。
 *
 * 设计文档声称这些规则「在代码层强制」。声称没有用 —— 所以它们在这里，
 * 是渲染路径上绕不过去的一个函数，并且 §7.2 的守门测试会证明它真的拦得住。
 *
 * 最容易出事的不是模型胡编一个项目，而是把「参与」写成「主导」、
 * 给一个没测过的数字补个「提升 30%」。面试第二轮就会被问穿。
 */

export type RenderMode = 'draft' | 'final';

export interface Violation {
  kind:
    | 'unconfirmed_claim'
    | 'expired_claim'
    | 'dropped_claim'
    | 'level_overreach'
    | 'unfilled_metric'
    | 'expired_certificate';
  claimId?: string;
  message: string;
  detail?: string;
}

export class GuardViolation extends Error {
  constructor(readonly violations: Violation[]) {
    super(
      `简历渲染被诚实性闸门拦下（${violations.length} 处）：\n` +
        violations.map((v) => `  [${v.kind}] ${v.message}`).join('\n'),
    );
    this.name = 'GuardViolation';
  }
}

export const PLACEHOLDER_RE = /__（需补充[^）]*）__/;

/** 待补的数字渲染成占位符，永不由模型代填。 */
export function renderMetric(m: Metric): string {
  if (m.status === '待补' || m.after === null) {
    return `__（需补充：${m.name}${m.unit ? ` / ${m.unit}` : ''}）__`;
  }
  const unit = m.unit ?? '';
  if (m.before === null) return `${m.name} ${m.after}${unit}`;
  return `${m.name} ${m.before}${unit} → ${m.after}${unit}`;
}

/**
 * 越级用词检查。
 *
 * 判断口径和 career-pivot skill 里的「重述红线」一致：
 * 如果 HR 打电话给前雇主核实，这个说法还站得住吗。
 */
export function checkLevelOverreach(text: string, claim: Claim): Violation | null {
  const forbidden = LEVEL_FORBIDDEN_TERMS[claim.responsibility_level] ?? [];
  const lower = text.toLowerCase();
  const hit = forbidden.find((term) =>
    /[a-z]/.test(term) ? lower.includes(term.toLowerCase()) : text.includes(term),
  );
  if (!hit) return null;
  return {
    kind: 'level_overreach',
    claimId: claim.id,
    message: `「${hit}」超出了该主张的责任等级（${claim.responsibility_level}）`,
    detail: text,
  };
}

export interface BulletDraft {
  claimId: string;
  section: string;
  text: string;
}

export interface GuardInput {
  mode: RenderMode;
  claims: Claim[];
  bullets: BulletDraft[];
  profile?: Profile;
  now?: Date;
}

function isExpired(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso.length === 7 ? `${iso}-01` : iso);
  return !Number.isNaN(d.getTime()) && d.getTime() < now.getTime();
}

/**
 * 返回全部违规，而不是遇到第一条就抛。
 * 一次把该修的都告诉你，比修一条跑一次高效得多。
 */
export function inspect(input: GuardInput): Violation[] {
  const now = input.now ?? new Date();
  const violations: Violation[] = [];
  const byId = new Map(input.claims.map((c) => [c.id, c]));

  for (const c of input.claims) {
    if (c.verification_status === '不采用') {
      violations.push({
        kind: 'dropped_claim',
        claimId: c.id,
        message: `主张 ${c.id} 已标记「不采用」，不应出现在任何简历里`,
      });
      continue;
    }
    // draft 允许待确认/已过期进来（带占位标记），final 一律拦下
    if (input.mode === 'final' && c.verification_status === '待确认') {
      violations.push({
        kind: 'unconfirmed_claim',
        claimId: c.id,
        message: `主张 ${c.id} 仍是「待确认」，不能进最终 PDF`,
        detail: '先确认它，或把它从这份简历里去掉',
      });
    }
    if (input.mode === 'final' && c.verification_status === '已过期') {
      violations.push({
        kind: 'expired_claim',
        claimId: c.id,
        message: `主张 ${c.id} 已过期（last_verified=${c.last_verified ?? '从未'}）`,
        detail: '重新核实后更新 last_verified',
      });
    }
  }

  for (const b of input.bullets) {
    const claim = byId.get(b.claimId);
    if (!claim) {
      violations.push({
        kind: 'dropped_claim',
        claimId: b.claimId,
        message: `bullet 引用了不存在的主张 ${b.claimId}`,
      });
      continue;
    }
    const over = checkLevelOverreach(b.text, claim);
    if (over) violations.push(over);

    if (input.mode === 'final' && PLACEHOLDER_RE.test(b.text)) {
      violations.push({
        kind: 'unfilled_metric',
        claimId: claim.id,
        message: `bullet 里还留着待补占位符，不能进最终 PDF`,
        detail: b.text,
      });
    }
  }

  if (input.profile) {
    for (const cert of input.profile.records.certificate) {
      if (isExpired(cert.expires_at, now)) {
        violations.push({
          kind: 'expired_certificate',
          message: `证书「${cert.name}」已于 ${cert.expires_at} 过期，不会输出到简历`,
        });
      }
    }
  }

  return violations;
}

/** final 模式下有任何违规即抛错。draft 模式只把 level_overreach 当致命。 */
export function assertRenderable(input: GuardInput): Violation[] {
  const all = inspect(input);
  const fatal =
    input.mode === 'final' ? all.filter((v) => v.kind !== 'expired_certificate') : all.filter((v) => v.kind === 'level_overreach' || v.kind === 'dropped_claim');
  if (fatal.length > 0) throw new GuardViolation(fatal);
  return all;
}

/** 过期证书直接从输出里剔除，不是警告一下还照样渲染。 */
export function usableCertificates(profile: Profile, now = new Date()) {
  return profile.records.certificate.filter((c) => !isExpired(c.expires_at, now));
}
