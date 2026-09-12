import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EmployerRegistryFile, type EmployerEntry, type JobSource } from '@assit/contract';
import { paths } from '../util/paths.js';

/**
 * 雇主注册表的读取与展开（DESIGN §4.1.1）。
 *
 * 注册表回答「这家公司该走哪条路」，`sources.yaml` 回答「我想采哪几家」。
 * 两者刻意分开：前者是共享事实、几个月变一次、**是供应链入口**；
 * 后者是你的私人订阅、随时改。
 */

export function loadRegistry(dir = paths.registry): EmployerEntry[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const all: EmployerEntry[] = [];
  const seen = new Map<string, string>();

  for (const f of files.sort()) {
    const full = path.join(dir, f);
    const parsed = EmployerRegistryFile.safeParse(YAML.parse(fs.readFileSync(full, 'utf8')));
    if (!parsed.success) {
      throw new Error(
        `${full} 格式有问题：\n` +
          parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
      );
    }
    for (const e of parsed.data.employers) {
      // id 撞车必须显式失败：两个 tencent 会静默覆盖成一个，
      // 而你要到岗位池里少了一半岗位的时候才会发现。
      const prev = seen.get(e.id);
      if (prev) throw new Error(`雇主 id 重复：${e.id}（${prev} 和 ${f}）`);
      seen.set(e.id, f);
      all.push(e);
    }
  }
  return all;
}

/** 能直接采的：已打通的自建站接口 + 有 token 的标准 ATS。 */
export function collectableEntries(entries: EmployerEntry[]): EmployerEntry[] {
  return entries.filter(
    (e) =>
      (e.channel === 'api' && e.adapter && (e.status === 'ok' || e.status === 'needs_browser_ua')) ||
      (e.channel === 'ats' && e.ats?.token && e.ats.kind !== 'feishu' && e.ats.kind !== 'moka' &&
        e.ats.kind !== 'beisen' && e.ats.kind !== 'dayee'),
  );
}

export interface ToSourcesOptions {
  keywords?: string[];
  cities?: string[];
  pages?: number;
}

/**
 * 注册表条目 → `sources.yaml` 条目。
 *
 * **不直接写文件。** 生成的 YAML 打到终端，由你决定粘不粘 ——
 * 采集哪几家是你的订阅，不是注册表替你决定的事。
 */
export function registryToSources(
  entries: EmployerEntry[],
  opts: ToSourcesOptions = {},
): JobSource[] {
  const out: JobSource[] = [];
  for (const e of collectableEntries(entries)) {
    if (e.channel === 'api' && e.adapter) {
      out.push({
        platform: 'api',
        id: e.id,
        adapter: e.adapter,
        keywords: opts.keywords ?? [],
        cities: opts.cities ?? [],
        pages: opts.pages ?? 3,
        // 只有注册表明确记着「这家需要」才开，不是默认行为
        browser_ua: e.status === 'needs_browser_ua',
        enabled: true,
        note: e.name,
      });
    } else if (e.channel === 'ats' && e.ats?.token) {
      const t = e.ats.token;
      if (e.ats.kind === 'greenhouse') out.push({ platform: 'greenhouse', id: e.id, board: t, enabled: true, note: e.name });
      else if (e.ats.kind === 'lever') out.push({ platform: 'lever', id: e.id, company: t, enabled: true, note: e.name });
      else if (e.ats.kind === 'ashby') out.push({ platform: 'ashby', id: e.id, board: t, enabled: true, note: e.name });
    }
  }
  return out;
}

/** 生成可直接粘进 sources.yaml 的片段。YAML 序列化留在 core，CLI 不必再依赖一次。 */
export function registryToSourcesYaml(
  entries: EmployerEntry[],
  opts: ToSourcesOptions = {},
): string {
  const sources = registryToSources(entries, opts);
  // aliasDuplicateObjects:false —— 否则相同的 keywords 数组会被写成 &a1 / *a1 锚点。
  // 这段是给人粘贴和编辑的，锚点在这里只会制造困惑。
  return sources.length === 0
    ? ''
    : YAML.stringify({ sources }, { aliasDuplicateObjects: false }).trimEnd();
}

export interface RegistryStats {
  total: number;
  byStatus: Record<string, number>;
  /** 有多少条超过 90 天没验证过 —— 和「已知坏掉」在决策上是一回事 */
  stale: number;
}

export function registryStats(entries: EmployerEntry[], staleDays = 90): RegistryStats {
  const cutoff = Date.now() - staleDays * 86_400_000;
  const byStatus: Record<string, number> = {};
  let stale = 0;
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    if (!e.verified_at || Date.parse(e.verified_at) < cutoff) stale += 1;
  }
  return { total: entries.length, byStatus, stale };
}
