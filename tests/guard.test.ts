import { describe, expect, it } from 'vitest';
import {
  GuardViolation,
  assertRenderable,
  checkLevelOverreach,
  inspect,
  renderHtml,
  renderMetric,
  usableCertificates,
} from '@assit/core';
import { makeClaim, makeProfile } from './helpers.js';

/**
 * 渲染守门（plan §7.2）。
 *
 * DESIGN §13.7 声称诚实性防线「在代码层强制」。声称不算数 —— 这组测试是它的证明。
 * 这些断言如果开始失败，说明有人把闸门绕过去了，那才是这个项目真正的风险。
 */
describe('渲染守门：只有扛得住核实的内容能进最终 PDF', () => {
  it('「待确认」的主张不能进最终 PDF', () => {
    const claim = makeClaim({ verification_status: '待确认', last_verified: null });
    const bullets = [{ claimId: claim.id, section: '项目', text: '重构库存扣减链路' }];
    expect(() =>
      assertRenderable({ mode: 'final', claims: [claim], bullets }),
    ).toThrow(GuardViolation);

    // 草稿模式可以带着它出一版看看效果 —— 但草稿不该投出去
    expect(() => assertRenderable({ mode: 'draft', claims: [claim], bullets })).not.toThrow();
  });

  it('「已过期」的主张不能进最终 PDF', () => {
    const claim = makeClaim({ verification_status: '已过期', last_verified: '2024-01-01' });
    const bullets = [{ claimId: claim.id, section: '项目', text: '重构库存扣减链路' }];
    expect(() => assertRenderable({ mode: 'final', claims: [claim], bullets })).toThrow(
      GuardViolation,
    );
  });

  it('「不采用」的主张连草稿都进不去', () => {
    const claim = makeClaim({ verification_status: '不采用' });
    const bullets = [{ claimId: claim.id, section: '项目', text: 'x' }];
    for (const mode of ['draft', 'final'] as const) {
      expect(() => assertRenderable({ mode, claims: [claim], bullets })).toThrow(GuardViolation);
    }
  });

  it('责任等级是「参与」时，bullet 不许出现主导类用词', () => {
    const claim = makeClaim({ responsibility_level: '参与' });
    for (const bad of [
      '主导了库存扣减方案的设计',
      '负责整条交易链路的重构',
      'Owned the inventory deduction redesign',
      'Led a team of four engineers',
      '独立完成核心模块',
    ]) {
      const v = checkLevelOverreach(bad, claim);
      expect(v, `应当拦下：${bad}`).not.toBeNull();
      expect(v!.kind).toBe('level_overreach');
    }
  });

  it('等级相符的表述放行', () => {
    const claim = makeClaim({ responsibility_level: '参与' });
    for (const ok of [
      '参与库存扣减链路重构，实现幂等令牌校验部分',
      'Contributed to the inventory deduction redesign',
      '配合完成压测方案的执行',
    ]) {
      expect(checkLevelOverreach(ok, claim), `应当放行：${ok}`).toBeNull();
    }
  });

  it('越级用词在 draft 模式下同样是致命的', () => {
    // 状态问题可以留到最后修，但把「参与」说成「主导」是另一回事 ——
    // 那不是没准备好，是说了假话，草稿也不该有
    const claim = makeClaim({ responsibility_level: '参与' });
    const bullets = [{ claimId: claim.id, section: '项目', text: '主导了整体方案' }];
    expect(() => assertRenderable({ mode: 'draft', claims: [claim], bullets })).toThrow(
      GuardViolation,
    );
  });

  it('待补指标渲染成占位符，永不由模型填数字', () => {
    const text = renderMetric({ name: '超卖工单', before: null, after: null, unit: '单/月', status: '待补' });
    expect(text).toMatch(/__（需补充：超卖工单/);
    expect(text).not.toMatch(/\d+\s*单/);

    const confirmed = renderMetric({ name: 'P99', before: 820, after: 210, unit: 'ms', status: '已确认' });
    expect(confirmed).toBe('P99 820ms → 210ms');
  });

  it('带占位符的 bullet 不能进最终 PDF，但可以进草稿', () => {
    const claim = makeClaim();
    const bullets = [
      { claimId: claim.id, section: '项目', text: '超卖工单降至 __（需补充：超卖工单 / 单/月）__' },
    ];
    expect(() => assertRenderable({ mode: 'final', claims: [claim], bullets })).toThrow(
      GuardViolation,
    );
    expect(() => assertRenderable({ mode: 'draft', claims: [claim], bullets })).not.toThrow();
  });

  it('bullet 引用不存在的主张时拦下 —— 简历里不该有无出处的句子', () => {
    const claim = makeClaim();
    const bullets = [{ claimId: 'claim-does-not-exist', section: '项目', text: '干了件大事' }];
    expect(() => assertRenderable({ mode: 'final', claims: [claim], bullets })).toThrow(
      GuardViolation,
    );
  });

  it('过期证书被剔除，不是警告一下照样渲染', () => {
    const profile = makeProfile({
      fields: { 'name.zh': '张三', phone: '13800000000', email: 'a@b.com' },
      records: {
        certificate: [
          { name: '已过期证书', issued_at: '2021-01-01', expires_at: '2024-01-01' },
          { name: '有效证书', issued_at: '2025-01-01', expires_at: '2030-01-01' },
          { name: '无有效期证书', issued_at: '2020-01-01', expires_at: null },
        ],
      },
    });
    const now = new Date('2026-09-12');
    const usable = usableCertificates(profile, now);
    expect(usable.map((c) => c.name)).toEqual(['有效证书', '无有效期证书']);

    const html = renderHtml({ profile, bullets: [], now });
    expect(html).not.toContain('已过期证书');
    expect(html).toContain('有效证书');

    // 剔除的同时要说出来，否则你会以为它还在简历上
    const violations = inspect({ mode: 'final', claims: [], bullets: [], profile, now });
    expect(violations.some((v) => v.kind === 'expired_certificate')).toBe(true);
  });

  it('一次报出全部问题，而不是修一条跑一次', () => {
    const a = makeClaim({ id: 'claim-a', verification_status: '待确认', last_verified: null });
    const b = makeClaim({ id: 'claim-b', responsibility_level: '参与' });
    const violations = inspect({
      mode: 'final',
      claims: [a, b],
      bullets: [
        { claimId: 'claim-a', section: '项目', text: '做了一些事' },
        { claimId: 'claim-b', section: '项目', text: '主导了另一些事' },
      ],
    });
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(new Set(violations.map((v) => v.kind))).toEqual(
      new Set(['unconfirmed_claim', 'level_overreach']),
    );
  });

  it('渲染出的 HTML 里占位符是显眼的，不是混在正文里', () => {
    const profile = makeProfile();
    const html = renderHtml({
      profile,
      bullets: [{ claimId: 'claim-test-001', section: '项目', text: '降低 __（需补充：延迟）__' }],
    });
    expect(html).toContain('class="placeholder"');
  });
});
