import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProfileDraft, readRubricDraft, saveProfileDraft, saveRubricDraft } from '@assit/core';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assit-edit-'));
  process.env.ASSIT_DATA_DIR = dir;
  fs.mkdirSync(path.join(dir, 'facts', 'rubric'), { recursive: true });
});
afterEach(() => {
  delete process.env.ASSIT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const pf = () => path.join(dir, 'facts', 'profile.yaml');
const rf = () => path.join(dir, 'facts', 'rubric', 'v1.yaml');

const SEED = `# 这里的每一个值都会被【原样照抄】到简历和网申表单里
# 永远不会经过改写模型。

fields:
  name.zh: 张三        # 换成你自己的
  phone: "13800000000"

records:
  education:
    - school: 某某大学
      degree: 本科
      major: 计算机
      start_at: 2016-09
      end_at: 2020-06
`;

describe('档案编辑：文件仍然是真源', () => {
  it('存回去之后注释还在 —— 那些注释是这份配置的自解释部分', () => {
    fs.writeFileSync(pf(), SEED);
    const d = readProfileDraft(pf());
    d.fields['name.zh'] = '李工';
    saveProfileDraft(d, pf());

    const text = fs.readFileSync(pf(), 'utf8');
    expect(text).toContain('【原样照抄】');
    expect(text).toContain('永远不会经过改写模型');
    expect(text).toContain('李工');
    expect(text).not.toContain('张三');
  });

  it('空字符串不落盘 —— 不要在 YAML 里堆一排 gpa: \'\'', () => {
    fs.writeFileSync(pf(), SEED);
    const d = readProfileDraft(pf());
    d.fields.github = '';
    d.records.education[0]!.gpa = '';
    saveProfileDraft(d, pf());
    const text = fs.readFileSync(pf(), 'utf8');
    expect(text).not.toMatch(/github:\s*['"]{2}/);
    expect(text).not.toMatch(/gpa:\s*['"]{2}/);
  });

  it('半填的档案照样存，但把问题原样带回去', () => {
    fs.writeFileSync(pf(), 'fields: {}\n');
    const d = readProfileDraft(pf());
    d.records.employment.push({ company: '某某科技' }); // 缺 title / start_at
    const r = saveProfileDraft(d, pf());
    expect(fs.existsSync(pf())).toBe(true);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.some((i) => i.path.includes('employment'))).toBe(true);
  });

  it('合法档案存完没有 issue', () => {
    fs.writeFileSync(pf(), 'fields: {}\n');
    const d = readProfileDraft(pf());
    d.fields = { 'name.zh': '李工', phone: '13900001111', email: 'a@b.com' };
    d.records.education.push({ school: 'X 大学', degree: '本科', major: 'CS', start_at: '2016-09', end_at: '2020-06' });
    expect(saveProfileDraft(d, pf()).issues).toEqual([]);
  });

  it('文件不存在时也能读出一个空草稿，不抛', () => {
    expect(readProfileDraft(path.join(dir, 'nope.yaml')).fields).toEqual({});
  });
});

describe('rubric 编辑：只动 profile 那一段', () => {
  const SEED_R = `# 封顶规则。when 是封闭枚举，不是可写表达式
profile:
  cities: [杭州]
  stack: [go]
weights:
  core_stack: 40
caps:
  - label: missing_core_stack
    when: core_stack_below_half
    final_score_max: 55
`;

  it('改 profile 不碰 weights / caps —— 那些是规则，要看着注释在编辑器里改', () => {
    fs.writeFileSync(rf(), SEED_R);
    saveRubricDraft({ cities: ['上海', '深圳'], stack: ['java', 'spring'], target_roles: ['backend'] });

    const text = fs.readFileSync(rf(), 'utf8');
    expect(text).toContain('封闭枚举');           // 注释在
    expect(text).toContain('core_stack: 40');      // weights 没动
    expect(text).toContain('core_stack_below_half'); // caps 没动
    expect(text).toContain('java');
    expect(text).not.toContain('杭州');
  });

  it('读回来的就是刚存的', () => {
    fs.writeFileSync(rf(), SEED_R);
    saveRubricDraft({ cities: ['成都'], stack: ['rust'], exp_years: 3 });
    const r = readRubricDraft();
    expect(r.profile.cities).toEqual(['成都']);
    expect(r.profile.exp_years).toBe(3);
  });

  it('没有 rubric 文件时明说要先 init，而不是默默创建一个半截的', () => {
    fs.rmSync(path.join(dir, 'facts', 'rubric'), { recursive: true, force: true });
    expect(() => saveRubricDraft({ cities: ['x'] })).toThrow(/assit init/);
  });
});
