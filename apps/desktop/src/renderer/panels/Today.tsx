import { useEffect, useState } from 'react';
import type { TodaySummary } from '../../preload/index.js';

/**
 * 今日 = 动作清单，不是图表页。
 *
 * 每一条都必须点进去有明确下一步。M1 只做「新增高分岗位」这一张卡，
 * 外加几条真正需要你动手的提醒 —— 放了折线图的今日页，第三天就没人开了。
 */
export function Today(props: {
  onAlerts: (n: number) => void;
  onGoJobs: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [data, setData] = useState<TodaySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = (): void => {
    window.assit
      .today()
      .then((d) => {
        setData(d);
        setError(null);
        props.onAlerts(d.brokenSources.length + (d.unscored > 0 ? 1 : 0));
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(load, []);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    try {
      await fn();
      load();
      props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="card bad"><span className="err">{error}</span></div>;
  if (!data) return <p className="spin">读取中…</p>;

  const nothingToDo =
    data.newToday === 0 &&
    data.unscored === 0 &&
    data.brokenSources.length === 0 &&
    data.pendingAliases === 0;

  return (
    <>
      <div className="page-head">
        <h1>今日</h1>
      </div>
      <p className="sub">只列需要你动手的事。</p>

      <div className="card">
        <h2>新增高分岗位</h2>
        <div className="row" style={{ alignItems: 'flex-end', gap: 20 }}>
          <div>
            <div className="big">{data.newHighScore}</div>
            <div className="muted">
              24 小时内新增且 ≥ {data.highScoreThreshold} 分
            </div>
          </div>
          <div className="faint">共新增 {data.newToday} 个</div>
          <div className="spacer" />
          <button
            disabled={busy !== null}
            onClick={() => void run('collect', () => window.assit.collect())}
          >
            {busy === 'collect' ? '采集中…' : '采集'}
          </button>
          <button
            className="primary"
            disabled={busy !== null}
            onClick={() => void run('score', () => window.assit.score())}
          >
            {busy === 'score' ? '打分中…' : '打分'}
          </button>
        </div>

        {data.topNew.length > 0 && (
          <table style={{ marginTop: 14 }}>
            <tbody>
              {data.topNew.map((j) => (
                <tr key={j.jobId} onClick={props.onGoJobs}>
                  <td className="num" style={{ width: 48 }}>
                    <span className="score">{j.finalScore}</span>
                  </td>
                  <td>
                    {j.company} · {j.title}
                    <div className="faint">
                      {[j.city, j.salaryRaw ?? '薪资未披露'].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="num">
                    {j.coverage !== null && j.coverage < 0.5 && (
                      <span className="tag warn">低置信 {Math.round(j.coverage * 100)}%</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.unscored > 0 && (
        <div className="card warn">
          <h2>{data.unscored} 个岗位还没打分</h2>
          <p className="muted" style={{ margin: '0 0 10px' }}>
            采集之后没跑过打分，或者你改了 rubric —— 改了规则之后旧分数不可比，
            要重算一遍才对得上账。
          </p>
          <button
            disabled={busy !== null}
            onClick={() => void run('score', () => window.assit.score())}
          >
            {busy === 'score' ? '打分中…' : '现在打分'}
          </button>
        </div>
      )}

      {data.brokenSources.length > 0 && (
        <div className="card bad">
          <h2>采集源异常</h2>
          <p className="muted" style={{ margin: '0 0 10px' }}>
            连续失败 ≥3 通常意味着对方改版了。别硬猜页面结构 —— 去看一眼再改采集器。
          </p>
          {data.brokenSources.map((s) => (
            <div key={s.sourceId} style={{ marginBottom: 6 }}>
              <code>{s.sourceId}</code>{' '}
              <span className="tag bad">连续失败 {s.consecutiveFailures}</span>
              {s.lastError && <div className="faint mono">{s.lastError.slice(0, 160)}</div>}
            </div>
          ))}
        </div>
      )}

      {data.pendingAliases > 0 && (
        <div className="card warn">
          <h2>{data.pendingAliases} 个公司别名待确认</h2>
          <p className="muted" style={{ margin: 0 }}>
            系统按指纹把它们归并到了已有公司名下。指纹会猜错，
            而猜错的后果是两家不同的公司被合成一家、岗位去重跟着错。
            <br />
            <span className="faint">
              公司归并的人工确认界面还没做 —— 在那之前，同一家公司的不同写法可能被当成两家。
            </span>
          </p>
        </div>
      )}

      {nothingToDo && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            没有待办。
            {data.newToday === 0 && ' 今天还没有新岗位 —— 去岗位池点「采集」，或者「粘贴岗位」贴一份进来。'}
          </p>
        </div>
      )}
    </>
  );
}
