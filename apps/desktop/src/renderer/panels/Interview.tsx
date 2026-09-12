import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobRow, RecordingRow } from '../../preload/index.js';
import { startCapture, type CaptureHandle, type CaptureMode } from '../audio/capture.js';

/**
 * 面试录音（DESIGN §8.5）。
 *
 * 这一屏刻意只有「录」和「历史」两件事，没有实时转写、没有实时提示。
 * 理由写在 DESIGN 里：面试当下不该有一个正在解析你对话的东西在跑。
 * 转写是面试结束之后、在本地慢慢做的事。
 */

const MODES: { id: CaptureMode; label: string; hint: string }[] = [
  { id: 'mixed', label: '双方', hint: '系统音频 + 麦克风。线上面试用这个' },
  { id: 'system', label: '只录对方', hint: '只要系统音频' },
  { id: 'microphone', label: '只录自己', hint: '线下面试把手机/电脑放桌上' },
];

function fmtDur(sec: number): string {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtBytes(n: number): string {
  return n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export function Interview(props: { onRecordingChange: (on: boolean) => void }): JSX.Element {
  const [mode, setMode] = useState<CaptureMode>('mixed');
  const [label, setLabel] = useState('');
  const [jobId, setJobId] = useState<string>('');
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [rows, setRows] = useState<RecordingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);

  const [recId, setRecId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const capture = useRef<CaptureHandle | null>(null);
  const startedAt = useRef<number>(0);

  const load = useCallback(() => {
    window.assit.recList().then(setRows).catch((e: Error) => setError(e.message));
    window.assit.jobs({ limit: 60 }).then(setJobs).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!recId) return;
    const t = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 500);
    return () => clearInterval(t);
  }, [recId]);

  // 录音期间禁止关窗口。不拦的话，一个不小心的 Cmd+W 就是一场面试。
  useEffect(() => {
    props.onRecordingChange(recId !== null);
    if (!recId) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [recId, props]);

  const stop = useCallback(async () => {
    const id = recId;
    if (!id) return;
    setRecId(null);
    setLevel(0);
    // 先停采集再停会话：反过来的话，最后几帧会打到一个已经关掉的 writer 上。
    await capture.current?.stop();
    capture.current = null;
    try {
      const r = await window.assit.recStop(id);
      setError(null);
      setWarnings([`已保存 ${fmtDur(r.durationSec)}（${fmtBytes(r.bytes)}）`]);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }, [recId, load]);

  const start = async (): Promise<void> => {
    setError(null);
    setWarnings([]);
    try {
      const handle = await window.assit.recStart({
        label: label.trim() || `面试 ${new Date().toLocaleString('zh-CN')}`,
        jobId: jobId || null,
        sources: mode,
      });
      startedAt.current = Date.now();
      setElapsed(0);
      setRecId(handle.id);
      capture.current = await startCapture(mode, {
        onChunk: (pcm) => window.assit.recChunk(handle.id, pcm),
        onLevel: setLevel,
        onError: (e) => setError(e.message),
      });
      setWarnings(capture.current.warnings);
      setLabel('');
      setConsent(false);
      load();
    } catch (e) {
      setError((e as Error).message);
      // 会话已经开了但采集没起来 —— 必须收掉，否则库里留一条永远 recording 的行
      if (capture.current) {
        await capture.current.stop();
        capture.current = null;
      }
      setRecId((id) => {
        if (id) void window.assit.recStop(id).catch(() => undefined);
        return null;
      });
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>面试录音</h1>
        {recId && <span className="tag bad">● 录制中 {fmtDur(elapsed)}</span>}
      </div>
      <p className="sub">
        录完自动落盘到本机，不上传、不实时转写。转写和分析是面试之后用本地模型做的事。
      </p>

      <div className={`card ${recId ? 'bad' : ''}`}>
        {recId ? (
          <>
            <div className="row" style={{ alignItems: 'center' }}>
              <span className="big" style={{ color: '#c0392b' }}>● {fmtDur(elapsed)}</span>
              <div style={{ flex: 1, maxWidth: 260 }}>
                <div className="meter">
                  <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
                <div className="faint">
                  {level < 0.02 ? '几乎没有声音 —— 确认一下音源选对了' : '有信号'}
                </div>
              </div>
              <div className="spacer" />
              <button className="primary" onClick={() => void stop()}>停止并保存</button>
            </div>
            <p className="faint" style={{ marginBottom: 0 }}>
              录制期间关窗口会被拦下。文件每 5 秒回写一次长度，就算崩了也能救回大部分。
            </p>
          </>
        ) : (
          <>
            <div className="row">
              <input
                placeholder="这场叫什么（不填按时间命名）"
                style={{ flex: 1, minWidth: 200 }}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">不关联岗位</option>
                {jobs.map((j) => (
                  <option key={j.jobId} value={j.jobId}>
                    {j.company} · {j.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={mode === m.id ? 'primary' : ''}
                  title={m.hint}
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
              <span className="faint">{MODES.find((m) => m.id === mode)?.hint}</span>
            </div>

            {/*
              同意确认**每场都要点一次**，刻意没有「记住我的选择」。
              对方每场都不一样，上一场同意了不代表这一场。
            */}
            <label className="consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                我已告知对方并取得同意。
                <span className="faint">
                  　部分法域要求双方同意；即使单方录音合法，未告知就拿去做 AI 分析仍有争议。
                  这一项每场都要重新确认。
                </span>
              </span>
            </label>

            <button className="primary" disabled={!consent} onClick={() => void start()}>
              开始录制
            </button>
            {mode !== 'microphone' && (
              <p className="faint" style={{ marginBottom: 0 }}>
                系统会弹出共享选择框 —— <b>必须勾上「共享音频」</b>，否则只能录到你自己。
                选完之后视频轨会被立刻关掉，不会真的录屏。
              </p>
            )}
          </>
        )}

        {error && <p className="err" style={{ marginBottom: 0 }}>{error}</p>}
        {warnings.map((w) => (
          <p key={w} className="faint" style={{ margin: '6px 0 0' }}>{w}</p>
        ))}
      </div>

      <div className="card">
        <h2>历史</h2>
        {rows === null ? (
          <p className="spin">读取中…</p>
        ) : rows.length === 0 ? (
          <div className="empty">还没有录音。面试结束当天录一段，比事后凭记忆写面经准得多。</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>名称</th>
                <th>音源</th>
                <th className="num">时长</th>
                <th className="num">大小</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ cursor: 'default' }}>
                  <td className="muted">{r.startedAt.slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    <div>{r.label}</div>
                    {r.error && <div className="faint">{r.error}</div>}
                  </td>
                  <td className="muted">{r.sources || '—'}</td>
                  <td className="num">{fmtDur(r.durationSec)}</td>
                  <td className="num muted">{fmtBytes(r.bytes)}</td>
                  <td>
                    {!r.fileExists ? (
                      <span className="tag">音频已删</span>
                    ) : r.keep ? (
                      <span className="tag good">永久保留</span>
                    ) : (
                      <span className="tag" title={`${r.purgeAfter?.slice(0, 10)} 后自动删除`}>
                        {r.purgeAfter?.slice(0, 10)} 到期
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {r.fileExists && (
                      <>
                        <button onClick={() => void window.assit.reveal(r.file!)}>定位文件</button>
                        <button
                          onClick={() => void window.assit.recKeep(r.id, !r.keep).then(load)}
                        >
                          {r.keep ? '取消保留' : '永久保留'}
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`删除「${r.label}」的音频？记录会保留，音频不可恢复。`)) {
                              void window.assit.recDeleteAudio(r.id).then(load);
                            }
                          }}
                        >
                          删音频
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="faint" style={{ marginBottom: 0 }}>
          默认 30 天后自动删除音频，<b>但那一行会留着</b> ——
          「哪天、哪个岗位、录了多久」不含任何音频内容，却正是复盘时唯一还需要的东西。
        </p>
      </div>
    </>
  );
}
