import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { ensureDir, paths } from '../util/paths.js';

/**
 * 日历（DESIGN §7.4）。
 *
 * 一个设计判断：**面试事件要带上「这场该复习哪几条 claim」**。
 * 一个只写「14:00 某某科技二面」的日历条目，和你手机自带的提醒没区别。
 * 带上要复习的主张，它才连回了事实库 —— 而那正是这个系统存在的理由。
 */

export interface CalendarEvent {
  uid: string;
  title: string;
  startAt: string;
  durationMin: number;
  location?: string;
  /** 要复习的主张。写进备注里，打开日历就能看到 */
  claimIds?: string[];
  notes?: string;
  applicationId?: string;
}

function icsTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** RFC 5545 要求超过 75 字节折行，续行以空格开头。不折的话部分日历应用会截断。 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const take = i === 0 ? 75 : 74;
    // 不能从多字节字符中间切开
    let end = Math.min(i + take, bytes.length);
    while (end > i && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    out.push((i === 0 ? '' : ' ') + bytes.subarray(i, end).toString('utf8'));
    i = end;
  }
  return out.join('\r\n');
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function toIcs(events: CalendarEvent[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//assit-interview//CN', 'CALSCALE:GREGORIAN'];
  for (const e of events) {
    const end = new Date(new Date(e.startAt).getTime() + e.durationMin * 60_000).toISOString();
    const desc = [
      e.notes,
      e.claimIds?.length ? `要复习的主张：${e.claimIds.join('、')}` : '',
      e.applicationId ? `投递记录：${e.applicationId}` : '',
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${icsTime(new Date().toISOString())}`,
      `DTSTART:${icsTime(e.startAt)}`,
      `DTEND:${icsTime(end)}`,
      fold(`SUMMARY:${esc(e.title)}`),
      ...(e.location ? [fold(`LOCATION:${esc(e.location)}`)] : []),
      ...(desc ? [fold(`DESCRIPTION:${esc(desc)}`)] : []),
      // 提前一小时提醒。面试前一小时是复习那几条 claim 的最后窗口。
      'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:面试前复习',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export function writeIcs(events: CalendarEvent[], file?: string): string {
  const out = file ?? path.join(ensureDir(path.join(paths.out, 'calendar')), `assit-${Date.now()}.ics`);
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, toIcs(events), 'utf8');
  return out;
}

/**
 * 在 macOS 上直接打开 .ics，让系统日历接管导入。
 *
 * **刻意不用 osascript 直接往日历里写。** 那需要自动化权限，
 * 而且会绕过用户的「导入到哪个日历」选择 —— 一个悄悄往你工作日历里
 * 塞条目的工具，第一次塞错地方你就再也不会信它。
 */
export function openIcs(file: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('open', [file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 为一场面试凑出「该复习哪几条」。
 *
 * 优先级：这条投递用过的 claim（简历里真写了的）→ 最近答砸过的。
 * 后者是那条反向边的正向用法：面试里答砸过的，下次面试前先看它。
 */
export function claimsToReview(db: Db, applicationId: string, limit = 5): string[] {
  // 这条投递发出的那份简历里真写了哪几条主张。
  // 经 resume_versions.rendered_sha256 对上 —— applications 存的是那份 PDF 的 hash。
  const used = db
    .prepare(
      `SELECT DISTINCT rb.claim_id FROM resume_bullets rb
         JOIN resume_versions rv ON rv.id = rb.resume_version_id
         JOIN applications a ON a.resume_sha256 = rv.rendered_sha256
        WHERE a.id = ?`,
    )
    .all(applicationId) as { claim_id: string }[];

  const shaky = db
    .prepare(
      `SELECT t.claim_id, COUNT(*) n FROM interview_turns t
        WHERE t.claim_id IS NOT NULL AND t.verdict IN ('failed','shaky')
        GROUP BY t.claim_id ORDER BY n DESC LIMIT ?`,
    )
    .all(limit) as { claim_id: string }[];

  const out: string[] = [];
  for (const r of [...used, ...shaky]) {
    if (r.claim_id && !out.includes(r.claim_id)) out.push(r.claim_id);
    if (out.length >= limit) break;
  }
  return out;
}
