import { putArtifact, readArtifact } from '../artifacts.js';
import type { Db } from '../db/index.js';
import { applicationKey, checkCooldown, DEFAULT_COOLDOWN_DAYS, type CooldownHit } from '../dedup/index.js';
import { newId } from '../util/hash.js';

/**
 * 投递记录与快照（DESIGN §7.1）。
 *
 * 一条投递要冻结四份内容寻址的东西：**当时发出的简历 / 当时的 JD /
 * 当时的话术 / 当时填的表**。存 hash 不存副本，所以同一份简历投 50 家
 * 只占一份空间，但每条投递都能精确还原。
 *
 * 为什么 JD 必须存副本：一个月后 HR 约你面试，JD 早改了。
 * 面试准备要基于**你投递时看到的那份**。
 */

export interface PreflightInput {
  jobId: string;
  postingId: string;
  cooldownDays?: number;
  now?: Date;
}

export interface Preflight {
  jobId: string;
  postingId: string;
  company: string;
  companyId: string;
  title: string;
  roleFamily: string;
  applicationKey: string;
  /** 同一个 posting 已经投过 —— 这是硬阻止，不是提醒 */
  alreadyApplied: { id: string; sentAt: string } | null;
  /** 同公司同类岗在冷却期内 */
  cooldown: CooldownHit;
  /** 有没有当前 rubric 下的分数。没有不阻止，但值得知道 */
  scoreId: string | null;
  finalScore: number | null;
  jdSha256: string | null;
}

export class AlreadyApplied extends Error {
  constructor(readonly applicationId: string, readonly sentAt: string) {
    super(`这个岗位已经投过了（${sentAt}，记录 ${applicationId}）`);
    this.name = 'AlreadyApplied';
  }
}

export class NotConfirmed extends Error {
  constructor() {
    super(
      '投递必须有人工确认。\n' +
        'recordApplication 需要显式传 confirmedByUser: true —— ' +
        '这不是参数校验，是这个工具和「无人值守批量投递」的分界线（DESIGN §13.1）。',
    );
    this.name = 'NotConfirmed';
  }
}

/**
 * 投递前的检查。**只读，不写任何东西。**
 *
 * 分成 preflight / record 两步，是因为中间那一步是人看一眼再点确认。
 */
