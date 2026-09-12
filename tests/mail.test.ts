import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATEGORY_TO_EVENT,
  NoKeychain,
  classifyBySubject,
  claimsToReview,
  deletePassword,
  fetchRecent,
  detectBackend,
  getPassword,
  openDb,
  redactMailBody,
  setPassword,
  shouldInspect,
  toIcs,
  type Db,
  type KeychainRunner,
} from '@assit/core';

describe('邮件筛选：先用规则挡住 95%，模型只看剩下的', () => {
  const h = (from: string, subject: string) => ({ from, subject, date: '', messageId: 'm1' });

  it('招聘平台的信一定看', () => {
    expect(shouldInspect(h('no-reply@zhipin.com', '有新消息')).keep).toBe(true);
    expect(shouldInspect(h('x@greenhouse.io', 'Update')).matched).toBe('platform_domain');
  });

  it('投过的公司的信也看', () => {
    const r = shouldInspect(h('hr@acme.com', '关于您的申请'), { knownDomains: ['acme.com'] });
    expect(r.matched).toBe('known_company');
  });

  it('主题看得出和求职有关就看一眼', () => {
    expect(shouldInspect(h('someone@unknown.io', '面试安排')).matched).toBe('subject_hint');
  });

  it('账单、验证码、物流一律不看 —— 即使主题里有「确认」', () => {
    expect(shouldInspect(h('bank@x.com', '账单确认')).keep).toBe(false);
    expect(shouldInspect(h('x@y.com', '您的验证码是 123456')).keep).toBe(false);
    expect(shouldInspect(h('x@y.com', '您的快递已签收')).keep).toBe(false);
  });

  it('排除规则优先于平台域 —— 不能因为发件域对就放行一封账单', () => {
    expect(shouldInspect(h('billing@zhipin.com', '您的发票已开具')).keep).toBe(false);
  });

  it('完全无关的信不进模型上下文', () => {
    expect(shouldInspect(h('friend@gmail.com', '周末一起吃饭')).keep).toBe(false);
  });
});

describe('正文脱敏：别人的联系方式不该进模型上下文', () => {
  it('抹掉手机、邮箱、身份证、会议链接', () => {
    const r = redactMailBody(
      'HR 王女士 13912345678，邮箱 wang@acme.com，腾讯会议 https://meeting.tencent.com/dm/abc123',
    );
    expect(r.text).not.toContain('13912345678');
    expect(r.text).not.toContain('wang@acme.com');
    expect(r.text).not.toContain('abc123');
    expect(r.removed).toContain('phone');
    expect(r.removed).toContain('meeting_link');
  });

  it('没有敏感内容时原样返回', () => {
    const r = redactMailBody('请于周三下午两点参加面试。');
    expect(r.text).toBe('请于周三下午两点参加面试。');
    expect(r.removed).toEqual([]);
  });
});

describe('确定性分类：能用规则判的不问模型', () => {
  it('几类典型主题都能判', () => {
    expect(classifyBySubject('面试邀请 - 后端工程师')).toBe('interview_invite');
    expect(classifyBySubject('很遗憾地通知您')).toBe('rejection');
    expect(classifyBySubject('Offer Letter')).toBe('offer');
    expect(classifyBySubject('在线笔试通知')).toBe('assessment');
    expect(classifyBySubject('您的简历已投递成功')).toBe('application_ack');
  });

  it('判不了就返回 null —— 那时候才轮到模型', () => {
    expect(classifyBySubject('关于下一步')).toBeNull();
  });

  it('猎头主动来信不挂到某一条投递上', () => {
    expect(CATEGORY_TO_EVENT.recruiter_outreach).toBeNull();
    expect(CATEGORY_TO_EVENT.interview_invite).toBe('interview');
  });
});

