import { useCallback, useEffect, useState } from 'react';
import type { AppContext } from '../preload/index.js';
import { Apply } from './panels/Apply.js';
import { Drill } from './panels/Drill.js';
import { Facts } from './panels/Facts.js';
import { Settings } from './panels/Settings.js';
import { Interview } from './panels/Interview.js';
import { JobPool } from './panels/JobPool.js';
import { Today } from './panels/Today.js';

type PanelId = 'today' | 'jobs' | 'apply' | 'facts' | 'interview' | 'drill' | 'settings';

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

          <div className="spacer" />
          <button
            className={`nav-item ${panel === 'settings' ? 'active' : ''}`}
            onClick={() => setPanel('settings')}
          >
            <span>设置</span>
          </button>
        </nav>

        {/*
          左下角只留「还差什么」这一件事。
          原来那块堆的是 rubric/profile 版本和数据目录 —— 那是**运营与配置数据**，
          现在在设置页。一个你每天都看见但几乎从不需要的角落，
          不如用来显示唯一一件需要你行动的事。
        */}
        <div className="ctx">
          {ctxError ? (
            <span className="err">{ctxError}</span>
          ) : ctx ? (
            ctx.factsOk && ctx.rubricVersion ? (
              <span className="faint">档案与打分规则就绪</span>
            ) : (
              <button className="todo" onClick={() => setPanel(ctx.factsOk ? 'settings' : 'facts')}>
                {!ctx.factsOk && <div><span className="tag bad">{ctx.factsErrors}</span> 项必填还没写</div>}
                {!ctx.rubricVersion && <div><span className="tag bad">!</span> 打分规则不可用</div>}
                <div className="faint">点这里去处理</div>
              </button>
            )
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
        {panel === 'settings' && <Settings ctx={ctx} />}
      </main>
    </div>
  );
}
