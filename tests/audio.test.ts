import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChunk,
  deleteRecordingAudio,
  listRecordings,
  openDb,
  pruneRecordings,
  recoverStale,
  resetLiveForTest,
  setRecordingKeep,
  startRecording,
  stopRecording,
  type Db,
} from '@assit/core';
import {
  DEFAULT_WAV_FORMAT,
  WAV_HEADER_BYTES,
  WavWriter,
  wavDurationSec,
  wavHeader,
} from '../packages/core/src/audio/wav.js';

function pcm(samples: number, value = 0x1234): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b;
}

describe('WAV 头：逐字节锁住', () => {
  // 这段里全是 36 / 8 / 16 这类偏移量常数。写错了播放器通常**不报错**，
  // 只是播出噪音或长度显示不对 —— 所以只能靠逐字段断言。
  it('16kHz 单声道 PCM16 的标准头', () => {
    const h = wavHeader(DEFAULT_WAV_FORMAT, 32_000);
    expect(h.length).toBe(44);
    expect(h.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.readUInt32LE(4)).toBe(36 + 32_000); // 文件长度 - 8
    expect(h.toString('ascii', 8, 12)).toBe('WAVE');
    expect(h.toString('ascii', 12, 16)).toBe('fmt ');
    expect(h.readUInt32LE(16)).toBe(16); // PCM 的 fmt 块长度
    expect(h.readUInt16LE(20)).toBe(1); // audioFormat = PCM
    expect(h.readUInt16LE(22)).toBe(1); // 声道
    expect(h.readUInt32LE(24)).toBe(16_000); // 采样率
    expect(h.readUInt32LE(28)).toBe(32_000); // byteRate = 16000 * 1 * 2
    expect(h.readUInt16LE(32)).toBe(2); // blockAlign
    expect(h.readUInt16LE(34)).toBe(16); // 位深
    expect(h.toString('ascii', 36, 40)).toBe('data');
    expect(h.readUInt32LE(40)).toBe(32_000);
  });

  it('立体声 / 44.1kHz 时 byteRate 与 blockAlign 跟着变', () => {
    const h = wavHeader({ sampleRate: 44_100, channels: 2, bitsPerSample: 16 }, 0);
    expect(h.readUInt16LE(32)).toBe(4);
    expect(h.readUInt32LE(28)).toBe(44_100 * 4);
  });

  it('时长按字节算，0 字节不除零', () => {
    expect(wavDurationSec(DEFAULT_WAV_FORMAT, 32_000)).toBe(1);
    expect(wavDurationSec(DEFAULT_WAV_FORMAT, 0)).toBe(0);
    expect(wavDurationSec({ sampleRate: 0, channels: 1, bitsPerSample: 16 }, 100)).toBe(0);
  });
});

describe('WavWriter：增量写与崩溃后可播', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-wav-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('多次 write 之后头里的长度是对的', () => {
    const f = path.join(dir, 'a.wav');
    const w = new WavWriter(f);
    w.write(pcm(1600));
    w.write(pcm(1600));
    const r = w.close();

    expect(r.bytes).toBe(WAV_HEADER_BYTES + 6400);
    expect(r.durationSec).toBeCloseTo(0.2, 5);
    const buf = fs.readFileSync(f);
    expect(buf.length).toBe(WAV_HEADER_BYTES + 6400);
    expect(buf.readUInt32LE(40)).toBe(6400);
    expect(buf.readUInt32LE(4)).toBe(36 + 6400);
  });

  it('没 close 的文件也已经是能播的 —— 这是崩溃时唯一的保险', () => {
    const f = path.join(dir, 'b.wav');
    // syncEveryBytes 调小，让回填在测试里立刻发生
    const w = new WavWriter(f, { syncEveryBytes: 100 });
    w.write(pcm(500)); // 1000 字节，超过阈值，触发一次回填
    const buf = fs.readFileSync(f); // 故意不 close
    expect(buf.readUInt32LE(40)).toBe(1000);
    expect(buf.length).toBe(WAV_HEADER_BYTES + 1000);
    w.close();
  });

  it('空写入不改变任何东西，close 幂等', () => {
    const f = path.join(dir, 'c.wav');
    const w = new WavWriter(f);
    w.write(Buffer.alloc(0));
    expect(w.bytesWritten).toBe(0);
    w.close();
    expect(w.close().bytes).toBe(WAV_HEADER_BYTES);
    expect(w.closed).toBe(true);
  });

  it('关了之后再写要显式失败，不能静默丢数据', () => {
    const w = new WavWriter(path.join(dir, 'd.wav'));
    w.close();
    expect(() => w.write(pcm(10))).toThrow(/已关闭/);
  });

  it('写进去的 PCM 字节原样在 44 字节之后', () => {
    const f = path.join(dir, 'e.wav');
    const w = new WavWriter(f);
    w.write(pcm(3, 0x7fff));
    w.close();
    const buf = fs.readFileSync(f);
    expect(buf.readInt16LE(WAV_HEADER_BYTES)).toBe(0x7fff);
    expect(buf.readInt16LE(WAV_HEADER_BYTES + 4)).toBe(0x7fff);
  });
});

