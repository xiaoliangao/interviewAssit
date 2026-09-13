import { useCallback, useEffect, useState } from 'react';
import type { FactsView, FieldRequest, ProfileDraft, RubricDraft } from '../../preload/index.js';

/**
 * 事实库 & 简历 —— 照网申简历的样子排（DESIGN §5.2）。
 *
 * 为什么长得像网申表单而不是「配置页」：这份档案的**唯一用途**就是
 * 被照抄进网申表单和简历。长得一样，你填的时候就知道它会出现在哪。
 *
 * 两条边界体现在界面上：
 *   - 登记字段（上半屏）**永不经过改写模型**，所以是朴素输入框，必填标 *
 *   - 主张（下半屏）是叙事资产，这里只读 —— 责任等级由面试结果改，
 *     不由你在表单里随手调（反向边在 §8.2）
 */

interface FieldSpec {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'select';
  options?: string[];
}

/** 网申表单最常问的那一批。顺序照着真实表单排。 */
const BASIC: FieldSpec[] = [
  { key: 'name.zh', label: '姓名', required: true, placeholder: '身份证上的名字' },
  { key: 'name.en', label: '英文名 / 拼音', placeholder: 'San Zhang' },
  { key: 'gender', label: '性别', type: 'select', options: ['', '男', '女'] },
  { key: 'birth', label: '出生年月', placeholder: '1996-03' },
  { key: 'phone', label: '手机', required: true, placeholder: '13800000000' },
  { key: 'email', label: '邮箱', required: true, placeholder: 'you@example.com' },
  { key: 'city', label: '现居城市', placeholder: '杭州', hint: '「期望城市」在下面的求职意向里，两者不是一回事' },
  { key: 'hometown', label: '籍贯', placeholder: '浙江杭州' },
  { key: 'political', label: '政治面貌', type: 'select', options: ['', '群众', '共青团员', '中共党员', '民主党派', '其他'] },
  { key: 'github', label: 'GitHub', placeholder: 'https://github.com/…' },
  { key: 'website', label: '个人主页 / 博客', placeholder: 'https://…' },
];

const DEGREES = ['大专', '本科', '硕士', '博士', '其他'];

function Star(): JSX.Element {
  return <span className="req">*</span>;
}

function Pending(): JSX.Element {
  return <span className="pending">待填写</span>;
}

function Chips(props: { value: string[]; onChange: (v: string[]) => void; placeholder: string }): JSX.Element {
  return (
    <input
      className="full"
      placeholder={props.placeholder}
      defaultValue={props.value.join('、')}
      onBlur={(e) => props.onChange(e.target.value.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean))}
    />
  );
}

