import type { Db } from '../db/index.js';

/**
 * 「网申表单问了，但档案里没有」—— 那条反馈边（DESIGN §5.2 / §7.2）。
 *
 * 中文网申会问一堆 schema 里压根没有的字段：政治面貌、籍贯、紧急联系人、
 * 婚育状况……穷举不完，也不该穷举 —— 那等于假装自己知道所有招聘系统会问什么。
 *
 * 所以反过来做：**让表单告诉档案缺什么**。填表时遇到填不上的字段就记一笔，
 * 档案页显示成「待填写」。没有这条边，你会在第 8 个网申表单上
 * 第 8 次手打「政治面貌：群众」。
 */

export type FieldRequestStatus = 'pending' | 'filled' | 'ignored';

export interface FieldRequest {
  key: string;
  label: string;
  fieldClass: string;
  firstDomain: string | null;
  lastDomain: string | null;
  seenCount: number;
  example: string | null;
  status: FieldRequestStatus;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * 从网站上的字段名推一个档案 key。
 *
 * 归一化的目的只有一个：让「政治面貌」和「政治面貌：」和「 政治面貌 」
 * 算成同一个字段。**不做同义词合并** —— 「手机」和「联系电话」看起来
 * 该合并，但那需要知道这个站把它们当成一个还是两个，我们不知道。
 * 合错了的后果是往一个字段里填了另一个字段的值。
 */
export function fieldKeyFromLabel(label: string): string {
  const t = label
    .replace(/[\s:：*（）()\[\]【】]/g, '')
    .replace(/^请输入|^请填写|^请选择/, '')
    .trim();
  return t || label.trim();
}

export interface RecordMissingInput {
  /** 网站上写的字段名 */
  label: string;
  /** 已知的档案 key（分类器认出来了但档案里没值时传） */
  key?: string;
  fieldClass?: string;
  domain?: string;
  example?: string;
}

export function recordMissingField(db: Db, input: RecordMissingInput): string {
  const key = input.key ?? fieldKeyFromLabel(input.label);
  if (!key) throw new Error('字段名是空的，记不了');

  db.prepare(
    `INSERT INTO profile_field_requests
       (key, label, field_class, first_domain, last_domain, example)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       seen_count = profile_field_requests.seen_count + 1,
       last_domain = excluded.last_domain,
       last_seen_at = datetime('now'),
       -- label 和 example 取后来居上：不同站对同一字段的说明详略不同，
       -- 新的那个通常是你刚看过的，更能帮你想起来该填什么
       label = excluded.label,
       example = COALESCE(excluded.example, profile_field_requests.example),
       -- 已经标 ignored 的不要因为又被问一次就跳回 pending。
       -- 「这个我不打算填」是一个决定，不该被一次遭遇推翻
       status = CASE WHEN profile_field_requests.status = 'ignored'
                     THEN 'ignored' ELSE 'pending' END`,
  ).run(key, input.label, input.fieldClass ?? 'registry', input.domain ?? null, input.domain ?? null, input.example ?? null);
  return key;
}

function toRow(r: any): FieldRequest {
  return {
    key: r.key, label: r.label, fieldClass: r.field_class,
    firstDomain: r.first_domain, lastDomain: r.last_domain,
    seenCount: r.seen_count, example: r.example, status: r.status,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
  };
}

/** 被问得多的排前面 —— 那是最值得补的。 */
export function listFieldRequests(db: Db, status?: FieldRequestStatus): FieldRequest[] {
  const rows = status
    ? db.prepare('SELECT * FROM profile_field_requests WHERE status = ? ORDER BY seen_count DESC, last_seen_at DESC').all(status)
    : db.prepare('SELECT * FROM profile_field_requests ORDER BY status = \'pending\' DESC, seen_count DESC').all();
  return (rows as any[]).map(toRow);
}

export function setFieldRequestStatus(db: Db, key: string, status: FieldRequestStatus): void {
  db.prepare('UPDATE profile_field_requests SET status = ? WHERE key = ?').run(status, key);
}

/**
 * 档案存完之后调一次：填上值的自动标成 filled。
 *
 * 不在存档案时顺手改状态，而是单独一步 —— 因为「待填写」的真源是
 * 档案文件里有没有这个值，不是这张表。表只是个提醒清单。
 */
export function reconcileFieldRequests(db: Db, fields: Record<string, string>): number {
  const pending = listFieldRequests(db, 'pending');
  let n = 0;
  for (const r of pending) {
    if (String(fields[r.key] ?? '').trim()) {
      setFieldRequestStatus(db, r.key, 'filled');
      n += 1;
    }
  }
  // 反过来也要：以前填过、后来被清空的，要重新变回待填写
  for (const r of listFieldRequests(db, 'filled')) {
    if (!String(fields[r.key] ?? '').trim()) setFieldRequestStatus(db, r.key, 'pending');
  }
  return n;
}
