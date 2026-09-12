import type { Db } from '../db/index.js';
import { todayLocal } from '../util/paths.js';

/**
 * 平台访问闸门（DESIGN §4.4）。
 *
 * 语义抄自 BossHunter 的 `PlatformAccessGuard`，代码自己写（那个仓库是
 * PolyForm Noncommercial，见 vendor/THIRD_PARTY_NOTICES.md）。
 *
 * 两条不能动的规矩：
 *
 * 1. **记账在开页之前。** 先 `reserve` 再导航。反过来的话，崩在半路的那次
 *    不算数，于是「崩溃 → 重试」的循环能完整绕开预算 —— 而那恰好是
 *    出问题时最常见的模式。
 * 2. **命中风控立刻上锁，且默认只能手动解。** 「等一小时自动重试」
 *    正是最该避免的行为：对方刚告诉你它注意到你了。
 */

export type LockKind =
  | 'code_37'
  | 'captcha'
  | 'login_wall'
  | 'rate_limited'
  | 'unknown_page'
  | 'manual';

export const GLOBAL = '*';

export class GuardBlocked extends Error {
  constructor(
    readonly platform: string,
    readonly reason: string,
    readonly kind: 'locked' | 'budget',
  ) {
    super(reason);
    this.name = 'GuardBlocked';
  }
}

export interface Budget {
  dailyPages: number;
  perStage?: Record<string, number>;
}

export const DEFAULT_BUDGET: Budget = {
  // 一天 120 页对个人求职足够 —— 你投不完 2000 个岗位（DESIGN §14 纪律三）。
  // 定得低不是保守：超过这个量本身就说明用法跑偏了。
  dailyPages: 120,
  perStage: { list: 40, detail: 100 },
};

interface SafetyRow {
  platform: string;
  locked: number;
  lock_reason: string | null;
  lock_kind: string | null;
  locked_at: string | null;
  unlock_after: string | null;
  hits: number;
}

export interface LockState {
  platform: string;
  locked: boolean;
  reason: string | null;
  kind: LockKind | null;
  lockedAt: string | null;
  unlockAfter: string | null;
  hits: number;
}

function row(db: Db, platform: string): SafetyRow | undefined {
  return db.prepare('SELECT * FROM platform_safety_state WHERE platform = ?').get(platform) as
    | SafetyRow
    | undefined;
}

function toState(r: SafetyRow | undefined, platform: string): LockState {
  if (!r) {
    return { platform, locked: false, reason: null, kind: null, lockedAt: null, unlockAfter: null, hits: 0 };
  }
  // unlock_after 到点了就当没锁。注意**不清库** —— 锁过这件事本身是历史，
  // hits 一直累加，让「这个平台今年被风控过 5 次」可查。
  const expired = r.unlock_after !== null && r.unlock_after <= new Date().toISOString();
  return {
    platform: r.platform,
    locked: Boolean(r.locked) && !expired,
    reason: r.lock_reason,
    kind: (r.lock_kind as LockKind) ?? null,
    lockedAt: r.locked_at,
    unlockAfter: r.unlock_after,
    hits: r.hits,
  };
}

export function lockState(db: Db, platform: string): LockState {
  return toState(row(db, platform), platform);
}

/** 全局锁 + 平台锁，哪个响都算。 */
export function effectiveLock(db: Db, platform: string): LockState | null {
  const g = toState(row(db, GLOBAL), GLOBAL);
  if (g.locked) return g;
  const p = toState(row(db, platform), platform);
  return p.locked ? p : null;
}

