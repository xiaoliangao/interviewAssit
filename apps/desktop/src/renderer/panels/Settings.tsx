import { useCallback, useEffect, useState } from 'react';
import type { AppContext, SettingsView } from '../../preload/index.js';

/**
 * 设置（DESIGN §10）。
 *
 * 只放**真配置**：模型路由、隐私约束、数据位置。运营数据（今天采了多少、
 * 哪个源坏了）不放这里 —— 它们属于对应的工作面板，藏进设置页等于没人看。
 *
 * 一个刻意的「不可配置」：每个 provider 的 `max_visibility` 是硬编码的，
 * 这一页只显示不提供开关。它不是偏好，是事实 —— api/cli 都会把内容
 * 发出这台机器。做成开关的结果是某天赶时间时调高，然后忘掉。
 */

const TASK_LABELS: Record<string, string> = {
  code_analysis: '代码解析',
  resume_rewrite: '简历改写',
  jd_extract: 'JD 抽取',
  interview_chat: '面试追问',
  question_answer: '题目解答',
  email_classify: '邮件分类',
};

const KIND_LABELS: Record<string, string> = {
  local: '本机',
  api: '云端 API',
  cli: '本机 CLI（但会联网）',
};

const VIS_LABELS: Record<string, string> = {
  public: '只能处理 public',
  private: '可处理 private',
  nda: '可处理 nda（最高）',
};

export function Settings(props: { ctx: AppContext | null }): JSX.Element {
  const [s, setS] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.assit.settings().then(setS).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const anyLocal = s?.providers.some((p) => p.kind === 'local' && p.available) ?? false;

  return (
    <>
      <div className="page-head">
        <h1>设置</h1>
        <div className="spacer" />
        <button onClick={load}>重新探测</button>
      </div>
      <p className="sub">只放真配置。今天采了多少、哪个源坏了这类运营数据在各自的面板里。</p>

      {error && <p className="err">{error}</p>}

      <div className="card">
        <h2>模型 provider</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          每个 provider 能处理的最高敏感级是<b>硬编码的，这里不提供开关</b> ——
          它不是偏好，是事实：`api:*` 和 `cli:*` 都会把内容发出这台机器。
          做成开关的结果是某天赶时间时把它调高，然后忘掉。
        </p>
        {!s ? (
          <p className="spin">探测中…</p>
        ) : (
          <table>
            <thead>
              <tr><th>可用</th><th>provider</th><th>类型</th><th>模型</th><th>敏感级上限</th><th>凭据</th></tr>
            </thead>
            <tbody>
              {s.providers.map((p) => (
                <tr key={p.id} style={{ cursor: 'default' }}>
                  <td>{p.available ? <span className="tag good">✓</span> : <span className="tag">✗</span>}</td>
                  <td><code>{p.id}</code></td>
                  <td className="muted">{KIND_LABELS[p.kind] ?? p.kind}</td>
                  <td className="muted">{p.model}</td>
                  <td>
                    <span className={`tag ${p.maxVisibility === 'nda' ? 'good' : ''}`}>
                      {VIS_LABELS[p.maxVisibility] ?? p.maxVisibility}
                    </span>
                  </td>
                  <td className="faint mono">
                    {p.credentialRef ?? '—'}
                    {p.detail && <div className="faint">{p.detail}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {s && !anyLocal && (
          <div className="card warn" style={{ marginTop: 10 }}>
            <b>没有可用的本机模型。</b>
            <div className="faint" style={{ marginTop: 4 }}>
              后果是具体的：私有仓库解析（<code>assit propose</code>）和面试录音转写会被
              <b>路由层直接拦下</b>，不是降级到云端。装一个：
              <code>brew install ollama && ollama pull qwen2.5-coder:7b</code>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>任务路由</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          降级链里<b>不满足敏感级的会被跳过，而不是「降级到弱一点的模型」</b> —— 那是两回事。
          代码解析首选本机，因为它的载荷天然可能是 private / nda。
        </p>
        {s && (
          <table>
            <thead><tr><th>任务</th><th>首选</th><th>降级链</th></tr></thead>
            <tbody>
              {s.routes.map((r) => (
                <tr key={r.task} style={{ cursor: 'default' }}>
                  <td>{TASK_LABELS[r.task] ?? r.task}</td>
                  <td><code>{r.provider}</code></td>
                  <td className="faint mono">{r.fallback.join(' → ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="faint" style={{ marginBottom: 0 }}>
          路由表暂时改不了 —— 改它意味着改「哪些数据会出这台机器」，
          比调一个下拉框重。要改先看 <code>docs/DESIGN.md §10</code>。
        </p>
      </div>

      <div className="card">
        <h2>隐私约束</h2>
        <div className="comp">
          <span className="name">面试录音</span>
          <span className="val"><span className="tag good">只走本机</span></span>
          <span className="muted">
            转写只用 whisper.cpp / faster-whisper，<b>连「可选开启云端」的开关都不提供</b> ——
            录音里有对方的声音，那是别人的个人信息，而一个存在的开关迟早会被按下
          </span>
        </div>
        <div className="comp">
          <span className="name">邮箱</span>
          <span className="val"><span className="tag good">只读</span></span>
          <span className="muted">不标已读、不移动、不删除；正文只对白名单放行的那几封拉</span>
        </div>
        <div className="comp">
          <span className="name">凭据</span>
          <span className="val"><span className="tag good">系统钥匙串</span></span>
          <span className="muted">不进 SQLite、不进配置文件、不进环境变量</span>
        </div>
        <div className="comp">
          <span className="name">投递</span>
          <span className="val"><span className="tag good">逐条人工确认</span></span>
          <span className="muted">不做无人值守批量投递；自动填表里<b>没有「提交」这条代码路径</b></span>
        </div>
      </div>

      <div className="card">
        <h2>数据位置</h2>
        {s && (
          <>
            <div className="comp">
              <span className="name">数据目录</span>
              <span className="val" />
              <span className="mono">{s.dataDir}</span>
            </div>
            <div className="comp">
              <span className="name">数据库</span>
              <span className="val" />
              <span className="mono">{s.dbPath}</span>
            </div>
            <div className="comp">
              <span className="name">雇主注册表</span>
              <span className="val" />
              <span className="mono">{s.registryDir}</span>
            </div>
            <div className="comp">
              <span className="name">指针文件</span>
              <span className="val" />
              <span className="mono">
                {s.dataPointer ?? '（没有，用默认位置）'}
                <div className="faint">
                  打包后的应用 cwd 是 <code>/</code>，推不出仓库路径，所以靠它找到你的数据。
                  <code>assit link-data .</code> 写它，删掉就回到默认位置 —— 数据不会动。
                </div>
              </span>
            </div>
            <p style={{ marginBottom: 0 }}>
              <button onClick={() => void window.assit.reveal(s.dbPath)}>在访达中显示</button>
            </p>
          </>
        )}
      </div>

      {props.ctx && (
        <div className="card">
          <h2>当前版本</h2>
          <div className="comp">
            <span className="name">profile</span>
            <span className="val mono">{props.ctx.profileVersion.replace('facts-', '')}</span>
            <span className="faint">由档案内容 hash 派生，不手写 —— 手写的版本号一定会忘记改</span>
          </div>
          <div className="comp">
            <span className="name">rubric</span>
            <span className="val mono">{props.ctx.rubricVersion ?? '未配置'}</span>
            <span className="faint">
              {props.ctx.rubricError ? <span className="err">{props.ctx.rubricError.slice(0, 200)}</span>
                : '改了 rubric 版本会变，岗位需要重算'}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
