import fs from 'node:fs';
import path from 'node:path';
import { putArtifact } from '../artifacts.js';
import type { Db } from '../db/index.js';
import { newId } from '../util/hash.js';
import { ensureDir, paths } from '../util/paths.js';
import { DEFAULT_WAV_FORMAT, WavWriter, type WavFormat } from './wav.js';

/**
 * 面试录音的会话生命周期（DESIGN §8.5）。
 *
 * 这一层刻意不碰任何音频采集 API —— 采集只能在渲染进程做
 * （`getDisplayMedia` / `getUserMedia` 是 Web API），core 不 import Electron。
 * 这里只负责：**同意闸门、落盘、入库、保留期**。
 *
 * 落盘分两段，因为内容寻址要整份内容才能算哈希：
 *
 *   录制中 → data/recordings/<id>.wav（staging，边录边写）
 *   停止后 → 算 sha256 → 搬进 artifacts/<前两位>/<hash>/interview.wav
 *
 * 好处不只是哈希：staging 目录里剩下的文件就是**没正常收尾的录音**，
 * 下次启动一眼看得见，不用去猜。
 */

export const DEFAULT_RETENTION_DAYS = 30;

export interface StartRecordingInput {
  label: string;
  jobId?: string | null;
  /**
   * 用户在**这一场**确认了知情同意。
   *
   * 故意不接受布尔值：这里要的是一个时间戳，将来要能回答
   * 「那场录音，我是什么时候确认的同意」。
   * 也故意不提供「记住我的选择」—— 对方每场都不一样。
   */
  consentConfirmedAt: string;
  sources?: string;
  format?: WavFormat;
  retentionDays?: number;
}

export interface RecordingHandle {
  id: string;
  file: string;
  startedAt: string;
  format: WavFormat;
}

interface LiveSession extends RecordingHandle {
  writer: WavWriter;
}

/** 进行中的会话只活在内存里。进程没了，staging 文件仍在，靠 `recoverStale` 收拾。 */
const live = new Map<string, LiveSession>();

function stagingDir(): string {
  return ensureDir(path.join(paths.data, 'recordings'));
}

export function startRecording(db: Db, input: StartRecordingInput): RecordingHandle {
  if (!input.consentConfirmedAt) {
    // 这个错误不该出现在 UI 上 —— 出现了说明有人绕过了确认那一步。
    throw new Error('没有知情同意确认，不允许开始录制（DESIGN §13.3）');
  }
  if (!input.label.trim()) throw new Error('录音要有名字，否则三天后你分不清哪场是哪场');

  const id = newId('rec_');
  const format = input.format ?? DEFAULT_WAV_FORMAT;
  const file = path.join(stagingDir(), `${id}.wav`);
  const startedAt = new Date().toISOString();
  const days = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const purgeAfter = new Date(Date.now() + days * 86_400_000).toISOString();

  const writer = new WavWriter(file, { format });
  db.prepare(
    `INSERT INTO interview_recordings
       (id, job_id, label, status, sources, consent_confirmed_at, started_at,
        sample_rate, file, purge_after)
     VALUES (?,?,?,'recording',?,?,?,?,?,?)`,
  ).run(
    id, input.jobId ?? null, input.label.trim(), input.sources ?? '',
    input.consentConfirmedAt, startedAt, format.sampleRate, file, purgeAfter,
  );

  const handle: RecordingHandle = { id, file, startedAt, format };
  live.set(id, { ...handle, writer });
  return handle;
}

export interface ChunkResult {
  bytes: number;
  durationSec: number;
}

export function appendChunk(id: string, pcm: Buffer): ChunkResult {
  const s = live.get(id);
  if (!s) throw new Error(`录音会话 ${id} 不存在或已停止`);
  s.writer.write(pcm);
  return { bytes: s.writer.bytesWritten, durationSec: s.writer.durationSec };
}

