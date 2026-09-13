import { useState } from 'react';

/**
 * 粘贴入库（DESIGN §4.0 通道 0）。
 *
 * 零风险、覆盖一切平台 —— 包括那些采集器还没做的。桌面端有了它，
 * 「池子里怎么加岗位」这个问题就不再需要命令行来回答。
 *
 * 只有 JD 正文是必填。公司和职位留空也能进，因为最常见的用法是
 * 在 BOSS 上看到一个岗位，全选复制，回来一粘 —— 那一刻你不想先填五个框。
 */
export function PasteJob(props: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [jdText, setJdText] = useState('');
  const [url, setUrl] = useState('');
  const [company, setCompany] = useState('');
  const [title, setTitle] = useState('');
  const [city, setCity] = useState('');
  const [salary, setSalary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.assit.pasteJob({
        jdText, url: url || undefined, company: company || undefined,
        title: title || undefined, city: city || undefined, salaryRaw: salary || undefined,
      });
      setDone(
        r.outcome === 'new_job' ? '已入库，是个新岗位'
          : r.outcome === 'unchanged' ? '这个岗位已经在池子里了，没有变化'
          : r.outcome === 'jd_changed' ? '这个岗位在池子里，但 JD 变了 —— 已存新版本'
          : '已更新已有岗位',
      );
      props.onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 style={{ flex: 1 }}>粘贴一个岗位</h2>
          <button onClick={props.onClose}>关闭</button>
        </div>
        <p className="faint">
          在招聘网站上全选复制 JD，粘到下面就行。<b>只有正文是必填</b> ——
          公司和职位留空也能进，解析器会尽量从正文里认。
        </p>

        {done ? (
          <>
            <div className="card good"><b>{done}</b></div>
            <div className="row">
              <button className="primary" onClick={() => { setDone(null); setJdText(''); setUrl(''); setCompany(''); setTitle(''); }}>
                再粘一个
              </button>
              <button onClick={props.onClose}>完成</button>
            </div>
          </>
        ) : (
          <>
            <textarea
              rows={14}
              style={{ width: '100%', fontFamily: 'inherit', lineHeight: 1.6 }}
              placeholder="把 JD 正文粘在这里…"
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <input style={{ minWidth: 240, flex: 1 }} placeholder="原始链接（可空，用来判断来源平台）" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <input placeholder="公司" value={company} onChange={(e) => setCompany(e.target.value)} />
              <input placeholder="职位" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input style={{ width: 90 }} placeholder="城市" value={city} onChange={(e) => setCity(e.target.value)} />
              <input style={{ width: 130 }} placeholder="薪资原文" value={salary} onChange={(e) => setSalary(e.target.value)} />
            </div>
            {error && <p className="err">{error}</p>}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" disabled={busy || !jdText.trim()} onClick={() => void submit()}>
                {busy ? '入库中…' : '入库'}
              </button>
              <span className="faint">同一份 JD 粘两次不会重复入库 —— 按内容去重。</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
