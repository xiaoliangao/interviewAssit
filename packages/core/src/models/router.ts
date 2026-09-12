import type { Visibility } from '@assit/contract';
import { NoProviderAvailable, PrivacyBlocked, type Provider, type Task } from './types.js';
import { canHandle, DEFAULT_ROUTES, defaultRegistry } from './registry.js';

export interface RouteTable {
  [task: string]: { provider: string; fallback: string[] };
}

export interface RouterOptions {
  registry?: Map<string, Provider>;
  routes?: RouteTable;
  /** 注入可用性判断，测试用；不传则真去探测。 */
  availability?: (id: string) => Promise<boolean> | boolean;
}

export interface RouteDecision {
  provider: Provider;
  chain: string[];
  skippedForPrivacy: { id: string; max: Visibility }[];
  skippedForAvailability: string[];
}

/**
 * 按任务 + 载荷敏感级选 provider。
 *
 * 两种失败必须区分开：
 *   - 有候选，但全都扛不住这个敏感级 -> PrivacyBlocked（去配本地模型）
 *   - 压根没有可用的                 -> NoProviderAvailable（去配 key）
 * 混成一个错误的话，你分不清该装 ollama 还是该填 API key。
 */
export async function route(
  task: Task,
  visibility: Visibility,
  opts: RouterOptions = {},
): Promise<RouteDecision> {
  const registry = opts.registry ?? defaultRegistry();
  const routes = opts.routes ?? DEFAULT_ROUTES;
  const entry = routes[task] ?? DEFAULT_ROUTES[task];
  if (!entry) throw new NoProviderAvailable(task);

  const chain = [entry.provider, ...entry.fallback];
  const skippedForPrivacy: { id: string; max: Visibility }[] = [];
  const skippedForAvailability: string[] = [];

  for (const id of chain) {
    const p = registry.get(id);
    if (!p) {
      skippedForAvailability.push(id);
      continue;
    }
    if (!canHandle(p.spec, visibility)) {
      skippedForPrivacy.push({ id, max: p.spec.max_visibility });
      continue;
    }
    const available = opts.availability ? await opts.availability(id) : await p.isAvailable();
    if (!available) {
      skippedForAvailability.push(id);
      continue;
    }
    return { provider: p, chain, skippedForPrivacy, skippedForAvailability };
  }

  // 只要有 provider 是因为敏感级被挡下的，就报隐私错误 —— 这比「没有可用 provider」
  // 更准确，也更可行动：用户需要知道的是「装个本地模型」而不是「检查网络」。
  if (skippedForPrivacy.length > 0) {
    throw new PrivacyBlocked(task, visibility, skippedForPrivacy);
  }
  throw new NoProviderAvailable(task);
}