export function preflight(db: Db, input: PreflightInput): Preflight {
  const row = db
    .prepare(
      `SELECT j.id job_id, j.title_raw, j.role_family, j.company_id, c.canonical_name company,
              p.id posting_id,
              (SELECT h.jd_sha256 FROM posting_jd_history h
                WHERE h.posting_id = p.id ORDER BY h.id DESC LIMIT 1) jd_sha256
         FROM postings p JOIN jobs j ON j.id = p.job_id
         JOIN companies c ON c.id = j.company_id
        WHERE p.id = ?`,
    )
    .get(input.postingId) as any;
  if (!row) throw new Error(`找不到挂牌 ${input.postingId}`);

  const already = db
    .prepare('SELECT id, sent_at FROM applications WHERE posting_id = ? ORDER BY sent_at DESC LIMIT 1')
    .get(input.postingId) as { id: string; sent_at: string } | undefined;

  const key = applicationKey(row.company_id, row.role_family ?? 'unknown');
  const prev = (
    db
      .prepare('SELECT sent_at FROM applications WHERE application_key = ? AND posting_id != ?')
      .all(key, input.postingId) as { sent_at: string }[]
  ).map((r) => r.sent_at);

  const score = db
    .prepare(
      `SELECT id, final_score FROM job_scores WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(row.job_id) as { id: string; final_score: number } | undefined;

  return {
    jobId: row.job_id,
    postingId: row.posting_id,
    company: row.company,
    companyId: row.company_id,
    title: row.title_raw,
    roleFamily: row.role_family ?? 'unknown',
    applicationKey: key,
    alreadyApplied: already ? { id: already.id, sentAt: already.sent_at } : null,
    cooldown: checkCooldown(prev, input.now, input.cooldownDays ?? DEFAULT_COOLDOWN_DAYS),
    scoreId: score?.id ?? null,
    finalScore: score?.final_score ?? null,
    jdSha256: row.jd_sha256 ?? null,
  };
}

export interface RecordInput {
  postingId: string;
  /** 走哪个渠道投的：chat / form / email / external */
  channel: string;
  /** 实际发出去的那个 PDF 的字节。**不是「当前版本的简历」** */
  resumePdf: Buffer;
  /** 实际发出的话术 */
  greeting?: string;
  /** 表单实际填写内容（见 §7.2） */
  formData?: Record<string, unknown>;
  formDomain?: string;
  formUrl?: string;
  /**
   * 人工确认位。**必须显式传 true。**
   * 默认值会让「忘了传」和「确认过」变成同一件事。
   */
  confirmedByUser: boolean;
  /** 冷却期内仍要投 —— 有时是对的（换了个部门），但要显式 */
  overrideCooldown?: boolean;
  prefsOverride?: Record<string, unknown>;
  now?: Date;
}

export interface RecordedApplication {
  id: string;
  applicationKey: string;
  sentAt: string;
  snapshots: { kind: string; sha256: string; bytes: number }[];
}

export function recordApplication(db: Db, input: RecordInput): RecordedApplication {
  if (input.confirmedByUser !== true) throw new NotConfirmed();

  const pre = preflight(db, { jobId: '', postingId: input.postingId, now: input.now });
  if (pre.alreadyApplied) {
    // 同一个挂牌重复投是硬错误。冷却期是提醒，这个不是。
    throw new AlreadyApplied(pre.alreadyApplied.id, pre.alreadyApplied.sentAt);
  }
  if (pre.cooldown.blocked && !input.overrideCooldown) {
    throw new Error(
      `${pre.cooldown.reason}\n` +
        '确实要投就显式传 overrideCooldown —— 换了部门、换了岗位方向都可能是对的，' +
        '但这件事应该是你想过之后的决定。',
    );
  }
  if (!pre.jdSha256) {
    // JD 存档拿不到就不让投。没有 JD 副本的投递记录，一个月后
    // 面试准备时只能对着已经改过的线上 JD —— 那正是这套存档要解决的问题。
    throw new Error('这个挂牌没有 JD 存档，投递记录会缺一份关键快照。先跑一次采集或 assit ingest。');
  }

  const sentAt = (input.now ?? new Date()).toISOString();
  const snapshots: RecordedApplication['snapshots'] = [];

  const resume = putArtifact(db, 'application_resume', 'resume.pdf', input.resumePdf);
  snapshots.push({ kind: 'resume', sha256: resume.sha256, bytes: resume.bytes });

  let greetingSha: string | null = null;
  if (input.greeting?.trim()) {
    const g = putArtifact(db, 'application_greeting', 'greeting.txt', input.greeting);
    greetingSha = g.sha256;
    snapshots.push({ kind: 'greeting', sha256: g.sha256, bytes: g.bytes });
  }
  let formSha: string | null = null;
  if (input.formData) {
    const f = putArtifact(db, 'application_form', 'form.json', JSON.stringify(input.formData, null, 2));
    formSha = f.sha256;
    snapshots.push({ kind: 'form', sha256: f.sha256, bytes: f.bytes });
  }
  snapshots.push({ kind: 'jd', sha256: pre.jdSha256, bytes: 0 });

  const id = newId('app_');
  db.prepare(
    `INSERT INTO applications
       (id, posting_id, company_id, application_key, channel, resume_sha256, jd_sha256,
        greeting_sha256, score_id, prefs_override, sent_at, confirmed_by_user, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'sent')`,
  ).run(
    id, input.postingId, pre.companyId, pre.applicationKey, input.channel,
    resume.sha256, pre.jdSha256, greetingSha, pre.scoreId,
    input.prefsOverride ? JSON.stringify(input.prefsOverride) : null, sentAt,
  );
  db.prepare(
    `INSERT INTO application_events (application_id, event_type, source, confirmed_by_user, occurred_at, detail)
     VALUES (?, 'sent', 'user', 1, ?, ?)`,
  ).run(id, sentAt, `${pre.company} · ${pre.title}`);

  // 表单快照挂在 form_fills 上而不是 applications 的一列：
  // 一次投递可能要填不止一张表（网申常见「基本信息」+「教育经历」分步），
  // 而「当时这张表填了什么」是要能逐张还原的。
  if (formSha) {
    db.prepare(
      `INSERT INTO form_fills (id, application_id, domain, url, snapshot_sha256, submitted_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(newId('ff_'), id, input.formDomain ?? '(unknown)', input.formUrl ?? null, formSha, sentAt);
  }

  return { id, applicationKey: pre.applicationKey, sentAt, snapshots };
}

/** 还原一条投递当时发出去的东西。这是整套存档存在的理由。 */
export interface ApplicationSnapshot {
  resume: Buffer | null;
  jd: string | null;
  greeting: string | null;
  forms: { domain: string; url: string | null; data: unknown }[];
}

export function applicationSnapshot(db: Db, applicationId: string): ApplicationSnapshot {
  const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId) as any;
  if (!a) throw new Error(`找不到投递记录 ${applicationId}`);
  const read = (hash: string | null, name: string): Buffer | null => {
    if (!hash) return null;
    try {
      return readArtifact(hash, name);
    } catch {
      return null; // 文件被删了。记录仍在，这本身也是信息
    }
  };
  const fills = db
    .prepare('SELECT domain, url, snapshot_sha256 FROM form_fills WHERE application_id = ? ORDER BY id')
    .all(applicationId) as { domain: string; url: string | null; snapshot_sha256: string }[];
  const forms = fills.map((f) => {
    const buf = read(f.snapshot_sha256, 'form.json');
    return { domain: f.domain, url: f.url, data: buf ? JSON.parse(buf.toString('utf8')) : null };
  });
  return {
    resume: read(a.resume_sha256, 'resume.pdf'),
    jd: read(a.jd_sha256, 'jd.md')?.toString('utf8') ?? null,
    greeting: read(a.greeting_sha256, 'greeting.txt')?.toString('utf8') ?? null,
    forms,
  };
}