// ── 录音会话：把规则锁住，而不是把实现锁住 ────────────────────────────────

describe('录音会话', () => {
  let dataDir: string;
  let db: Db;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-rec-'));
    process.env.ASSIT_DATA_DIR = dataDir;
    db = openDb();
  });
  afterEach(() => {
    db.close();
    delete process.env.ASSIT_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const consent = () => new Date().toISOString();

  it('没有同意确认就不许开录', () => {
    expect(() =>
      startRecording(db, { label: '一面', consentConfirmedAt: '' }),
    ).toThrow(/知情同意/);
  });

  it('没有名字不许开录 —— 三天后你分不清哪场是哪场', () => {
    expect(() =>
      startRecording(db, { label: '   ', consentConfirmedAt: consent() }),
    ).toThrow(/名字/);
  });

  it('录完搬进内容寻址存档，staging 文件清掉', () => {
    const h = startRecording(db, { label: '腾讯一面', consentConfirmedAt: consent() });
    expect(fs.existsSync(h.file)).toBe(true);
    // 2 秒的 16kHz PCM16
    appendChunk(h.id, pcm(32_000));
    const r = stopRecording(db, h.id);

    expect(r.durationSec).toBeCloseTo(2, 5);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(r.file)).toBe(true);
    expect(fs.existsSync(h.file)).toBe(false); // staging 已清
    expect(r.file).toContain(r.sha256);

    const row = listRecordings(db)[0]!;
    expect(row.status).toBe('stopped');
    expect(row.sha256).toBe(r.sha256);
    expect(row.fileExists).toBe(true);
  });

  it('不到 1 秒判为误触并丢弃，但那一行要留着', () => {
    const h = startRecording(db, { label: '误触', consentConfirmedAt: consent() });
    appendChunk(h.id, pcm(800)); // 0.05 秒
    expect(() => stopRecording(db, h.id)).toThrow(/不足 1 秒/);

    const row = listRecordings(db)[0]!;
    // 「我以为我录了」和「我确实没录」必须能区分 —— 所以行不能删
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/不足 1 秒/);
    expect(fs.existsSync(h.file)).toBe(false);
  });

  it('停止后再送分片要显式失败，不能悄悄写到别处', () => {
    const h = startRecording(db, { label: 'x', consentConfirmedAt: consent() });
    appendChunk(h.id, pcm(32_000));
    stopRecording(db, h.id);
    expect(() => appendChunk(h.id, pcm(100))).toThrow(/不存在或已停止/);
  });

  it('删音频保留记录行', () => {
    const h = startRecording(db, { label: '字节二面', consentConfirmedAt: consent() });
    appendChunk(h.id, pcm(32_000));
    const r = stopRecording(db, h.id);

    expect(deleteRecordingAudio(db, h.id)).toBe(true);
    expect(fs.existsSync(r.file)).toBe(false);

    const row = listRecordings(db)[0]!;
    expect(row.status).toBe('purged');
    expect(row.file).toBeNull();
    // 「哪天、哪个岗位、录了多久」还在 —— 这才是复盘要的东西
    expect(row.label).toBe('字节二面');
    expect(row.durationSec).toBeCloseTo(2, 5);
    expect(row.consentConfirmedAt).toBeTruthy();
  });

  it('过期清理跳过标了保留的', () => {
    const a = startRecording(db, { label: '会过期', consentConfirmedAt: consent(), retentionDays: -1 });
    appendChunk(a.id, pcm(32_000));
    stopRecording(db, a.id);
    const b = startRecording(db, { label: '要留着', consentConfirmedAt: consent(), retentionDays: -1 });
    appendChunk(b.id, pcm(32_000));
    stopRecording(db, b.id);
    setRecordingKeep(db, b.id, true);

    const r = pruneRecordings(db);
    expect(r.purged).toEqual([a.id]);
    expect(r.keptByFlag).toBe(1);
  });

  it('崩溃留下的半截录音被恢复而不是删掉 —— 面试不可重来', () => {
    const h = startRecording(db, { label: '崩了那场', consentConfirmedAt: consent() });
    appendChunk(h.id, pcm(32_000));
    // 模拟进程没了：staging 文件还在，但内存里的会话没了
    resetLiveForTest();

    const r = recoverStale(db);
    expect(r.recovered).toEqual([h.id]);
    expect(r.failed).toEqual([]);

    const row = listRecordings(db)[0]!;
    expect(row.status).toBe('stopped');
    expect(row.durationSec).toBeCloseTo(2, 1);
    expect(row.error).toMatch(/恢复/);
    expect(row.fileExists).toBe(true);
  });

  it('崩溃时连一帧都没写的，判失败而不是留个空文件', () => {
    const h = startRecording(db, { label: '空的', consentConfirmedAt: consent() });
    resetLiveForTest();
    const r = recoverStale(db);
    expect(r.failed).toEqual([h.id]);
    expect(listRecordings(db)[0]!.status).toBe('failed');
  });
});
