import type { BrowserBridge } from '../collectors/bridge/types.js';
import type { FormPlan, PlannedField } from './plan.js';

/**
 * 执行一份**已经被人看过**的填表计划。
 *
 * 这个函数里没有提交。不是「默认不提交」，是根本没有那条代码路径 ——
 * 一旦允许自动提交，这个工具的性质就变了（DESIGN §7.2 红线一）。
 */

export class NarrativeNotApproved extends Error {
  constructor(refs: string[]) {
    super(
      `有 ${refs.length} 个叙事字段还没有经过确认的文本：${refs.join('、')}\n` +
        '叙事字段必须**先展示、人确认后**才写进输入框 —— ' +
        '模型改写出来的句子会代表你说话，而你要为它负责。',
    );
    this.name = 'NarrativeNotApproved';
  }
}

export interface FormFillInput {
  tabId: string;
  plan: FormPlan;
  /**
   * 人已经确认过的叙事文本：ref → 最终文本。
   * 计划里 action=rewrite 的字段，**必须**在这里有值才会被写入。
   */
  approvedNarratives?: Record<string, string>;
  /** 只填这几个 ref。人在 UI 上取消勾选的不填 */
  only?: string[];
}

export interface FormFillResult {
  filled: { ref: string; label: string; profileKey: string | null; value: string }[];
  uploaded: { ref: string; path: string }[];
  /** 留给人填的 —— 这些要在 UI 上高亮 */
  leftToUser: { ref: string; label: string; why: string }[];
  /** 供投递快照使用（DESIGN §7.1 第四份） */
  snapshot: Record<string, string>;
  submitted: false;
}

export async function applyPlan(bridge: BrowserBridge, input: FormFillInput): Promise<FormFillResult> {
  const { plan } = input;
  const want = (f: PlannedField): boolean => !input.only || input.only.includes(f.ref);

  const pending = plan.fields.filter(
    (f) => f.action === 'rewrite' && want(f) && !input.approvedNarratives?.[f.ref],
  );
  if (pending.length > 0) throw new NarrativeNotApproved(pending.map((f) => f.label || f.ref));

  const filled: FormFillResult['filled'] = [];
  const uploaded: FormFillResult['uploaded'] = [];
  const leftToUser: FormFillResult['leftToUser'] = [];
  const snapshot: Record<string, string> = {};

  for (const f of plan.fields) {
    if (!want(f)) continue;
    switch (f.action) {
      case 'copy': {
        if (f.value === null) break;
        await bridge.fill(input.tabId, f.ref, f.value);
        filled.push({ ref: f.ref, label: f.label, profileKey: f.profileKey, value: f.value });
        snapshot[f.label || f.ref] = f.value;
        break;
      }
      case 'rewrite': {
        const text = input.approvedNarratives![f.ref]!;
        await bridge.fill(input.tabId, f.ref, text);
        filled.push({ ref: f.ref, label: f.label, profileKey: null, value: text });
        snapshot[f.label || f.ref] = text;
        break;
      }
      case 'upload': {
        if (!f.value) break;
        await bridge.uploadFile(input.tabId, f.ref, f.value);
        uploaded.push({ ref: f.ref, path: f.value });
        snapshot[f.label || f.ref] = `(文件) ${f.value.split('/').pop()}`;
        break;
      }
      case 'ask_user':
        leftToUser.push({
          ref: f.ref,
          label: f.label,
          why: f.fieldClass === 'decision' ? '决策字段：只有你知道对这一家怎么想' : '档案里没有这个值',
        });
        break;
      case 'skip':
        leftToUser.push({ ref: f.ref, label: f.label, why: f.evidence });
        break;
    }
  }

  return { filled, uploaded, leftToUser, snapshot, submitted: false };
}