/** 一行「标签 : 输入框」。必填没填就在标签后面挂一个「待填写」。 */
function Row(props: {
  spec: FieldSpec;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const empty = !props.value.trim();
  return (
    <tr style={{ cursor: 'default' }}>
      <td className="flabel">
        {props.spec.label}
        {props.spec.required && <Star />}
      </td>
      <td>
        <div className="row" style={{ gap: 8 }}>
          {props.spec.type === 'select' ? (
            <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
              {(props.spec.options ?? []).map((o) => (
                <option key={o} value={o}>{o || '未填'}</option>
              ))}
            </select>
          ) : (
            <input
              className="full"
              value={props.value}
              placeholder={props.spec.placeholder ?? ''}
              onChange={(e) => props.onChange(e.target.value)}
            />
          )}
          {props.spec.required && empty && <Pending />}
        </div>
        {props.spec.hint && <div className="faint">{props.spec.hint}</div>}
      </td>
    </tr>
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
    setProfile((p) => (p ? { ...p, records: { ...p.records, [kind]: p.records[kind].filter((_, j) => j !== i) } } : p));
    setDirty(true);
  };
  const setPref = (k: string, val: unknown): void => {
    setProfile((p) => (p ? { ...p, preferences: { ...p.preferences, [k]: val } } : p));
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (!profile) return;
    setError(null);
    try {
      const a = await window.assit.factsSaveProfile(profile);
      const b = v?.rubricFile ? await window.assit.factsSaveRubric(rubric) : { issues: [] };
      const issues = [...a.issues, ...b.issues];
      setMsg(issues.length === 0 ? '已保存到文件' : `已保存，但有 ${issues.length} 处还不合法（见上方清单）`);
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
      setMsg(`已同步进库：字段 ${r.profileFields} · 主张新增 ${r.claimsInserted} / 更新 ${r.claimsUpdated}`);
      load();
      props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const fieldStatus = async (k: string, s: 'pending' | 'filled' | 'ignored'): Promise<void> => {
    await window.assit.factsFieldStatus(k, s);
    load();
  };

  if (!profile || !v) {
    return (
      <>
        <div className="page-head"><h1>事实库 & 简历</h1></div>
        {error ? <p className="err">{error}</p> : <p className="spin">读取中…</p>}
      </>
    );
  }

  const missingRequired = BASIC.filter((f) => f.required && !(profile.fields[f.key] ?? '').trim());
  const pendingFields = v.fieldRequests.filter((f) => f.status === 'pending');
  const ignoredFields = v.fieldRequests.filter((f) => f.status === 'ignored');
  const filledCount =
    BASIC.filter((f) => (profile.fields[f.key] ?? '').trim()).length +
    profile.records.education.length + profile.records.employment.length;
  const totalish = BASIC.length + 2;

  return (
    <>
      <div className="page-head">
        <h1>事实库 & 简历</h1>
        <span className="muted">完整度 {Math.min(100, Math.round((filledCount / totalish) * 100))}%</span>
        {dirty && <span className="tag warn">未保存</span>}
        <div className="spacer" />
        <button className="primary" onClick={() => void save()}>保存</button>
        <button onClick={() => void sync()} title="文件 → SQLite">同步进库</button>
      </div>
      <p className="sub">
        这里的每个值都会被<b>原样照抄</b>进简历和网申表单，<b>永不经过改写模型</b> ——
        所以照抄真实信息，写错了就是错的。带 <span className="req">*</span> 的是投递前必须有的。
      </p>

      {error && <p className="err">{error}</p>}
      {msg && <div className="card" style={{ marginBottom: 12 }}>{msg}</div>}

      {missingRequired.length > 0 && (
        <div className="card bad">
          <b>还有 {missingRequired.length} 项必填没写：</b>
          {missingRequired.map((f) => <span key={f.key} className="tag bad" style={{ marginLeft: 6 }}>{f.label}</span>)}
          <div className="faint" style={{ marginTop: 6 }}>
            没填完也能存 —— 半填是正常状态。但简历生成和自动填表会停在这里。
          </div>
        </div>
      )}

      {/* 网申发现的缺口。这一块是 §7.2 那条反馈边的出口 */}
      {(pendingFields.length > 0 || ignoredFields.length > 0) && (
        <div className="card warn">
          <h2>网申时发现缺的信息</h2>
          <p className="faint" style={{ marginTop: 0 }}>
            这些是自动填表时遇到、但档案里没有的字段。中文网申会问一堆预设不了的东西
            （政治面貌、籍贯、紧急联系人……），穷举不完 ——
            <b>所以让表单来告诉档案缺什么</b>。填一次，下次同一个字段就有值了。
          </p>
          <table>
            <tbody>
              {pendingFields.map((f: FieldRequest) => (
                <tr key={f.key} style={{ cursor: 'default' }}>
                  <td className="flabel">
                    {f.label}
                    <div className="faint">
                      被问过 {f.seenCount} 次{f.lastDomain ? ` · 最近 ${f.lastDomain}` : ''}
                    </div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <input
                        className="full"
                        placeholder={f.example ?? ''}
                        value={profile.fields[f.key] ?? ''}
                        onChange={(e) => setField(f.key, e.target.value)}
                      />
                      {!(profile.fields[f.key] ?? '').trim() && <Pending />}
                      <button onClick={() => void fieldStatus(f.key, 'ignored')} title="这个我不打算填">
                        不填
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {ignoredFields.map((f) => (
                <tr key={f.key} style={{ cursor: 'default' }}>
                  <td className="flabel faint">{f.label}</td>
                  <td>
                    <span className="faint">已标为不填</span>
                    <button style={{ marginLeft: 8 }} onClick={() => void fieldStatus(f.key, 'pending')}>恢复</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>基本信息</h2>
        <table className="formtable">
          <tbody>
            {BASIC.map((f) => (
              <Row key={f.key} spec={f} value={profile.fields[f.key] ?? ''} onChange={(val) => setField(f.key, val)} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>教育经历<Star /></h2>
          <div className="spacer" />
          <button onClick={() => addRec('education', { school: '', degree: '本科', major: '', start_at: '', end_at: null })}>
            + 添加
          </button>
        </div>
        {profile.records.education.length === 0 ? (
          <div className="empty">还没有教育经历 <Pending /></div>
        ) : (
          profile.records.education.map((r, i) => (
            <div key={i} className="reccard">
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <input style={{ minWidth: 180 }} placeholder="学校全称 *" value={String(r.school ?? '')} onChange={(e) => setRec('education', i, 'school', e.target.value)} />
                <select value={String(r.degree ?? '本科')} onChange={(e) => setRec('education', i, 'degree', e.target.value)}>
                  {DEGREES.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <input placeholder="专业 *" value={String(r.major ?? '')} onChange={(e) => setRec('education', i, 'major', e.target.value)} />
                <input style={{ width: 96 }} placeholder="入学 2016-09" value={String(r.start_at ?? '')} onChange={(e) => setRec('education', i, 'start_at', e.target.value)} />
                <input style={{ width: 96 }} placeholder="毕业 2020-06" value={String(r.end_at ?? '')} onChange={(e) => setRec('education', i, 'end_at', e.target.value || null)} />
                <label className="muted chk">
                  <input type="checkbox" checked={Boolean(r.is_statutory)} onChange={(e) => setRec('education', i, 'is_statutory', e.target.checked)} />
                  统招
                </label>
                <div className="spacer" />
                <button onClick={() => delRec('education', i)}>删除</button>
              </div>
            </div>
          ))
        )}
        <p className="faint" style={{ marginBottom: 0 }}>「统招」在国内表单里是独立字段，如实填。</p>
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>工作经历<Star /></h2>
          <div className="spacer" />
          <button onClick={() => addRec('employment', { company: '', title: '', start_at: '', end_at: null, is_current: false })}>
            + 添加
          </button>
        </div>
        {profile.records.employment.length === 0 ? (
          <div className="empty">还没有工作经历 <Pending /></div>
        ) : (
          profile.records.employment.map((r, i) => (
            <div key={i} className="reccard">
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <input style={{ minWidth: 210 }} placeholder="公司全称 *（不是简称）" value={String(r.company ?? '')} onChange={(e) => setRec('employment', i, 'company', e.target.value)} />
                <input placeholder="部门" value={String(r.department ?? '')} onChange={(e) => setRec('employment', i, 'department', e.target.value)} />
                <input placeholder="职位 *" value={String(r.title ?? '')} onChange={(e) => setRec('employment', i, 'title', e.target.value)} />
                <input style={{ width: 80 }} placeholder="城市" value={String(r.city ?? '')} onChange={(e) => setRec('employment', i, 'city', e.target.value)} />
                <input style={{ width: 96 }} placeholder="2021-03" value={String(r.start_at ?? '')} onChange={(e) => setRec('employment', i, 'start_at', e.target.value)} />
                <input style={{ width: 96 }} placeholder="至今留空" value={String(r.end_at ?? '')} onChange={(e) => setRec('employment', i, 'end_at', e.target.value || null)} />
                <label className="muted chk">
                  <input type="checkbox" checked={Boolean(r.is_current)} onChange={(e) => setRec('employment', i, 'is_current', e.target.checked)} />
                  在职
                </label>
                <div className="spacer" />
                <button onClick={() => delRec('employment', i)}>删除</button>
              </div>
            </div>
          ))
        )}
        <p className="faint" style={{ marginBottom: 0 }}>公司写<b>全称</b> —— 表单和背调用的是全称。</p>
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>证书与语言</h2>
          <div className="spacer" />
          <button onClick={() => addRec('certificate', { name: '', issued_at: '', expires_at: null })}>+ 证书</button>
          <button onClick={() => addRec('language', { language: '', exam: '', score: '' })}>+ 语言</button>
        </div>
        {profile.records.certificate.map((r, i) => (
          <div key={`c${i}`} className="reccard">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input style={{ minWidth: 220 }} placeholder="证书名称" value={String(r.name ?? '')} onChange={(e) => setRec('certificate', i, 'name', e.target.value)} />
              <input placeholder="颁发机构" value={String(r.issuer ?? '')} onChange={(e) => setRec('certificate', i, 'issuer', e.target.value)} />
              <input style={{ width: 110 }} placeholder="2023-05-10" value={String(r.issued_at ?? '')} onChange={(e) => setRec('certificate', i, 'issued_at', e.target.value)} />
              <input style={{ width: 110 }} placeholder="到期（可空）" value={String(r.expires_at ?? '')} onChange={(e) => setRec('certificate', i, 'expires_at', e.target.value || null)} />
              <div className="spacer" />
              <button onClick={() => delRec('certificate', i)}>删除</button>
            </div>
          </div>
        ))}
        {profile.records.language.map((r, i) => (
          <div key={`l${i}`} className="reccard">
            <div className="row">
              <input placeholder="语言（英语）" value={String(r.language ?? '')} onChange={(e) => setRec('language', i, 'language', e.target.value)} />
              <input placeholder="考试（CET-6）" value={String(r.exam ?? '')} onChange={(e) => setRec('language', i, 'exam', e.target.value)} />
              <input style={{ width: 90 }} placeholder="分数" value={String(r.score ?? '')} onChange={(e) => setRec('language', i, 'score', e.target.value)} />
              <div className="spacer" />
              <button onClick={() => delRec('language', i)}>删除</button>
            </div>
          </div>
        ))}
        {profile.records.certificate.length + profile.records.language.length === 0 && (
          <p className="faint">还没有。</p>
        )}
        <p className="faint" style={{ marginBottom: 0 }}>
          过期证书会被渲染层<b>直接剔除</b>，不是警告一下照样印上去。
        </p>
      </div>

      <div className="card">
        <h2>求职意向</h2>
        <p className="faint" style={{ marginTop: 0 }}>
          这一段既进网申表单，也是打分的依据 —— 分数是「这个岗位<b>对你</b>合不合适」。
          {v.rubricFile && <> 打分部分写进 <code>{v.rubricFile}</code>。</>}
        </p>
        <table className="formtable">
          <tbody>
            <tr style={{ cursor: 'default' }}>
              <td className="flabel">我的技术栈<Star /></td>
              <td>
                <Chips value={rubric.stack ?? []} placeholder="go、redis、mysql（顿号或逗号分隔）"
                  onChange={(stack) => { setRubric((r) => ({ ...r, stack })); setDirty(true); }} />
                <div className="faint">写你<b>真能扛住追问</b>的，不是你听说过的。</div>
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td className="flabel">要投的职能<Star /></td>
              <td>
                <Chips value={rubric.target_roles ?? []} placeholder="backend / frontend / sre / algo / data / qa / security / architect / fullstack / swe"
                  onChange={(target_roles) => { setRubric((r) => ({ ...r, target_roles })); setDirty(true); }} />
                <div className="faint">
                  留空 = 不限。<b>强烈建议填</b>：销售岗的 JD 里没有技术词，技术栈那一维会被判成未知
                  而排除出分母，剩下的通用维度碰巧都匹配 —— 于是它拿 80 分排在你的后端岗前面。
                </div>
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td className="flabel">期望城市</td>
              <td>
                <Chips value={rubric.cities ?? []} placeholder="杭州、上海"
                  onChange={(cities) => { setRubric((r) => ({ ...r, cities })); setDirty(true); }} />
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td className="flabel">工作年限</td>
              <td>
                <input type="number" style={{ width: 90 }} value={rubric.exp_years ?? ''}
                  onChange={(e) => { setRubric((r) => ({ ...r, exp_years: e.target.value ? Number(e.target.value) : undefined })); setDirty(true); }} />
                <span className="faint" style={{ marginLeft: 8 }}>年</span>
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td className="flabel">月薪下限 / 目标</td>
              <td>
                <input type="number" style={{ width: 110 }} placeholder="45000" value={rubric.salary_floor_yuan ?? ''}
                  onChange={(e) => { setRubric((r) => ({ ...r, salary_floor_yuan: e.target.value ? Number(e.target.value) : undefined })); setDirty(true); }} />
                <span className="faint"> — </span>
                <input type="number" style={{ width: 110 }} placeholder="65000" value={rubric.salary_target_yuan ?? ''}
                  onChange={(e) => { setRubric((r) => ({ ...r, salary_target_yuan: e.target.value ? Number(e.target.value) : undefined })); setDirty(true); }} />
                <div className="faint">低于下限这一项记 0 分；到目标这一项满分。</div>
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td className="flabel">最高学历</td>
              <td>
                <select value={rubric.degree ?? ''} onChange={(e) => { setRubric((r) => ({ ...r, degree: e.target.value || undefined })); setDirty(true); }}>
                  <option value="">未填</option>
                  {['大专', '本科', '硕士', '博士'].map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </td>
            </tr>
            <tr style={{ cursor: 'default' }}>
              <td className="flabel">到岗时间</td>
              <td>
                <input style={{ width: 140 }} placeholder="2026-10-01" value={String(profile.preferences.available_from ?? '')}
                  onChange={(e) => setPref('available_from', e.target.value || undefined)} />
                <div className="faint">网申表单会问。它是决策字段 —— 自动填表永远不替你填，只高亮出来。</div>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="faint" style={{ marginBottom: 0 }}>
          权重、硬门槛、封顶规则<b>刻意不放在这里</b> —— 改它们要理解「未知不计入分母」
          「封顶不是扣分」这些语义，而那些语义写在 rubric 文件的注释里。
        </p>
      </div>

      <div className="card">
        <h2>主张账本 <span className="faint" style={{ fontWeight: 400 }}>（只读）</span></h2>
        <p className="faint" style={{ marginTop: 0 }}>
          叙事性资产：你做过什么、做到什么程度。<b>责任等级由面试结果改</b> ——
          答砸了会自动降级，不由你在表单里随手调。录入走 <code>data/facts/claims/</code>，
          或 <code>assit scan</code> + <code>assit propose</code> 从真实仓库长出来。
        </p>
        {v.claims.length === 0 ? (
          <div className="empty">
            还没有主张。没有主张就生成不了简历 —— 它是简历里每一条 bullet 的出处。
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

      <p className="faint" style={{ margin: '4px 0 20px' }}>
        全部写进 <code>{v.profileFile}</code>。文件是真源，SQLite 只是索引层 ——
        你也可以直接用编辑器改，那边每个字段上面都有注释。
      </p>
    </>
  );
}
