import workletSource from './pcm-worklet.js?raw';

/**
 * 面试录音的采集层（DESIGN §8.5）。
 *
 * 四个只有踩过才知道的点，都写在对应的代码旁边：
 *   ① 系统音频只能从 getDisplayMedia 出来，而它必须同时要视频
 *   ② 双路混音要降益，否则双方同时说话就削顶
 *   ③ 必须用 AudioWorklet，不能用已废弃的 ScriptProcessorNode
 *   ④ worklet 必须 connect(destination) 才会被调度，即使它输出静音
 */

export type CaptureSource = 'system' | 'microphone';
export type CaptureMode = 'system' | 'microphone' | 'mixed';

export const SAMPLE_RATE = 16_000;
const FRAME_MS = 100;

export interface CaptureHandle {
  /** 实际拿到的音源。可能少于请求的 —— 比如用户在系统弹窗里没勾「共享音频」 */
  activeSources: CaptureSource[];
  warnings: string[];
  stop: () => Promise<void>;
}

export interface CaptureCallbacks {
  onChunk: (pcm: ArrayBuffer) => void;
  /** 0..1 的电平。UI 上那根跳动的条 —— 它存在的唯一理由是让你确认「真的在录」 */
  onLevel?: (level: number) => void;
  onError?: (err: Error) => void;
}

async function openMic(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // 回声消除要开：不开的话对方的声音会从扬声器绕回麦克风，
      // 混音后同一句话出现两次，转写会把它当成口吃。
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('麦克风没有可用音轨');
  }
  return stream;
}

async function openSystem(): Promise<MediaStream> {
  // ① Chromium 里系统/标签页声音只能经 getDisplayMedia 拿到，而它**必须**同时要视频。
  //    所以要了视频，再立刻把视频轨停掉 —— 这是唯一的路子，不是绕路。
  //    视频轨不停掉的话，整场面试都在后台编码一路屏幕流，白烧 CPU。
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('这次共享没有勾选「共享音频」，拿不到对方的声音');
  }
  return stream;
}

export async function startCapture(
  mode: CaptureMode,
  cb: CaptureCallbacks,
): Promise<CaptureHandle> {
  const wanted: { source: CaptureSource; open: () => Promise<MediaStream> }[] = [];
  if (mode === 'system' || mode === 'mixed') wanted.push({ source: 'system', open: openSystem });
  if (mode === 'microphone' || mode === 'mixed') wanted.push({ source: 'microphone', open: openMic });

  const settled = await Promise.allSettled(wanted.map((w) => w.open()));
  const streams: { source: CaptureSource; stream: MediaStream }[] = [];
  const warnings: string[] = [];
  settled.forEach((r, i) => {
    const name = wanted[i]!.source === 'system' ? '系统音频' : '麦克风';
    if (r.status === 'fulfilled') streams.push({ source: wanted[i]!.source, stream: r.value });
    else warnings.push(`${name}不可用：${(r.reason as Error).message}`);
  });
  if (streams.length === 0) {
    throw new Error(`没有可用的音频输入。${warnings.join('；')}`);
  }

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const mixer = ctx.createGain();
  mixer.channelCount = 1;
  mixer.channelCountMode = 'explicit';
  // ② 两路相加会超过 ±1.0，削顶之后转写基本报废 —— 而削顶恰恰发生在
  //    「双方同时说话」的时刻，也就是你最想听清的那一段。
  mixer.gain.value = streams.length > 1 ? 0.5 : 1;

  const nodes = streams.map(({ stream }) => {
    const audioOnly = new MediaStream(stream.getAudioTracks());
    const node = ctx.createMediaStreamSource(audioOnly);
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    node.connect(mixer);
    return node;
  });

  // ③ AudioWorklet，不是 ScriptProcessorNode。理由见 pcm-worklet.js 顶部。
  const proc = new AudioWorkletNode(ctx, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { frameSamples: Math.round((ctx.sampleRate * FRAME_MS) / 1000) },
  });

  let acknowledgeFlush: (() => void) | null = null;
  proc.port.onmessage = ({ data }) => {
    if (data.type === 'flushed') {
      acknowledgeFlush?.();
      return;
    }
    if (data.type === 'pcm') {
      cb.onChunk(data.pcm as ArrayBuffer);
      if (cb.onLevel) {
        const floor = -60;
        const db = data.rms > 0 ? 20 * Math.log10(data.rms) : floor;
        cb.onLevel(Math.max(0, Math.min(1, (db - floor) / -floor)));
      }
    }
  };

  mixer.connect(proc);
  // ④ worklet 输出的是静音，但不 connect 到 destination 它根本不会被调度 ——
  //    表现是「没报错、也没有任何数据」，是这套里最难查的一个坑。
  proc.connect(ctx.destination);
  await ctx.resume();

  // 用户在系统的「停止共享」浮条上点了停止 —— 这条路径必须接住，
  // 否则录音会静默地录出一段空白而不是停下来。
  streams.forEach(({ stream }) =>
    stream.getAudioTracks().forEach((t) => {
      t.onended = () => cb.onError?.(new Error('音频来源被系统停止（可能点了「停止共享」）'));
    }),
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    nodes.forEach((n) => n.disconnect());
    mixer.disconnect();
    streams.forEach(({ stream }) => stream.getTracks().forEach((t) => t.stop()));
    if (ctx.state === 'running') {
      // 把最后不满一帧的样本要出来，否则每次录音都会丢掉末尾 <100ms
      await new Promise<void>((resolve) => {
        acknowledgeFlush = resolve;
        proc.port.postMessage('flush');
        setTimeout(resolve, 500);
      });
      acknowledgeFlush = null;
    }
    proc.disconnect();
    proc.port.close();
    if (ctx.state !== 'closed') await ctx.close();
  };

  return { activeSources: streams.map((s) => s.source), warnings, stop };
}
