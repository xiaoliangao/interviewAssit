import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { EmployerEntry, EmployerStatus } from '@assit/contract';
import { fetchText } from './_shared/http.js';
import { BrowserUaRequired, PORTAL_ADAPTERS } from './cn-portals.js';
import { collectGreenhouse, collectLever, collectAshby } from './platforms.js';
import { paths, todayLocal } from '../util/paths.js';

/**
 * 逐条验证雇主注册表（DESIGN §4.1.1）。
 *
 * 一条必须守住的区分：**「主页能打开」不等于「能采到岗位」。**
 *
 * 前者只说明公司还在招人页面还在，后者才是这个注册表存在的意义。
 * 如果 doctor 把「主页 200」洗成 `status: ok`，那 26 个 `unverified`
 * 会在一次运行后全变绿 —— 而你一个岗位都采不到。所以只有真的跑了
 * 一次采集并拿到条目，才允许写 `verified_at`。
 */

export type ProbeKind =
  /** 真跑了一次采集并拿到了岗位。只有这种才写 verified_at */
  | 'collect'
  /** 只探了主页可达性。说明不了能不能采 */
  | 'reachability';

export interface ProbeResult {
  id: string;
  name: string;
  kind: ProbeKind;
  ok: boolean;
  /** 建议写回的状态。null = 不动它 */
  status: EmployerStatus | null;
  detail: string;
  sampleCount?: number;
  ms: number;
}

export interface DoctorOptions {
  /** 只查这几个 id */
  only?: string[];
  /** 单次探测超时 */
  timeoutMs?: number;
  /** 探主页也算一种探测。关掉的话只跑真能采的那些，快很多 */
  probeHomepages?: boolean;
  /**
   * 来自用户 `sources.yaml` 的每源设置（目前只有 browser_ua）。
   *
   * doctor **不替用户决定要不要伪装 UA**。没有配置就用诚实 UA 去打，
   * 打不通就如实记 `needs_browser_ua` —— 那正是最准确的观测：
   * 「用我们如实声明的 UA，这家采不到」。
   * 用户在自己的配置里开了，doctor 才跟着开，这样验的才是他真实的采集路径。
   */
  sourceOverrides?: Map<string, { browserUa?: boolean }>;
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number, current: string) => void;
}

async function probeCollect(e: EmployerEntry, opts: DoctorOptions): Promise<ProbeResult> {
  const t0 = Date.now();
  const base = { id: e.id, name: e.name, kind: 'collect' as const };
  const net = { timeoutMs: opts.timeoutMs ?? 20_000, retries: 1, fetchImpl: opts.fetchImpl };

  try {
    let count = 0;
    if (e.channel === 'api' && e.adapter) {
      const r = await PORTAL_ADAPTERS[e.adapter]({
        ...net,
        limit: 1,
        pages: 1,
        intervalMs: 0,
        // 只跟随用户自己的配置，不因为注册表写着 needs_browser_ua 就自作主张。
        // 见 DoctorOptions.sourceOverrides 上面那段。
        browserUa: opts.sourceOverrides?.get(e.id)?.browserUa === true,
      });
      count = r.postings.length;
    } else if (e.channel === 'ats' && e.ats?.token) {
      const t = e.ats.token;
      const r =
        e.ats.kind === 'greenhouse' ? await collectGreenhouse(t, { ...net, limit: 1 })
        : e.ats.kind === 'lever' ? await collectLever(t, { ...net, limit: 1 })
        : e.ats.kind === 'ashby' ? await collectAshby(t, { ...net, limit: 1 })
        : null;
      if (!r) {
        return { ...base, kind: 'reachability', ok: false, status: null, ms: Date.now() - t0,
          detail: `${e.ats.kind} 还没有适配器，采不了` };
      }
      count = r.postings.length;
    } else {
      return { ...base, kind: 'reachability', ok: false, status: null, ms: Date.now() - t0,
        detail: '没有可执行的采集路径' };
    }

    if (count === 0) {
      // 接口通了但一条都没有。可能是真没岗位，也可能是接口换了形状 ——
      // 分不清，所以不写 ok，也不写 broken。
      return { ...base, ok: false, status: null, sampleCount: 0, ms: Date.now() - t0,
        detail: '接口通了但没返回岗位。可能真没在招，也可能字段变了 —— 去页面上看一眼' };
    }
    return { ...base, ok: true, status: 'ok', sampleCount: count, ms: Date.now() - t0,
      detail: `采到 ${count} 条` };
  } catch (err) {
    const e2 = err as Error;
    if (e2 instanceof BrowserUaRequired || e2.name === 'BrowserUaRequired') {
      // 这不是坏掉，是「需要你做一个决定」。状态如实记成 needs_browser_ua。
      return { ...base, ok: false, status: 'needs_browser_ua', ms: Date.now() - t0,
        detail: '接口要浏览器 UA，在 sources.yaml 里开 browser_ua 才能采' };
    }
    return { ...base, ok: false, status: 'broken', ms: Date.now() - t0,
      detail: e2.message.slice(0, 160) };
  }
}

