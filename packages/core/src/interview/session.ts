import type { ResponsibilityLevel, VerificationStatus } from '@assit/contract';
import type { Db } from '../db/index.js';
import { newId } from '../util/hash.js';

/**
 * 面试会话与**那条反向边**（DESIGN §8.2 / §2.3）。
 *
 * 这是整个系统唯一的闭环：简历里的一条主张 → 被追问 → 答不上来 →
 * **账本里它降级** → 下一份简历不再那样写。
 *
 * 没有这条边，前面所有东西只是一个花哨的岗位筛选器。
 */

export type SessionKind = 'mock' | 'real' | 'drill';

/**
 * 自评四档。**由人填，不是模型判的。**
 *
 * 模型可以给意见，但「我到底答上来没有」只有你知道 ——
 * 让模型判定会同时产生两种错误：把你答得好的判砸（于是降级了一条真主张），
 * 和把你糊弄过去的判过（于是那条主张继续留在简历上）。后者更贵。
 */
export type Verdict = 'solid' | 'shaky' | 'failed' | 'skipped';

export interface StartSessionInput {
  kind: SessionKind;
  label: string;
  jobId?: string | null;
  recordingId?: string | null;
}

export function startSession(db: Db, input: StartSessionInput): string {
  const id = newId('ivs_');
  db.prepare(
    `INSERT INTO interview_sessions (id, kind, job_id, recording_id, label, started_at)
     VALUES (?,?,?,?,?,datetime('now'))`,
  ).run(id, input.kind, input.jobId ?? null, input.recordingId ?? null, input.label);
  return id;
}

export function endSession(db: Db, sessionId: string, note?: string): void {
  db.prepare("UPDATE interview_sessions SET ended_at = datetime('now'), note = ? WHERE id = ?")
    .run(note ?? null, sessionId);
}

export interface AddTurnInput {
  sessionId: string;
  question: string;
  claimId?: string | null;
  questionBasis?: string | null;
}

export function addTurn(db: Db, input: AddTurnInput): string {
  const seq =
    ((db.prepare('SELECT MAX(seq) m FROM interview_turns WHERE session_id = ?').get(input.sessionId) as
      | { m: number | null }
      | undefined)?.m ?? 0) + 1;
  const id = newId('ivt_');
  db.prepare(
    `INSERT INTO interview_turns (id, session_id, seq, claim_id, question, question_basis)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, input.sessionId, seq, input.claimId ?? null, input.question, input.questionBasis ?? null);
  return id;
}

/** 降级路径：主导方案或交付 → 负责模块 → 参与。已经是「参与」就不再往下降。 */
const LEVEL_ORDER: ResponsibilityLevel[] = ['参与', '负责模块', '主导方案或交付', '项目负责人'];

export function downgradeLevel(level: ResponsibilityLevel): ResponsibilityLevel | null {
  const i = LEVEL_ORDER.indexOf(level);
  return i > 0 ? LEVEL_ORDER[i - 1]! : null;
}

export interface AnswerInput {
  turnId: string;
  answer: string;
  verdict: Verdict;
  modelFeedback?: string;
  /** real 的证据权重高于 mock —— 见 applyReverseEdge */
  sessionKind?: SessionKind;
}

export interface ReverseEdgeEffect {
  claimId: string;
  field: 'verification_status' | 'responsibility_level';
  from: string;
  to: string;
  reason: string;
}

/**
 * 记录一次作答，并在需要时走反向边。
 *
 * 分档的理由：
 * - `failed` + 真实面试 → 直接**降责任等级**。真实面试里答不上来，
 *   是关于这条主张最强的证据，比任何自评都硬
 * - `failed` + 模拟面试 → 转「待确认」。模拟里答砸可能只是没准备，
 *   不该因此改写一条可能是真的经历
 * - `shaky` → 转「待确认」。它不是错，是「还不能拿出去讲」
 * - `solid` → 更新 last_verified。**一条经常被追问且答得住的主张，
 *   比一条从没被问过的主张可信**
 */
export function recordAnswer(db: Db, input: AnswerInput): ReverseEdgeEffect[] {
  db.prepare(
    `UPDATE interview_turns
        SET answer = ?, verdict = ?, model_feedback = ?, answered_at = datetime('now')
      WHERE id = ?`,
  ).run(input.answer, input.verdict, input.modelFeedback ?? null, input.turnId);

  const turn = db
    .prepare('SELECT claim_id, session_id FROM interview_turns WHERE id = ?')
    .get(input.turnId) as { claim_id: string | null; session_id: string } | undefined;
  if (!turn?.claim_id) return []; // 不挂主张的问答（八股题）没有反向边

  const kind =
    input.sessionKind ??
    ((db.prepare('SELECT kind FROM interview_sessions WHERE id = ?').get(turn.session_id) as
      | { kind: SessionKind }
      | undefined)?.kind ?? 'mock');

  const claim = db
    .prepare('SELECT responsibility_level, verification_status FROM claims WHERE id = ?')
    .get(turn.claim_id) as
    | { responsibility_level: ResponsibilityLevel; verification_status: VerificationStatus }
    | undefined;
  if (!claim) return [];

  const source = kind === 'real' ? 'real_interview' : 'mock_interview';
  const effects: ReverseEdgeEffect[] = [];

  const write = (
    field: ReverseEdgeEffect['field'],
    from: string,
    to: string,
    note: string,
  ): void => {
    db.prepare(`UPDATE claims SET ${field} = ? WHERE id = ?`).run(to, turn.claim_id);
    db.prepare(
      `INSERT INTO claim_events (claim_id, field, old_value, new_value, source, evidence_ref, note)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(turn.claim_id, field, from, to, source, input.turnId, note);
    effects.push({ claimId: turn.claim_id!, field, from, to, reason: note });
  };

  if (input.verdict === 'failed' && kind === 'real') {
    const lower = downgradeLevel(claim.responsibility_level);
    if (lower) {
      write('responsibility_level', claim.responsibility_level, lower,
        '真实面试里答不上来 —— 这是关于这条主张最强的证据，比任何自评都硬');
    }
    if (claim.verification_status !== '待确认') {
      write('verification_status', claim.verification_status, '待确认', '真实面试未通过追问');
    }
  } else if (input.verdict === 'failed' || input.verdict === 'shaky') {
    // 模拟里答砸可能只是没准备，不该因此改写一条可能是真的经历。
    // 转「待确认」是说「还不能拿出去讲」，不是说「这是假的」。
    if (claim.verification_status === '已确认') {
      write('verification_status', '已确认', '待确认',
        input.verdict === 'failed' ? '模拟面试里答不上来' : '答得不踏实，还不能拿出去讲');
    }
  } else if (input.verdict === 'solid') {
    db.prepare("UPDATE claims SET last_verified = date('now') WHERE id = ?").run(turn.claim_id);
    db.prepare(
      `INSERT INTO claim_events (claim_id, field, old_value, new_value, source, evidence_ref, note)
       VALUES (?, 'last_verified', NULL, date('now'), ?, ?, ?)`,
    ).run(turn.claim_id, source, input.turnId, '被追问且答得住');
  }

  return effects;
}

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  label: string;
  startedAt: string;
  endedAt: string | null;
  turns: number;
  answered: number;
  byVerdict: Record<string, number>;
  /** 这场里被降级/转待确认的主张 */
  affectedClaims: string[];
}