describe('钥匙串：不退化成明文', () => {
  function fakeRunner(has: string[]): KeychainRunner & { store: Map<string, string>; argvs: string[][] } {
    const store = new Map<string, string>();
    const argvs: string[][] = [];
    return {
      store, argvs,
      has: (b) => has.includes(b),
      run: (bin, args, input) => {
        argvs.push([bin, ...args]);
        const acct = args[args.indexOf('-a') + 1] ?? args[args.indexOf('account') + 1] ?? '';
        if (args.includes('add-generic-password') || args.includes('store')) {
          store.set(acct, input ?? '');
          return '';
        }
        if (args.includes('find-generic-password') || args.includes('lookup')) {
          const v = store.get(acct);
          if (v === undefined) throw new Error('not found');
          return `${v}\n`;
        }
        if (args.includes('delete-generic-password') || args.includes('clear')) {
          if (!store.delete(acct)) throw new Error('not found');
          return '';
        }
        return '';
      },
    };
  }

  it('没有钥匙串就拒绝保存，而不是写明文文件', () => {
    expect(() => setPassword('a@b.com', 'pw', fakeRunner([]))).toThrow(NoKeychain);
    expect(detectBackend(fakeRunner([]))).toBe('none');
  });

  it('密码走 stdin 不进 argv —— argv 在 ps 里对同机所有进程可见', () => {
    const r = fakeRunner(process.platform === 'darwin' ? ['security'] : ['secret-tool']);
    setPassword('a@b.com', 'super-secret', r);
    expect(r.argvs.flat()).not.toContain('super-secret');
    expect(getPassword('a@b.com', r)).toBe('super-secret');
  });

  it('读不到返回 null 而不是抛', () => {
    const r = fakeRunner(process.platform === 'darwin' ? ['security'] : ['secret-tool']);
    expect(getPassword('nobody@x.com', r)).toBeNull();
    expect(deletePassword('nobody@x.com', r)).toBe(false);
  });
});

describe('日历：面试事件要带上该复习什么', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-cal-'));
    process.env.ASSIT_DATA_DIR = dir;
    db = openDb();
  });
  afterEach(() => {
    db.close();
    delete process.env.ASSIT_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ICS 带上主张 id 和提前一小时的提醒', () => {
    const ics = toIcs([{
      uid: 'u1', title: '某某科技 二面', startAt: '2026-10-01T06:00:00.000Z',
      durationMin: 60, claimIds: ['claim-inv-001', 'claim-api-002'], applicationId: 'app_1',
    }]);
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('TRIGGER:-PT1H');
    expect(ics).toContain('claim-inv-001');
    expect(ics).toContain('DTSTART:20261001T060000Z');
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('长标题按 RFC 5545 折行，且不从多字节字符中间切开', () => {
    const long = '某某科技股份有限公司技术中心基础架构部后端开发工程师第二轮技术面试安排通知';
    const ics = toIcs([{ uid: 'u', title: long, startAt: '2026-10-01T06:00:00Z', durationMin: 30 }]);
    for (const line of ics.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(76);
    }
    // 折行还原后内容不丢
    const unfolded = ics.split('\r\n').reduce((acc, l) => (l.startsWith(' ') ? acc + l.slice(1) : acc + '\n' + l), '');
    expect(unfolded).toContain(long);
  });

  it('分号逗号被转义 —— 不转义会把一个字段拆成两个', () => {
    const ics = toIcs([{ uid: 'u', title: 'A, B; C', startAt: '2026-10-01T06:00:00Z', durationMin: 30 }]);
    expect(ics).toContain('SUMMARY:A\\, B\; C');
  });

  it('答砸过的主张会被推上复习清单 —— 反向边的正向用法', () => {
    db.prepare(
      `INSERT INTO claims (id, source_fact, responsibility_level, verification_status, boundary, visibility)
       VALUES ('claim-a','f','参与','已确认','b','private')`,
    ).run();
    db.prepare(
      `INSERT INTO interview_sessions (id, kind, label, started_at) VALUES ('s','mock','x',datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO interview_turns (id, session_id, seq, claim_id, question, verdict)
       VALUES ('t','s',1,'claim-a','q','failed')`,
    ).run();
    expect(claimsToReview(db, 'app_nonexistent')).toEqual(['claim-a']);
  });
});

// ── IMAP：只读，且先过白名单再取正文 ──────────────────────────────────────

