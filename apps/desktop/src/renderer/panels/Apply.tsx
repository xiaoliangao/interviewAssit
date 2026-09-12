import { useCallback, useEffect, useState } from 'react';
import type { AppSnapshot, FunnelBucket, PipelineRow } from '../../preload/index.js';

/**
 * 投递管线（DESIGN §7.1）。
 *
 * 这一屏刻意**不能从这里投递**。它记录你已经投出去的那一次，并把当时
 * 发出的四份东西冻结下来。一个「点一下就投」的按钮会让这个工具变成
 * 另一种东西 —— 那条线在 §13.1。
 */

const DIMS: { id: 'score' | 'channel' | 'role'; label: string }[] = [
  { id: 'score', label: '按分数段' },
  { id: 'channel', label: '按渠道' },
  { id: 'role', label: '按职能' },
];

export function Apply(): JSX.Element {
  const [rows, setRows] = useState<PipelineRow[] | null>(null);
  const [dim, setDim] = useState<'score' | 'channel' | 'role'>('score');
  const [buckets, setBuckets] = useState<FunnelBucket[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [snap, setSnap] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.assit.applyPipeline().then(setRows).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    window.assit.applyFunnel(dim).then(setBuckets).catch(() => undefined);
  }, [dim, rows]);

  useEffect(() => {
    if (!openId) { setSnap(null); return; }
    window.assit.applySnapshot(openId).then(setSnap).catch((e: Error) => setError(e.message));
  }, [openId]);

  const maxSent = Math.max(1, ...buckets.map((b) => b.sent));

  return (
    <>
      <div className="page-head">
        <h1>投递管线</h1>
        <span className="muted">{rows ? `${rows.length} 条` : ''}</span>
      </div>
      <p className="sub">
        这一屏不能投递 —— 它记录你已经投出去的那一次，并冻结当时发出的简历、JD、话术和表单。
      </p>

      {error && <p className="err">{error}</p>}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>漏斗</h2>
          {DIMS.map((d) => (
            <button key={d.id} className={dim === d.id ? 'primary' : ''} onClick={() => setDim(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
        {buckets.length === 0 ? (
          <p className="faint" style={{ marginBottom: 0 }}>还没有投递记录。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>分组</th>
                <th className="num">投出</th>
                <th className="num">回复</th>
                <th className="num">面试</th>
                <th className="num">offer</th>
                <th>回复率</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key} style={{ cursor: 'default' }}>
                  <td>{b.label}</td>
                  <td className="num">
                    <div className="bar" style={{ width: `${(b.sent / maxSent) * 100}%` }} />
                    {b.sent}
                  </td>
                  <td className="num">{b.replied}</td>
                  <td className="num">{b.interviewed}</td>
                  <td className="num">{b.offered}</td>
                  <td>
                    {b.replyRate === null ? (
                      <span className="faint" title="样本少于 5，比率没有信息量">样本不足</span>
                    ) : (
                      <b>{Math.round(b.replyRate * 100)}%</b>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="faint" style={{ marginBottom: 0 }}>
          样本少于 5 不给比率：<b>3 投 1 回不是 33%，是「还不知道」</b>——
          而那个数字会让你真的据此改策略。
        </p>
      </div>

      <div className="card">
        <h2>投递记录</h2>
        {rows === null ? (
          <p className="spin">读取中…</p>
        ) : rows.length === 0 ? (
          <div className="empty">
            还没有投递记录。投完一家之后在命令行跑：
            <code>assit apply &lt;postingId&gt; --confirm --resume &lt;pdf&gt;</code>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>投出时间</th>
                <th className="num">天前</th>
                <th className="num">分数</th>
                <th>状态</th>
                <th>公司 · 职位</th>
                <th>渠道</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)}>
                  <td className="muted">{r.sentAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="num">{r.daysSince}</td>
                  <td className="num"><span className="score">{r.finalScore ?? '—'}</span></td>
                  <td>
                    <span className="tag">{r.status}</span>
                    {r.unconfirmedEvents > 0 && (
                      <span className="tag warn" title="邮件解析出来的事件，要你点过才算数">
                        {r.unconfirmedEvents} 条待确认
                      </span>
                    )}
                  </td>
                  <td>{r.company} · {r.title}</td>
                  <td className="muted">{r.channel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openId && (
        <div className="drawer-backdrop" onClick={() => setOpenId(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h2 style={{ flex: 1 }}>当时发出去的东西</h2>
              <button onClick={() => setOpenId(null)}>关闭</button>
            </div>
            {!snap ? (
              <p className="spin">读取中…</p>
            ) : (
              <>
                <div className="card">
                  <div className="comp">
                    <span className="name">简历</span>
                    <span className="val">{snap.hasResume ? `${Math.round(snap.resumeBytes / 1024)} KB` : '—'}</span>
                    <span className="muted">
                      {snap.hasResume ? '投递时实际发出的那一份，不是「当前版本」' : '文件读不到了'}
                    </span>
                  </div>
                  <div className="comp">
                    <span className="name">话术</span>
                    <span className="val" />
                    <span className="muted">{snap.greeting ?? <span className="faint">没有</span>}</span>
                  </div>
                  {snap.forms.map((f, i) => (
                    <div key={i} className="comp">
                      <span className="name">表单</span>
                      <span className="val faint">{f.domain}</span>
                      <span className="mono faint">{JSON.stringify(f.data).slice(0, 240)}</span>
                    </div>
                  ))}
                </div>
                <div className="card">
                  <h2>投递时的 JD</h2>
                  <p className="faint" style={{ marginTop: 0 }}>
                    岗位上线的 JD 可能早改了。面试准备要基于<b>你投递时看到的那份</b>。
                  </p>
                  <div className="jd">{snap.jd ?? '(存档读不到了)'}</div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
