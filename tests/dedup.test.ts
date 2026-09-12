import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_COOLDOWN_DAYS,
  applicationKey,
  checkCooldown,
  companyFingerprint,
  identityKey,
  mergeCompanies,
  normalizeCompany,
  normalizeTitle,
  openDb,
  parseTimestamp,
  pendingAliases,
  resolveCompany,
  salaryConflict,
  type Db,
} from '@assit/core';

/**
 * 去重守门（plan §7.2）。
 *
 * 两个 key 回答两个不同的问题。合并成一个的话，你要么把该投的挡了，
 * 要么把同一个岗位投两遍 —— 两种都很尴尬。
 */

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-dedup-'));
  db = openDb(path.join(dir, 'test.sqlite'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('公司归并：规则只用来猜，猜不准的交给人确认一次', () => {
  it('同一个写法稳定解析到同一个 company_id', () => {
    const a = resolveCompany(db, '杭州某某科技有限公司');
    const b = resolveCompany(db, '杭州某某科技有限公司');
    expect(b.companyId).toBe(a.companyId);
    expect(b.isNewAlias).toBe(false);
  });

  it('指纹能猜中的写法自动归并，但标成待确认', () => {
    const a = resolveCompany(db, '北京字节跳动科技有限公司');
    const b = resolveCompany(db, '字节跳动');
    expect(b.companyId).toBe(a.companyId);
    expect(b.isNewAlias).toBe(true);
    expect(b.fingerprintMatch?.canonicalName).toBe('北京字节跳动科技有限公司');

    // 自动归并过的写法要出现在待确认队列里 —— 不能悄悄合并两家公司
    expect(pendingAliases(db).map((p) => p.alias)).toContain('字节跳动');
  });

  it('指纹猜不中的写法先各算一家，等人工合并', () => {
    // 「杭州某某科技有限公司」和「某某科技」没有任何可靠规则能归到一起，
    // 假装能做到的实现，早晚会把两家真正不同的公司合成一家
    const a = resolveCompany(db, '杭州某某科技有限公司');
    const b = resolveCompany(db, '某某科技');
    expect(b.companyId).not.toBe(a.companyId);

    mergeCompanies(db, b.companyId, a.companyId);
    expect(resolveCompany(db, '某某科技').companyId).toBe(a.companyId);
  });

  it('英文与中文主体名分别记别名，合并后都指向同一家', () => {
    const zh = resolveCompany(db, '北京字节跳动科技有限公司');
    const en = resolveCompany(db, 'ByteDance Ltd.');
    mergeCompanies(db, en.companyId, zh.companyId);
    expect(resolveCompany(db, 'ByteDance Ltd.').companyId).toBe(zh.companyId);
  });

  it('指纹剥掉后缀和城市前缀，但不会把名字剥空', () => {
    expect(companyFingerprint('北京字节跳动科技有限公司')).toBe('字节跳动');
    expect(companyFingerprint('字节跳动')).toBe('字节跳动');
    // 主体名本身就是城市名时不剥
    expect(companyFingerprint('上海有限公司')).toBe('上海');
  });
});

describe('岗位身份键：同一岗位跨平台合并', () => {
  it('公司解析一致时，噪音不同的标题合并成一个 job', () => {
    // BOSS 挂「【急招】后端开发工程师（杭州）P7」，51job 挂「后端开发工程师 - 高薪双休」
    const co = resolveCompany(db, '杭州某某科技有限公司').companyId;
    const boss = identityKey(co, '【急招】后端开发工程师（杭州）P7', '杭州');
    const job51 = identityKey(co, '后端开发工程师 - 高薪双休', '杭州');
    expect(boss).toBe(job51);
  });

  it('薪资写法不同不影响合并 —— 这正是 key 里不放薪资的原因', () => {
    // BOSS 写 25-40K·15薪，51job 写 2.5-4万/月，猎聘给年薪。
    // 分桶之后仍可能落到不同桶；漏合比误合难受得多。
    const co = resolveCompany(db, '某某科技').companyId;
    expect(identityKey(co, '后端工程师', '北京')).toBe(identityKey(co, '后端工程师', '北京'));
  });

  it('不同城市的同名岗位不合并', () => {
    const co = resolveCompany(db, '某某科技').companyId;
    expect(identityKey(co, '后端开发工程师', '杭州')).not.toBe(
      identityKey(co, '后端开发工程师', '上海'),
    );
  });

  it('不同职能不合并', () => {
    const co = resolveCompany(db, '某某科技').companyId;
    expect(identityKey(co, '后端开发工程师', '杭州')).not.toBe(
      identityKey(co, '前端开发工程师', '杭州'),
    );
  });

  it('不同公司不合并', () => {
    const a = resolveCompany(db, '甲公司').companyId;
    const b = resolveCompany(db, '乙公司').companyId;
    expect(identityKey(a, '后端工程师', '杭州')).not.toBe(identityKey(b, '后端工程师', '杭州'));
  });

  it('职位名归一化去掉噪音但保留语义', () => {
    expect(normalizeTitle('【急招】高级后端开发工程师（杭州）P7')).toBe('高级后端开发工程师');
    expect(normalizeTitle('Golang 开发工程师 / 后端')).toBe('golang 开发工程师 后端');
    expect(normalizeCompany('北京字节跳动科技有限公司')).toBe('北京字节跳动');
  });
});

describe('投递身份键与冷却窗口', () => {
  it('同公司不同职能族的投递放行', () => {
    // 你可能真的想同时投这家的后端和 SRE —— 这不是重复投递
    expect(applicationKey('c-1', 'backend')).not.toBe(applicationKey('c-1', 'sre'));
  });

  it('同公司同职能族是同一个投递身份', () => {
    expect(applicationKey('c-1', 'backend')).toBe(applicationKey('c-1', 'backend'));
  });

  it('时间戳一律按 UTC 读 —— SQLite 的 datetime(now) 不带时区标记', () => {
    // 混着本地时区解析，会在「89 天还是 90 天」的边界上真的翻车
    expect(parseTimestamp('2026-08-01 10:00:00').toISOString()).toBe('2026-08-01T10:00:00.000Z');
    expect(parseTimestamp('2026-08-01').toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(parseTimestamp('2026-08-01T10:00:00Z').toISOString()).toBe('2026-08-01T10:00:00.000Z');
  });

  it('90 天冷却窗口内同 key 告警', () => {
    const now = new Date('2026-09-12T00:00:00Z');
    const hit = checkCooldown(['2026-08-01 10:00:00'], now);
    expect(hit.blocked).toBe(true);
    expect(hit.daysAgo).toBe(41);
    expect(hit.reason).toContain('41 天前');
  });

  it('超过冷却窗口放行', () => {
    const now = new Date('2026-09-12T00:00:00Z');
    const hit = checkCooldown(['2026-01-01 10:00:00'], now);
    expect(hit.blocked).toBe(false);
    expect(hit.daysAgo).toBeGreaterThan(DEFAULT_COOLDOWN_DAYS);
  });

  it('没投过就没有冷却', () => {
    expect(checkCooldown([]).blocked).toBe(false);
  });

  it('多次投递取最近一次判断', () => {
    const now = new Date('2026-09-12T00:00:00Z');
    const hit = checkCooldown(['2025-01-01 10:00:00', '2026-09-01 10:00:00'], now);
    expect(hit.blocked).toBe(true);
    expect(hit.daysAgo).toBe(10);
  });
});

describe('薪资冲突只是标记，不参与身份判定', () => {
  it('宽区间但有重叠不算冲突', () => {
    // 25-40K 本来就是个宽区间，拿下限比上限会把正常挂牌全判成冲突
    expect(salaryConflict({ min: 25000, max: 40000 }, { min: 25000, max: 38000 })).toBe(false);
    expect(salaryConflict({ min: 25000, max: 40000 }, { min: 30000, max: 60000 })).toBe(false);
  });

  it('完全不重叠且差距悬殊时标记冲突', () => {
    expect(salaryConflict({ min: 25000, max: 40000 }, { min: 8000, max: 12000 })).toBe(true);
  });

  it('相邻但不重叠的区间不算冲突 —— 平台取整差异而已', () => {
    expect(salaryConflict({ min: 25000, max: 30000 }, { min: 31000, max: 36000 })).toBe(false);
  });

  it('一边未知时不下结论', () => {
    expect(salaryConflict({ min: null, max: null }, { min: 25000, max: 40000 })).toBe(false);
  });
});
