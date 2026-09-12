import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  GLOBAL,
  GuardBlocked,
  clearLock,
  effectiveLock,
  guardStatus,
  lockState,
  openDb,
  record,
  reserve,
  trip,
  usedToday,
  type Db,
} from '@assit/core';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-guard-'));
  process.env.ASSIT_DATA_DIR = dir;
  db = openDb();
});
afterEach(() => {
  db.close();
  delete process.env.ASSIT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const small = { dailyPages: 3, perStage: { list: 2 } };

describe('预算：记账在开页之前', () => {
  it('每次 reserve 都立刻记一笔 —— 崩在半路的那次也算用过了', () => {
    reserve(db, 'boss', { stage: 'list', budget: small });
    expect(usedToday(db, 'boss')).toBe(1);
    // 模拟这一页崩了：没有 record，但账已经记上
    reserve(db, 'boss', { stage: 'list', budget: small });
    expect(usedToday(db, 'boss')).toBe(2);
  });

  it('「崩溃 → 重试」不能绕开预算', () => {
    reserve(db, 'boss', { stage: 'list', budget: small });
    reserve(db, 'boss', { stage: 'list', budget: small });
    expect(() => reserve(db, 'boss', { stage: 'list', budget: small })).toThrow(GuardBlocked);
  });

  it('stage 预算和总预算各管各的', () => {
    reserve(db, 'boss', { stage: 'list', budget: small });
    reserve(db, 'boss', { stage: 'list', budget: small });
    // list 满了，但 detail 还能开
    expect(() => reserve(db, 'boss', { stage: 'list', budget: small })).toThrow(/list/);
    expect(() => reserve(db, 'boss', { stage: 'detail', budget: small })).not.toThrow();
    // 总量到 3 了
    expect(() => reserve(db, 'boss', { stage: 'detail', budget: small })).toThrow(/上限 3/);
  });

  it('平台之间预算独立', () => {
    reserve(db, 'boss', { budget: small });
    reserve(db, 'boss', { budget: small });
    reserve(db, 'boss', { budget: small });
    expect(() => reserve(db, 'boss', { budget: small })).toThrow(GuardBlocked);
    expect(() => reserve(db, '51job', { budget: small })).not.toThrow();
  });

  it('默认预算刻意定得低 —— 超过这个量说明用法跑偏了', () => {
    expect(DEFAULT_BUDGET.dailyPages).toBeLessThanOrEqual(200);
  });
});

describe('风控锁', () => {
  it('命中即锁，且默认没有自动解锁时间', () => {
    const st = trip(db, 'boss', 'code_37', '响应 code=37');
    expect(st.locked).toBe(true);
    expect(st.unlockAfter).toBeNull();
    expect(() => reserve(db, 'boss')).toThrow(/已上锁/);
  });

  it('锁是按平台的 —— BOSS 被限流说明不了 51job 的任何事', () => {
    trip(db, 'boss', 'rate_limited', '太频繁');
    expect(() => reserve(db, 'boss')).toThrow(GuardBlocked);
    expect(() => reserve(db, '51job')).not.toThrow();
  });

  it('但信号跨平台时可以全局锁', () => {
    trip(db, 'boss', 'captcha', '整个网络被标记了', { global: true });
    expect(() => reserve(db, '51job')).toThrow(/全局已上锁/);
    expect(lockState(db, 'boss').locked).toBe(false); // 平台自己那行没动
    expect(effectiveLock(db, '51job')?.platform).toBe(GLOBAL);
  });

  it('解锁要人来做，而 hits 不清零 —— 被风控过几次是要能查的', () => {
    trip(db, 'boss', 'code_37', 'a');
    clearLock(db, 'boss');
    expect(lockState(db, 'boss').locked).toBe(false);
    expect(lockState(db, 'boss').hits).toBe(1);
    trip(db, 'boss', 'captcha', 'b');
    expect(lockState(db, 'boss').hits).toBe(2);
  });

  it('设了 unlock_after 且已过期就放行，但记录仍在', () => {
    trip(db, 'boss', 'rate_limited', '短时限流', { unlockAfter: '2000-01-01T00:00:00.000Z' });
    const st = lockState(db, 'boss');
    expect(st.locked).toBe(false);
    expect(st.hits).toBe(1);
    expect(() => reserve(db, 'boss')).not.toThrow();
  });

  it('上锁会在最近一条访问记录上留下原因', () => {
    reserve(db, 'boss', { stage: 'list' });
    trip(db, 'boss', 'code_37', '环境存在异常');
    const row = db
      .prepare('SELECT outcome, detail FROM platform_access_events ORDER BY id DESC LIMIT 1')
      .get() as { outcome: string; detail: string };
    expect(row.outcome).toBe('blocked');
    expect(row.detail).toContain('code_37');
  });
});

describe('状态展示', () => {
  it('把今天用了多少、各 stage 用了多少一起给出来', () => {
    reserve(db, 'boss', { stage: 'list' });
    reserve(db, 'boss', { stage: 'detail' });
    record(db, 'boss', 'ok');
    const s = guardStatus(db, 'boss');
    expect(s.usedToday).toBe(2);
    expect(s.byStage.find((x) => x.stage === 'list')?.used).toBe(1);
    expect(s.byStage.find((x) => x.stage === 'detail')?.used).toBe(1);
    expect(s.locked).toBe(false);
  });
});