export interface StoppedRecording {
  id: string;
  sha256: string;
  file: string;
  bytes: number;
  durationSec: number;
  deduped: boolean;
}

export function stopRecording(db: Db, id: string): StoppedRecording {
  const s = live.get(id);
  if (!s) throw new Error(`录音会话 ${id} 不存在或已停止`);
  live.delete(id);
  const closed = s.writer.close();

  if (closed.durationSec < 1) {
    // 不到 1 秒的基本是误触。留一个 0 字节的 artifact 没有意义，
    // 但这一行要留着 —— 「我以为我录了」和「我确实没录」必须能区分。
    db.prepare(
      `UPDATE interview_recordings
          SET status='failed', stopped_at=datetime('now'), duration_sec=?, bytes=?,
              error='录制时长不足 1 秒，已丢弃'
        WHERE id=?`,
    ).run(closed.durationSec, closed.bytes, id);
    fs.rmSync(s.file, { force: true });
    throw new Error('录制时长不足 1 秒，已丢弃');
  }

  const stored = putArtifact(db, 'interview_audio', 'interview.wav', fs.readFileSync(s.file));
  fs.rmSync(s.file, { force: true });

  db.prepare(
    `UPDATE interview_recordings
        SET status='stopped', stopped_at=datetime('now'), duration_sec=?, bytes=?,
            sha256=?, file=?
      WHERE id=?`,
  ).run(closed.durationSec, stored.bytes, stored.sha256, stored.file, id);

  return {
    id,
    sha256: stored.sha256,
    file: stored.file,
    bytes: stored.bytes,
    durationSec: closed.durationSec,
    deduped: stored.deduped,
  };
}

/** 正在录的有几个。UI 靠它决定要不要显示那个常驻的红点。 */
export function liveRecordings(): RecordingHandle[] {
  return [...live.values()].map(({ writer: _w, ...h }) => h);
}

/**
 * 只给测试用：模拟「进程没了，但 staging 文件还在」。
 *
 * 这个缝必须留，因为 `recoverStale` 的整个价值就在崩溃路径上，
 * 而崩溃路径没法用正常 API 走到。留一个明确标注用途的导出，
 * 好过让测试去 mock 模块内部状态。
 */
export function resetLiveForTest(): void {
  for (const s of live.values()) {
    try {
      s.writer.close();
    } catch {
      /* 测试里无所谓 */
    }
  }
  live.clear();
}

export function liveProgress(id: string): ChunkResult | null {
  const s = live.get(id);
  return s ? { bytes: s.writer.bytesWritten, durationSec: s.writer.durationSec } : null;
}

export interface RecordingRow {
  id: string;
  jobId: string | null;
  label: string;
  status: string;
  sources: string;
  consentConfirmedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  durationSec: number;
  bytes: number;
  sha256: string | null;
  file: string | null;
  purgeAfter: string | null;
  keep: boolean;
  hasTranscript: boolean;
  note: string | null;
  error: string | null;
  /** 文件还在不在。过期清理跑过之后，行还在但文件没了 */
  fileExists: boolean;
}

function toRow(r: any): RecordingRow {
  return {
    id: r.id,
    jobId: r.job_id,
    label: r.label,
    status: r.status,
    sources: r.sources,
    consentConfirmedAt: r.consent_confirmed_at,
    startedAt: r.started_at,
    stoppedAt: r.stopped_at,
    durationSec: r.duration_sec,
    bytes: r.bytes,
    sha256: r.sha256,
    file: r.file,
    purgeAfter: r.purge_after,
    keep: Boolean(r.keep),
    hasTranscript: Boolean(r.transcript_sha256),
    note: r.note,
    error: r.error,
    fileExists: Boolean(r.file) && fs.existsSync(r.file),
  };
}

export function listRecordings(db: Db, limit = 100): RecordingRow[] {
  const rows = db
    .prepare('SELECT * FROM interview_recordings ORDER BY started_at DESC LIMIT ?')
    .all(limit) as any[];
  return rows.map(toRow);
}

