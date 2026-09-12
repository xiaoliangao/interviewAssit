import type { ElementRef } from '../collectors/bridge/types.js';

/**
 * 表单字段分类（DESIGN §7.2）。
 *
 * **三类字段区别对待，这是整个功能的骨架：**
 *
 *   registry  登记字段（姓名/手机/学历/公司全称/证书）→ 从档案照抄，**不过模型**
 *   narrative 叙事字段（自我评价/项目描述）          → 调模型改写，先展示后写入
 *   decision  决策字段（期望薪资/到岗时间/能否 996）  → **永远不自动填**
 *
 * 分错的后果不对称：把 decision 错分成 registry，工具就替你做了一个
 * 只有你能做的决定；把 registry 错分成 narrative，你的手机号会被模型改写。
 * 所以两边都宁可落到 `unknown`，交给人。
 */

export type FieldClass = 'registry' | 'narrative' | 'decision' | 'unknown';

export interface FieldMatch {
  ref: string;
  fieldClass: FieldClass;
  /** 命中的档案 key（registry 才有） */
  profileKey: string | null;
  /** 0–1。低于阈值不自动填 —— 见 MIN_CONFIDENCE */
  confidence: number;
  /** 凭什么这么判的。**必须能说出来**，否则出错时没法查 */
  evidence: string;
}

/** 低于这个分就不自动填，只高亮出来让人填。 */
export const MIN_CONFIDENCE = 0.55;

interface Rule {
  key: string;
  cls: FieldClass;
  /** 命中任意一个就算 */
  patterns: RegExp[];
  /** 出现这些词就否决 —— 「期望薪资」不是「薪资」 */
  veto?: RegExp;
}

/**
 * 顺序即优先级：**decision 排在最前**。
 *
 * 「期望城市」既像 city（registry）又像决策。它是决策 ——
 * 你现在住哪和你愿意去哪是两件事，而工具只知道前者。
 */
const RULES: Rule[] = [
  // ── 决策字段：永不自动填 ──
  { key: 'expected_salary', cls: 'decision', patterns: [/期望(薪[资酬]|月薪|年薪)/, /薪[资酬]要求/, /expected\s*salary/i, /salary\s*expectation/i] },
  { key: 'available_from', cls: 'decision', patterns: [/到岗|入职时间|可入职|notice\s*period|start\s*date|available/i] },
  { key: 'relocate', cls: 'decision', patterns: [/是否(接受|愿意)?(异地|外派|出差|搬迁|调岗)/, /willing\s*to\s*relocate/i, /relocation/i] },
  { key: 'overtime', cls: 'decision', patterns: [/加班|大小周|996|出差频[率次]/] },
  { key: 'expected_city', cls: 'decision', patterns: [/期望(工作)?(城市|地点)/, /意向城市/, /preferred\s*location/i] },
  { key: 'sponsorship', cls: 'decision', patterns: [/签证|sponsorship|work\s*authorization|require.*visa/i] },

  // ── 登记字段：照抄 ──
  { key: 'name.zh', cls: 'registry', patterns: [/^姓名$/, /真实姓名/, /中文名/, /^name$/i, /full\s*name/i] },
  { key: 'name.en', cls: 'registry', patterns: [/英文名/, /拼音/, /english\s*name/i] },
  { key: 'phone', cls: 'registry', patterns: [/手机|电话|联系方式|联系电话|phone|mobile|tel/i] },
  { key: 'email', cls: 'registry', patterns: [/邮箱|电子邮件|e-?mail/i] },
  { key: 'city', cls: 'registry', patterns: [/现居|所在城市|居住城市|当前城市|current\s*(city|location)/i], veto: /期望|意向|preferred/i },
  { key: 'github', cls: 'registry', patterns: [/github/i] },
  { key: 'website', cls: 'registry', patterns: [/个人(主页|网站|博客)|portfolio|blog|website/i] },
  { key: 'school', cls: 'registry', patterns: [/毕业院校|学校|院校|university|school|college/i] },
  { key: 'degree', cls: 'registry', patterns: [/学历|学位|degree|education\s*level/i] },
  { key: 'major', cls: 'registry', patterns: [/专业|major|field\s*of\s*study/i] },
  { key: 'company', cls: 'registry', patterns: [/公司名称|就职(公司|单位)|单位名称|employer|company\s*name/i] },
  { key: 'title', cls: 'registry', patterns: [/职位名称|岗位名称|职务|job\s*title/i], veto: /期望|应聘|申请/ },

  // ── 叙事字段：改写，但要人确认 ──
  { key: 'self_intro', cls: 'narrative', patterns: [/自我(评价|介绍)|个人(优势|简介|评价)|self[\s-]*(introduction|assessment)|about\s*(you|yourself)|summary/i] },
  { key: 'why_us', cls: 'narrative', patterns: [/为什么(选择|应聘|加入)|求职意向说明|why\s*(do\s*you\s*want|are\s*you\s*interested|us|this)/i] },
  { key: 'project_desc', cls: 'narrative', patterns: [/项目(描述|经历|介绍)|工作(内容|职责|描述)|project\s*(description|experience)|responsibilit/i] },
  { key: 'cover_letter', cls: 'narrative', patterns: [/求职信|cover\s*letter/i] },
];

/** 一个元素上所有能读到的文字。中文站的字段名常常只在旁边的 div 里。 */
export function fieldText(el: ElementRef): string {
  return [el.label, el.placeholder, el.name, el.id, el.nearby].filter(Boolean).join(' ');
}

/**
 * 每个来源的权重。
 *
 * label 最可信（它是页面明确写给人看的），nearby 最不可信
 * （可能是隔壁字段的说明文字蹭进来的）。
 */
const WEIGHTS: [keyof ElementRef, number][] = [
  ['label', 1.0],
  ['placeholder', 0.8],
  ['name', 0.7],
  ['id', 0.6],
  ['nearby', 0.45],
];

export function classifyField(el: ElementRef): FieldMatch {
  // 文件上传单独一类：它不是「填」，是「传」
  if (el.type === 'file') {
    return { ref: el.ref, fieldClass: 'registry', profileKey: '__resume__', confidence: 0.9, evidence: 'type=file' };
  }

  let best: FieldMatch = { ref: el.ref, fieldClass: 'unknown', profileKey: null, confidence: 0, evidence: '没有规则命中' };

  for (const rule of RULES) {
    for (const [src, w] of WEIGHTS) {
      const text = (el[src] as string | undefined) ?? '';
      if (!text) continue;
      if (rule.veto?.test(text)) continue;
      const hit = rule.patterns.find((p) => p.test(text));
      if (!hit) continue;
      if (w > best.confidence) {
        best = {
          ref: el.ref,
          fieldClass: rule.cls,
          profileKey: rule.cls === 'registry' ? rule.key : null,
          confidence: w,
          evidence: `${String(src)}「${text.slice(0, 30)}」命中 ${rule.key}`,
        };
      }
      break;
    }
    // decision 一旦命中就定案，不让后面的 registry 规则把它抢走。
    // 「期望城市」错分成 city 的后果是：工具替你回答了一个只有你能回答的问题。
    if (best.fieldClass === 'decision' && best.confidence >= 0.6) return best;
  }

  // 长文本框即使没规则命中，也按叙事处理而不是 unknown ——
  // 一个 textarea 里放的几乎不可能是登记字段。
  if (best.fieldClass === 'unknown' && el.tag === 'textarea') {
    return { ref: el.ref, fieldClass: 'narrative', profileKey: null, confidence: 0.5,
      evidence: 'textarea：长文本框里放的几乎不可能是登记字段' };
  }
  return best;
}
