import type { ElementRef } from '../collectors/bridge/types.js';
import type { Db } from '../db/index.js';
import { recordMissingField } from '../facts/requests.js';
import { classifyField, fieldText, MIN_CONFIDENCE, type FieldClass, type FieldMatch } from './classify.js';

/**
 * 填表计划（DESIGN §7.2）。
 *
 * **计划和执行分两步**，中间那步是人看一眼。这不是 UI 便利，
 * 是这个功能的安全模型：叙事字段的改写必须先展示、决策字段必须人填、
 * 而**永远不点提交**。一个「一键填完并提交」的实现是另一种产品。
 */

export type PlanAction =
  /** 直接从档案照抄。不过模型 */
  | 'copy'
  /** 模型改写，**先展示后写入** */
  | 'rewrite'
  /** 高亮出来让人填。工具不碰 */
  | 'ask_user'
  /** 传文件 */
  | 'upload'
  /** 认不出来 */
  | 'skip';

export interface PlannedField {
  ref: string;
  label: string;
  fieldClass: FieldClass;
  profileKey: string | null;
  action: PlanAction;
  /** copy 时是档案里的值；rewrite 时为 null（等模型产出后人确认） */
  value: string | null;
  confidence: number;
  evidence: string;
  /** 之前在这个域名上人工纠正过 —— 直接用，不再猜 */
  learned: boolean;
  required: boolean;
}

export interface FormPlan {
  domain: string;
  url: string;
  fields: PlannedField[];
  /** 统计，用来在 UI 上一句话说清「这次会做什么」 */
  summary: { copy: number; rewrite: number; askUser: number; upload: number; skip: number };
  /** 永远为 false。放在这里是为了让「不提交」成为一个显式的、可断言的事实 */
  willSubmit: false;
}

export interface LearnedMapping {
  selector: string;
  profileKey: string;
  fieldClass: FieldClass;
  confirmed: boolean;
}

export function loadFieldMap(db: Db, domain: string): Map<string, LearnedMapping> {
  const rows = db
    .prepare('SELECT selector, profile_key, field_class, confirmed_by_user FROM form_field_map WHERE domain = ?')
    .all(domain) as { selector: string; profile_key: string; field_class: string; confirmed_by_user: number }[];
  return new Map(
    rows.map((r) => [
      r.selector,
      { selector: r.selector, profileKey: r.profile_key, fieldClass: r.field_class as FieldClass, confirmed: Boolean(r.confirmed_by_user) },
    ]),
  );
}

/**
 * 人工纠正之后记住。**按域名记，不按页面** ——
 * 同一个招聘系统的不同岗位页字段是一样的，第一次填慢，第二次就快了。
 */
export function learnField(
  db: Db,
  domain: string,
  selector: string,
  profileKey: string,
  fieldClass: FieldClass,
): void {
  db.prepare(
    `INSERT INTO form_field_map (domain, selector, profile_key, field_class, confirmed_by_user)
     VALUES (?,?,?,?,1)
     ON CONFLICT(domain, selector) DO UPDATE SET
       profile_key = excluded.profile_key, field_class = excluded.field_class, confirmed_by_user = 1`,
  ).run(domain, selector, profileKey, fieldClass);
}

/** 元素的稳定标识。ref（`@e1`）每次 snapshot 都会变，不能拿来当记忆的键。 */
export function selectorOf(el: ElementRef): string {
  return el.name ? `[name=${el.name}]` : el.id ? `#${el.id}` : `${el.tag}:${(el.label ?? el.placeholder ?? '').slice(0, 24)}`;
}

export interface PlanOptions {
  /** 档案里的登记字段。**原样照抄，不经过任何模型** */
  profileFields: Record<string, string>;
  /** 简历 PDF 路径，用于 type=file */
  resumePath?: string;
  /**
   * 把「这个站问了但档案里没有」记进 `profile_field_requests`。
   *
   * 这是反馈边：中文网申会问一堆 schema 里压根没有的字段（政治面貌、籍贯、
   * 紧急联系人……），穷举不完也不该穷举。让表单来告诉档案缺什么，
   * 下次同一个字段就有值了。
   */
  recordMissing?: boolean;
}

export function planForm(
  db: Db,
  domain: string,
  url: string,
  elements: ElementRef[],
  opts: PlanOptions,
): FormPlan {
  const learned = loadFieldMap(db, domain);
  const fields: PlannedField[] = [];
  const missing: { key?: string; label: string; cls: FieldClass; el: ElementRef }[] = [];

  for (const el of elements) {
    if (el.tag === 'button' || el.type === 'submit' || el.type === 'hidden') continue;

    const sel = selectorOf(el);
    const memo = learned.get(sel);
    const m: FieldMatch = memo
      ? { ref: el.ref, fieldClass: memo.fieldClass, profileKey: memo.profileKey,
          confidence: 1, evidence: `之前在 ${domain} 上你纠正过这个字段` }
      : classifyField(el);

    let action: PlanAction;
    let value: string | null = null;

    if (m.profileKey === '__resume__') {
      action = opts.resumePath ? 'upload' : 'skip';
      value = opts.resumePath ?? null;
    } else if (m.fieldClass === 'decision') {
      // 永不自动填。即使档案里有 preferences，那也只是默认值 ——
      // 它随岗位而变，而这个工具不知道你对**这一家**怎么想。
      action = 'ask_user';
    } else if (m.fieldClass === 'registry' && m.confidence >= MIN_CONFIDENCE && m.profileKey) {
      const v = opts.profileFields[m.profileKey];
      action = v ? 'copy' : 'ask_user';
      value = v ?? null;
      // 认出来了但档案里没值 —— 这是最值得补的一类：字段是已知的，只差你填
      if (!v) missing.push({ key: m.profileKey, label: el.label ?? m.profileKey, cls: 'registry', el });
    } else if (m.fieldClass === 'narrative') {
      action = 'rewrite';
    } else {
      // 认不出来就不动。硬猜一个登记字段填错的代价，是一份写着别人手机号的申请。
      action = 'skip';
      // 但要记下来：认不出的字段里有一大半是「政治面貌」这种我们没定义过的
      const label = el.label ?? el.placeholder;
      if (label?.trim()) missing.push({ key: undefined, label: label.trim(), cls: 'registry', el });
    }

    fields.push({
      ref: el.ref,
      label: (el.label ?? el.placeholder ?? fieldText(el)).slice(0, 60),
      fieldClass: m.fieldClass,
      profileKey: m.profileKey,
      action,
      value,
      confidence: m.confidence,
      evidence: m.evidence,
      learned: Boolean(memo),
      required: Boolean(el.required),
    });
  }

  // 记账放在最后、且只记一次：计划可能被反复重算（页面一变就要重 snapshot），
  // 每次都 +1 会让 seen_count 变成「重算了几次」而不是「被几个站问过」。
  if (opts.recordMissing) {
    for (const m of missing) {
      try {
        recordMissingField(db, {
          key: m.key, label: m.label, fieldClass: m.cls, domain,
          example: m.el.placeholder ?? m.el.nearby ?? undefined,
        });
      } catch {
        /* 记不上不该让填表失败 */
      }
    }
  }

  const summary = {
    copy: fields.filter((f) => f.action === 'copy').length,
    rewrite: fields.filter((f) => f.action === 'rewrite').length,
    askUser: fields.filter((f) => f.action === 'ask_user').length,
    upload: fields.filter((f) => f.action === 'upload').length,
    skip: fields.filter((f) => f.action === 'skip').length,
  };
  return { domain, url, fields, summary, willSubmit: false };
}
