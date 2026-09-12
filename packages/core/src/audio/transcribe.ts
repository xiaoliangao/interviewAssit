import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { putArtifact } from '../artifacts.js';
import type { Db } from '../db/index.js';
import { ensureDir, paths } from '../util/paths.js';

const run = promisify(execFile);

/**
 * 本地转写（DESIGN §8.5 / §13.3）。
 *
 * **音频不出本机，没有例外。** 面试录音里有对方的声音 ——
 * 那是别人的个人信息，不是你的。所以这里不接任何云端 ASR，
 * 连「可选开启」的开关都不提供：一个存在的开关迟早会被按下。
 *
 * 实现上只是调本机的 whisper.cpp / faster-whisper。找不到就明说怎么装，
 * 而不是悄悄降级到某个在线服务。
 */

export type Engine = 'whisper-cpp' | 'faster-whisper';

export interface EngineInfo {
  engine: Engine;
  bin: string;
  /** whisper.cpp 需要模型文件路径；faster-whisper 用模型名 */
  model: string;
}

export class NoLocalEngine extends Error {
  constructor(detail: string) {
    super(
      `没有可用的本地转写引擎。${detail}\n\n` +
        '装其中一个：\n' +
        '  brew install whisper-cpp        然后下一个模型放到 ~/.cache/whisper/\n' +
        '  pipx install faster-whisper     首次运行会自动下模型\n\n' +
        '**不会有云端兜底。** 面试录音里有对方的声音，那是别人的个人信息。\n' +
        '一个「可选的云端开关」迟早会被按下，所以这里根本不提供。',
    );
    this.name = 'NoLocalEngine';
  }
}

function which(bin: string): string | null {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const MODEL_DIRS = [
  `${process.env.HOME}/.cache/whisper`,
  `${process.env.HOME}/Library/Application Support/whisper`,
  '/opt/homebrew/share/whisper-cpp',
  '/usr/local/share/whisper-cpp',
];

function findGgml(): string | null {
  for (const d of MODEL_DIRS) {
    if (!fs.existsSync(d)) continue;
    const f = fs.readdirSync(d).filter((x) => x.endsWith('.bin')).sort();
    // 有多个就挑最大的 —— 通常就是精度最好的那个
    if (f.length > 0) {
      const withSize = f.map((n) => ({ n, size: fs.statSync(path.join(d, n)).size }));
      withSize.sort((a, b) => b.size - a.size);
      return path.join(d, withSize[0]!.n);
    }
  }
  return null;
}

export function detectEngine(env = process.env): EngineInfo | null {
  const explicitModel = env.ASSIT_WHISPER_MODEL;
  for (const bin of ['whisper-cli', 'whisper-cpp', 'main']) {
    const p = which(bin);
    if (!p) continue;
    const model = explicitModel ?? findGgml();
    if (model) return { engine: 'whisper-cpp', bin: p, model };
  }
  const fw = which('faster-whisper') ?? which('whisper-ctranslate2');
  if (fw) return { engine: 'faster-whisper', bin: fw, model: explicitModel ?? 'medium' };
  return null;
}

export interface TranscribeOptions {
  engine?: EngineInfo;
  language?: string;
  timeoutMs?: number;
  /** 注入用 */
  runner?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  engine: Engine;
}

/** whisper.cpp 的 `[00:00:01.000 --> 00:00:04.000]  文本` 逐行输出。 */
export function parseWhisperOutput(out: string): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  const re = /\[(\d\d):(\d\d):(\d\d)[.,](\d{3})\s*-->\s*(\d\d):(\d\d):(\d\d)[.,](\d{3})\]\s*(.*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const text = (m[9] ?? '').trim();
    if (!text) continue;
    segs.push({
      startSec: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
      endSec: Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000,
      text,
    });
  }
  return segs;
}

export async function transcribeFile(
  wavPath: string,
  opts: TranscribeOptions = {},
): Promise<Transcript> {
  const engine = opts.engine ?? detectEngine();
  if (!engine) throw new NoLocalEngine('PATH 里找不到 whisper-cli / whisper-cpp / faster-whisper。');
  if (!fs.existsSync(wavPath)) throw new Error(`音频文件不存在：${wavPath}`);

  const runner =
    opts.runner ??
    (async (bin: string, args: string[]) =>
      run(bin, args, { timeout: opts.timeoutMs ?? 30 * 60_000, maxBuffer: 64 * 1024 * 1024 }));

  const lang = opts.language ?? 'zh';
  const args =
    engine.engine === 'whisper-cpp'
      ? ['-m', engine.model, '-f', wavPath, '-l', lang, '-np']
      : [wavPath, '--model', engine.model, '--language', lang, '--output_format', 'txt', '--output_dir', '-'];

  const { stdout } = await runner(engine.bin, args);
  const segments = parseWhisperOutput(stdout);
  // 认不出时间戳就退回整段文本 —— 有文字总比因为格式不认识而失败好，
  // 但这时候要把「没有分段」如实表达出来（segments 为空），不要伪造一段。
  const text = segments.length > 0 ? segments.map((s) => s.text).join('\n') : stdout.trim();
  if (!text) throw new Error('转写产出为空。检查音频是不是静音，或者模型/语言参数对不对。');
  return { text, segments, engine: engine.engine };
}

export interface TranscribeRecordingResult {
  recordingId: string;
  sha256: string;
  chars: number;
  segments: number;
  engine: Engine;
}

/**
 * 转写一份已入库的录音，把结果也存成内容寻址 artifact。
 *
 * 转写文本和音频分开存：音频 30 天后自动删，**转写留着** ——
 * 结构化的问答记录不含声纹，却是复盘唯一需要的东西。
 */
export async function transcribeRecording(
  db: Db,
  recordingId: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeRecordingResult> {
  const r = db
    .prepare('SELECT file, status FROM interview_recordings WHERE id = ?')
    .get(recordingId) as { file: string | null; status: string } | undefined;
  if (!r) throw new Error(`找不到录音 ${recordingId}`);
  if (!r.file || !fs.existsSync(r.file)) {
    throw new Error(`录音 ${recordingId} 的音频文件已不在（status=${r.status}）。过期清理会删音频但保留记录行。`);
  }

  const t = await transcribeFile(r.file, opts);
  const stored = putArtifact(db, 'interview_transcript', 'transcript.txt', t.text);
  db.prepare('UPDATE interview_recordings SET transcript_sha256 = ? WHERE id = ?')
    .run(stored.sha256, recordingId);

  // 分段带时间戳的那份也留一份，逐答分析要靠它定位
  if (t.segments.length > 0) {
    ensureDir(paths.artifacts);
    putArtifact(db, 'interview_transcript_segments', 'segments.json', JSON.stringify(t.segments, null, 2));
  }

  return {
    recordingId,
    sha256: stored.sha256,
    chars: t.text.length,
    segments: t.segments.length,
    engine: t.engine,
  };
}
