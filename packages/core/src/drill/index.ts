import type { Db } from '../db/index.js';
import { newId } from '../util/hash.js';
import { todayLocal } from '../util/paths.js';
import { INITIAL, addDays, nextReview, type Grade, type ReviewState } from './sm2.js';

export * from './sm2.js';

/**
 * 题库与复习（DESIGN §9）。
 *
 * 两条硬约束写在表上而不是代码里（0001_init.sql）：
 *   - `source_ref` NOT NULL：**没有来源的题不入库**
 *   - `credibility` 独立于 `source_type`：「一个人在牛客发的帖」和
 *     「我自己面完记下来的」都是真实来源，但可信度差着量级
 */

export type SourceType = 'web_scrape' | 'manual' | 'real_interview' | 'claim_derived' | 'official_doc';
export type Credibility = 'verified' | 'secondhand' | 'unverified';

export interface AddQuestionInput {
  content: string;
  topic?: string;
  sourceType: SourceType;
  /** 必填。URL、面经出处、或「2026-09-12 某某科技一面」 */
  sourceRef: string;
  credibility?: Credibility;
  informant?: string;
  claimId?: string | null;
  answerStandard?: string;
  answerStandardRefs?: string[];
  answerMine?: string;
  answerMineClaimIds?: string[];
}

export class MissingSource extends Error {
  constructor() {
    super(
      '题目必须有来源（sourceRef）。\n' +
        '  「这题哪来的」决定了你该花多少时间在它上面 —— 一道大厂真题和一道' +
        '不知哪抄来的题，复习优先级不一样。没有来源的题进了库就再也分不清。',
    );
    this.name = 'MissingSource';
  }
}

/** 同一道题重复录入很常见（不同面经抄来抄去）。按内容归一化去重。 */
function normalizeContent(s: string): string {
  return s.replace(/\s+/g, '').replace(/[？?。.，,、；;：:！!]/g, '').toLowerCase();
}

export interface AddQuestionResult {
  id: string;
  created: boolean;
  /** 已存在时，是否因为这次录入提升了可信度 */
  upgraded: boolean;
}

const CRED_RANK: Record<Credibility, number> = { unverified: 0, secondhand: 1, verified: 2 };

