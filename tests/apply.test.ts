import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AlreadyApplied,
  NotConfirmed,
  applicationSnapshot,
  funnel,
  ingestPosting,
  logApplicationEvent,
  openDb,
  pipeline,
  preflight,
  recordApplication,
  type Db,
} from '@assit/core';
import { Posting } from '@assit/contract';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-apply-'));
  process.env.ASSIT_DATA_DIR = dir;
  db = openDb();
});
afterEach(() => {
  db.close();
  delete process.env.ASSIT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function addJob(company: string, title: string, jd = '任职要求：精通 Go，3 年经验。'): string {
  const p = Posting.parse({
    platform: 'test',
    platform_job_id: `t${seq++}`,
    company_name: company,
    title,
    city: '杭州',
    jd_text: jd,
    collected_by: 'test@1',
    collected_at: new Date().toISOString(),
  });
  const r = ingestPosting(db, p);
  return r.postingId;
}

const PDF = Buffer.from('%PDF-1.4 fake');

describe('投递前检查：只读，不写', () => {
  it('preflight 不产生任何投递记录', () => {
    const pid = addJob('某某科技', '后端工程师');
    preflight(db, { jobId: '', postingId: pid });
    expect((db.prepare('SELECT COUNT(*) n FROM applications').get() as any).n).toBe(0);
  });

  it('带出分数、JD 存档和投递键', () => {
    const pid = addJob('某某科技', '后端工程师');
    const pre = preflight(db, { jobId: '', postingId: pid });
    expect(pre.company).toBe('某某科技');
    expect(pre.roleFamily).toBe('backend');
    expect(pre.jdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pre.applicationKey).toContain(':backend');
    expect(pre.alreadyApplied).toBeNull();
  });
});

describe('人工确认闸门', () => {
  it('不显式确认就拒绝 —— 这是和「无人值守批量投递」的分界线', () => {
    const pid = addJob('某某科技', '后端工程师');
    expect(() =>
      recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: false }),
    ).toThrow(NotConfirmed);
    expect(() =>
      recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF } as any),
    ).toThrow(NotConfirmed);
  });

  it('数据库层面也拦得住：confirmed_by_user 有 CHECK 约束', () => {
    const pid = addJob('某某科技', '后端工程师');
    recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
    expect(() =>
      db.prepare('UPDATE applications SET confirmed_by_user = 0').run(),
    ).toThrow();
  });
});

