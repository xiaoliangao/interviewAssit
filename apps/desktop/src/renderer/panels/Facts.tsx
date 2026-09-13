import { useCallback, useEffect, useState } from 'react';
import type { FactsView, ProfileDraft, RubricDraft } from '../../preload/index.js';

/**
 * 事实库 & 简历（DESIGN §5）。
 *
 * 这一屏回答「我手上有什么弹药」，而它同时是**上手的入口** ——
 * 档案不填，分数算的是另一个人，简历里印的是「张三」。
 *
 * 两条边界直接体现在界面上：
 *   - 登记字段（上半屏）**永不经过改写模型**，所以是朴素的输入框
 *   - 主张（下半屏）是叙事资产，这里只读；它的责任等级由面试结果改，
 *     不由你在表单里随手调（那条反向边在 §8.2）
 */

const FIELD_SPECS: { key: string; label: string; hint?: string; required?: boolean }[] = [
  { key: 'name.zh', label: '姓名', required: true },
  { key: 'name.en', label: '英文名 / 拼音' },
  { key: 'phone', label: '手机', required: true },
  { key: 'email', label: '邮箱', required: true },
  { key: 'city', label: '现居城市', hint: '「期望城市」在下面的打分设置里，两者不是一回事' },
  { key: 'github', label: 'GitHub' },
  { key: 'website', label: '个人主页' },
];

const DEGREES = ['大专', '本科', '硕士', '博士', '其他'];
const ROLE_HINT = 'backend / frontend / sre / algo / data / qa / security / architect / fullstack / swe';

function Chips(props: { value: string[]; onChange: (v: string[]) => void; placeholder: string }): JSX.Element {
  return (
    <input
      style={{ flex: 1, minWidth: 220 }}
      placeholder={props.placeholder}
      defaultValue={props.value.join('、')}
      onBlur={(e) =>
        props.onChange(
          e.target.value.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean),
        )
      }
    />
  );
}

