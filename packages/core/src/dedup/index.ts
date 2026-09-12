import { sha256 } from '../util/hash.js';

/**
 * 两个 key 解决两个完全不同的问题，绝不能合并成一个（DESIGN §11.3）。
 *
 * 你可能想投同一家的后端岗和 SRE 岗（岗位不同，该放行）；
 * 你也可能在 BOSS 和 51job 看到同一个岗位（岗位相同，只该投一次）。
 * 一个 key 表达不了这两件事。
 */

const TITLE_NOISE = [
  /[（(][^）)]*[）)]/g,
  /[【\[][^】\]]*[】\]]/g,
  // 中文噪音词不能加 \b：JS 的 \b 只认 [A-Za-z0-9_]，中文字符两侧永远没有边界，
  // 加上去的结果是这条规则从来不生效 —— 而且不会报错，只会让同一个岗位反复出现。
  /(急招|急聘|高薪|双休|单双休|单休|包吃住|五险一金|大量招聘|诚聘|热招|直招|可远程|应届|校招|社招|待遇优|月薪|年薪)/g,
  // 职级标记（P7 / T3 / E5）在不同平台写法不一，不进身份键
  /\b[PpTtEe]\d{1,2}[-+]?\b/g,
  /[·•\-—_|/、,，]+/g,
];

/** 归一化职位名。噪音不去干净，同一个岗位会在列表里反复出现 —— 体验杀手。 */
export function normalizeTitle(raw: string): string {
  let t = raw.trim().toLowerCase();
  for (const re of TITLE_NOISE) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function normalizeCompany(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(有限责任公司|股份有限公司|有限公司|科技有限公司|集团|公司)$/g, '')
    .toLowerCase();
}

/**
 * 岗位身份键。
 *
 * 第一个参数是**已经解析过的 company_id**，不是平台上抓到的原始公司名 ——
 * 公司归并靠 resolveCompany() 的别名表 + 一次人工确认，靠字符串规则做不到
 * （「杭州某某科技有限公司」和「某某科技」没有任何可靠规则能归到一起）。
 * 采集器不许自己拼这个 key。
 *
 * 刻意不含薪资：BOSS 写 `25-40K·15薪`，51job 写 `2.5-4万/月`，猎聘给年薪，
 * 分桶之后仍可能落到不同桶，导致同一岗位漏合。漏合比误合难受得多 ——
 * 误合你能看到两个 posting 手动拆开，漏合是同一个岗位在列表里刷屏。
 *
 * 也刻意不含 JD 全文：同一岗位在不同平台的措辞常有出入。
 */
export function identityKey(companyId: string, title: string, city: string | null): string {
  return sha256([companyId, normalizeTitle(title), (city ?? '').trim().toLowerCase()].join('|'));
}

/** 投递身份键。回答「我最近是不是投过这家的这类岗」。 */
export function applicationKey(companyId: string, roleFamily: string): string {
  return `${companyId}:${roleFamily}`;
}

/**
 * SQLite 的 datetime('now') 产出的是 UTC，但不带时区标记。
 * 直接 new Date('2026-08-01 10:00:00') 会按本地时区解析，而
 * new Date('2026-09-12') 按 UTC 解析 —— 两者一减就差出几个小时，
 * 在「89 天还是 90 天」的边界上会真的翻车。统一按 UTC 读。
 */
export function parseTimestamp(s: string): Date {
  const t = s.trim().replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(t);
  return new Date(hasZone ? t : `${t}${t.includes('T') ? '' : 'T00:00:00'}Z`);
}

export interface CooldownHit {
  blocked: boolean;
  reason: string;
  daysAgo?: number;
}

export const DEFAULT_COOLDOWN_DAYS = 90;

export function checkCooldown(
  previousSentAt: string[],
  now: Date = new Date(),
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
): CooldownHit {
  if (previousSentAt.length === 0) return { blocked: false, reason: '' };
  const mostRecent = previousSentAt
    .map(parseTimestamp)
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (!mostRecent) return { blocked: false, reason: '' };
  const days = Math.floor((now.getTime() - mostRecent.getTime()) / 86_400_000);
  if (days < cooldownDays) {
    return {
      blocked: true,
      daysAgo: days,
      reason: `${days} 天前投过同公司同类岗位（冷却窗口 ${cooldownDays} 天）`,
    };
  }
  return { blocked: false, reason: '', daysAgo: days };
}

/**
 * 薪资写法不一致时不参与去重，但差得离谱要标出来让人看一眼。
 *
 * 判断的是「两个区间是否矛盾」，不是「区间有多宽」—— 25-40K 本来就是个宽区间，
 * 拿下限比上限会把正常挂牌全判成冲突。
 */
export function salaryConflict(
  a: { min: number | null; max: number | null },
  b: { min: number | null; max: number | null },
): boolean {
  if (a.min === null || b.min === null) return false; // 未知就是未知，不下结论
  const aMax = a.max ?? a.min;
  const bMax = b.max ?? b.min;
  const overlapLo = Math.max(a.min, b.min);
  const overlapHi = Math.min(aMax, bMax);
  if (overlapHi >= overlapLo) return false; // 有重叠就不算矛盾
  const lo = Math.min(aMax, bMax);
  const hi = Math.max(a.min, b.min);
  return lo > 0 && hi / lo > 1.3;
}

export * from './companies.js';