describe('四份快照', () => {
  it('投递当时的简历、JD、话术、表单都能原样还原', () => {
    const pid = addJob('某某科技', '后端工程师', '独一无二的 JD 正文 XYZ');
    const r = recordApplication(db, {
      postingId: pid, channel: 'form', resumePdf: PDF,
      greeting: '您好，我看到贵司在招后端', formData: { name: '李工', phone: '139' },
      formDomain: 'jobs.example.com', confirmedByUser: true,
    });
    expect(r.snapshots.map((s) => s.kind).sort()).toEqual(['form', 'greeting', 'jd', 'resume']);

    const snap = applicationSnapshot(db, r.id);
    expect(snap.resume?.equals(PDF)).toBe(true);
    expect(snap.jd).toContain('独一无二的 JD 正文 XYZ');
    expect(snap.greeting).toBe('您好，我看到贵司在招后端');
    expect(snap.forms[0]!.data).toEqual({ name: '李工', phone: '139' });
    expect(snap.forms[0]!.domain).toBe('jobs.example.com');
  });

  it('JD 之后被改了，投递记录里仍是投递时那一份', () => {
    const pid = addJob('某某科技', '后端工程师', '原始 JD：要 Go');
    const r = recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true });

    // 同一个挂牌重新采到一份改过的 JD
    ingestPosting(db, Posting.parse({
      platform: 'test', platform_job_id: 't0', company_name: '某某科技', title: '后端工程师',
      city: '杭州', jd_text: '改过的 JD：要 Rust 了', collected_by: 'test@1',
      collected_at: new Date().toISOString(),
    }));

    expect(applicationSnapshot(db, r.id).jd).toContain('原始 JD：要 Go');
  });

  it('没有 JD 存档就不让投 —— 缺这一份等于一个月后没法准备面试', () => {
    const pid = addJob('某某科技', '后端工程师');
    db.prepare('DELETE FROM posting_jd_history WHERE posting_id = ?').run(pid);
    expect(() =>
      recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true }),
    ).toThrow(/JD 存档/);
  });

  it('同一份简历投多家只存一份字节', () => {
    const a = addJob('A 公司', '后端工程师');
    const b = addJob('B 公司', '后端工程师');
    const r1 = recordApplication(db, { postingId: a, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
    const r2 = recordApplication(db, { postingId: b, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
    expect(r1.snapshots.find((s) => s.kind === 'resume')!.sha256)
      .toBe(r2.snapshots.find((s) => s.kind === 'resume')!.sha256);
  });
});

describe('去重与冷却', () => {
  it('同一个挂牌重复投是硬错误', () => {
    const pid = addJob('某某科技', '后端工程师');
    recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
    expect(() =>
      recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true }),
    ).toThrow(AlreadyApplied);
  });

  it('同公司同类岗在 90 天内是提醒，不是禁止 —— 但要显式 override', () => {
    const a = addJob('某某科技', '后端工程师');
    const b = addJob('某某科技', '高级后端工程师');
    recordApplication(db, { postingId: a, channel: 'chat', resumePdf: PDF, confirmedByUser: true });

    expect(() =>
      recordApplication(db, { postingId: b, channel: 'chat', resumePdf: PDF, confirmedByUser: true }),
    ).toThrow(/overrideCooldown/);

    const r = recordApplication(db, {
      postingId: b, channel: 'chat', resumePdf: PDF, confirmedByUser: true, overrideCooldown: true,
    });
    expect(r.id).toBeTruthy();
  });

  it('不同职能族不受同公司冷却影响', () => {
    const a = addJob('某某科技', '后端工程师');
    const b = addJob('某某科技', '前端工程师', '任职要求：精通 React');
    recordApplication(db, { postingId: a, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
    expect(() =>
      recordApplication(db, { postingId: b, channel: 'chat', resumePdf: PDF, confirmedByUser: true }),
    ).not.toThrow();
  });
});

describe('管线与漏斗', () => {
  it('未确认的事件单独计数 —— 邮件解析出来的东西要人点过才算数', () => {
    const pid = addJob('某某科技', '后端工程师');
    const r = recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
    logApplicationEvent(db, r.id, { type: 'replied', source: 'email', confirmed: false });
    const row = pipeline(db)[0]!;
    expect(row.unconfirmedEvents).toBe(1);
    expect(row.status).toBe('sent'); // 没确认就不改状态
    logApplicationEvent(db, r.id, { type: 'replied', source: 'user', confirmed: true });
    expect(pipeline(db)[0]!.status).toBe('replied');
  });

  it('样本少于 5 不给比率 —— 3 投 1 回不是 33%，是「还不知道」', () => {
    for (let i = 0; i < 3; i++) {
      const pid = addJob(`公司${i}`, '后端工程师');
      const r = recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
      if (i === 0) logApplicationEvent(db, r.id, { type: 'replied', source: 'user', confirmed: true });
    }
    const f = funnel(db, 'channel');
    expect(f[0]!.sent).toBe(3);
    expect(f[0]!.replied).toBe(1);
    expect(f[0]!.replyRate).toBeNull();
  });

  it('够 5 条才算比率', () => {
    for (let i = 0; i < 5; i++) {
      const pid = addJob(`公司${i}`, '后端工程师');
      const r = recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
      if (i < 2) logApplicationEvent(db, r.id, { type: 'replied', source: 'user', confirmed: true });
    }
    expect(funnel(db, 'channel')[0]!.replyRate).toBeCloseTo(0.4, 5);
  });

  it('未确认的事件不进漏斗 —— 漏斗要反映事实不是猜测', () => {
    for (let i = 0; i < 5; i++) {
      const pid = addJob(`公司${i}`, '后端工程师');
      const r = recordApplication(db, { postingId: pid, channel: 'chat', resumePdf: PDF, confirmedByUser: true });
      logApplicationEvent(db, r.id, { type: 'replied', source: 'email', confirmed: false });
    }
    expect(funnel(db, 'channel')[0]!.replyRate).toBe(0);
  });
});
