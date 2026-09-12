import { describe, expect, it } from 'vitest';
import { baselineBullet, droppedMetrics, extractTokens, mergeBigrams, selectClaims } from '@assit/core';
import { makeClaim } from './helpers.js';

describe('主张选择：确定性、可解释', () => {
  it('重叠 bigram 接回成词 —— 对照表是给人看的', () => {
    expect(mergeBigrams(['分布', '布式', '式锁'])).toEqual(['分布式锁']);
    expect(mergeBigrams(['go', '容器', '器化', '化迁', '迁移'])).toEqual(['go', '容器化迁移']);
    expect(mergeBigrams(['订单', '库存'])).toEqual(expect.arrayContaining(['订单', '库存']));
  });

  it('中英文都能抽出 token，停用词不算命中', () => {
    const t = extractTokens('负责 Redis 分布式锁的设计与实现');
    expect(t.has('redis')).toBe(true);
    expect(t.has('负责')).toBe(false); // 停用词
  });

  it('按 JD 选主张，不匹配的不入选', () => {
    const jd = '需要 Go、Redis、分布式锁、高并发经验';
    const hit = makeClaim({ id: 'claim-hit-001', tags: ['Go', 'Redis', '分布式锁'] });
    const miss = makeClaim({
      id: 'claim-miss-001',
      source_fact: '设计了一套财务对账的报表模板',
      candidate_wording: '设计财务对账报表模板',
      tags: ['Excel', '财务'],
    });
    const picked = selectClaims([hit, miss], jd);
    expect(picked.map((p) => p.claim.id)).toEqual(['claim-hit-001']);
  });

  it('final 模式不提未确认的数字，draft 模式留占位符', () => {
    const c = makeClaim({
      metrics: [
        { name: 'P99', before: 820, after: 210, unit: 'ms', status: '已确认' },
        { name: '超卖工单', before: null, after: null, unit: '单/月', status: '待补' },
      ],
    });
    const draft = baselineBullet(c, { includePlaceholders: true });
    expect(draft).toContain('需补充');

    const final = baselineBullet(c, { includePlaceholders: false });
    expect(final).not.toContain('需补充');
    expect(final).toContain('820ms → 210ms'); // 确认过的数字照常保留
    expect(droppedMetrics(c)).toEqual(['超卖工单']);
  });

  it('「待确认」的主张在 final 模式下压根不参与选择', () => {
    const c = makeClaim({ verification_status: '待确认', last_verified: null, tags: ['Go'] });
    expect(selectClaims([c], 'Go 后端')).toHaveLength(0);
    expect(selectClaims([c], 'Go 后端', { includeUnconfirmed: true })).toHaveLength(1);
  });
});
