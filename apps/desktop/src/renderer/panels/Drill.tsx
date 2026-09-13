import { useCallback, useEffect, useState } from 'react';
import type { ClaimDrillStat, DrillBoard, DueQuestion } from '../../preload/index.js';

/**
 * 题库与复习（DESIGN §9）。
 *
 * 回答的唯一问题是「今天刷哪些」。所以到期清单排最前，
 * 看板和错题本在下面 —— 它们是用来解释「为什么是这些」的，不是主角。
 */

const GRADES: { g: number; label: string; hint: string }[] = [
  { g: 5, label: '答得很顺', hint: '下次会隔很久再见到' },
  { g: 4, label: '答上来了', hint: '' },
  { g: 3, label: '勉强想起来', hint: '' },
  { g: 2, label: '没答上来', hint: '明天还来' },
  { g: 0, label: '完全不会', hint: '明天还来，且难度画像会下调' },
];

const CRED: Record<string, { label: string; cls: string }> = {
  verified: { label: '真题', cls: 'good' },
  secondhand: { label: '二手', cls: 'warn' },
  unverified: { label: '未核实', cls: '' },
};

export function Drill(): JSX.Element {
  const [due, setDue] = useState<DueQuestion[] | null>(null);
  const [board, setBoard] = useState<DrillBoard | null>(null);
  const [claims, setClaims] = useState<ClaimDrillStat[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [nq, setNq] = useState({ content: '', topic: '', sourceType: 'real_interview', sourceRef: '' });

  const load = useCallback(() => {
    window.assit.drillDue(50).then((r) => { setDue(r); setIdx(0); setRevealed(false); })
      .catch((e: Error) => setError(e.message));
    window.assit.drillBoard().then(setBoard).catch(() => undefined);
    window.assit.drillClaims().then(setClaims).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const current = due?.[idx] ?? null;

  const grade = async (g: number): Promise<void> => {
    if (!current) return;
    try {
      const r = await window.assit.drillGrade(current.id, g);
      setLast(`下次 ${r.dueInDays} 天后（${r.nextReviewAt.slice(0, 10)}）`);
      setRevealed(false);
      if (idx + 1 < (due?.length ?? 0)) setIdx(idx + 1);
      else load();
      window.assit.drillBoard().then(setBoard).catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>题库 & 复习</h1>
        {board && <span className="muted">今天到期 {board.dueNow} / 共 {board.total}</span>}
        <div className="spacer" />
        <button onClick={() => setAdding(true)}>加一道题</button>
      </div>
      <p className="sub">真实面试答错的题排最前，而且重复得更密 —— 那是有人真的拿它筛过你。</p>

      {error && <p className="err">{error}</p>}

      <div className="card">
        {due === null ? (
          <p className="spin">读取中…</p>
        ) : !current ? (
          <div className="empty">
            {board?.total === 0
              ? <>题库是空的。点右上角<b>「加一道题」</b>。</>
              : <>今天的题都过完了。{last && <span className="faint"> {last}</span>}</>}
          </div>
        ) : (
          <>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <span className={`tag ${CRED[current.credibility]?.cls ?? ''}`}>
                {CRED[current.credibility]?.label ?? current.credibility}
              </span>
              {current.topic && <span className="tag">{current.topic}</span>}
              {current.origin === 'real_interview' && <span className="tag bad">真实面试</span>}
              <div className="spacer" />
              <span className="faint">{idx + 1} / {due.length}　复习过 {current.repetitions} 次</span>
            </div>

            <p className="big" style={{ margin: '14px 0', lineHeight: 1.5 }}>{current.content}</p>
            <p className="faint">来源：{current.sourceRef}</p>

            {!revealed ? (
              <button className="primary" onClick={() => setRevealed(true)}>看答案</button>
            ) : (
              <>
                <div className="card" style={{ background: '#fafbfc' }}>
                  <h2>标准答案</h2>
                  <div className="jd">{current.answerStandard ?? '（还没写）'}</div>
                  <h2 style={{ marginTop: 14 }}>我的答法</h2>
                  <div className="jd">
                    {current.answerMine ?? '（还没写。接上自己的 claim，面试时讲的才是你做过的事）'}
                  </div>
                </div>
                <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                  {GRADES.map((g) => (
                    <button
                      key={g.g}
                      className={g.g >= 4 ? 'primary' : ''}
                      title={g.hint}
                      onClick={() => void grade(g.g)}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
                <p className="faint" style={{ marginBottom: 0 }}>
                  自评由你填。低于「勉强想起来」算没答上来：重复次数归零，明天还来，
                  但<b>难度画像不会被一次失手抹掉</b>。
                </p>
              </>
            )}
          </>
        )}
      </div>

      {adding && (
        <div className="drawer-backdrop" onClick={() => setAdding(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="row"><h2 style={{ flex: 1 }}>加一道题</h2><button onClick={() => setAdding(false)}>关闭</button></div>
            <p className="faint">
              <b>来源必填。</b>「这题哪来的」决定了你该花多少时间在它上面 ——
              一道大厂真题和一道不知哪抄来的题，复习优先级不一样。
              没有来源的题进了库就再也分不清。
            </p>
            <textarea rows={5} style={{ width: '100%' }} placeholder="题目"
              value={nq.content} onChange={(e) => setNq({ ...nq, content: e.target.value })} />
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <select value={nq.sourceType} onChange={(e) => setNq({ ...nq, sourceType: e.target.value })}>
                <option value="real_interview">我面到的真题</option>
                <option value="manual">手动录入的面经</option>
                <option value="web_scrape">网上看到的</option>
                <option value="official_doc">官方文档</option>
              </select>
              <input style={{ minWidth: 220, flex: 1 }} placeholder="来源 *（如「2026-09-12 某某科技一面」或链接）"
                value={nq.sourceRef} onChange={(e) => setNq({ ...nq, sourceRef: e.target.value })} />
              <input style={{ width: 120 }} placeholder="主题（MySQL）"
                value={nq.topic} onChange={(e) => setNq({ ...nq, topic: e.target.value })} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" disabled={!nq.content.trim() || !nq.sourceRef.trim()}
                onClick={() => {
                  void window.assit.drillAdd(nq)
                    .then((r) => {
                      setLast(r.created ? '已加入题库' : r.upgraded ? '这题已有，可信度提升了' : '这题已经在库里了');
                      setNq({ content: '', topic: '', sourceType: nq.sourceType, sourceRef: nq.sourceRef });
                      load();
                    })
                    .catch((e: Error) => setError(e.message));
                }}>
                加入题库
              </button>
              <span className="faint">真题默认标「已核实」，网上抄的默认「未核实」。</span>
            </div>
          </div>
        </div>
      )}

      {board && board.weakest.length > 0 && (
        <div className="card">
          <h2>错题本</h2>
          <p className="faint" style={{ marginTop: 0 }}>真实面试答错的排最前。</p>
          {board.weakest.slice(0, 12).map((w) => (
            <div key={w.id} className="comp">
              <span className="name">
                {w.origin === 'real_interview' ? <span className="tag bad">真题</span> : <span className="tag">刷题</span>}
              </span>
              <span className="val faint">{w.lastGrade}</span>
              <span>{w.content.slice(0, 80)}</span>
            </div>
          ))}
        </div>
      )}

      {claims.length > 0 && (
        <div className="card">
          <h2>主张被追问的历史</h2>
          <p className="faint" style={{ marginTop: 0 }}>
            简历上哪几条你其实讲不清楚 —— 那正是下一场最该准备的。
            <b>「问过 0 次」也值得注意</b>：没被追问过的主张，可信度没有被验证过。
          </p>
          <table>
            <thead>
              <tr>
                <th className="num">问过</th>
                <th className="num">答住</th>
                <th className="num">答砸</th>
                <th>状态</th>
                <th>等级</th>
                <th>主张</th>
              </tr>
            </thead>
            <tbody>
              {claims.slice(0, 15).map((c) => (
                <tr key={c.claimId} style={{ cursor: 'default' }}>
                  <td className="num">{c.asked}</td>
                  <td className="num">{c.solid}</td>
                  <td className="num">
                    {c.failed > 0 ? <span className="tag bad">{c.failed}</span> : <span className="faint">0</span>}
                  </td>
                  <td><span className="tag">{c.status}</span></td>
                  <td className="muted">{c.level}</td>
                  <td>{c.fact.slice(0, 50)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {board && board.byTopic.length > 0 && (
        <div className="card">
          <h2>按主题</h2>
          <table>
            <thead><tr><th>主题</th><th className="num">总数</th><th className="num">到期</th></tr></thead>
            <tbody>
              {board.byTopic.map((t) => (
                <tr key={t.topic} style={{ cursor: 'default' }}>
                  <td>{t.topic}</td>
                  <td className="num">{t.total}</td>
                  <td className="num">{t.due > 0 ? <b>{t.due}</b> : <span className="faint">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
