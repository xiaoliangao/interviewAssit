import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db/index.js';
import { sha256 } from './util/hash.js';
import { ensureDir, paths } from './util/paths.js';

/**
 * 内容寻址存档（DESIGN §7.1）。
 *
 * 同一份简历投 50 家只存一份，但每条投递都能精确还原当时发出去的字节。
 * 「三个月后复盘为什么这家没回」，靠的就是这个 —— 不是「我当前的简历」。
 */
export interface StoredArtifact {
  sha256: string;
  file: string;
  bytes: number;
  deduped: boolean;
}

export function putArtifact(
  db: Db | null,
  kind: string,
  name: string,
  content: string | Buffer,
): StoredArtifact {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const hash = sha256(buf);
  const dir = path.join(paths.artifacts, hash.slice(0, 2), hash);
  const file = path.join(dir, name);
  const deduped = fs.existsSync(file);
  if (!deduped) {
    ensureDir(dir);
    fs.writeFileSync(file, buf);
  }
  db?.prepare(
    'INSERT OR IGNORE INTO artifacts (sha256, kind, bytes) VALUES (?, ?, ?)',
  ).run(hash, kind, buf.length);
  return { sha256: hash, file, bytes: buf.length, deduped };
}

export function artifactPath(hash: string, name: string): string {
  return path.join(paths.artifacts, hash.slice(0, 2), hash, name);
}

export function readArtifact(hash: string, name: string): Buffer {
  return fs.readFileSync(artifactPath(hash, name));
}
