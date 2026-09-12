import type { Claim } from '@assit/contract';
import type { Db } from '../db/index.js';
import { newId } from '../util/hash.js';
import type { FactBase } from './load.js';

export interface SyncReport {
  profileFields: number;
  profileRecords: number;
  claimsInserted: number;
  claimsUpdated: number;
  claimsUnchanged: number;
  events: number;
  repos: number;
}

const CLAIM_JSON_COLS = [
  'code_evidence', 'artifact_evidence', 'interview_details',
  'metrics', 'allowed_uses', 'tags',
] as const;

function claimRow(c: Claim, sourcePath: string) {
  return {
    id: c.id,
    source_fact: c.source_fact,
    candidate_wording: c.candidate_wording ?? null,
    candidate_wording_en: c.candidate_wording_en ?? null,
    responsibility_level: c.responsibility_level,
    verification_status: c.verification_status,
    boundary: c.boundary,
    visibility: c.visibility,
    code_evidence: c.code_evidence ? JSON.stringify(c.code_evidence) : null,
    artifact_evidence: JSON.stringify(c.artifact_evidence),
    interview_details: JSON.stringify(c.interview_details),
    metrics: JSON.stringify(c.metrics),
    allowed_uses: JSON.stringify(c.allowed_uses),
    tags: JSON.stringify(c.tags),
    risk_notes: c.risk_notes ?? null,
    last_verified: c.last_verified,
    source_path: sourcePath,
  };
}

/**
 * 文件 → SQLite。文件是真源，这里只是重建索引层。
 *
 * 关键点：claims 的状态变更要写 claim_events。
 * 「面试答不上来自动降级 claim」如果不留事件，就是不可逆的静默改写 ——
 * 三个月后你看到一条 claim 是「待确认」，完全不知道是谁、什么时候、为什么改的。
 */
export function syncFacts(db: Db, facts: FactBase): SyncReport {
  const report: SyncReport = {
    profileFields: 0, profileRecords: 0,
    claimsInserted: 0, claimsUpdated: 0, claimsUnchanged: 0,
    events: 0, repos: 0,
  };

  db.transaction(() => {
    // ---- 档案：全量替换。它是登记事实，没有增量语义。 ----
    db.prepare('DELETE FROM profile_fields').run();
    const insField = db.prepare(
      'INSERT INTO profile_fields (key, value, value_en) VALUES (?, ?, ?)',
    );
    for (const [k, v] of Object.entries(facts.profile.fields)) {
      if (k.endsWith('.en')) continue;
      insField.run(k, v, facts.profile.fields[`${k}.en`] ?? null);
      report.profileFields++;
    }

    db.prepare('DELETE FROM profile_records').run();
    const insRec = db.prepare(`INSERT INTO profile_records
      (id, kind, payload, start_at, end_at, expires_at, is_current, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const R = facts.profile.records;
    const groups: [string, any[]][] = [
      ['education', R.education], ['employment', R.employment],
      ['certificate', R.certificate], ['language', R.language], ['award', R.award],
    ];
    for (const [kind, rows] of groups) {
      rows.forEach((row, i) => {
        insRec.run(
          newId(`${kind}-`), kind, JSON.stringify(row),
          row.start_at ?? row.issued_at ?? null,
          row.end_at ?? null,
          row.expires_at ?? null,
          row.is_current ? 1 : 0,
          i,
        );
        report.profileRecords++;
      });
    }

    db.prepare('DELETE FROM preference_defaults').run();
    const insPref = db.prepare('INSERT INTO preference_defaults (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(facts.profile.preferences)) {
      if (v === undefined) continue;
      insPref.run(k, typeof v === 'string' ? v : JSON.stringify(v));
    }

    // ---- 主张：逐条 upsert，字段变化写事件 ----
    const existing = new Map<string, any>(
      db.prepare('SELECT * FROM claims').all().map((r: any) => [r.id, r]),
    );
    const insEvent = db.prepare(`INSERT INTO claim_events
      (claim_id, field, old_value, new_value, source, note) VALUES (?, ?, ?, ?, 'sync', ?)`);

    const cols = [
      'id','source_fact','candidate_wording','candidate_wording_en','responsibility_level',
      'verification_status','boundary','visibility', ...CLAIM_JSON_COLS,
      'risk_notes','last_verified','source_path',
    ];
    const insClaim = db.prepare(
      `INSERT INTO claims (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`,
    );
    const updClaim = db.prepare(
      `UPDATE claims SET ${cols.filter((c) => c !== 'id').map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`,
    );

    // 这两个字段的变更是有后果的，值得单独留痕
    const TRACKED = ['verification_status', 'responsibility_level', 'visibility'] as const;

    for (const c of facts.claims) {
      const row = claimRow(c, facts.claimSource.get(c.id) ?? '');
      const prev = existing.get(c.id);
      if (!prev) {
        insClaim.run(row);
        report.claimsInserted++;
        continue;
      }
      const changed = cols.some((k) => (prev as any)[k] !== (row as any)[k]);
      if (!changed) { report.claimsUnchanged++; continue; }
      for (const f of TRACKED) {
        if (prev[f] !== row[f]) {
          insEvent.run(c.id, f, prev[f], row[f], '来自 assit sync：文件被编辑');
          report.events++;
        }
      }
      updClaim.run(row);
      report.claimsUpdated++;
    }

    // 文件里删掉的主张不物理删除 —— 它可能正被某份已投出去的简历引用。
    // 标成「不采用」并留事件。
    const fileIds = new Set(facts.claims.map((c) => c.id));
    for (const [id, prev] of existing) {
      if (fileIds.has(id) || prev.verification_status === '不采用') continue;
      insEvent.run(id, 'verification_status', prev.verification_status, '不采用',
        '文件中已移除；保留记录因为可能被历史简历引用');
      db.prepare("UPDATE claims SET verification_status='不采用' WHERE id=?").run(id);
      report.events++;
    }

    // ---- 仓库清单 ----
    const insRepo = db.prepare(`INSERT INTO repos (id, full_name, local_path, visibility)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(full_name) DO UPDATE SET local_path=excluded.local_path, visibility=excluded.visibility`);
    for (const r of facts.repos.repos) {
      insRepo.run(newId('repo-'), r.full_name, r.local_path, r.visibility);
      report.repos++;
    }
  })();

  return report;
}
