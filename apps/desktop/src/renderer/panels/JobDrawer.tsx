import { useEffect, useState } from 'react';
import type { JobDetail } from '../../preload/index.js';

const DIM_LABEL: Record<string, string> = {
  core_stack: '技术栈',
  experience: '经验年限',
  salary: '薪资',
  location: '城市',
  schedule: '作息',
  company: '公司性质',
};

/**
 * 一个岗位的完整打分证据。
 *
 * 这一屏是整个岗位池存在的理由：分数本身没有意义，
 * 「凭什么是这个分」才有。每一项要么能指回 JD 原文，要么标明是算出来的。
 */
export function JobDrawer(props: { jobId: string; onClose: () => void }): JSX.Element {
  const [d, setD] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showJd, setShowJd] = useState(false);

  useEffect(() => {
    window.assit.jobDetail(props.jobId).then(setD).catch((e: Error) => setError(e.message));
  }, [props.jobId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const t = d?.trace ?? null;

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        {error && <p className="err">{error}</p>}
        {!d && !error && <p className="spin">读取中…</p>}

        {d && (
          <>
            <div className="row">
              <div style={{ flex: 1 }}>
                <h2>{d.title}</h2>
                <div className="muted">
                  {[d.company, d.city, d.salaryRaw ?? '薪资未披露'].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button onClick={props.onClose}>关闭</button>
            </div>

            {d.urls.length > 0 && (
              <p style={{ marginTop: 10 }}>
                {d.urls.map((u) => (
                  <button
                    key={u}
                    style={{ marginRight: 6 }}
                    onClick={() => void window.assit.openExternal(u)}
                  >
                    在浏览器打开
                  </button>
                ))}
              </p>
            )}

            {!t ? (
              <div className="card warn" style={{ marginTop: 14 }}>
                这个岗位还没有当前 rubric / profile 下的分数。回岗位池点「打分」。
              </div>
            ) : (
              <>
                <div className="card" style={{ marginTop: 14 }}>
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <span className="big">{t.final_score}</span>
                    <span className="muted">
                      原始分 {t.raw_score}
                      {t.capped_by && ` → 被「${t.capped_by}」封顶`}
                    </span>
                    <div className="spacer" />
                    <span className="faint mono">
                      覆盖 {Math.round(t.coverage * 100)}% · rubric@{t.rubric_version}
                    </span>
                  </div>

                  {t.caps.filter((c) => c !== t.capped_by).length > 0 && (
                    <p className="faint" style={{ marginBottom: 0 }}>
                      触发但未影响分数：{t.caps.filter((c) => c !== t.capped_by).join('、')}
                      　—— 条件确实成立，只是分数本来就更低
                    </p>
                  )}
                </div>

                <div className="card">
                  <h2>逐项证据</h2>
                  {Object.entries(t.components).map(([dim, c]) => (
                    <div key={dim} className="comp">
                      <span className="name">{DIM_LABEL[dim] ?? dim}</span>
                      <span className="val">
                        {c.score}/{c.max_score}
                      </span>
                      <span>
                        {c.evidence}
                        {c.jd_quote ? (
                          <div className="quote">JD 原文：「{c.jd_quote}」</div>
                        ) : (
                          <div className="quote">算出来的，不是 JD 原文</div>
                        )}
                      </span>
                    </div>
                  ))}
                  {t.unknown_dims.map((dim) => (
                    <div key={dim} className="comp">
                      <span className="name faint">{DIM_LABEL[dim] ?? dim}</span>
                      <span className="val faint">—</span>
                      <span className="faint">未披露，不计入分母</span>
                    </div>
                  ))}
                </div>

                {t.gates.length > 0 && (
                  <div className="card">
                    <h2>硬门槛</h2>
                    <p className="faint" style={{ marginTop: 0 }}>
                      没过不淘汰，只沉底 —— JD 的门槛常常是虚标的。
                    </p>
                    {t.gates.map((g) => (
                      <div key={g.key} className="comp">
                        <span className="name">{g.key}</span>
                        <span className="val">
                          {g.status === 'pass' ? (
                            <span className="tag good">通过</span>
                          ) : g.status === 'fail' ? (
                            <span className="tag bad">未过</span>
                          ) : (
                            <span className="tag">未知</span>
                          )}
                        </span>
                        <span className="muted">{g.detail}</span>
                      </div>
                    ))}
                  </div>
                )}

                {t.injection_flags.length > 0 && (
                  <div className="card bad">
                    <h2>JD 里检出可疑指令性文本</h2>
                    <p className="mono">{t.injection_flags.join(' / ')}</p>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      已打标但**没有**改分数。自动降分反而会被用来攻击竞品岗位的排序。
                    </p>
                  </div>
                )}
              </>
            )}

            <div className="card">
              <h2>挂牌与 JD 版本</h2>
              {d.postings.map((p, i) => (
                <div key={i} className="comp">
                  <span className="name">{p.platform}</span>
                  <span className="val faint">{p.jdVersions} 版</span>
                  <span className="muted">
                    {p.collectedAt} · {p.collectedBy ?? '—'}
                  </span>
                </div>
              ))}
              {d.jdVersions > 1 && (
                <p className="faint" style={{ marginBottom: 0 }}>
                  这个岗位的 JD 改过 {d.jdVersions - 1} 次。每一版都存档了 —— 改动本身是个信号。
                </p>
              )}
            </div>

            <div className="card">
              <div className="row">
                <h2 style={{ margin: 0 }}>JD 原文</h2>
                <span className="faint mono">{d.jdSha256?.slice(0, 12)}</span>
                <div className="spacer" />
                <button onClick={() => setShowJd((s) => !s)}>{showJd ? '收起' : '展开'}</button>
              </div>
              {showJd &&
                (d.jdText ? (
                  <div className="jd" style={{ marginTop: 10 }}>
                    {d.jdText}
                  </div>
                ) : (
                  <p className="faint" style={{ marginBottom: 0 }}>
                    存档读不到了（文件被删或路径变了）。分数仍然可查，因为它存的是 trace 不是原文。
                  </p>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
