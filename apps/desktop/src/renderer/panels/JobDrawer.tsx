import { useEffect, useState } from 'react';
import type { JobDetail, Preflight } from '../../preload/index.js';

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
  const [applying, setApplying] = useState(false);
  const [pre, setPre] = useState<Preflight | null>(null);
  const [resumePath, setResumePath] = useState<string | null>(null);
  const [greeting, setGreeting] = useState('');
  const [override, setOverride] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

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

            <p style={{ marginTop: 10 }}>
              {d.urls.map((u) => (
                <button key={u} style={{ marginRight: 6 }} onClick={() => void window.assit.openExternal(u)}>
                  在浏览器打开
                </button>
              ))}
              {!d.applied && !applying && d.postingId && (
                <button
                  className="primary"
                  onClick={() => {
                    setApplying(true);
                    window.assit.applyPreflight(d.postingId!).then(setPre).catch((e: Error) => setError(e.message));
                  }}
                >
                  我已投递
                </button>
              )}
              {d.applied && <span className="tag good">已投</span>}
            </p>

            {applying && (
              <div className="card">
                <h2>记录这次投递</h2>
                {applied ? (
                  <>
                    <p><b>{applied}</b></p>
                    <p className="faint" style={{ marginBottom: 0 }}>
                      当时发出的简历、JD、话术已经冻结下来。一个月后 HR 约你面试时，
                      JD 可能早改了 —— 面试准备要基于<b>你投递时看到的那份</b>。
                    </p>
                  </>
                ) : (
                  <>
                    <p className="faint" style={{ marginTop: 0 }}>
                      这一步<b>不会替你投递</b>，它记录你已经投出去的那一次，
                      并把当时发出的东西冻结下来。
                    </p>
                    {pre?.alreadyApplied && (
                      <p className="err">这个岗位已经投过了（{pre.alreadyApplied.sentAt.slice(0, 10)}）。</p>
                    )}
                    {pre?.cooldown.blocked && (
                      <div className="card warn">
                        {pre.cooldown.reason}
                        <label className="chk" style={{ marginTop: 6 }}>
                          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                          还是要投（换了部门、换了方向都可能是对的，但这该是你想过之后的决定）
                        </label>
                      </div>
                    )}
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <button
                        onClick={() => {
                          void window.assit.pickFile({ title: '选择你实际发出去的那份简历', extensions: ['pdf'] })
                            .then((p) => p && setResumePath(p));
                        }}
                      >
                        {resumePath ? '换一份简历' : '选择实际发出的简历 PDF'}
                      </button>
                      <span className="faint">
                        {resumePath ? resumePath.split('/').pop() : '必选 —— 没有快照的投递记录三个月后什么也还原不出来'}
                      </span>
                    </div>
                    <textarea
                      rows={3}
                      style={{ width: '100%', marginTop: 8 }}
                      placeholder="实际发出的打招呼话术（可空）"
                      value={greeting}
                      onChange={(e) => setGreeting(e.target.value)}
                    />
                    <div className="row" style={{ marginTop: 8 }}>
                      <button
                        className="primary"
                        disabled={!resumePath || Boolean(pre?.alreadyApplied) || (pre?.cooldown.blocked && !override)}
                        onClick={() => {
                          void window.assit
                            .applyRecord({
                              postingId: d.postingId!,
                              channel: d.applyChannel ?? 'chat',
                              resumePath: resumePath!,
                              greeting: greeting || undefined,
                              overrideCooldown: override,
                            })
                            .then((r) => setApplied(`已记录，冻结了 ${r.snapshots.length} 份快照`))
                            .catch((e: Error) => setError(e.message));
                        }}
                      >
                        确认已投递
                      </button>
                      <button onClick={() => { setApplying(false); setPre(null); }}>取消</button>
                    </div>
                  </>
                )}
              </div>
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