async function probeHomepage(e: EmployerEntry, opts: DoctorOptions): Promise<ProbeResult> {
  const t0 = Date.now();
  const base = { id: e.id, name: e.name, kind: 'reachability' as const };
  try {
    const r = await fetchText(e.homepage, {
      timeoutMs: opts.timeoutMs ?? 15_000,
      retries: 0,
      fetchImpl: opts.fetchImpl,
      headers: { accept: 'text/html,*/*' },
    });
    // 注意：ok 只表示主页活着。**不写 status，也不写 verified_at** ——
    // 把「网站在」洗成「能采」是这个功能最容易犯的错。
    return { ...base, ok: true, status: null, ms: Date.now() - t0, detail: `主页 ${r.status}` };
  } catch (err) {
    return { ...base, ok: false, status: 'broken', ms: Date.now() - t0,
      detail: `主页打不开：${(err as Error).message.slice(0, 120)}` };
  }
}

export async function doctorRegistry(
  entries: EmployerEntry[],
  opts: DoctorOptions = {},
): Promise<ProbeResult[]> {
  const targets = opts.only?.length ? entries.filter((e) => opts.only!.includes(e.id)) : entries;
  const out: ProbeResult[] = [];
  let done = 0;
  for (const e of targets) {
    opts.onProgress?.(done, targets.length, e.id);
    const canCollect =
      (e.channel === 'api' && e.adapter) || (e.channel === 'ats' && e.ats?.token);
    if (canCollect) out.push(await probeCollect(e, opts));
    else if (opts.probeHomepages !== false) out.push(await probeHomepage(e, opts));
    done += 1;
  }
  opts.onProgress?.(done, targets.length, '');
  return out;
}

export interface WriteBackResult {
  file: string;
  updated: { id: string; from: string; to: string }[];
}

/**
 * 把探测结果写回 YAML，**保留注释**。
 *
 * 注释不是装饰：那个文件里写着「httservice 返回 illegal-visit」这类
 * 为什么走这条通道的理由。用 `YAML.stringify(parse(x))` 会把它们全抹掉，
 * 下一个人（三个月后的你）就只剩一堆没有来由的 `needs_cdp`。
 */
/**
 * 把探测结果写回 YAML，**保留注释，并且只动改了的那几行**。
 *
 * 两件事都不能省：
 *
 * 1. **注释。** 那个文件里写着「httservice 返回 illegal-visit」这类
 *    为什么走这条通道的理由。`YAML.stringify(YAML.parse(x))` 会把它们全抹掉，
 *    三个月后就只剩一堆没有来由的 `needs_cdp`。
 * 2. **其余字节原样不动。** 直接把整个 Document 重新序列化会重排缩进、
 *    把手工对齐的一行流式条目折成多行 —— 一次只改了一个字段的 doctor 运行
 *    会产出 30 行 diff。那种工具没人会愿意天天跑。
 *
 * 所以这里用节点的 range 做定点替换：改过的条目重新序列化，其它一个字节不碰。
 */
export function writeBackRegistry(
  results: ProbeResult[],
  dir = paths.registry,
  today = todayLocal(),
): WriteBackResult[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const out: WriteBackResult[] = [];

  for (const name of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    const doc = YAML.parseDocument(text, { keepSourceTokens: true });
    const list = doc.get('employers') as any;
    if (!list?.items) continue;

    const updated: WriteBackResult['updated'] = [];
    // 从后往前替换，否则前面的替换会让后面的 range 全部失效
    const edits: { start: number; end: number; text: string }[] = [];

    for (const item of list.items) {
      if (typeof item?.get !== 'function' || !item.range) continue;
      const id = String(item.get('id') ?? '');
      const r = byId.get(id);
      if (!r) continue;

      const before = String(item.get('status') ?? 'unverified');
      let touched = false;
      if (r.status && r.status !== before) {
        item.set('status', r.status);
        updated.push({ id, from: before, to: r.status });
        touched = true;
      }
      // verified_at 只在**真跑了采集并成功**时更新。主页可达不是验证。
      //
      // 状态没变但日期变了同样要落盘 —— 否则「上次验证是三个月前」会永远
      // 停在三个月前，而这个字段的全部意义就是回答「这条还新不新」。
      if (r.kind === 'collect' && r.ok && item.get('verified_at') !== today) {
        item.set('verified_at', today);
        touched = true;
      }
      if (!touched) continue;

      const [start, , end] = item.range as [number, number, number];
      // 条目在 `- ` 之后，所以续行要缩进到同一列
      const indent = ' '.repeat(Math.max(0, columnOf(text, start)));
      const body = YAML.stringify(item.toJSON(), { lineWidth: 0 })
        .trimEnd()
        .split('\n')
        .map((line, i) => (i === 0 ? line : indent + line))
        .join('\n');
      edits.push({ start, end, text: body + '\n' });
    }

    if (edits.length > 0) {
      let next = text;
      for (const e of edits.sort((a, b) => b.start - a.start)) {
        next = next.slice(0, e.start) + e.text + next.slice(e.end);
      }
      fs.writeFileSync(file, next, 'utf8');
    }
    out.push({ file, updated });
  }
  return out;
}

/** offset 在所在行里的列号（0 起）。用来给续行补缩进。 */
function columnOf(text: string, offset: number): number {
  const nl = text.lastIndexOf('\n', offset - 1);
  return offset - (nl + 1);
}
