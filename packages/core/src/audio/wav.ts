import fs from 'node:fs';

/**
 * 增量写 WAV（DESIGN §8.5）。
 *
 * 为什么不攒在内存里最后一次写：一场面试 60 分钟、16kHz 单声道 PCM16
 * 就是 115MB。攒内存意味着「录到一半崩了 = 什么都没有」，
 * 而面试录音是**不可重来**的数据 —— 这一条决定了整个写入策略。
 *
 * WAV 的头里有两个长度字段，写的时候还不知道最终值。常见做法是
 * 收尾时回填一次；这里额外**每隔一段就回填一次**，代价是几次 write，
 * 换来的是崩溃/断电后文件仍然能播 —— 只是尾巴少几秒。
 */

export const WAV_HEADER_BYTES = 44;

export interface WavFormat {
  sampleRate: number;
  /** 声道数。面试录音固定 1：双声道只是把同一份数据存两遍 */
  channels: number;
  /** 位深。固定 16 —— whisper 系模型吃的就是 PCM16 */
  bitsPerSample: number;
}

export const DEFAULT_WAV_FORMAT: WavFormat = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
};

/**
 * 生成 44 字节的规范 WAV 头。
 *
 * 单独抽出来是因为这段里全是「减 8」「减 36」这类偏移量常数，
 * 写错了播放器**通常不报错，只是播出噪音或长度显示不对** ——
 * 所以它必须能被单测逐字节锁住。
 */
export function wavHeader(fmt: WavFormat, dataBytes: number): Buffer {
  const { sampleRate, channels, bitsPerSample } = fmt;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(WAV_HEADER_BYTES);

  h.write('RIFF', 0, 'ascii');
  // RIFF 块大小 = 整个文件 - 'RIFF' 和这个字段自己（共 8 字节）
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');

  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // PCM 的 fmt 块固定 16 字节
  h.writeUInt16LE(1, 20); // 1 = PCM，无压缩
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);

  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** 已写入的 PCM 字节数 → 秒。UI 上的计时器和保留期清理都用它。 */
export function wavDurationSec(fmt: WavFormat, dataBytes: number): number {
  const bytesPerSec = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
  return bytesPerSec === 0 ? 0 : dataBytes / bytesPerSec;
}

export interface WavWriterOptions {
  format?: WavFormat;
  /** 每写这么多字节就回填一次头。默认约 5 秒 —— 崩溃最多丢这么多 */
  syncEveryBytes?: number;
}

export class WavWriter {
  readonly format: WavFormat;
  private fd: number | null;
  private dataBytes = 0;
  private sinceSync = 0;
  private readonly syncEvery: number;

  constructor(readonly file: string, opts: WavWriterOptions = {}) {
    this.format = opts.format ?? DEFAULT_WAV_FORMAT;
    const bytesPerSec =
      (this.format.sampleRate * this.format.channels * this.format.bitsPerSample) / 8;
    this.syncEvery = opts.syncEveryBytes ?? bytesPerSec * 5;
    this.fd = fs.openSync(file, 'w');
    // 先占位。长度未知，先按 0 写，后面回填。
    fs.writeSync(this.fd, wavHeader(this.format, 0), 0, WAV_HEADER_BYTES, 0);
  }

  get bytesWritten(): number {
    return this.dataBytes;
  }

  get durationSec(): number {
    return wavDurationSec(this.format, this.dataBytes);
  }

  get closed(): boolean {
    return this.fd === null;
  }

  write(pcm: Buffer): void {
    if (this.fd === null) throw new Error('WavWriter 已关闭');
    if (pcm.length === 0) return;
    fs.writeSync(this.fd, pcm, 0, pcm.length, WAV_HEADER_BYTES + this.dataBytes);
    this.dataBytes += pcm.length;
    this.sinceSync += pcm.length;
    if (this.sinceSync >= this.syncEvery) {
      this.syncHeader();
      this.sinceSync = 0;
    }
  }

  /** 回填长度字段。中途调用是为了让崩溃后的半截文件仍然可播。 */
  private syncHeader(): void {
    if (this.fd === null) return;
    fs.writeSync(this.fd, wavHeader(this.format, this.dataBytes), 0, WAV_HEADER_BYTES, 0);
  }

  close(): { file: string; bytes: number; durationSec: number } {
    if (this.fd !== null) {
      this.syncHeader();
      fs.closeSync(this.fd);
      this.fd = null;
    }
    return {
      file: this.file,
      bytes: WAV_HEADER_BYTES + this.dataBytes,
      durationSec: this.durationSec,
    };
  }
}