export function addQuestion(db: Db, input: AddQuestionInput): AddQuestionResult {
  if (!input.sourceRef?.trim()) throw new MissingSource();
  if (!input.content.trim()) throw new Error('题目内容不能为空');

  const norm = normalizeContent(input.content);
  const existing = db
    .prepare('SELECT id, content, credibility FROM questions')
    .all() as { id: string; content: string; credibility: Credibility }[];
  const dup = existing.find((q) => normalizeContent(q.content) === norm);

  const cred = input.credibility ?? (input.sourceType === 'real_interview' ? 'verified' : 'unverified');

  if (dup) {
    // 同一道题被不同来源提到过，可信度取高的那个 ——
    // 「三份面经都提到」本身就是信号。
    if (CRED_RANK[cred] > CRED_RANK[dup.credibility]) {
      db.prepare('UPDATE questions SET credibility = ?, source_ref = ? WHERE id = ?')
        .run(cred, input.sourceRef, dup.id);
      return { id: dup.id, created: false, upgraded: true };
    }
    return { id: dup.id, created: false, upgraded: false };
  }

  const id = newId('q_');
  db.prepare(
    `INSERT INTO questions
       (id, content, topic, source_type, source_ref, credibility, informant, claim_id,
        answer_standard, answer_standard_refs, answer_mine, answer_mine_claim_ids)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, input.content.trim(), input.topic ?? null, input.sourceType, input.sourceRef.trim(),
    cred, input.informant ?? null, input.claimId ?? null,
    input.answerStandard ?? null,
    input.answerStandardRefs ? JSON.stringify(input.answerStandardRefs) : null,
    input.answerMine ?? null,
    input.answerMineClaimIds ? JSON.stringify(input.answerMineClaimIds) : null,
  );

  const origin = input.sourceType === 'real_interview' ? 'real_interview'
    : input.sourceType === 'claim_derived' ? 'claim_derived' : 'drill';
  db.prepare(
    `INSERT INTO reviews (question_id, ease_factor, interval_days, repetitions, origin, next_review_at)
     VALUES (?,?,?,?,?,datetime('now'))`,
  ).run(id, INITIAL.easeFactor, INITIAL.intervalDays, INITIAL.repetitions, origin);

  return { id, created: true, upgraded: false };
}

export interface DueQuestion {
  id: string;
  content: string;
  topic: string | null;
  sourceType: SourceType;
  sourceRef: string;
  credibility: Credibility;
  claimId: string | null;
  answerStandard: string | null;
  answerMine: string | null;
  origin: string | null;
  repetitions: number;
  nextReviewAt: string;
}

/**
 * 今天该复习什么。
 *
 * 排序刻意先按来源权重再按到期时间：真实面试答错的题，
 * 即使和日常刷题的同一天到期，也该先看。
 */
export function dueToday(db: Db, limit = 20, now = new Date()): DueQuestion[] {
  const rows = db
    .prepare(
      `SELECT q.*, r.origin, r.repetitions, r.next_review_at
         FROM questions q JOIN reviews r ON r.question_id = q.id
        WHERE r.next_review_at <= ?
        ORDER BY CASE r.origin
                   WHEN 'real_interview' THEN 0
                   WHEN 'claim_derived' THEN 1
                   WHEN 'mock_interview' THEN 2
                   ELSE 3 END,
                 r.next_review_at ASC
        LIMIT ?`,
    )
    .all(now.toISOString(), limit) as any[];
  return rows.map((r) => ({
    id: r.id, content: r.content, topic: r.topic, sourceType: r.source_type,
    sourceRef: r.source_ref, credibility: r.credibility, claimId: r.claim_id,
    answerStandard: r.answer_standard, answerMine: r.answer_mine,
    origin: r.origin, repetitions: r.repetitions, nextReviewAt: r.next_review_at,
  }));
}

export interface GradeResult {
  questionId: string;
  state: ReviewState;
  dueInDays: number;
  nextReviewAt: string;
}

export function gradeQuestion(db: Db, questionId: string, grade: Grade, now = new Date()): GradeResult {
  const r = db
    .prepare('SELECT ease_factor, interval_days, repetitions, origin FROM reviews WHERE question_id = ?')
    .get(questionId) as
    | { ease_factor: number; interval_days: number; repetitions: number; origin: string | null }
    | undefined;
  if (!r) throw new Error(`题目 ${questionId} 没有复习记录`);

  const next = nextReview(
    { easeFactor: r.ease_factor, intervalDays: r.interval_days, repetitions: r.repetitions },
    grade,
    r.origin ?? 'drill',
  );
  const at = addDays(now, next.dueInDays);
  db.prepare(
    `UPDATE reviews SET ease_factor = ?, interval_days = ?, repetitions = ?, last_grade = ?, next_review_at = ?
      WHERE question_id = ?`,
  ).run(next.easeFactor, next.intervalDays, next.repetitions, grade, at, questionId);

  return {
    questionId,
    state: { easeFactor: next.easeFactor, intervalDays: next.intervalDays, repetitions: next.repetitions },
    dueInDays: next.dueInDays,
    nextReviewAt: at,
  };
}

export interface DrillBoard {
  total: number;
  dueNow: number;
  byTopic: { topic: string; total: number; due: number }[];
  byCredibility: Record<string, number>;
  /** 连续答错 ≥2 次的题。这就是错题本 */
  weakest: { id: string; content: string; origin: string | null; lastGrade: number | null }[];
  todayGraded: number;
}

export function drillBoard(db: Db, now = new Date()): DrillBoard {
  const total = (db.prepare('SELECT COUNT(*) n FROM questions').get() as any).n;
  const dueNow = (db
    .prepare('SELECT COUNT(*) n FROM reviews WHERE next_review_at <= ?')
    .get(now.toISOString()) as any).n;

  const byTopic = db
    .prepare(
      `SELECT COALESCE(q.topic,'(未分类)') topic, COUNT(*) total,
              SUM(CASE WHEN r.next_review_at <= ? THEN 1 ELSE 0 END) due
         FROM questions q JOIN reviews r ON r.question_id = q.id
        GROUP BY q.topic ORDER BY due DESC, total DESC`,
    )
    .all(now.toISOString()) as any[];

  const cred: Record<string, number> = {};
  for (const r of db.prepare('SELECT credibility, COUNT(*) n FROM questions GROUP BY credibility').all() as any[]) {
    cred[r.credibility] = r.n;
  }

  const weakest = db
    .prepare(
      `SELECT q.id, q.content, r.origin, r.last_grade
         FROM questions q JOIN reviews r ON r.question_id = q.id
        WHERE r.last_grade IS NOT NULL AND r.last_grade < 3
        ORDER BY CASE r.origin WHEN 'real_interview' THEN 0 WHEN 'claim_derived' THEN 1 ELSE 2 END,
                 r.last_grade ASC
        LIMIT 20`,
    )
    .all() as any[];

  const todayGraded = (db
    .prepare("SELECT COUNT(*) n FROM reviews WHERE last_grade IS NOT NULL AND date(next_review_at) >= ?")
    .get(todayLocal(now)) as any).n;

  return {
    total, dueNow,
    byTopic: byTopic.map((r) => ({ topic: r.topic, total: r.total, due: r.due })),
    byCredibility: cred,
    weakest: weakest.map((r) => ({ id: r.id, content: r.content, origin: r.origin, lastGrade: r.last_grade })),
    todayGraded,
  };
}

/**
 * 把一段面经原文拆成题目。
 *
 * **不自动入库。** 返回候选，由人勾选 —— 模型拆题会把
 * 「面试官人很好」这种句子也拆成一道题，而那种噪音进了库就很难清。
 */
export interface SplitCandidate {
  content: string;
  topic: string | null;
}

export function parseSplitOutput(text: string): SplitCandidate[] {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`模型没有返回合法 JSON（前 200 字）：${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('模型返回的不是数组');
  return (parsed as any[])
    .filter((q) => typeof q?.content === 'string' && q.content.trim().length >= 4)
    .map((q) => ({ content: String(q.content).trim(), topic: q.topic ? String(q.topic) : null }));
}