export interface PipelineRow {
  id: string;
  company: string;
  title: string;
  channel: string;
  sentAt: string;
  status: string;
  finalScore: number | null;
  daysSince: number;
  lastEvent: { type: string; at: string; confirmed: boolean } | null;
  unconfirmedEvents: number;
}

export function pipeline(db: Db, limit = 200): PipelineRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.channel, a.sent_at, a.status, c.canonical_name company, j.title_raw title,
              s.final_score,
              (SELECT COUNT(*) FROM application_events e
                WHERE e.application_id = a.id AND e.confirmed_by_user = 0) unconfirmed
         FROM applications a
         JOIN companies c ON c.id = a.company_id
         JOIN postings p ON p.id = a.posting_id
         JOIN jobs j ON j.id = p.job_id
         LEFT JOIN job_scores s ON s.id = a.score_id
        ORDER BY a.sent_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
  const now = Date.now();
  return rows.map((r) => {
    const last = db
      .prepare(
        `SELECT event_type, occurred_at, confirmed_by_user FROM application_events
          WHERE application_id = ? ORDER BY occurred_at DESC LIMIT 1`,
      )
      .get(r.id) as any;
    return {
      id: r.id,
      company: r.company,
      title: r.title,
      channel: r.channel,
      sentAt: r.sent_at,
      status: r.status,
      finalScore: r.final_score ?? null,
      daysSince: Math.floor((now - Date.parse(r.sent_at)) / 86_400_000),
      lastEvent: last
        ? { type: last.event_type, at: last.occurred_at, confirmed: Boolean(last.confirmed_by_user) }
        : null,
      unconfirmedEvents: r.unconfirmed,
    };
  });
}

