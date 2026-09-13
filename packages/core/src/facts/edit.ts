import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Profile, Rubric, type RubricProfile } from '@assit/contract';
import { ensureDir, paths } from '../util/paths.js';

/**
 * 档案与 rubric 的可编辑视图（DESIGN §5.1 / §12.2）。
 *
 * **文件仍然是真源。** 这一层只是让桌面端能改它，而不是把真源搬进 SQLite ——
 * 一旦分叉，你就有两份档案，而且永远说不清哪份是对的。
 *
 * 写回用 `YAML.parseDocument` 保留注释：那个文件里每一段上面都写着
 * 「这些值会被原样照抄进简历和表单，永不经过改写模型」这类话。
 * 用表单存一次就把它们全抹掉，是把一份会自解释的配置退化成一堆裸字段。
 */

export interface ProfileDraft {
  fields: Record<string, string>;
  records: {
    education: Record<string, unknown>[];
    employment: Record<string, unknown>[];
    certificate: Record<string, unknown>[];
    language: Record<string, unknown>[];
    award: Record<string, unknown>[];
  };
  preferences: Record<string, unknown>;
}

const EMPTY_DRAFT: ProfileDraft = {
  fields: {},
  records: { education: [], employment: [], certificate: [], language: [], award: [] },
  preferences: {},
};

export function readProfileDraft(file = paths.profile): ProfileDraft {
  if (!fs.existsSync(file)) return structuredClone(EMPTY_DRAFT);
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, any> | null;
  if (!raw) return structuredClone(EMPTY_DRAFT);
  return {
    fields: raw.fields ?? {},
    records: {
      education: raw.records?.education ?? [],
      employment: raw.records?.employment ?? [],
      certificate: raw.records?.certificate ?? [],
      language: raw.records?.language ?? [],
      award: raw.records?.award ?? [],
    },
    preferences: raw.preferences ?? {},
  };
}

export interface SaveResult {
  file: string;
  /** 保存前先校验。**不合法照样存** —— 半填的档案是正常中间状态，
   *  但要把问题原样带回去显示，而不是悄悄存下一个坏文件 */
  issues: { path: string; message: string }[];
}

function writeDoc(file: string, next: Record<string, unknown>): void {
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, YAML.stringify(next, { lineWidth: 0 }), 'utf8');
    return;
  }
  // 逐个顶层键 set 而不是整份重写：注释挂在节点上，整份重写会全部丢掉。
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(next)) doc.set(k, doc.createNode(v));
  fs.writeFileSync(file, YAML.stringify(doc, { lineWidth: 0 }), 'utf8');
}

/** 去掉空字符串和空数组 —— 让 YAML 里不要堆一排 `gpa: ''`。 */
function prune(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(prune).filter((x) => x !== undefined);
    return arr;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(val);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (v === '' || v === null || v === undefined) return undefined;
  return v;
}

export function saveProfileDraft(draft: ProfileDraft, file = paths.profile): SaveResult {
  const next = {
    fields: Object.fromEntries(Object.entries(draft.fields).filter(([, v]) => String(v).trim() !== '')),
    records: prune(draft.records) ?? {},
    preferences: prune(draft.preferences) ?? {},
  };
  writeDoc(file, next);

  const r = Profile.safeParse(YAML.parse(fs.readFileSync(file, 'utf8')));
  return {
    file,
    issues: r.success ? [] : r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

// ── rubric ────────────────────────────────────────────────────────────────

export interface RubricDraft extends Partial<RubricProfile> {}

export function readRubricDraft(): { file: string | null; profile: RubricDraft } {
  const dir = paths.rubricDir;
  if (!fs.existsSync(dir)) return { file: null, profile: {} };
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const name = files[files.length - 1];
  if (!name) return { file: null, profile: {} };
  const file = path.join(dir, name);
  try {
    const raw = YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, any> | null;
    return { file, profile: raw?.profile ?? {} };
  } catch {
    return { file, profile: {} };
  }
}

/**
 * 只写 `profile` 这一段。
 *
 * weights / hard_gates / caps 刻意不放进表单：它们是**规则**，
 * 改它们要理解「未知不计入分母」「封顶不是扣分」这些语义，
 * 而那些语义写在 rubric 文件的注释里 —— 在编辑器里看着注释改才对。
 * 表单只管「你是谁、你要什么」这一半。
 */
export function saveRubricDraft(profile: RubricDraft): SaveResult {
  const { file } = readRubricDraft();
  if (!file) throw new Error('还没有 rubric 文件。先跑 `assit init --only rubric`。');
  writeDoc(file, { profile: prune(profile) ?? {} });

  const r = Rubric.safeParse(YAML.parse(fs.readFileSync(file, 'utf8')));
  return {
    file,
    issues: r.success ? [] : r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}
