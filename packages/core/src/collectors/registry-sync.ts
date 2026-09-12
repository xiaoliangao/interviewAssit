import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EmployerRegistryFile, type EmployerEntry } from '@assit/contract';
import { fetchText } from './_shared/http.js';
import { paths } from '../util/paths.js';

/**
 * 注册表同步（DESIGN §4.1.1）。
 *
 * **这是这个项目里唯一一处供应链入口。**
 *
 * 注册表条目里存的是采集器接下来要去请求的 URL。一个被污染的条目 =
 * 让你的采集器去打攻击者的服务器，抓回来的东西还会**以可信来源的身份**
 * 进岗位池 → 进打分 → 进简历。所以这里的规矩比别处都严：
 *
 *   1. 上游钉 commit sha，不跟 HEAD
 *   2. 拉下来先算 diff，**只返回不落盘**
 *   3. 落盘要单独一次调用，由人在看过 diff 之后显式触发
 *   4. 本地手改过的条目默认不覆盖 —— 你写的 `needs_cdp` 理由比上游的猜测值钱
 */

export interface SyncSource {
  /** owner/repo */
  repo: string;
  /** **必须**是 commit sha，不接受分支名 */
  commit: string;
  /** 仓库内路径 */
  filePath: string;
}

export class UnpinnedUpstream extends Error {
  constructor(commit: string) {
    super(
      `上游必须钉在 commit sha 上，拿到的是「${commit}」。\n` +
        '跟 HEAD 等于把采集器要请求的 URL 交给别人随时改 —— ' +
        '而那些 URL 抓回来的东西会以可信来源的身份进岗位池、进打分、进简历。',
    );
    this.name = 'UnpinnedUpstream';
  }
}

const SHA_RE = /^[0-9a-f]{40}$/i;

export function upstreamUrl(src: SyncSource): string {
  if (!SHA_RE.test(src.commit)) throw new UnpinnedUpstream(src.commit);
  return `https://raw.githubusercontent.com/${src.repo}/${src.commit}/${src.filePath}`;
}

export type ChangeKind = 'add' | 'update' | 'remove';

export interface EntryDiff {
  kind: ChangeKind;
  id: string;
  /** 哪些字段变了，逐字段列出来 —— 「有变化」这种粒度没法审 */
  fields: { key: string; from: unknown; to: unknown }[];
  /** 本地手改过，默认跳过 */
  locallyEdited: boolean;
}

export interface SyncPlan {
  source: SyncSource;
  url: string;
  upstreamCount: number;
  localCount: number;
  changes: EntryDiff[];
  /** 上游里有、但本地明确标过 status/note 的，默认不动 */
  skipped: string[];
}

/** 只比较「上游有资格提供」的字段。status / verified_at / note 是本地的观测结果，上游说了不算。 */
const UPSTREAM_FIELDS = ['name', 'homepage', 'region', 'channel', 'adapter', 'ats'] as const;

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 拉上游并算出差异。**不写任何文件。**
 *
 * 分成 plan / apply 两步不是为了优雅，是因为中间那一步是人看 diff ——
 * 一个会自动写入的同步命令等于没有这道防线。
 */