export function usedToday(db: Db, platform: string, stage?: string): number {
  const day = todayLocal();
  const sql = stage
    ? `SELECT COUNT(*) n FROM platform_access_events
        WHERE platform = ? AND stage = ? AND date(occurred_at, 'localtime') = ?`
    : `SELECT COUNT(*) n FROM platform_access_events
        WHERE platform = ? AND date(occurred_at, 'localtime') = ?`;
  const args = stage ? [platform, stage, day] : [platform, day];
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

export interface ReserveInput {
  stage?: string;
  action?: string;
  budget?: Budget;
}

/**
 * 申请开一页。**必须在真的导航之前调用。**
 *
 * 通过就已经记了一笔账；后面无论成功、失败还是进程被杀，这一页都算用过了。
 */
export function reserve(db: Db, platform: string, input: ReserveInput = {}): void {
  const lock = effectiveLock(db, platform);
  if (lock) {
    throw new GuardBlocked(
      platform,
      `${lock.platform === GLOBAL ? '全局' : lock.platform}已上锁（${lock.kind ?? '未知'}）：${lock.reason ?? ''}\n` +
        '解锁要人来做，不会自动恢复 —— 平台刚告诉过你它注意到你了。',
      'locked',
    );
  }

  const budget = input.budget ?? DEFAULT_BUDGET;
  const total = usedToday(db, platform);
  if (total >= budget.dailyPages) {
    throw new GuardBlocked(platform, `${platform} 今天已开 ${total} 页，达到上限 ${budget.dailyPages}`, 'budget');
  }
  if (input.stage && budget.perStage?.[input.stage] !== undefined) {
    const limit = budget.perStage[input.stage]!;
    const used = usedToday(db, platform, input.stage);
    if (used >= limit) {
      throw new GuardBlocked(
        platform,
        `${platform} 的 ${input.stage} 今天已开 ${used} 页，达到上限 ${limit}`,
        'budget',
      );
    }
  }

  db.prepare(
    `INSERT INTO platform_access_events (platform, stage, action, occurred_at)
     VALUES (?,?,?,datetime('now'))`,
  ).run(platform, input.stage ?? null, input.action ?? null);
}

/** 记录这一页的结果。只是观测，不影响预算 —— 预算在 reserve 时就扣了。 */
export function record(db: Db, platform: string, outcome: string, detail?: string): void {
  db.prepare(
    `UPDATE platform_access_events SET outcome = ?, detail = ?
      WHERE id = (SELECT MAX(id) FROM platform_access_events WHERE platform = ?)`,
  ).run(outcome, detail ?? null, platform);
}

export interface TripOptions {
  /** 锁全局而不是单平台。只在信号明显跨平台时用（比如整个网络被标记） */
  global?: boolean;
  /** 自动解锁时间。**默认不设** —— 风控命中就该人来看一眼 */
  unlockAfter?: string;
}

/** 命中风控：立刻上锁。**绝不尝试绕过。** */
export function trip(
  db: Db,
  platform: string,
  kind: LockKind,
  reason: string,
  opts: TripOptions = {},
): LockState {
  const target = opts.global ? GLOBAL : platform;
  db.prepare(
    `INSERT INTO platform_safety_state (platform, locked, lock_reason, lock_kind, locked_at, unlock_after, hits)
     VALUES (?, 1, ?, ?, datetime('now'), ?, 1)
     ON CONFLICT(platform) DO UPDATE SET
       locked = 1, lock_reason = excluded.lock_reason, lock_kind = excluded.lock_kind,
       locked_at = excluded.locked_at, unlock_after = excluded.unlock_after,
       hits = platform_safety_state.hits + 1`,
  ).run(target, reason, kind, opts.unlockAfter ?? null);
  record(db, platform, 'blocked', `${kind}: ${reason}`);
  return lockState(db, target);
}

/** 人工解锁。hits 不清 —— 「这个平台被风控过几次」是要能查的。 */
export function clearLock(db: Db, platform: string): void {
  db.prepare(
    `UPDATE platform_safety_state
        SET locked = 0, lock_reason = NULL, lock_kind = NULL, unlock_after = NULL
      WHERE platform = ?`,
  ).run(platform);
}

export interface GuardStatus extends LockState {
  usedToday: number;
  dailyLimit: number;
  byStage: { stage: string; used: number; limit: number | null }[];
}

export function guardStatus(db: Db, platform: string, budget = DEFAULT_BUDGET): GuardStatus {
  const st = lockState(db, platform);
  const seen = db
    .prepare(
      `SELECT DISTINCT stage FROM platform_access_events
        WHERE platform = ? AND stage IS NOT NULL AND date(occurred_at, 'localtime') = ?`,
    )
    .all(platform, todayLocal()) as { stage: string }[];
  const stages = new Set([...Object.keys(budget.perStage ?? {}), ...seen.map((r) => r.stage)]);
  return {
    ...st,
    usedToday: usedToday(db, platform),
    dailyLimit: budget.dailyPages,
    byStage: [...stages].map((s) => ({
      stage: s,
      used: usedToday(db, platform, s),
      limit: budget.perStage?.[s] ?? null,
    })),
  };
}