export function Facts(props: { onChanged: () => void }): JSX.Element {
  const [v, setV] = useState<FactsView | null>(null);
  const [profile, setProfile] = useState<ProfileDraft | null>(null);
  const [rubric, setRubric] = useState<RubricDraft>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    window.assit.factsRead()
      .then((r) => { setV(r); setProfile(r.profile); setRubric(r.rubric); setDirty(false); })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const setField = (k: string, val: string): void => {
    setProfile((p) => (p ? { ...p, fields: { ...p.fields, [k]: val } } : p));
    setDirty(true);
  };
  const setRec = (kind: keyof ProfileDraft['records'], i: number, k: string, val: unknown): void => {
    setProfile((p) => {
      if (!p) return p;
      const arr = [...p.records[kind]];
      arr[i] = { ...arr[i], [k]: val };
      return { ...p, records: { ...p.records, [kind]: arr } };
    });
    setDirty(true);
  };
  const addRec = (kind: keyof ProfileDraft['records'], tpl: Record<string, unknown>): void => {
    setProfile((p) => (p ? { ...p, records: { ...p.records, [kind]: [...p.records[kind], tpl] } } : p));
    setDirty(true);
  };
  const delRec = (kind: keyof ProfileDraft['records'], i: number): void => {
    setProfile((p) =>
      p ? { ...p, records: { ...p.records, [kind]: p.records[kind].filter((_, j) => j !== i) } } : p,
    );
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (!profile) return;
    setError(null);
    try {
      const a = await window.assit.factsSaveProfile(profile);
      const b = v?.rubricFile ? await window.assit.factsSaveRubric(rubric) : { issues: [] };
      const issues = [...a.issues, ...b.issues];
      setMsg(issues.length === 0 ? '已保存到文件' : `已保存，但还有 ${issues.length} 处不合法`);
      setDirty(false);
      load();
      props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sync = async (): Promise<void> => {
    setError(null);
    try {
      const r = await window.assit.factsSync();
      setMsg(`已同步进库：档案字段 ${r.profileFields}、主张新增 ${r.claimsInserted} / 更新 ${r.claimsUpdated}`);
      load();
      props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const errors = (v?.findings ?? []).filter((f) => f.severity === 'error');
  const warns = (v?.findings ?? []).filter((f) => f.severity === 'warn');

  if (!profile || !v) {
    return (
      <>
        <div className="page-head"><h1>事实库 & 简历</h1></div>
        {error ? <p className="err">{error}</p> : <p className="spin">读取中…</p>}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>事实库 & 简历</h1>
        {dirty && <span className="tag warn">有未保存的改动</span>}
      </div>
      <p className="sub">
        这里的每个值都会被<b>原样照抄</b>进简历和网申表单，<b>永不经过改写模型</b>。
        写错了就是错的 —— 所以照抄真实信息。
      </p>

      {error && <p className="err">{error}</p>}
      {msg && <p className="card" style={{ marginBottom: 12 }}>{msg}</p>}

      {(errors.length > 0 || warns.length > 0) && (
        <div className={`card ${errors.length > 0 ? 'bad' : 'warn'}`}>
          <h2>还需要处理</h2>
          {errors.map((f, i) => (
            <div key={`e${i}`} className="comp">
              <span className="name"><span className="tag bad">必填</span></span>
              <span className="val faint">{f.where ?? ''}</span>
              <span>{f.message}{f.hint && <div className="faint">{f.hint}</div>}</span>
            </div>
          ))}
          {warns.map((f, i) => (
            <div key={`w${i}`} className="comp">
              <span className="name"><span className="tag warn">建议</span></span>
              <span className="val faint">{f.where ?? ''}</span>
              <span>{f.message}{f.hint && <div className="faint">{f.hint}</div>}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>登记字段</h2>
          <div className="spacer" />
          <button className="primary" onClick={() => void save()}>保存到文件</button>
          <button onClick={() => void sync()} title="文件 → SQLite">同步进库</button>
        </div>
        <table>
          <tbody>
            {FIELD_SPECS.map((f) => (
              <tr key={f.key} style={{ cursor: 'default' }}>
                <td style={{ width: 150 }}>
                  {f.label}
                  {f.required && <span className="tag bad" style={{ marginLeft: 4 }}>必填</span>}
                </td>
                <td>
                  <input
                    style={{ width: '100%' }}
                    value={profile.fields[f.key] ?? ''}
                    placeholder={f.hint ?? ''}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                  {f.hint && <div className="faint">{f.hint}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="faint" style={{ marginBottom: 0 }}>
          写进 <code>{v.profileFile}</code>。文件是真源，SQLite 只是索引层 ——
          你也可以直接用编辑器改，那边有每个字段的注释。
        </p>
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>教育经历</h2>
          <div className="spacer" />
          <button onClick={() => addRec('education', { school: '', degree: '本科', major: '', start_at: '', end_at: null })}>
            加一条
          </button>
        </div>
        {profile.records.education.length === 0 && <p className="faint">还没有。</p>}
        {profile.records.education.map((r, i) => (
          <div key={i} className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <input placeholder="学校全称" value={String(r.school ?? '')} onChange={(e) => setRec('education', i, 'school', e.target.value)} />
            <select value={String(r.degree ?? '本科')} onChange={(e) => setRec('education', i, 'degree', e.target.value)}>
              {DEGREES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <input placeholder="专业" value={String(r.major ?? '')} onChange={(e) => setRec('education', i, 'major', e.target.value)} />
            <input style={{ width: 90 }} placeholder="2016-09" value={String(r.start_at ?? '')} onChange={(e) => setRec('education', i, 'start_at', e.target.value)} />
            <input style={{ width: 90 }} placeholder="2020-06" value={String(r.end_at ?? '')} onChange={(e) => setRec('education', i, 'end_at', e.target.value || null)} />
            <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={Boolean(r.is_statutory)} onChange={(e) => setRec('education', i, 'is_statutory', e.target.checked)} />
              统招
            </label>
            <button onClick={() => delRec('education', i)}>删除</button>
          </div>
        ))}
        <p className="faint" style={{ marginBottom: 0 }}>「统招」在国内表单里是独立字段，如实填。</p>
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>工作经历</h2>
          <div className="spacer" />
          <button onClick={() => addRec('employment', { company: '', title: '', start_at: '', end_at: null, is_current: false })}>
            加一条
          </button>
        </div>
        {profile.records.employment.length === 0 && <p className="faint">还没有。</p>}
        {profile.records.employment.map((r, i) => (
          <div key={i} className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <input style={{ minWidth: 200 }} placeholder="公司全称（不是简称）" value={String(r.company ?? '')} onChange={(e) => setRec('employment', i, 'company', e.target.value)} />
            <input placeholder="部门" value={String(r.department ?? '')} onChange={(e) => setRec('employment', i, 'department', e.target.value)} />
            <input placeholder="职位" value={String(r.title ?? '')} onChange={(e) => setRec('employment', i, 'title', e.target.value)} />
            <input style={{ width: 90 }} placeholder="2021-03" value={String(r.start_at ?? '')} onChange={(e) => setRec('employment', i, 'start_at', e.target.value)} />
            <input style={{ width: 90 }} placeholder="至今留空" value={String(r.end_at ?? '')} onChange={(e) => setRec('employment', i, 'end_at', e.target.value || null)} />
            <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={Boolean(r.is_current)} onChange={(e) => setRec('employment', i, 'is_current', e.target.checked)} />
              在职
            </label>
            <button onClick={() => delRec('employment', i)}>删除</button>
          </div>
        ))}
        <p className="faint" style={{ marginBottom: 0 }}>公司写<b>全称</b> —— 表单和背调用的是全称。</p>
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>证书</h2>
          <div className="spacer" />
          <button onClick={() => addRec('certificate', { name: '', issued_at: '', expires_at: null })}>加一条</button>
        </div>
        {profile.records.certificate.length === 0 && <p className="faint">还没有。</p>}
        {profile.records.certificate.map((r, i) => (
          <div key={i} className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            <input style={{ minWidth: 220 }} placeholder="证书名称" value={String(r.name ?? '')} onChange={(e) => setRec('certificate', i, 'name', e.target.value)} />
            <input placeholder="颁发机构" value={String(r.issuer ?? '')} onChange={(e) => setRec('certificate', i, 'issuer', e.target.value)} />
            <input style={{ width: 110 }} placeholder="2023-05-10" value={String(r.issued_at ?? '')} onChange={(e) => setRec('certificate', i, 'issued_at', e.target.value)} />
            <input style={{ width: 110 }} placeholder="到期（可空）" value={String(r.expires_at ?? '')} onChange={(e) => setRec('certificate', i, 'expires_at', e.target.value || null)} />
            <button onClick={() => delRec('certificate', i)}>删除</button>
          </div>
        ))}
        <p className="faint" style={{ marginBottom: 0 }}>过期证书会被渲染层直接剔除，不是警告一下照样印上去。</p>
      </div>

      <div className="card">
        <h2>打分设置</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          分数是「这个岗位<b>对你</b>合不合适」，所以这一段写的是<b>你</b>。
          {v.rubricFile ? <> 写进 <code>{v.rubricFile}</code>。</> : <> 还没有 rubric 文件，命令行跑 <code>assit init --only rubric</code>。</>}
        </p>
        <table>
          <tbody>
            <tr style={{ cursor: 'default' }}>
              <td style={{ width: 150 }}>我的技术栈</td>
              <td>
                <Chips value={rubric.stack ?? []} placeholder="go、redis、mysql（顿号或逗号分隔）"
                  onChange={(stack) => { setRubric((r) => ({ ...r, stack })); setDirty(true); }} />
                <div className="faint">写你<b>真能扛住追问</b>的，不是你听说过的。</div>
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td>要投的职能</td>
              <td>
                <Chips value={rubric.target_roles ?? []} placeholder={ROLE_HINT}
                  onChange={(target_roles) => { setRubric((r) => ({ ...r, target_roles })); setDirty(true); }} />
                <div className="faint">
                  留空 = 不限。<b>强烈建议填</b>：销售岗的 JD 里没有技术词，技术栈那一维会被判成未知
                  而排除出分母，剩下的通用维度碰巧都匹配 —— 于是它拿 80 分排在你的后端岗前面。
                </div>
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td>期望城市</td>
              <td>
                <Chips value={rubric.cities ?? []} placeholder="杭州、上海"
                  onChange={(cities) => { setRubric((r) => ({ ...r, cities })); setDirty(true); }} />
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td>工作年限</td>
              <td>
                <input type="number" style={{ width: 90 }} value={rubric.exp_years ?? ''}
                  onChange={(e) => { setRubric((r) => ({ ...r, exp_years: e.target.value ? Number(e.target.value) : undefined })); setDirty(true); }} />
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td>月薪下限 / 目标</td>
              <td>
                <input type="number" style={{ width: 110 }} placeholder="45000" value={rubric.salary_floor_yuan ?? ''}
                  onChange={(e) => { setRubric((r) => ({ ...r, salary_floor_yuan: e.target.value ? Number(e.target.value) : undefined })); setDirty(true); }} />
                <input type="number" style={{ width: 110, marginLeft: 8 }} placeholder="65000" value={rubric.salary_target_yuan ?? ''}
                  onChange={(e) => { setRubric((r) => ({ ...r, salary_target_yuan: e.target.value ? Number(e.target.value) : undefined })); setDirty(true); }} />
                <div className="faint">低于下限这一项记 0 分；到目标这一项满分。</div>
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td>最高学历</td>
              <td>
                <select value={rubric.degree ?? ''} onChange={(e) => { setRubric((r) => ({ ...r, degree: e.target.value || undefined })); setDirty(true); }}>
                  <option value="">不填</option>
                  {['大专', '本科', '硕士', '博士'].map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="faint" style={{ marginBottom: 0 }}>
          权重、硬门槛、封顶规则<b>刻意不放在这里</b> —— 改它们要理解「未知不计入分母」
          「封顶不是扣分」这些语义，而那些语义写在 rubric 文件的注释里，
          在编辑器里对着注释改才对。
        </p>
      </div>

      <div className="card">
        <h2>主张账本</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          叙事性资产：你做过什么、做到什么程度。这里<b>只读</b> ——
          责任等级由面试结果改（答砸了会降级），不由你在表单里随手调。
          录入走 <code>data/facts/claims/</code>，或者 <code>assit scan</code> + <code>assit propose</code> 从真实仓库长出来。
        </p>
        {v.claims.length === 0 ? (
          <div className="empty">
            还没有主张。没有主张就生成不了简历 ——
            它是简历里每一条 bullet 的出处。
          </div>
        ) : (
          <table>
            <thead><tr><th>状态</th><th>责任等级</th><th>主张</th></tr></thead>
            <tbody>
              {v.claims.map((c) => (
                <tr key={c.id} style={{ cursor: 'default' }}>
                  <td><span className={`tag ${c.status === '已确认' ? 'good' : c.status === '不采用' ? '' : 'warn'}`}>{c.status}</span></td>
                  <td className="muted">{c.level}</td>
                  <td>{c.fact}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
