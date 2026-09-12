import { useCallback, useEffect, useState } from 'react';
import type { AppContext } from '../preload/index.js';
import { JobPool } from './panels/JobPool.js';
import { Today } from './panels/Today.js';

type PanelId = 'today' | 'jobs';

/**
 * 六个面板是最终形态，但按阶段落地（见 docs/DESIGN.md §14）。
 * 没做的明着灰在这里，而不是假装存在然后点进去是个空页 ——
 * 你自己用这个工具，骗自己没有意义。
 */
const PLANNED = [
  { id: 'apply', label: '投递管线', stage: 'M2' },
  { id: 'facts', label: '事实库 & 简历', stage: '按需（现在用 CLI）' },
  { id: 'interview', label: '面试训练', stage: 'M4' },
  { id: 'drill', label: '题库 & 复习', stage: 'M5' },
];

export function App(): JSX.Element {
  const [panel, setPanel] = useState<PanelId>('today');
  const [ctx, setCtx] = useState<AppContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const loadCtx = useCallback(() => {
    window.assit
      .context()
      .then((c) => {
        setCtx(c);
        setCtxError(null);
      })
      .catch((e: Error) => setCtxError(e.message));
  }, []);

  useEffect(loadCtx, [loadCtx, reloadKey]);

  const refreshAll = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div className="app">
      <aside className="sidebar">
        <nav>
          <button
            className={`nav-item ${panel === 'today' ? 'active' : ''}`}
            onClick={() => setPanel('today')}
          >
            <span>今日</span>
            {alerts > 0 && <span className="nav-badge">{alerts}</span>}
          </button>
          <button
            className={`nav-item ${panel === 'jobs' ? 'active' : ''}`}
            onClick={() => setPanel('jobs')}
          >
            <span>岗位池</span>
          </button>

          <div className="nav-section">尚未落地</div>
          {PLANNED.map((p) => (
            <div key={p.id} className="nav-item disabled" title={`计划在 ${p.stage}`}>
              <span>{p.label}</span>
              <span className="faint" style={{ fontSize: 10 }}>
                {p.stage}
              </span>
            </div>
          ))}
        </nav>

        <div className="ctx">
          {ctxError ? (
            <span className="err">{ctxError}</span>
          ) : ctx ? (
            <>
              <div>
                事实库 {ctx.factsOk ? <span className="tag good">正常</span> : <span className="tag bad">{ctx.factsErrors} 个错误</span>}
              </div>
              <div>主张 {ctx.claimCount} 条 · 采集源 {ctx.sourceCount} 个</div>
              <div>
                rubric{' '}
                {ctx.rubricVersion ? (
                  <code>{ctx.rubricVersion}</code>
                ) : (
                  <span className="tag bad">未配置</span>
                )}
              </div>
              <div>
                profile <code>{ctx.profileVersion.replace('facts-', '')}</code>
              </div>
              <div
                style={{ marginTop: 6, cursor: 'pointer' }}
                onClick={() => void window.assit.reveal(ctx.dbPath)}
                title="在访达中显示"
              >
                <code>{ctx.dataDir}</code>
              </div>
            </>
          ) : (
            <span className="spin">读取中…</span>
          )}
        </div>
      </aside>

      <main className="main">
        {ctx && !ctx.rubricVersion && (
          <div className="card bad">
            <h2>没有可用的打分规则</h2>
            <p className="muted" style={{ margin: 0 }}>
              {ctx.rubricError ?? '在 data/facts/rubric/ 下放一个 yaml。'}
              <br />
              命令行跑一次 <code>assit init</code> 会生成带注释的模板。
              岗位仍然可以采集入库，只是没有分数。
            </p>
          </div>
        )}

        {panel === 'today' && (
          <Today key={`t${reloadKey}`} onAlerts={setAlerts} onGoJobs={() => setPanel('jobs')} onChanged={refreshAll} />
        )}
        {panel === 'jobs' && <JobPool key={`j${reloadKey}`} onChanged={refreshAll} />}
      </main>
    </div>
  );
}