export function sessionSummary(db: Db, sessionId: string): SessionSummary {
  const s = db.prepare('SELECT * FROM interview_sessions WHERE id = ?').get(sessionId) as any;
  if (!s) throw new Error(`找不到会话 ${sessionId}`);
  const turns = db
    .prepare('SELECT verdict, claim_id FROM interview_turns WHERE session_id = ?')
    .all(sessionId) as { verdict: string | null; claim_id: string | null }[];

  const byVerdict: Record<string, number> = {};
  for (const t of turns) if (t.verdict) byVerdict[t.verdict] = (byVerdict[t.verdict] ?? 0) + 1;

  const affected = db
    .prepare(
      `SELECT DISTINCT e.claim_id FROM claim_events e
        JOIN interview_turns t ON t.id = e.evidence_ref
        WHERE t.session_id = ? AND e.field IN ('responsibility_level','verification_status')`,
    )
    .all(sessionId) as { claim_id: string }[];

  return {
    id: s.id, kind: s.kind, label: s.label, startedAt: s.started_at, endedAt: s.ended_at,
    turns: turns.length,
    answered: turns.filter((t) => t.verdict).length,
    byVerdict,
    affectedClaims: affected.map((r) => r.claim_id),
  };
}

export interface ClaimDrillStat {
  claimId: string;
  fact: string;
  level: ResponsibilityLevel;
  status: VerificationStatus;
  asked: number;
  solid: number;
  failed: number;
  lastAsked: string | null;
}

/**
 * 每条主张被追问的历史。
 *
 * 这张表回答的是「简历上哪几条我其实讲不清楚」—— 而那正是
 * 下一场面试最该准备的东西。
 */
export function claimDrillStats(db: Db): ClaimDrillStat[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.source_fact, c.responsibility_level, c.verification_status,
              COUNT(t.id) asked,
              SUM(CASE WHEN t.verdict = 'solid' THEN 1 ELSE 0 END) solid,
              SUM(CASE WHEN t.verdict = 'failed' THEN 1 ELSE 0 END) failed,
              MAX(t.answered_at) last_asked
         FROM claims c LEFT JOIN interview_turns t ON t.claim_id = c.id
        WHERE c.verification_status != '不采用'
        GROUP BY c.id
        ORDER BY failed DESC, asked ASC`,
    )
    .all() as any[];
  return rows.map((r) => ({
    claimId: r.id,
    fact: r.source_fact,
    level: r.responsibility_level,
    status: r.verification_status,
    asked: r.asked ?? 0,
    solid: r.solid ?? 0,
    failed: r.failed ?? 0,
    lastAsked: r.last_asked ?? null,
  }));
}
