import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Profile } from '@assit/contract';
import { usableCertificates, type BulletDraft } from './guard.js';

const exec = promisify(execFile);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean) as string[];

/**
 * 直接用系统 Chrome 的 headless 打印，不引 puppeteer/playwright。
 * 省掉一次 ~180MB 的 chromium 下载；M1 搬进 Electron 后换成主进程的
 * webContents.printToPDF，模板不用改。
 */
export function findChrome(): string | null {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export interface RenderInput {
  profile: Profile;
  bullets: BulletDraft[];
  summary?: string;
  targetRole?: string;
  lang?: 'zh' | 'en';
  now?: Date;
}

const CSS = `
:root { --ink:#16181d; --muted:#5b6472; --rule:#d8dde5; --accent:#1f4e79; }
* { box-sizing: border-box; }
body { margin:0; font: 10.5pt/1.55 "PingFang SC","Hiragino Sans GB","Microsoft YaHei",
       -apple-system, "Helvetica Neue", Arial, sans-serif; color: var(--ink); }
.page { padding: 14mm 14mm 12mm; }
h1 { font-size: 20pt; margin: 0 0 2mm; letter-spacing: .5px; }
.contact { color: var(--muted); font-size: 9pt; margin-bottom: 4mm; }
.contact span + span::before { content: " · "; }
h2 { font-size: 11pt; color: var(--accent); margin: 6mm 0 2mm;
     border-bottom: 1px solid var(--rule); padding-bottom: 1mm; letter-spacing:.5px; }
.summary { margin: 0 0 2mm; }
ul { margin: 0; padding-left: 5mm; }
li { margin: 0 0 1.6mm; }
.row { display:flex; justify-content: space-between; gap: 6mm; }
.row .what { font-weight: 600; }
.row .when { color: var(--muted); font-size: 9pt; white-space: nowrap; }
.sub { color: var(--muted); font-size: 9.5pt; margin-bottom: 1mm; }
.placeholder { background: #fff3cd; border-bottom: 1px dashed #b8860b; padding: 0 2px; }
.claimref { color:#9aa3b0; font-size: 7.5pt; }
@page { size: A4; margin: 0; }
@media print { .page { padding: 12mm 14mm; } }
`;

/** 待补占位符在 PDF 里必须显眼 —— 它的作用是提醒你填，不是蒙混过关。 */
function markPlaceholders(text: string): string {
  return esc(text).replace(/__（需补充[^）]*）__/g, (m) => `<span class="placeholder">${m}</span>`);
}

export function renderHtml(input: RenderInput, opts: { showClaimRefs?: boolean } = {}): string {
  const { profile } = input;
  const now = input.now ?? new Date();
  const f = profile.fields;
  const name = f['name.zh'] ?? f['name.en'] ?? '';
  const contact = ['phone', 'email', 'city', 'github', 'website']
    .map((k) => f[k])
    .filter(Boolean)
    .map((v) => `<span>${esc(v!)}</span>`)
    .join('');

  const bySection = new Map<string, BulletDraft[]>();
  for (const b of input.bullets) {
    const arr = bySection.get(b.section) ?? [];
    arr.push(b);
    bySection.set(b.section, arr);
  }

  const emp = profile.records.employment
    .slice()
    .sort((a, b) => (b.start_at ?? '').localeCompare(a.start_at ?? ''));
  const edu = profile.records.education
    .slice()
    .sort((a, b) => (b.start_at ?? '').localeCompare(a.start_at ?? ''));
  const certs = usableCertificates(profile, now);

  const sections: string[] = [];

  if (input.summary) {
    sections.push(`<h2>个人概述</h2><p class="summary">${markPlaceholders(input.summary)}</p>`);
  }

  if (emp.length > 0) {
    sections.push(
      `<h2>工作经历</h2>` +
        emp
          .map((e) => {
            const when = `${e.start_at} – ${e.is_current ? '至今' : e.end_at ?? ''}`;
            const head =
              `<div class="row"><span class="what">${esc(e.company)}</span>` +
              `<span class="when">${esc(when)}</span></div>` +
              `<div class="sub">${esc([e.title, e.department, e.city].filter(Boolean).join(' · '))}</div>`;
            const items = (bySection.get(e.company) ?? []).map(
              (b) =>
                `<li>${markPlaceholders(b.text)}` +
                (opts.showClaimRefs ? ` <span class="claimref">[${esc(b.claimId)}]</span>` : '') +
                `</li>`,
            );
            return head + (items.length ? `<ul>${items.join('')}</ul>` : '');
          })
          .join(''),
    );
  }

  // section 命中公司全称的挂到那段经历下，其余一律进「项目经历」。
  // 一条 bullet 只出现在一个地方 —— 重复出现会让 HR 以为你在凑字数。
  const known = new Set(emp.map((e) => e.company));
  const projects = input.bullets.filter((b) => !known.has(b.section));
  if (projects.length > 0) {
    sections.push(
      `<h2>项目经历</h2><ul>` +
        projects
          .map(
            (b) =>
              `<li>${markPlaceholders(b.text)}` +
              (opts.showClaimRefs ? ` <span class="claimref">[${esc(b.claimId)}]</span>` : '') +
              `</li>`,
          )
          .join('') +
        `</ul>`,
    );
  }

  if (edu.length > 0) {
    sections.push(
      `<h2>教育经历</h2>` +
        edu
          .map(
            (e) =>
              `<div class="row"><span class="what">${esc(e.school)}</span>` +
              `<span class="when">${esc(`${e.start_at} – ${e.end_at ?? ''}`)}</span></div>` +
              `<div class="sub">${esc([e.degree, e.major, e.is_statutory ? '统招' : ''].filter(Boolean).join(' · '))}</div>`,
          )
          .join(''),
    );
  }

  if (certs.length > 0) {
    sections.push(
      `<h2>证书与语言</h2><ul>` +
        certs
          .map(
            (c) =>
              `<li>${esc(c.name)}${c.issuer ? ` · ${esc(c.issuer)}` : ''}` +
              `${c.expires_at ? ` <span class="when">(有效期至 ${esc(c.expires_at)})</span>` : ''}</li>`,
          )
          .join('') +
        profile.records.language
          .map(
            (l) =>
              `<li>${esc(l.language)}${l.exam ? ` · ${esc(l.exam)}` : ''}${l.score ? ` ${esc(l.score)}` : ''}</li>`,
          )
          .join('') +
        `</ul>`,
    );
  }

  return `<meta charset="utf-8"><title>${esc(name)}${input.targetRole ? ` - ${esc(input.targetRole)}` : ''}</title>
<style>${CSS}</style>
<div class="page">
  <h1>${esc(name)}</h1>
  <div class="contact">${contact}</div>
  ${sections.join('\n')}
</div>`;
}

export interface PdfResult {
  ok: boolean;
  pdfPath?: string;
  reason?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PDF 写完之后大小就不再变了。连续两次采样一致即认为落盘完成。 */
async function waitForStableFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    if (size > 0 && size === lastSize) return true;
    lastSize = size;
  }
  return false;
}

