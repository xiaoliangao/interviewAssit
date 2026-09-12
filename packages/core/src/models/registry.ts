import { VIS_RANK, type Visibility } from '@assit/contract';
import type { Provider, ProviderSpec, Task } from './types.js';
import { anthropicProvider } from './providers/anthropic.js';
import { ollamaProvider } from './providers/ollama.js';
import { cliProvider } from './providers/cli.js';

/**
 * provider 的 max_visibility 是硬编码的，设置页不提供放开的开关（plan §9.1）。
 *
 * 理由：这个上限不是偏好，是事实 —— api:* 和 cli:* 都会把内容发出这台机器。
 * 做成可配置项的结果是某天赶时间时把它调高，然后忘掉。
 */
export const DEFAULT_PROVIDERS: (ProviderSpec & { bin?: string; args?: string[] })[] = [
  {
    id: 'api:anthropic',
    kind: 'api',
    max_visibility: 'public',
    model: 'claude-sonnet-5',
    credential_ref: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'cli:claude',
    kind: 'cli',
    max_visibility: 'public',
    model: 'cli-default',
    bin: 'claude',
    args: ['-p'],
  },
  {
    id: 'cli:codex',
    kind: 'cli',
    max_visibility: 'public',
    model: 'cli-default',
    bin: 'codex',
    args: ['exec'],
  },
  {
    id: 'local:ollama',
    kind: 'local',
    max_visibility: 'nda',
    model: process.env.ASSIT_OLLAMA_MODEL ?? 'qwen2.5-coder:7b',
  },
];

export function buildProvider(spec: ProviderSpec & { bin?: string; args?: string[] }): Provider {
  if (spec.kind === 'api') return anthropicProvider(spec);
  if (spec.kind === 'local') return ollamaProvider(spec);
  return cliProvider({ ...spec, bin: spec.bin ?? spec.id.split(':')[1]!, args: spec.args });
}

export function defaultRegistry(): Map<string, Provider> {
  return new Map(DEFAULT_PROVIDERS.map((s) => [s.id, buildProvider(s)]));
}

/**
 * 默认路由。降级链里不满足 visibility 的会被路由层跳过，
 * 而不是「降级到一个弱一点的模型」——那是两回事。
 * code_analysis 首选本地，因为它的载荷天然可能是 private / nda。
 */
export const DEFAULT_ROUTES: Record<Task, { provider: string; fallback: string[] }> = {
  code_analysis: { provider: 'local:ollama', fallback: ['api:anthropic', 'cli:claude'] },
  resume_rewrite: { provider: 'api:anthropic', fallback: ['cli:claude', 'local:ollama'] },
  jd_extract: { provider: 'api:anthropic', fallback: ['cli:claude', 'local:ollama'] },
  interview_chat: { provider: 'api:anthropic', fallback: ['cli:claude', 'local:ollama'] },
  question_answer: { provider: 'api:anthropic', fallback: ['cli:claude', 'local:ollama'] },
  email_classify: { provider: 'local:ollama', fallback: ['api:anthropic'] },
};

export function canHandle(spec: ProviderSpec, visibility: Visibility): boolean {
  return VIS_RANK[visibility] <= VIS_RANK[spec.max_visibility];
}
