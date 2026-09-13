import { useCallback, useEffect, useState } from 'react';
import type { AppContext } from '../preload/index.js';
import { Apply } from './panels/Apply.js';
import { Drill } from './panels/Drill.js';
import { Facts } from './panels/Facts.js';
import { Interview } from './panels/Interview.js';
import { JobPool } from './panels/JobPool.js';
import { Today } from './panels/Today.js';

type PanelId = 'today' | 'jobs' | 'apply' | 'facts' | 'interview' | 'drill';

/**
 * 六个面板是最终形态，但按阶段落地（见 docs/DESIGN.md §14）。
 * 没做的明着灰在这里，而不是假装存在然后点进去是个空页 ——
 * 你自己用这个工具，骗自己没有意义。
 */
export function App(): JSX.Element {
  const [panel, setPanel] = useState<PanelId>('today');
  const [ctx, setCtx] = useState<AppContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState(0);
  const [recording, setRecording] = useState(false);
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
          <button
            className={`nav-item ${panel === 'apply' ? 'active' : ''}`}
            onClick={() => setPanel('apply')}
          >
            <span>投递管线</span>
          </button>
          <button
            className={`nav-item ${panel === 'facts' ? 'active' : ''}`}
            onClick={() => setPanel('facts')}
          >
            <span>事实库 & 简历</span>
            {ctx && !ctx.factsOk && <span className="nav-badge">{ctx.factsErrors}</span>}
          </button>
          <button
            className={`nav-item ${panel === 'interview' ? 'active' : ''}`}
            onClick={() => setPanel('interview')}
          >
            <span>面试录音</span>
            {/*
              录制中的红点是全局的，不只在那一页。
              一个你忘了它在录的录音器是个事故 —— DESIGN §13.3。
            */}
            {recording && <span className="rec-dot" title="正在录制" />}
          </button>
          <button
            className={`nav-item ${panel === 'drill' ? 'active' : ''}`}
            onClick={() => setPanel('drill')}
          >
            <span>题库 & 复习</span>
          </button>

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
        {/*
          面试录音刻意不带 key={reloadKey}：其它面板重挂一次只是重新查一遍库，
          这一个重挂会**把正在进行的录音打断**。
        */}
        {panel === 'apply' && <Apply key={`a${reloadKey}`} />}
        {panel === 'interview' && <Interview onRecordingChange={setRecording} />}
        {panel === 'facts' && <Facts key={`f${reloadKey}`} onChanged={refreshAll} />}
        {panel === 'drill' && <Drill key={`d${reloadKey}`} />}
      </main>
    </div>
  );
}
