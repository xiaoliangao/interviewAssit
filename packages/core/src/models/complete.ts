import type { Visibility } from '@assit/contract';
import type { Db } from '../db/index.js';
import { cacheGet, cacheSet, promptHash } from './cache.js';
import { redact } from './redact.js';
import { route, type RouterOptions } from './router.js';
import type { CompleteRequest, CompleteResult, RedactionLevel } from './types.js';

export interface CompleteOptions extends RouterOptions {
  db?: Db | null;
  /** 载荷进模型前的脱敏级别。不传则按 visibility 推导。 */
  redaction?: RedactionLevel;
}

function defaultRedaction(v: Visibility): RedactionLevel {
  return v === 'public' ? 'none' : 'signatures';
}

/**
 * 唯一的模型入口。所有调用都必须经过这里，因为这里挂着四件事：
 * 脱敏 -> 路由（visibility 拦截）-> 缓存 -> 用量记账。
 *
 * 绕过它直接调 provider 的代码，就是绕过了隐私闸门。code review 时这是红线。
 */
export async function complete(
  req: CompleteRequest,
  opts: CompleteOptions = {},
): Promise<CompleteResult> {
  const db = opts.db ?? null;
  const level = opts.redaction ?? defaultRedaction(req.visibility);
  const safePrompt = redact(req.prompt, level).text;
  const safeSystem = req.system ? redact(req.system, level).text : undefined;

  const decision = await route(req.task, req.visibility, opts);
  const { provider } = decision;
  const model = provider.spec.model;
  const hash = promptHash(safeSystem, safePrompt);

  if (!req.noCache) {
    const hit = cacheGet(db, req.task, hash, model);
    if (hit !== null) {
      recordUsage(db, {
        task: req.task,
        provider: provider.spec.id,
        model,
        redaction_level: level,
        visibility: req.visibility,
        cache_hit: 1,
      });
      return { text: hit, provider: provider.spec.id, model, cacheHit: true };
    }
  }

  const out = await provider.complete({
    system: safeSystem,
    prompt: safePrompt,
    model,
    maxTokens: req.maxTokens ?? 2048,
    temperature: req.temperature,
  });

  cacheSet(db, req.task, hash, model, out.text);
  recordUsage(db, {
    task: req.task,
    provider: provider.spec.id,
    model,
    redaction_level: level,
    visibility: req.visibility,
    cache_hit: 0,
    input_tokens: out.inputTokens,
    output_tokens: out.outputTokens,
  });

  return {
    text: out.text,
    provider: provider.spec.id,
    model,
    cacheHit: false,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
  };
}

export interface UsageRow {
  task: string;
  provider: string;
  model: string | null;
  redaction_level?: string;
  visibility?: string;
  cache_hit: 0 | 1;
  input_tokens?: number;
  output_tokens?: number;
  cost_cents?: number;
}

export function recordUsage(db: Db | null, row: UsageRow): void {
  db?.prepare(
    `INSERT INTO model_usage
      (task, provider, model, redaction_level, visibility, cache_hit,
       input_tokens, output_tokens, cost_cents)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.task,
    row.provider,
    row.model,
    row.redaction_level ?? null,
    row.visibility ?? null,
    row.cache_hit,
    row.input_tokens ?? null,
    row.output_tokens ?? null,
    row.cost_cents ?? null,
  );
}