export interface FunnelBucket {
  key: string;
  label: string;
  sent: number;
  replied: number;
  interviewed: number;
  offered: number;
  /** 回复率。分母小于 5 时为 null —— 3 投 1 回不是 33%，是「还不知道」 */
  replyRate: number | null;
}

const REPLY_EVENTS = new Set(['replied', 'screening', 'interview', 'offer']);
const INTERVIEW_EVENTS = new Set(['interview', 'offer']);
const MIN_DENOM = 5;

/**
 * 三维度漏斗：按分数段 / 渠道 / 职能族看「投出去之后发生了什么」。
 *
 * **样本少于 5 就不给比率。** 3 投 1 回显示成 33% 会让人真的据此改策略，
 * 而那个数字里没有任何信息 —— 这是求职数据最容易骗自己的地方。
 */
export function funnel(db: Db, dimension: 'score' | 'channel' | 'role'): FunnelBucket[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.channel, s.final_score, j.role_family
         FROM applications a
         LEFT JOIN job_scores s ON s.id = a.score_id
         JOIN postings p ON p.id = a.posting_id
         JOIN jobs j ON j.id = p.job_id`,
    )
    .all() as { id: string; channel: string; final_score: number | null; role_family: string | null }[];

  const events = db
    .prepare('SELECT application_id, event_type FROM application_events WHERE confirmed_by_user = 1')
    .all() as { application_id: string; event_type: string }[];
  const byApp = new Map<string, Set<string>>();
  for (const e of events) {
    if (!byApp.has(e.application_id)) byApp.set(e.application_id, new Set());
    byApp.get(e.application_id)!.add(e.event_type);
  }

  const bucketOf = (r: (typeof rows)[number]): [string, string] => {
    if (dimension === 'channel') return [r.channel, r.channel];
    if (dimension === 'role') return [r.role_family ?? 'unknown', r.role_family ?? '未分类'];
    const s = r.final_score;
    if (s === null) return ['unscored', '没有分数'];
    if (s >= 80) return ['80+', '80 分以上'];
    if (s >= 70) return ['70-79', '70–79'];
    if (s >= 55) return ['55-69', '55–69'];
    return ['<55', '55 分以下'];
  };

  const acc = new Map<string, FunnelBucket>();
  for (const r of rows) {
    const [key, label] = bucketOf(r);
    if (!acc.has(key)) {
      acc.set(key, { key, label, sent: 0, replied: 0, interviewed: 0, offered: 0, replyRate: null });
    }
    const b = acc.get(key)!;
    b.sent += 1;
    const ev = byApp.get(r.id) ?? new Set();
    if ([...ev].some((t) => REPLY_EVENTS.has(t))) b.replied += 1;
    if ([...ev].some((t) => INTERVIEW_EVENTS.has(t))) b.interviewed += 1;
    if (ev.has('offer')) b.offered += 1;
  }

  return [...acc.values()]
    .map((b) => ({ ...b, replyRate: b.sent >= MIN_DENOM ? b.replied / b.sent : null }))
    .sort((a, b) => b.sent - a.sent);
}

export function logApplicationEvent(
  db: Db,
  applicationId: string,
  input: { type: string; source: string; occurredAt?: string; detail?: string; confirmed?: boolean; evidenceRef?: string },
): void {
  db.prepare(
    `INSERT INTO application_events
       (application_id, event_type, source, evidence_ref, confirmed_by_user, occurred_at, detail)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    applicationId, input.type, input.source, input.evidenceRef ?? null,
    input.confirmed ? 1 : 0, input.occurredAt ?? new Date().toISOString(), input.detail ?? null,
  );
  if (input.confirmed) {
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(input.type, applicationId);
  }
}
