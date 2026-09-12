import type { Db } from '../db/index.js';
import { getPassword } from './credentials.js';
import { redactMailBody, shouldInspect, type FilterOptions, type MailHeader } from './classify.js';

/**
 * IMAP **只读**收信（DESIGN §7.3）。
 *
 * 三条约束，都不是可配置项：
 *
 * 1. **只读。** 不标已读、不移动、不删除。这是别人也在用的邮箱，
 *    一个把未读标成已读的工具会让你错过真正重要的信。
 * 2. **先过白名单再取正文。** 只对 `shouldInspect` 放行的那几封拉 body。
 *    邮箱里有银行流水、医疗、家人的信 —— 一个「把所有新邮件喂给模型」
 *    的实现等于把整个邮箱交出去。
 * 3. **正文脱敏后才可能进模型。** 邮件里常带着 HR 的手机、被抄送的
 *    其他候选人 —— 那不是你的信息。
 */

export interface MailAccount {
  /** 邮箱地址，同时是钥匙串里的 account */
  user: string;
  host: string;
  port?: number;
  secure?: boolean;
  mailbox?: string;
}

export interface FetchedMail extends MailHeader {
  uid: number;
  /** 已脱敏。原文不保留在内存里超过必要时间 */
  body: string;
  redacted: string[];
  filterReason: string;
}

/** imapflow 的最小子集。抽出来是为了能不联网测上层逻辑。 */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(
    range: string | object,
    query: object,
    opts?: object,
  ): AsyncIterable<{ uid: number; envelope?: any; source?: Buffer; bodyParts?: Map<string, Buffer> }>;
  search(query: object, opts?: object): Promise<number[] | false>;
}

export type ClientFactory = (acct: MailAccount, password: string) => ImapClientLike;

const defaultFactory: ClientFactory = (acct, password) => {
  // 动态 import：没配邮箱的人不该为一个用不到的依赖付启动开销
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ImapFlow } = require('imapflow') as typeof import('imapflow');
  return new ImapFlow({
    host: acct.host,
    port: acct.port ?? 993,
    secure: acct.secure !== false,
    auth: { user: acct.user, pass: password },
    logger: false,
  }) as unknown as ImapClientLike;
};

export class NoMailPassword extends Error {
  constructor(user: string) {
    super(
      `钥匙串里没有 ${user} 的密码。\n` +
        '  先存进去：assit mail login <邮箱>\n' +
        '  注意多数邮箱要用**应用专用密码**，不是登录密码。',
    );
    this.name = 'NoMailPassword';
  }
}

export interface MailFetchOptions extends FilterOptions {
  /** 只看这个时间之后的 */
  since?: Date;
  limit?: number;
  factory?: ClientFactory;
  password?: string;
}

export interface FetchSummary {
  seen: number;
  kept: number;
  mails: FetchedMail[];
  /** 被规则挡掉的，只留统计不留内容 */
  skippedReasons: Record<string, number>;
}

function headerOf(env: any, uid: number): MailHeader {
  const from = env?.from?.[0];
  return {
    from: from ? `${from.name ?? ''} <${from.address ?? ''}>`.trim() : '',
    subject: String(env?.subject ?? ''),
    date: env?.date ? new Date(env.date).toISOString() : '',
    messageId: String(env?.messageId ?? `uid-${uid}`),
  };
}

function textOf(source: Buffer | undefined): string {
  if (!source) return '';
  const raw = source.toString('utf8');
  // 只要正文，不要 header 块。找第一个空行。
  const i = raw.indexOf('\r\n\r\n');
  return (i >= 0 ? raw.slice(i + 4) : raw).slice(0, 20_000);
}

export async function fetchRecent(acct: MailAccount, opts: MailFetchOptions = {}): Promise<FetchSummary> {
  const password = opts.password ?? getPassword(acct.user);
  if (!password) throw new NoMailPassword(acct.user);

  const client = (opts.factory ?? defaultFactory)(acct, password);
  const since = opts.since ?? new Date(Date.now() - 7 * 86_400_000);
  const mails: FetchedMail[] = [];
  const skipped: Record<string, number> = {};
  let seen = 0;

  await client.connect();
  const lock = await client.getMailboxLock(acct.mailbox ?? 'INBOX');
  try {
    const uids = await client.search({ since });
    if (!uids || uids.length === 0) return { seen: 0, kept: 0, mails: [], skippedReasons: {} };

    // 先只拉 envelope。**正文要等白名单放行之后再取** ——
    // 这一步就是那条「不把整个邮箱交出去」的边界。
    const heads = new Map<number, MailHeader>();
    for await (const m of client.fetch({ uid: uids.join(',') }, { envelope: true, uid: true })) {
      seen += 1;
      heads.set(m.uid, headerOf(m.envelope, m.uid));
    }

    const keepUids: number[] = [];
    for (const [uid, h] of heads) {
      const r = shouldInspect(h, { knownDomains: opts.knownDomains });
      if (r.keep) keepUids.push(uid);
      else skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
    }

    const take = keepUids.slice(-(opts.limit ?? 50));
    if (take.length > 0) {
      for await (const m of client.fetch({ uid: take.join(',') }, { source: true, uid: true })) {
        const h = heads.get(m.uid);
        if (!h) continue;
        const red = redactMailBody(textOf(m.source));
        mails.push({
          ...h, uid: m.uid, body: red.text, redacted: red.removed,
          filterReason: shouldInspect(h, { knownDomains: opts.knownDomains }).reason,
        });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }

  return { seen, kept: mails.length, mails, skippedReasons: skipped };
}

/** 你投过的公司域名。投过谁就看谁的信。 */
export function knownDomainsFromApplications(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.url FROM applications a JOIN postings p ON p.id = a.posting_id WHERE p.url IS NOT NULL`,
    )
    .all() as { url: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    try {
      out.add(new URL(r.url).hostname.replace(/^www\./, ''));
    } catch {
      /* 不是合法 URL 就跳过 */
    }
  }
  return [...out];
}
