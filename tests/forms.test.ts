import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NarrativeNotApproved,
  applyPlan,
  classifyField,
  learnField,
  openDb,
  planForm,
  selectorOf,
  type BrowserBridge,
  type Db,
  type ElementRef,
} from '@assit/core';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-forms-'));
  process.env.ASSIT_DATA_DIR = dir;
  db = openDb();
});
afterEach(() => {
  db.close();
  delete process.env.ASSIT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const el = (o: Partial<ElementRef>): ElementRef => ({ ref: '@e1', tag: 'input', ...o });

const PROFILE = {
  'name.zh': '李工',
  phone: '13900001111',
  email: 'li@example.com',
  city: '杭州',
  school: '某某大学',
};

describe('字段分类：分错的后果不对称', () => {
  it('登记字段照抄', () => {
    expect(classifyField(el({ label: '姓名' })).fieldClass).toBe('registry');
    expect(classifyField(el({ label: '手机号码' })).profileKey).toBe('phone');
    expect(classifyField(el({ placeholder: '请输入电子邮箱' })).profileKey).toBe('email');
  });

  it('「期望城市」是决策字段，不是 city —— 你住哪和你愿意去哪是两件事', () => {
    const m = classifyField(el({ label: '期望工作城市' }));
    expect(m.fieldClass).toBe('decision');
    expect(m.profileKey).toBeNull();
  });

  it('「期望薪资」永远不自动填', () => {
    expect(classifyField(el({ label: '期望薪资' })).fieldClass).toBe('decision');
    expect(classifyField(el({ label: '能否接受加班' })).fieldClass).toBe('decision');
    expect(classifyField(el({ label: '最快到岗时间' })).fieldClass).toBe('decision');
  });

  it('现居城市才是 registry，且「期望」会否决它', () => {
    expect(classifyField(el({ label: '现居城市' })).profileKey).toBe('city');
    expect(classifyField(el({ label: '期望城市' })).fieldClass).toBe('decision');
  });

  it('label 比 nearby 可信 —— nearby 可能是隔壁字段蹭进来的', () => {
    const m = classifyField(el({ label: '姓名', nearby: '期望薪资（税前）' }));
    expect(m.profileKey).toBe('name.zh');
    expect(m.confidence).toBe(1);
  });

  it('长文本框没规则命中也按叙事处理，不当成 unknown', () => {
    const m = classifyField(el({ tag: 'textarea', label: '补充说明' }));
    expect(m.fieldClass).toBe('narrative');
  });

  it('认不出来就是 unknown，不硬猜', () => {
    expect(classifyField(el({ label: '请选择渠道来源' })).fieldClass).toBe('unknown');
  });

  it('文件输入框单独一类', () => {
    expect(classifyField(el({ type: 'file' })).profileKey).toBe('__resume__');
  });
});

describe('计划', () => {
  const els: ElementRef[] = [
    el({ ref: '@e1', label: '姓名', name: 'realname' }),
    el({ ref: '@e2', label: '手机', name: 'mobile' }),
    el({ ref: '@e3', label: '期望薪资', name: 'salary' }),
    el({ ref: '@e4', tag: 'textarea', label: '自我评价', name: 'intro' }),
    el({ ref: '@e5', type: 'file', name: 'resume' }),
    el({ ref: '@e6', label: '渠道来源', name: 'src' }),
    el({ ref: '@e7', tag: 'button', type: 'submit', label: '提交' }),
  ];

  it('四类动作分得开，且提交按钮不进计划', () => {
    const p = planForm(db, 'jobs.example.com', 'https://jobs.example.com/a', els, {
      profileFields: PROFILE, resumePath: '/tmp/r.pdf',
    });
    expect(p.summary).toEqual({ copy: 2, rewrite: 1, askUser: 1, upload: 1, skip: 1 });
    expect(p.fields.find((f) => f.ref === '@e7')).toBeUndefined();
    expect(p.willSubmit).toBe(false);
  });

  it('档案里没有的值降级成「让人填」，不是填空字符串', () => {
    const p = planForm(db, 'd.com', 'u', [el({ ref: '@e1', label: '毕业院校', name: 'school' })], {
      profileFields: {},
    });
    expect(p.fields[0]!.action).toBe('ask_user');
  });

  it('人工纠正按域名记住，下次直接用', () => {
    const weird = el({ ref: '@e1', label: '联络号', name: 'lxh' });
    expect(planForm(db, 'd.com', 'u', [weird], { profileFields: PROFILE }).fields[0]!.action).toBe('skip');

    learnField(db, 'd.com', selectorOf(weird), 'phone', 'registry');
    const p2 = planForm(db, 'd.com', 'u', [weird], { profileFields: PROFILE });
    expect(p2.fields[0]!.action).toBe('copy');
    expect(p2.fields[0]!.value).toBe('13900001111');
    expect(p2.fields[0]!.learned).toBe(true);
    // 换个域名不该受影响 —— 记的是「这个站的这个字段」
    expect(planForm(db, 'other.com', 'u', [weird], { profileFields: PROFILE }).fields[0]!.action).toBe('skip');
  });

  it('selector 不用 ref —— @e 每次 snapshot 都会变，不能当记忆的键', () => {
    expect(selectorOf(el({ ref: '@e9', name: 'mobile' }))).toBe('[name=mobile]');
    expect(selectorOf(el({ ref: '@e9', id: 'phone-input' }))).toBe('#phone-input');
  });
});

describe('执行：没有提交这条路径', () => {
  function fakeBridge(): BrowserBridge & { filled: [string, string][]; uploads: string[] } {
    const filled: [string, string][] = [];
    const uploads: string[] = [];
    return {
      name: 'fake', filled, uploads,
      health: async () => ({ ok: true, detail: '' }),
      tabs: async () => [], open: async () => ({ tabId: 't', url: '', title: '' }),
      startCapture: async () => undefined, capturedResponses: async () => [],
      stopCapture: async () => undefined, exec: async () => undefined,
      snapshot: async () => [],
      fill: async (_t, ref, v) => { filled.push([ref, v]); },
      uploadFile: async (_t, _r, p) => { uploads.push(p); },
      close: async () => undefined,
    } as any;
  }

  const els: ElementRef[] = [
    el({ ref: '@e1', label: '姓名', name: 'realname' }),
    el({ ref: '@e2', label: '期望薪资', name: 'salary' }),
    el({ ref: '@e3', tag: 'textarea', label: '自我评价', name: 'intro' }),
  ];

  it('叙事字段没有确认过的文本就拒绝执行', async () => {
    const b = fakeBridge();
    const p = planForm(db, 'd.com', 'u', els, { profileFields: PROFILE });
    await expect(applyPlan(b, { tabId: 't', plan: p })).rejects.toThrow(NarrativeNotApproved);
    // 一个字都没写进去 —— 不是写一半再报错
    expect(b.filled).toHaveLength(0);
  });

  it('确认过之后才写入，决策字段留给人', async () => {
    const b = fakeBridge();
    const p = planForm(db, 'd.com', 'u', els, { profileFields: PROFILE });
    const r = await applyPlan(b, {
      tabId: 't', plan: p, approvedNarratives: { '@e3': '五年后端，主导过交易链路重构。' },
    });
    expect(b.filled).toEqual([['@e1', '李工'], ['@e3', '五年后端，主导过交易链路重构。']]);
    expect(r.leftToUser.map((x) => x.label)).toEqual(['期望薪资']);
    expect(r.leftToUser[0]!.why).toContain('只有你知道');
    expect(r.submitted).toBe(false);
  });

  it('产出的快照就是投递记录里的第四份', async () => {
    const b = fakeBridge();
    const p = planForm(db, 'd.com', 'u', els, { profileFields: PROFILE });
    const r = await applyPlan(b, { tabId: 't', plan: p, approvedNarratives: { '@e3': 'xyz' } });
    expect(r.snapshot).toEqual({ 姓名: '李工', 自我评价: 'xyz' });
  });

  it('人可以只填其中几个', async () => {
    const b = fakeBridge();
    const p = planForm(db, 'd.com', 'u', els, { profileFields: PROFILE });
    await applyPlan(b, { tabId: 't', plan: p, only: ['@e1'] });
    expect(b.filled).toEqual([['@e1', '李工']]);
  });

  it('传简历走 uploadFile', async () => {
    const b = fakeBridge();
    const p = planForm(db, 'd.com', 'u', [el({ ref: '@e9', type: 'file' })], {
      profileFields: PROFILE, resumePath: '/tmp/r.pdf',
    });
    const r = await applyPlan(b, { tabId: 't', plan: p });
    expect(b.uploads).toEqual(['/tmp/r.pdf']);
    expect(r.snapshot['']).toBeUndefined();
  });
});
