import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NoCodeEvidence,
  addTurn,
  claimDrillStats,
  downgradeLevel,
  endSession,
  gatherProbeContext,
  openDb,
  parseProbes,
  recordAnswer,
  sessionSummary,
  startSession,
  type Db,
} from '@assit/core';
import { Claim } from '@assit/contract';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-iv-'));
  process.env.ASSIT_DATA_DIR = dir;
  db = openDb();
});
afterEach(() => {
  db.close();
  delete process.env.ASSIT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedClaim(id = 'c1', level = '主导方案或交付', status = '已确认'): string {
  db.prepare(
    `INSERT INTO claims (id, source_fact, responsibility_level, verification_status, boundary, visibility)
     VALUES (?,?,?,?,?,'private')`,
  ).run(id, '主导库存扣减重构，超卖工单归零', level, status, '团队做了整体链路，我负责扣减与对账');
  return id;
}

const claimWith = (commits: string[]) =>
  Claim.parse({
    id: 'claim-inv-001',
    source_fact: '主导库存扣减重构',
    responsibility_level: '主导方案或交付',
    verification_status: '已确认',
    boundary: '团队做整体，我做扣减',
    visibility: 'private',
    code_evidence: { repo: 'org/x', commits, prs: [], files_touched: [], modules: ['inventory'], visibility: 'private' },
  });

describe('项目深挖：没有证据就不硬问', () => {
  it('没有 commit 直接拒绝，并指出该怎么补', () => {
    expect(() => gatherProbeContext(claimWith([]), '/tmp')).toThrow(NoCodeEvidence);
  });

  it('commit 全都取不到（仓库换了/rebase 过）也拒绝，而不是产出空上下文', () => {
    expect(() =>
      gatherProbeContext(claimWith(['deadbeef']), '/tmp', {
        runGit: () => { throw new Error('bad object'); },
      }),
    ).toThrow(NoCodeEvidence);
  });

  it('取到的 diff 带上 --stat —— patch 被截断时它还在', () => {
    const seen: string[][] = [];
    const ctx = gatherProbeContext(claimWith(['abc123']), '/tmp', {
      runGit: (args) => { seen.push(args); return 'stat+patch'; },
    });
    expect(seen[0]).toContain('--stat');
    expect(seen[0]).toContain('--patch');
    expect(ctx.diffs).toHaveLength(1);
    expect(ctx.visibility).toBe('private'); // 会被路由层用来挡云端模型
  });

  it('没有 basis 的追问被丢掉 —— 指不回改动的问题就是八股题', () => {
    const out = parseProbes(JSON.stringify([
      { question: '并发下怎么防超卖？', basis: 'commit abc123 改了 deduct.go' },
      { question: '什么是 MVCC？' },
      { question: '  ', basis: 'x' },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]!.question).toContain('超卖');
  });

  it('模型乱返回时显式失败，不吞', () => {
    expect(() => parseProbes('抱歉，我无法完成')).toThrow(/合法 JSON/);
    expect(() => parseProbes('{"a":1}')).toThrow(/不是数组/);
  });

  it('带 ```json 围栏也能解出来', () => {
    expect(parseProbes('```json\n[{"question":"q","basis":"b"}]\n```')).toHaveLength(1);
  });
});

describe('反向边：这是整个系统唯一的闭环', () => {
  it('真实面试答不上来 → 责任等级降一级 + 转待确认', () => {
    seedClaim();
    const s = startSession(db, { kind: 'real', label: '某某科技一面' });
    const t = addTurn(db, { sessionId: s, question: '怎么防超卖？', claimId: 'c1' });
    const fx = recordAnswer(db, { turnId: t, answer: '记不清了', verdict: 'failed' });

    expect(fx.map((f) => f.field).sort()).toEqual(['responsibility_level', 'verification_status']);
    const c = db.prepare('SELECT * FROM claims WHERE id = ?').get('c1') as any;
    expect(c.responsibility_level).toBe('负责模块');
    expect(c.verification_status).toBe('待确认');

    // 留痕：改了什么、凭什么、指回哪一轮
    const ev = db.prepare("SELECT * FROM claim_events WHERE claim_id='c1'").all() as any[];
    expect(ev.every((e) => e.source === 'real_interview')).toBe(true);
    expect(ev.every((e) => e.evidence_ref === t)).toBe(true);
  });

  it('模拟面试答砸只转待确认，不降级 —— 可能只是没准备，不该改写一段真经历', () => {
    seedClaim();
    const s = startSession(db, { kind: 'mock', label: '自己练' });
    const t = addTurn(db, { sessionId: s, question: 'q', claimId: 'c1' });
    recordAnswer(db, { turnId: t, answer: '嗯…', verdict: 'failed' });

    const c = db.prepare('SELECT * FROM claims WHERE id = ?').get('c1') as any;
    expect(c.responsibility_level).toBe('主导方案或交付'); // 没降
    expect(c.verification_status).toBe('待确认');
  });

  it('shaky 也转待确认 —— 它不是错，是「还不能拿出去讲」', () => {
    seedClaim();
    const s = startSession(db, { kind: 'mock', label: 'x' });
    const t = addTurn(db, { sessionId: s, question: 'q', claimId: 'c1' });
    recordAnswer(db, { turnId: t, answer: '大概是…', verdict: 'shaky' });
    expect((db.prepare('SELECT * FROM claims WHERE id=?').get('c1') as any).verification_status).toBe('待确认');
  });

  it('答得住会更新 last_verified —— 被追问过且扛住的主张比没被问过的可信', () => {
    seedClaim();
    const s = startSession(db, { kind: 'real', label: 'x' });
    const t = addTurn(db, { sessionId: s, question: 'q', claimId: 'c1' });
    recordAnswer(db, { turnId: t, answer: '用 Redis 原子扣减 + 对账补偿', verdict: 'solid' });
    const c = db.prepare('SELECT * FROM claims WHERE id=?').get('c1') as any;
    expect(c.last_verified).toBeTruthy();
    expect(c.verification_status).toBe('已确认');
  });

  it('已经是「参与」就不再往下降', () => {
    seedClaim('c1', '参与');
    const s = startSession(db, { kind: 'real', label: 'x' });
    const t = addTurn(db, { sessionId: s, question: 'q', claimId: 'c1' });
    const fx = recordAnswer(db, { turnId: t, answer: '', verdict: 'failed' });
    expect(fx.some((f) => f.field === 'responsibility_level')).toBe(false);
    expect(downgradeLevel('参与')).toBeNull();
  });

  it('不挂主张的问答（八股题）没有反向边', () => {
    const s = startSession(db, { kind: 'drill', label: '刷题' });
    const t = addTurn(db, { sessionId: s, question: '什么是 MVCC？' });
    expect(recordAnswer(db, { turnId: t, answer: '不知道', verdict: 'failed' })).toEqual([]);
  });

  it('skipped 不触发任何降级 —— 跳过不等于答不上来', () => {
    seedClaim();
    const s = startSession(db, { kind: 'real', label: 'x' });
    const t = addTurn(db, { sessionId: s, question: 'q', claimId: 'c1' });
    expect(recordAnswer(db, { turnId: t, answer: '', verdict: 'skipped' })).toEqual([]);
    expect((db.prepare('SELECT * FROM claims WHERE id=?').get('c1') as any).verification_status).toBe('已确认');
  });
});

describe('会话汇总与主张统计', () => {
  it('汇总能说清这一场动了哪些主张', () => {
    seedClaim('c1');
    seedClaim('c2');
    const s = startSession(db, { kind: 'real', label: '某某一面' });
    const t1 = addTurn(db, { sessionId: s, question: 'q1', claimId: 'c1' });
    const t2 = addTurn(db, { sessionId: s, question: 'q2', claimId: 'c2' });
    recordAnswer(db, { turnId: t1, answer: 'a', verdict: 'failed' });
    recordAnswer(db, { turnId: t2, answer: 'a', verdict: 'solid' });
    endSession(db, s, '紧张');

    const sum = sessionSummary(db, s);
    expect(sum.turns).toBe(2);
    expect(sum.byVerdict).toEqual({ failed: 1, solid: 1 });
    expect(sum.affectedClaims).toEqual(['c1']);
    expect(sum.endedAt).toBeTruthy();
  });

  it('答砸最多的主张排最前 —— 那正是下一场最该准备的', () => {
    seedClaim('c1');
    seedClaim('c2');
    const s = startSession(db, { kind: 'mock', label: 'x' });
    for (let i = 0; i < 2; i++) {
      const t = addTurn(db, { sessionId: s, question: 'q', claimId: 'c1' });
      recordAnswer(db, { turnId: t, answer: '', verdict: 'failed' });
    }
    const t = addTurn(db, { sessionId: s, question: 'q', claimId: 'c2' });
    recordAnswer(db, { turnId: t, answer: '', verdict: 'solid' });

    const stats = claimDrillStats(db);
    expect(stats[0]!.claimId).toBe('c1');
    expect(stats[0]!.failed).toBe(2);
  });
});
