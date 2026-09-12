/**
 * 把 Web Audio 的 float32 流切成定长 PCM16 帧。
 *
 * 为什么是 AudioWorklet 而不是 ScriptProcessorNode：后者已废弃，
 * 而且跑在**主线程**上 —— Electron 里 React 一次重渲染就可能让它丢帧。
 * 录音丢帧是不可逆的，这一条没有折中余地。
 *
 * 这个 processor 的输出恒为静音：采到的声音绝不在本机外放，
 * 否则会形成「系统音频 → 扬声器 → 又被系统音频采到」的回环。
 * 但它仍然必须被 connect 到 destination，否则不会被调度 —— 见 capture.ts。
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.frameSamples = opts.frameSamples || 1600; // 16kHz 下约 100ms
    this.buf = new Float32Array(this.frameSamples);
    this.used = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  flush() {
    if (this.used === 0) return;
    this.emit(this.buf.subarray(0, this.used));
    this.used = 0;
  }

  emit(samples) {
    const pcm = new Int16Array(samples.length);
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      // 先夹再转。不夹的话响一点的地方会整数溢出，听起来是爆音。
      const v = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      sumSq += v * v;
    }
    const rms = samples.length ? Math.sqrt(sumSq / samples.length) : 0;
    // transfer 掉 buffer，避免每帧复制一份
    this.port.postMessage({ type: 'pcm', pcm: pcm.buffer, rms }, [pcm.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.used++] = ch[i];
      if (this.used === this.frameSamples) {
        this.emit(this.buf);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
