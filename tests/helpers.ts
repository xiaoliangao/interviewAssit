import { Claim, Profile } from '@assit/contract';
import type { Provider, ProviderSpec } from '@assit/core';

export function makeClaim(over: Partial<Record<string, unknown>> = {}) {
  return Claim.parse({
    id: 'claim-test-001',
    source_fact: '重构订单服务的库存扣减逻辑',
    candidate_wording: '重构订单服务库存扣减链路，消除并发超卖',
    responsibility_level: '主导方案或交付',
    verification_status: '已确认',
    boundary: '方案与核心实现是我；压测由 QA 执行',
    visibility: 'private',
    last_verified: '2026-08-01',
    ...over,
  });
}

export function makeProfile(over: Record<string, unknown> = {}) {
  return Profile.parse({
    fields: { 'name.zh': '李工', phone: '13900001111', email: 'a@b.com' },
    records: {
      employment: [
        {
          company: '杭州盈通网络科技有限公司',
          title: '高级后端工程师',
          start_at: '2021-03',
          end_at: null,
          is_current: true,
        },
      ],
    },
    ...over,
  });
}

/** 假 provider：只用来验证路由决策，不发任何网络请求。 */
export function fakeProvider(spec: ProviderSpec, available = true): Provider {
  return {
    spec,
    isAvailable: () => available,
    async complete() {
      return { text: `[${spec.id}]` };
    },
  };
}

export function registryOf(...specs: (ProviderSpec & { available?: boolean })[]) {
  return new Map(specs.map((s) => [s.id, fakeProvider(s, s.available ?? true)]));
}
