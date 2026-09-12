import type { Db } from '../db/index.js';
import { newId } from '../util/hash.js';

/**
 * 公司归一与别名解析。
 *
 * 这是去重的地基，也是最容易想当然的地方：「字节跳动」「北京字节跳动科技有限公司」
 * 「ByteDance」是同一家，但没有任何字符串规则能可靠地把它们归到一起 ——
 * 「杭州某某科技有限公司」和「某某科技」也一样。
 *
 * 所以做法是：规则只用来**猜**，猜中了直接复用，猜不中就记下来让人确认一次。
 * 确认过的写法进 company_aliases，之后自动命中。
 * 把这件事伪装成纯函数的系统，最后都会静默地把两家公司合成一家。
 */

const SUFFIXES =
  /(集团有限公司|股份有限公司|有限责任公司|科技有限公司|信息technology|有限公司|集团|公司|inc\.?|ltd\.?|llc|co\.?,?\s*ltd\.?|corporation|corp\.?)$/i;

const CITY_PREFIX =
  /^(北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|天津|重庆|长沙|青岛|厦门|合肥|郑州|济南|东莞|佛山|宁波|无锡)/;

/** 归一化到一个「指纹」。它只是别名匹配的候选键，不是身份本身。 */
export function companyFingerprint(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  s = s.replace(/[\s·•,，.。\-_]/g, '');
  let prev: string;
  do {
    prev = s;
    s = s.replace(SUFFIXES, '');
  } while (s !== prev && s.length > 0);
  // 城市前缀只在去掉之后仍有内容时才剥离
  const stripped = s.replace(CITY_PREFIX, '');
  if (stripped.length >= 2) s = stripped;
  return s;
}

export interface ResolvedCompany {
  companyId: string;
  canonicalName: string;
  /** 第一次见到这个写法。true 时应该提示用户确认它是不是已有公司的别名。 */
  isNewAlias: boolean;
  /** 指纹命中的候选公司，供人工确认用 */
  fingerprintMatch?: { companyId: string; canonicalName: string };
}

/**
 * 把平台上抓到的公司名解析成一个稳定的 company_id。
 * 采集器不许自己拼 identity_key —— 必须先过这里。
 */
export function resolveCompany(db: Db, rawName: string): ResolvedCompany {
  const name = rawName.trim();
  const alias = db
    .prepare('SELECT company_id FROM company_aliases WHERE alias = ?')
    .get(name.toLowerCase()) as { company_id: string } | undefined;
  if (alias) {
    const c = db
      .prepare('SELECT canonical_name FROM companies WHERE id = ?')
      .get(alias.company_id) as { canonical_name: string };
    return { companyId: alias.company_id, canonicalName: c.canonical_name, isNewAlias: false };
  }

  const fp = companyFingerprint(name);
  const byFp = db
    .prepare(
      `SELECT c.id, c.canonical_name FROM companies c
       JOIN company_aliases a ON a.company_id = c.id
       WHERE a.alias = ? LIMIT 1`,
    )
    .get(`fp:${fp}`) as { id: string; canonical_name: string } | undefined;

  if (byFp) {
    // 指纹命中：先用着，但标成待确认，让用户在 UI 上看一眼是不是真的同一家
    db.prepare(
      'INSERT OR IGNORE INTO company_aliases (alias, company_id, confirmed_by_user) VALUES (?,?,0)',
    ).run(name.toLowerCase(), byFp.id);
    return {
      companyId: byFp.id,
      canonicalName: byFp.canonical_name,
      isNewAlias: true,
      fingerprintMatch: { companyId: byFp.id, canonicalName: byFp.canonical_name },
    };
  }

  const id = newId('co-');
  db.transaction(() => {
    db.prepare('INSERT INTO companies (id, canonical_name) VALUES (?,?)').run(id, name);
    db.prepare(
      'INSERT OR IGNORE INTO company_aliases (alias, company_id, confirmed_by_user) VALUES (?,?,1)',
    ).run(name.toLowerCase(), id);
    db.prepare(
      'INSERT OR IGNORE INTO company_aliases (alias, company_id, confirmed_by_user) VALUES (?,?,0)',
    ).run(`fp:${fp}`, id);
  })();
  return { companyId: id, canonicalName: name, isNewAlias: true };
}

/** 人工确认两个写法是同一家：把 from 的所有别名迁到 to 名下。 */
export function mergeCompanies(db: Db, fromId: string, toId: string): void {
  db.transaction(() => {
    db.prepare('UPDATE company_aliases SET company_id = ?, confirmed_by_user = 1 WHERE company_id = ?')
      .run(toId, fromId);
    db.prepare('UPDATE jobs SET company_id = ? WHERE company_id = ?').run(toId, fromId);
    db.prepare('DELETE FROM companies WHERE id = ?').run(fromId);
  })();
}

/** 待你确认的别名。M1 的岗位池面板上应该有这么一个小队列。 */
export function pendingAliases(db: Db): { alias: string; canonical_name: string }[] {
  return db
    .prepare(
      `SELECT a.alias, c.canonical_name FROM company_aliases a
       JOIN companies c ON c.id = a.company_id
       WHERE a.confirmed_by_user = 0 AND a.alias NOT LIKE 'fp:%'
       ORDER BY a.alias`,
    )
    .all() as { alias: string; canonical_name: string }[];
}