describe('IMAP 收信', () => {
  interface FakeMail { uid: number; from: string; subject: string; body: string }

  function fakeClient(mails: FakeMail[], log: string[]) {
    return () => ({
      connect: async () => { log.push('connect'); },
      logout: async () => { log.push('logout'); },
      getMailboxLock: async (p: string) => { log.push(`lock:${p}`); return { release: () => log.push('release') }; },
      search: async () => mails.map((m) => m.uid),
      fetch: async function* (range: any, query: any) {
        const wanted = new Set(String(range.uid).split(',').map(Number));
        log.push(`fetch:${query.source ? 'source' : 'envelope'}:${[...wanted].join(',')}`);
        for (const m of mails) {
          if (!wanted.has(m.uid)) continue;
          yield {
            uid: m.uid,
            envelope: query.envelope
              ? { subject: m.subject, from: [{ address: m.from }], date: new Date('2026-09-01') }
              : undefined,
            source: query.source ? Buffer.from(`Subject: x\r\n\r\n${m.body}`) : undefined,
          };
        }
      },
    }) as any;
  }

  const MAILS: FakeMail[] = [
    { uid: 1, from: 'no-reply@zhipin.com', subject: '面试邀请', body: 'HR 王 13912345678' },
    { uid: 2, from: 'bank@icbc.com', subject: '您的账单已生成', body: '卡号 6222020202020202' },
    { uid: 3, from: 'mom@qq.com', subject: '周末回家吃饭吗', body: '记得带伞' },
  ];

  it('正文只对白名单放行的那几封拉 —— 这就是「不把整个邮箱交出去」的边界', async () => {
    const log: string[] = [];
    const r = await fetchRecent(
      { user: 'me@x.com', host: 'imap.x.com' },
      { password: 'pw', factory: fakeClient(MAILS, log) },
    );
    expect(r.seen).toBe(3);
    expect(r.kept).toBe(1);
    // envelope 拉了全部 3 封，source 只拉了 uid=1
    expect(log).toContain('fetch:envelope:1,2,3');
    expect(log).toContain('fetch:source:1');
    expect(log.some((l) => l.startsWith('fetch:source') && (l.includes('2') || l.includes('3')))).toBe(false);
  });

  it('取回的正文已经脱敏', async () => {
    const r = await fetchRecent(
      { user: 'me@x.com', host: 'imap.x.com' },
      { password: 'pw', factory: fakeClient(MAILS, []) },
    );
    expect(r.mails[0]!.body).not.toContain('13912345678');
    expect(r.mails[0]!.redacted).toContain('phone');
  });

  it('被挡掉的只留统计不留内容 —— 账单正文一个字都不该被带出来', async () => {
    const r = await fetchRecent(
      { user: 'me@x.com', host: 'imap.x.com' },
      { password: 'pw', factory: fakeClient(MAILS, []) },
    );
    expect(Object.values(r.skippedReasons).reduce((a, b) => a + b, 0)).toBe(2);
    expect(JSON.stringify(r)).not.toContain('6222020202020202');
    expect(JSON.stringify(r)).not.toContain('记得带伞');
  });

  it('无论成功失败都释放邮箱锁并登出 —— 这是别人也在用的邮箱', async () => {
    const log: string[] = [];
    const bad = () => ({
      connect: async () => { log.push('connect'); },
      logout: async () => { log.push('logout'); },
      getMailboxLock: async () => { log.push('lock'); return { release: () => log.push('release') }; },
      search: async () => { throw new Error('boom'); },
      fetch: async function* () { /* 用不到 */ },
    }) as any;
    await expect(
      fetchRecent({ user: 'me@x.com', host: 'h' }, { password: 'pw', factory: bad }),
    ).rejects.toThrow('boom');
    expect(log).toEqual(['connect', 'lock', 'release', 'logout']);
  });

  it('钥匙串里没有密码时指向 assit mail login，且不尝试连接', async () => {
    const log: string[] = [];
    await expect(
      fetchRecent({ user: 'nobody@x.com', host: 'h' }, { factory: fakeClient([], log) }),
    ).rejects.toThrow(/mail login/);
    expect(log).toEqual([]);
  });
});