export async function htmlToPdf(html: string, outPdf: string): Promise<PdfResult> {
  const chrome = findChrome();
  if (!chrome) {
    return {
      ok: false,
      reason:
        '没找到可用的 Chrome/Chromium。装一个，或设 CHROME_PATH 指向它；HTML 已经生成，可以自己打印。',
    };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-resume-'));
  const htmlFile = path.join(tmp, 'resume.html');
  fs.writeFileSync(htmlFile, html, 'utf8');
  fs.mkdirSync(path.dirname(outPdf), { recursive: true });
  fs.rmSync(outPdf, { force: true });

  const child = spawn(
    chrome,
    [
      '--headless=new',
      // 必须用独立 profile：不给的话 Chrome 会去抢默认 profile 的锁，
      // 而你的 Chrome 基本上一直开着。
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--virtual-time-budget=4000',
      '--no-pdf-header-footer',
      `--print-to-pdf=${outPdf}`,
      `file://${htmlFile}`,
    ],
    { stdio: 'ignore', detached: true },
  );

  try {
    // 不能等 Chrome 退出：它把 PDF 写完之后会继续活着（拉更新器、保活进程），
    // 等下去就是干等到超时。正确姿势是等文件落地，然后把整个进程组收掉。
    const ok = await waitForStableFile(outPdf, 45_000);
    return ok
      ? { ok: true, pdfPath: outPdf }
      : { ok: false, reason: 'Chrome 在 45 秒内没有写出 PDF；HTML 已生成，可以自己打印' };
  } catch (e) {
    return { ok: false, reason: `Chrome 打印失败：${(e as Error).message.slice(0, 200)}` };
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