export function setRecordingKeep(db: Db, id: string, keep: boolean): void {
  db.prepare('UPDATE interview_recordings SET keep=? WHERE id=?').run(keep ? 1 : 0, id);
}

export function setRecordingJob(db: Db, id: string, jobId: string | null): void {
  db.prepare('UPDATE interview_recordings SET job_id=? WHERE id=?').run(jobId, id);
}

/**
 * 删音频，**但保留那一行**。
 *
 * 行里剩下的是「哪天、哪个岗位、录了多久」—— 不含任何音频内容，
 * 却正是复盘时唯一还需要的东西。整行删掉等于把自己的面试历史也删了。
 */
export function deleteRecordingAudio(db: Db, id: string): boolean {
  const r = db.prepare('SELECT file FROM interview_recordings WHERE id=?').get(id) as
    | { file: string | null }
    | undefined;
  if (!r?.file) return false;
  fs.rmSync(r.file, { force: true });
  db.prepare("UPDATE interview_recordings SET file=NULL, status='purged' WHERE id=?").run(id);
  return true;
}

export interface PruneResult {
  purged: string[];
  keptByFlag: number;
}

/** 过期清理。`keep=1` 的跳过。默认在应用启动时跑一次。 */
export function pruneRecordings(db: Db, now = new Date()): PruneResult {
  const rows = db
    .prepare(
      `SELECT id, file, keep FROM interview_recordings
        WHERE file IS NOT NULL AND purge_after IS NOT NULL AND purge_after < ?`,
    )
    .all(now.toISOString()) as { id: string; file: string; keep: number }[];
  const purged: string[] = [];
  let keptByFlag = 0;
  for (const r of rows) {
    if (r.keep) {
      keptByFlag += 1;
      continue;
    }
    deleteRecordingAudio(db, r.id);
    purged.push(r.id);
  }
  return { purged, keptByFlag };
}

/**
 * 收拾上次没正常收尾的录音。
 *
 * 应用启动时跑。因为 WavWriter 每 5 秒回填一次长度，
 * 崩溃留下的 staging 文件通常是**能播的**，只是尾巴少几秒 ——
 * 所以这里的正确处理是把它入库，而不是删掉。
 * 面试录音不可重来，宁可留一份少几秒的。
 */
export function recoverStale(db: Db): { recovered: string[]; failed: string[] } {
  const rows = db
    .prepare("SELECT id, file FROM interview_recordings WHERE status='recording'")
    .all() as { id: string; file: string | null }[];
  const recovered: string[] = [];
  const failed: string[] = [];

  for (const r of rows) {
    if (live.has(r.id)) continue; // 本进程正在录的，不是残留
    const ok = r.file && fs.existsSync(r.file) && fs.statSync(r.file).size > 44;
    if (!ok) {
      db.prepare(
        "UPDATE interview_recordings SET status='failed', error='上次异常退出，没有留下可用音频' WHERE id=?",
      ).run(r.id);
      failed.push(r.id);
      continue;
    }
    const buf = fs.readFileSync(r.file!);
    const stored = putArtifact(db, 'interview_audio', 'interview.wav', buf);
    const sampleRate =
      (db.prepare('SELECT sample_rate FROM interview_recordings WHERE id=?').get(r.id) as {
        sample_rate: number;
      }).sample_rate;
    const dataBytes = Math.max(0, buf.length - 44);
    db.prepare(
      `UPDATE interview_recordings
          SET status='stopped', stopped_at=datetime('now'), sha256=?, file=?, bytes=?,
              duration_sec=?, error='上次异常退出后恢复，结尾可能缺几秒'
        WHERE id=?`,
    ).run(stored.sha256, stored.file, stored.bytes, dataBytes / (sampleRate * 2), r.id);
    fs.rmSync(r.file!, { force: true });
    recovered.push(r.id);
  }
  return { recovered, failed };
}
