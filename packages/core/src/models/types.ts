import type { Visibility } from '@assit/contract';

export type ProviderKind = 'api' | 'cli' | 'local';

/** 调模型的场景。路由按任务走，不是全局选一个模型（DESIGN §10.2）。 */
export type Task =
  | 'code_analysis'
  | 'resume_rewrite'
  | 'jd_extract'
  | 'interview_chat'
  | 'question_answer'
  | 'email_classify';

export const ALL_TASKS: Task[] = [
  'code_analysis', 'resume_rewrite', 'jd_extract',
  'interview_chat', 'question_answer', 'email_classify',
];

export type RedactionLevel = 'none' | 'signatures' | 'summary';

export interface ProviderSpec {
  id: string;
  kind: ProviderKind;
  /** 该 provider 允许处理的最高敏感级。路由层强制校验，这不是提示，是闸门。 */
  max_visibility: Visibility;
  model: string;
  endpoint?: string;
  /** keychain 里的引用名或环境变量名 —— 密钥本身永不入库 */
  credential_ref?: string;
}

export interface CompleteRequest {
  task: Task;
  visibility: Visibility;
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** 传入后跳过缓存（测试或强制重算用） */
  noCache?: boolean;
}

export interface CompleteResult {
  text: string;
  provider: string;
  model: string;
  cacheHit: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Provider {
  spec: ProviderSpec;
  isAvailable(): Promise<boolean> | boolean;
  complete(req: {
    system?: string;
    prompt: string;
    model: string;
    maxTokens: number;
    temperature?: number;
  }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}

/**
 * 载荷的敏感级超过了所有可用 provider 的承受上限。
 *
 * 这是正确行为，不是故障。宁可硬失败让你去配一个本地模型，
 * 也不要静默地把公司代码发到云端 —— 后者可能直接违反雇佣合同。
 */
export class PrivacyBlocked extends Error {
  constructor(
    readonly task: Task,
    readonly visibility: Visibility,
    readonly rejected: { id: string; max: Visibility }[],
  ) {
    super(
      `任务 ${task} 的载荷是 ${visibility}，没有任何已配置的 provider 能处理它。\n` +
        rejected.map((r) => `  - ${r.id} 最高只能处理 ${r.max}`).join('\n') +
        `\n配一个本地模型（如 ollama）后重试，或把这条内容脱敏到 public 再用。`,
    );
    this.name = 'PrivacyBlocked';
  }
}

export class NoProviderAvailable extends Error {
  constructor(readonly task: Task) {
    super(`任务 ${task} 没有可用的 provider。跑 \`assit providers\` 看检测结果。`);
    this.name = 'NoProviderAvailable';
  }
}
