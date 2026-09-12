import { useCallback, useEffect, useState } from 'react';
import type { Facets, JobFilter, JobRow, SourceHealth, SourceRunResult } from '../../preload/index.js';
import { JobDrawer } from './JobDrawer.js';

/**
 * 岗位池。
 *
 * 两个刻意的设计：
 *
 * 1. **排序不乘置信度。** coverage 低只打标记、可筛选，但不偷偷压排名 ——
 *    那等价于对 unknown 记负分，和「未知保持未知」自相矛盾。
 *    要不要因为「这家披露得少」少看它一眼，是你的判断。
 * 2. **采集源健康度就摆在这一页，不藏进设置。** 采集器坏掉是常态不是异常，
 *    你需要一眼看到「某个源已经 5 天没抓到东西了」。
 */
export function JobPool(props: { onChanged: () => void }): JSX.Element {
  const [rows, setRows] = useState<JobRow[] | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<SourceRunResult[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);

  const [filter, setFilter] = useState<JobFilter>({ limit: 200 });

  const load = useCallback(() => {
    window.assit.jobs(filter).then(setRows).catch((e: Error) => setError(e.message));
    window.assit.facets().then(setFacets).catch(() => undefined);
    window.assit.sources().then(setSources).catch(() => undefined);
  }, [filter]);

  useEffect(load, [load]);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      if (label === 'collect') setLastRun(r as SourceRunResult[]);
      load();
      props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const ignore = async (job: JobRow): Promise<void> => {
    const reason = window.prompt(
      `不投「${job.company} · ${job.title}」的原因？\n\n` +
        '这句话不是随手写的：assit rubric-review 会把它聚类，\n' +
        '告诉你 rubric 和你真实偏好差在哪。',
    );
    if (!reason?.trim()) return;
    await window.assit.ignore(job.jobId, reason.trim(), job.finalScore);
    load();
  };

  const broken = sources.filter((s) => s.consecutiveFailures > 0);

  return (
    <>
      <div className="page-head">
        <h1>岗位池</h1>
        <span className="muted">{rows ? `${rows.length} 个` : ''}</span>
      </div>
      <p className="sub">
        分数是「这个岗位对你合不合适」，不是「这个岗位好不好」。点任意一行看逐项证据。
      </p>

      <div className="card">
        <div className="row">
          <button disabled={busy !== null} onClick={() => void run('collect', () => window.assit.collect())}>
            {busy === 'collect' ? '采集中…' : '采集'}
          </button>
          <button
            className="primary"
            disabled={busy !== null}
            onClick={() => void run('score', () => window.assit.score())}
          >
            {busy === 'score' ? '打分中…' : '打分'}
          </button>
          <button
            disabled={busy !== null}
            title="改了 rubric 之后需要重算"
            onClick={() => void run('score', () => window.assit.score(true))}
          >
            重算全部
          </button>

          <div className="spacer" />

          <input
            placeholder="搜公司或职位"
            style={{ width: 170 }}
            onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value || undefined }))}
          />
          <select
            onChange={(e) =>
              setFilter((f) => ({ ...f, minScore: e.target.value ? Number(e.target.value) : undefined }))
            }
          >
            <option value="">全部分数</option>
            <option value="80">≥ 80</option>
            <option value="70">≥ 70</option>
            <option value="55">≥ 55</option>
          </select>
          <select
            onChange={(e) =>
              setFilter((f) => ({
                ...f,
                minCoverage: e.target.value ? Number(e.target.value) : undefined,
              }))
            }
            title="披露维度太少的岗位不是差，是你看不清它"
          >
            <option value="">全部置信度</option>
            <option value="0.5">覆盖 ≥ 50%</option>
            <option value="0.8">覆盖 ≥ 80%</option>
          </select>
          <select
            onChange={(e) =>
              setFilter((f) => ({ ...f, roleFamilies: e.target.value ? [e.target.value] : undefined }))
            }
          >
            <option value="">全部职能</option>
            {facets?.roleFamilies.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              onChange={(e) => setFilter((f) => ({ ...f, hideHardGaps: e.target.checked || undefined }))}
            />
            隐藏硬门槛未过
          </label>
          <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="checkbox"
              onChange={(e) => setFilter((f) => ({ ...f, includeIgnored: e.target.checked || undefined }))}
            />
            含已忽略
          </label>
        </div>

        {error && <p className="err" style={{ marginBottom: 0 }}>{error}</p>}

        {lastRun && (
          <p className="faint" style={{ margin: '10px 0 0' }}>
            {lastRun.map((r) =>
              r.ok
                ? `${r.sourceId}：抓 ${r.fetched}、入库 ${r.ingested}、新增 ${r.newJobs}`
                : `${r.sourceId}：失败 — ${r.error}`,
            ).join('　')}
          </p>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: showSources ? 10 : 0 }}>
          <h2 style={{ margin: 0 }}>采集源健康度</h2>
          {broken.length > 0 && <span className="tag bad">{broken.length} 个异常</span>}
          <div className="spacer" />
          <button onClick={() => setShowSources((s) => !s)}>{showSources ? '收起' : '展开'}</button>
        </div>
        {showSources &&
          (sources.length === 0 ? (
            <p className="faint" style={{ margin: 0 }}>
              还没配置采集源。编辑 <code>data/facts/sources.yaml</code>；
              国内平台要登录，用 <code>assit ingest --clipboard</code> 手动粘贴即可，下游处理完全一样。
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>源</th>
                  <th>平台</th>
                  <th>上次成功</th>
                  <th className="num">连续失败</th>
                  <th className="num">岗位</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.sourceId} style={{ cursor: 'default' }}>
                    <td><code>{s.sourceId}</code></td>
                    <td className="muted">{s.platform}</td>
                    <td className="muted">{s.lastOkAt ?? '从未'}</td>
                    <td className="num">
                      {s.consecutiveFailures > 0 ? (
                        <span className="tag bad">{s.consecutiveFailures}</span>
                      ) : (
                        <span className="faint">0</span>
                      )}
                      {s.lastError && <div className="faint mono">{s.lastError.slice(0, 90)}</div>}
                    </td>
                    <td className="num">{s.totalJobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>

      <div className="card">
        {rows === null ? (
          <p className="spin">读取中…</p>
        ) : rows.length === 0 ? (
          <div className="empty">
            没有岗位。点上面的「采集」，或者用 <code>assit ingest --clipboard</code> 粘一个进来。
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="num">分数</th>
                <th className="num">覆盖</th>
                <th>公司 · 职位</th>
                <th>城市</th>
                <th>薪资</th>
                <th>来源</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr
                  key={j.jobId}
                  className={j.ignoredReason ? 'ignored' : ''}
                  onClick={() => setOpenId(j.jobId)}
                >
                  <td className="num">
                    <span className="score">{j.finalScore ?? '—'}</span>
                    {j.hardGaps.length > 0 && <span className="tag bad" title={j.hardGaps.join('；')}>⚑</span>}
                  </td>
                  <td className="num">
                    {j.coverage === null ? (
                      <span className="faint">—</span>
                    ) : (
                      <span className={j.coverage < 0.5 ? 'tag warn' : 'faint'}>
                        {Math.round(j.coverage * 100)}%
                      </span>
                    )}
                  </td>
                  <td>
                    <div>{j.company} · {j.title}</div>
                    <div>
                      {j.roleFamily && <span className="tag">{j.roleFamily}</span>}
                      {j.cappedBy && <span className="tag warn">被「{j.cappedBy}」封顶</span>}
                      {j.injectionFlags.length > 0 && (
                        <span className="tag bad" title={j.injectionFlags.join(' / ')}>
                          JD 含可疑指令
                        </span>
                      )}
                      {j.jdVersions > 1 && <span className="tag">JD 改过 {j.jdVersions - 1} 次</span>}
                      {j.applied && <span className="tag good">已投</span>}
                      {j.ignoredReason && <span className="tag">已忽略：{j.ignoredReason}</span>}
                    </div>
                  </td>
                  <td className="muted">{j.city ?? '—'}</td>
                  <td className="muted">{j.salaryRaw ?? <span className="faint">未披露</span>}</td>
                  <td className="muted">{j.platforms.join('、')}</td>
                  <td className="num">
                    {j.ignoredReason ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void window.assit.unignore(j.jobId).then(load);
                        }}
                      >
                        恢复
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void ignore(j);
                        }}
                      >
                        忽略
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openId && <JobDrawer jobId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
