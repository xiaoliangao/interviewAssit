import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INITIAL,
  MissingSource,
  addQuestion,
  drillBoard,
  dueToday,
  gradeQuestion,
  nextReview,
  openDb,
  parseSplitOutput,
  type Db,
} from '@assit/core';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-drill-'));
  process.env.ASSIT_DATA_DIR = dir;
  db = openDb();
});
afterEach(() => {
  db.close();
  delete process.env.ASSIT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SM-2', () => {
  it('答对时间隔按 1 → 6 → ×EF 走', () => {
    let s = INITIAL;
    s = nextReview(s, 5);
    expect(s.intervalDays).toBe(1);
    s = nextReview(s, 5);
    expect(s.intervalDays).toBe(6);
    s = nextReview(s, 5);
    expect(s.intervalDays).toBeGreaterThan(6);
  });

  it('答错重复次数归零，但 easeFactor 不归零 —— 一次失手不该抹掉长期难度画像', () => {
    let s = { easeFactor: 2.5, intervalDays: 30, repetitions: 5 };
    const r = nextReview(s, 1);
    expect(r.repetitions).toBe(0);
    expect(r.intervalDays).toBe(1);
    expect(r.easeFactor).toBeGreaterThan(1.3);
    expect(r.easeFactor).toBeLessThan(2.5);
  });

  it('easeFactor 有下限 1.3 —— 再低难题会几乎每天出现，最后你会关掉整个功能', () => {
    let s = INITIAL;
    for (let i = 0; i < 20; i++) s = nextReview(s, 0);
    expect(s.easeFactor).toBe(1.3);
  });

  it('真实面试答错的题重复得更密', () => {
    const base = { easeFactor: 2.5, intervalDays: 10, repetitions: 3 };
    const drill = nextReview(base, 4, 'drill');
    const real = nextReview(base, 4, 'real_interview');
    expect(real.dueInDays).toBeLessThan(drill.dueInDays);
  });
});

describe('题库：没有来源的题不入库', () => {
  it('缺 sourceRef 直接拒绝，并说清为什么', () => {
    expect(() => addQuestion(db, { content: 'q', sourceType: 'manual', sourceRef: '  ' }))
      .toThrow(MissingSource);
  });

  it('真实面试来的题默认 verified，网上抄的默认 unverified', () => {
    const a = addQuestion(db, { content: 'MVCC 怎么实现的？', sourceType: 'real_interview', sourceRef: '2026-09-12 某某一面' });
    const b = addQuestion(db, { content: 'Go 的 GMP 模型', sourceType: 'web_scrape', sourceRef: 'https://x/y' });
    const rows = db.prepare('SELECT id, credibility FROM questions').all() as any[];
    expect(rows.find((r) => r.id === a.id).credibility).toBe('verified');
    expect(rows.find((r) => r.id === b.id).credibility).toBe('unverified');
  });

  it('同一道题换个标点也算重复 —— 面经之间抄来抄去很常见', () => {
    addQuestion(db, { content: '什么是 MVCC？', sourceType: 'web_scrape', sourceRef: 'a' });
    const r = addQuestion(db, { content: '什么是MVCC', sourceType: 'web_scrape', sourceRef: 'b' });
    expect(r.created).toBe(false);
    expect((db.prepare('SELECT COUNT(*) n FROM questions').get() as any).n).toBe(1);
  });

  it('重复录入时可信度取高的 —— 「三份面经都提到」本身就是信号', () => {
    const a = addQuestion(db, { content: '什么是 MVCC？', sourceType: 'web_scrape', sourceRef: 'a' });
    const b = addQuestion(db, { content: '什么是 MVCC？', sourceType: 'real_interview', sourceRef: '某某一面' });
    expect(b.id).toBe(a.id);
    expect(b.upgraded).toBe(true);
    expect((db.prepare('SELECT credibility FROM questions WHERE id=?').get(a.id) as any).credibility).toBe('verified');
  });

  it('可信度只降不升地被覆盖是错的 —— verified 不会被 unverified 盖掉', () => {
    const a = addQuestion(db, { content: 'q1', sourceType: 'real_interview', sourceRef: 'x' });
    addQuestion(db, { content: 'q1', sourceType: 'web_scrape', sourceRef: 'y' });
    expect((db.prepare('SELECT credibility FROM questions WHERE id=?').get(a.id) as any).credibility).toBe('verified');
  });
});

describe('复习', () => {
  it('新题立刻到期', () => {
    addQuestion(db, { content: 'q1', sourceType: 'manual', sourceRef: 'x' });
    expect(dueToday(db)).toHaveLength(1);
  });

  it('真实面试的题排在日常刷题前面，即使同一天到期', () => {
    addQuestion(db, { content: '日常题', sourceType: 'web_scrape', sourceRef: 'a' });
    addQuestion(db, { content: '真题', sourceType: 'real_interview', sourceRef: '某某一面' });
    expect(dueToday(db)[0]!.content).toBe('真题');
  });

  it('答对之后不再出现在今天的清单里', () => {
    const q = addQuestion(db, { content: 'q1', sourceType: 'manual', sourceRef: 'x' });
    const r = gradeQuestion(db, q.id, 5);
    expect(r.dueInDays).toBeGreaterThanOrEqual(1);
    expect(dueToday(db)).toHaveLength(0);
  });

  it('答错明天还来', () => {
    const q = addQuestion(db, { content: 'q1', sourceType: 'manual', sourceRef: 'x' });
    const r = gradeQuestion(db, q.id, 1);
    expect(r.dueInDays).toBe(1);
    expect(r.state.repetitions).toBe(0);
  });
});

describe('看板与错题本', () => {
  it('答错的题进错题本，真实面试的排最前', () => {
    const a = addQuestion(db, { content: '刷题错的', sourceType: 'web_scrape', sourceRef: 'a' });
    const b = addQuestion(db, { content: '真题错的', sourceType: 'real_interview', sourceRef: 'b' });
    gradeQuestion(db, a.id, 2);
    gradeQuestion(db, b.id, 2);
    const board = drillBoard(db);
    expect(board.weakest[0]!.content).toBe('真题错的');
    expect(board.weakest).toHaveLength(2);
  });

  it('按主题统计到期数', () => {
    addQuestion(db, { content: 'q1', topic: 'MySQL', sourceType: 'manual', sourceRef: 'x' });
    addQuestion(db, { content: 'q2', topic: 'MySQL', sourceType: 'manual', sourceRef: 'x' });
    addQuestion(db, { content: 'q3', topic: 'Go', sourceType: 'manual', sourceRef: 'x' });
    const b = drillBoard(db);
    expect(b.total).toBe(3);
    expect(b.byTopic.find((t) => t.topic === 'MySQL')!.due).toBe(2);
  });
});

describe('面经拆题：不自动入库', () => {
  it('太短的碎句被丢掉 —— 「面试官人很好」不该变成一道题', () => {
    const out = parseSplitOutput(JSON.stringify([
      { content: '介绍一下 MVCC 的实现', topic: 'MySQL' },
      { content: '好', topic: null },
      { content: '   ' },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]!.topic).toBe('MySQL');
  });

  it('模型乱返回时显式失败', () => {
    expect(() => parseSplitOutput('我不能完成')).toThrow(/合法 JSON/);
    expect(() => parseSplitOutput('{}')).toThrow(/不是数组/);
  });
});