export async function planRegistrySync(
  src: SyncSource,
  local: EmployerEntry[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SyncPlan> {
  const url = upstreamUrl(src);
  const res = await fetchText(url, { timeoutMs: opts.timeoutMs ?? 20_000, fetchImpl: opts.fetchImpl });
  const parsed = EmployerRegistryFile.safeParse(YAML.parse(res.body));
  if (!parsed.success) {
    throw new Error(
      `上游 ${url} 不是合法的注册表：\n` +
        parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }

  const localById = new Map(local.map((e) => [e.id, e]));
  const changes: EntryDiff[] = [];
  const skipped: string[] = [];

  for (const up of parsed.data.employers) {
    const cur = localById.get(up.id);
    if (!cur) {
      changes.push({
        kind: 'add', id: up.id, locallyEdited: false,
        fields: UPSTREAM_FIELDS.filter((k) => up[k] !== undefined).map((k) => ({
          key: k, from: undefined, to: up[k],
        })),
      });
      continue;
    }
    const fields = UPSTREAM_FIELDS.filter((k) => !eq(cur[k], up[k])).map((k) => ({
      key: k, from: cur[k], to: up[k],
    }));
    if (fields.length === 0) continue;

    // 本地手写过 note、或验证过状态的条目，上游不该无声盖掉。
    // 那句「httservice 返回 illegal-visit」是有人真的去打过一次才写下来的。
    const locallyEdited = Boolean(cur.note) || cur.status !== 'unverified';
    if (locallyEdited) skipped.push(up.id);
    changes.push({ kind: 'update', id: up.id, fields, locallyEdited });
  }

  // 上游删掉的**不自动删本地**。只列出来 —— 本地可能是你自己加的一家。
  const upIds = new Set(parsed.data.employers.map((e) => e.id));
  for (const cur of local) {
    if (!upIds.has(cur.id)) {
      changes.push({ kind: 'remove', id: cur.id, locallyEdited: true, fields: [] });
    }
  }

  return {
    source: src, url,
    upstreamCount: parsed.data.employers.length,
    localCount: local.length,
    changes, skipped,
  };
}

export interface ApplyOptions {
  /** 连本地手改过的也一起覆盖。默认 false */
  includeLocallyEdited?: boolean;
  /** 只应用这几个 id */
  only?: string[];
  /** 写到哪个文件。默认 <registry>/upstream.yaml，和手写的分开放 */
  file?: string;
}

export interface ApplyResult {
  file: string;
  added: string[];
  updated: string[];
  skipped: string[];
}

/**
 * 应用一份已经被人看过的 plan。
 *
 * 上游来的条目落到**单独一个文件**（默认 `upstream.yaml`），不和手写的混在一起。
 * 这样「哪些是我自己判断的、哪些是别人给的」永远一眼可分，
 * 下次同步也不会把你的手写注释卷进去。
 */
export function applyRegistrySync(
  plan: SyncPlan,
  upstreamEntries: EmployerEntry[],
  opts: ApplyOptions = {},
): ApplyResult {
  const file = opts.file ?? path.join(paths.registry, 'upstream.yaml');
  const byId = new Map(upstreamEntries.map((e) => [e.id, e]));

  const doc = fs.existsSync(file)
    ? YAML.parseDocument(fs.readFileSync(file, 'utf8'))
    : YAML.parseDocument(
        `# 由 \`assit registry sync\` 从上游写入，**不要手改**。\n` +
          `# 手写的判断放在同目录其它文件里（如 cn.yaml）—— 那些永远不会被同步覆盖。\n` +
          `employers: []\n`,
      );

  doc.set('upstream', { repo: plan.source.repo, commit: plan.source.commit });
  const list = (doc.get('employers') as any) ?? doc.createNode([]);
  const existing = new Map<string, any>();
  for (const it of list.items ?? []) existing.set(String(it.get?.('id') ?? ''), it);

  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const c of plan.changes) {
    if (c.kind === 'remove') continue; // 从不自动删
    if (opts.only && !opts.only.includes(c.id)) continue;
    if (c.locallyEdited && !opts.includeLocallyEdited) {
      skipped.push(c.id);
      continue;
    }
    const up = byId.get(c.id);
    if (!up) continue;

    const node = doc.createNode({
      id: up.id, name: up.name, homepage: up.homepage, region: up.region,
      channel: up.channel, ...(up.adapter ? { adapter: up.adapter } : {}),
      ...(up.ats ? { ats: up.ats } : {}),
      // 从上游来的一律 unverified：别人说它能采，不等于你这里能采。
      status: 'unverified',
    });
    const prev = existing.get(c.id);
    if (prev) {
      const i = list.items.indexOf(prev);
      list.items[i] = node;
      updated.push(c.id);
    } else {
      list.add(node);
      added.push(c.id);
    }
  }

  doc.set('employers', list);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(doc), 'utf8');
  return { file, added, updated, skipped };
}

/** plan 里 add/update 涉及的上游条目，供 apply 使用。 */
export async function fetchUpstreamEntries(
  src: SyncSource,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<EmployerEntry[]> {
  const res = await fetchText(upstreamUrl(src), { fetchImpl: opts.fetchImpl });
  return EmployerRegistryFile.parse(YAML.parse(res.body)).employers;
}
