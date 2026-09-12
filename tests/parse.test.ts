import { describe, expect, it } from 'vitest';
import {
  annualTotal,
  coverage,
  degreeRank,
  parseEducation,
  parseExperience,
  parseJob,
  parseOutsourcing,
  parseSalary,
  parseSchedule,
  parseTechStack,
} from '@assit/core';

/**
 * 三态解析。贯穿全部用例的一条：**推不出来就是 unknown，不许填默认值。**
 *
 * 「JD 没写学历 → 默认不限」这种写法会系统性地给信息披露少的岗位加分，
 * 而那恰好是最该警惕的一批岗位。
 */

describe('薪资解析：每个平台写法都不一样', () => {
  const cases: [string, number | null, number | null, number | null][] = [
    ['25-40K·15薪', 25000, 40000, 15],
    ['25-40K', 25000, 40000, 12],
    ['2.5-4万/月', 25000, 40000, 12],
    ['8k-12k', 8000, 12000, 12],
    ['15000-25000元/月', 15000, 25000, 12],
    ['30K·16薪', 30000, 30000, 16],
    ['40-60K·15薪', 40000, 60000, 15],
    ['￥20,000-35,000', 20000, 35000, 12],
  ];
  for (const [raw, min, max, months] of cases) {
    it(`解析 ${raw}`, () => {
      const s = parseSalary(raw);
      expect([s.min, s.max, s.months]).toEqual([min, max, months]);
    });
  }

  it('年薪换算回月薪', () => {
    const s = parseSalary('年薪50-70万');
    expect(s.min).toBe(Math.round((50 * 10000) / 12));
    expect(s.max).toBe(Math.round((70 * 10000) / 12));
  });

  it('「面议」就是未知，不编一个中位数', () => {
    // 硬编中位数会让这个岗位混进你的高分列表
    for (const raw of ['面议', '薪资面议', '待遇从优', 'Competitive', '']) {
      const s = parseSalary(raw);
      expect(s.min, raw).toBeNull();
      expect(s.months, raw).toBeNull();
    }
  });

  it('只给月薪不给薪数时按 12 算，但标 inferred', () => {
    const s = parseSalary('25-40K');
    expect(s.months).toBe(12);
    expect(s.monthsConfidence).toBe('inferred');

    const s2 = parseSalary('25-40K·15薪');
    expect(s2.monthsConfidence).toBe('explicit_jd');
  });

  it('数字后面跟的是人数/年限/年龄时不当薪资', () => {
    // 采集到脏数据或粘错字段时，这些会被读成钱，然后一路参与打分
    for (const junk of ['3-5人团队', '5年以上经验', '25-35岁', '3-6个月试用期']) {
      expect(parseSalary(junk).min, junk).toBeNull();
    }
  });

  it('没有金额单位时，只认已经是「元」量级的裸数字', () => {
    expect(parseSalary('25000-40000').min).toBe(25000);
    expect(parseSalary('3-5').min).toBeNull();
  });

  it('区间写反了自动纠正', () => {
    const s = parseSalary('40-25K');
    expect([s.min, s.max]).toEqual([25000, 40000]);
  });

  it('年总包用于跨薪数比较', () => {
    // 25-40K·15薪 的年包高于 30-45K·12薪，光看月薪区间看不出来
    const a = annualTotal(parseSalary('25-40K·15薪'))!;
    const b = annualTotal(parseSalary('30-45K'))!;
    expect(a).toBeGreaterThan(b);
    expect(annualTotal(parseSalary('面议'))).toBeNull();
  });
});

describe('学历与经验', () => {
  it('读出明确写了的学历要求', () => {
    expect(parseEducation('本科及以上学历').value).toBe('本科');
    expect(parseEducation('硕士研究生以上').value).toBe('硕士');
    expect(parseEducation('大专以上即可').value).toBe('大专');
    expect(parseEducation('学历不限').value).toBe('不限');
  });

  it('没写学历时是 unknown，不是「不限」', () => {
    const e = parseEducation('负责后端服务开发，熟悉 Go 与 MySQL');
    expect(e.value).toBeNull();
    expect(e.confidence).toBe('unknown');
  });

  it('source 指回 JD 原文', () => {
    const jd = '任职要求：\n1. 本科及以上学历，计算机相关专业';
    const e = parseEducation(jd);
    expect(e.confidence).toBe('explicit_jd');
    expect(jd.replace(/\s+/g, ' ')).toContain(e.source!.slice(0, 10));
  });

  it('学历可比较', () => {
    expect(degreeRank('硕士')).toBeGreaterThan(degreeRank('本科'));
    expect(degreeRank('本科')).toBeGreaterThan(degreeRank('大专'));
    expect(degreeRank(null)).toBe(0);
  });

  it('经验年限取下限', () => {
    expect(parseExperience('3-5年工作经验').value).toBe(3);
    expect(parseExperience('5年以上后端开发经验').value).toBe(5);
    expect(parseExperience('经验不限').value).toBe(0);
    expect(parseExperience('负责服务开发').confidence).toBe('unknown');
  });
});

describe('作息：国内 JD 大量回避这一项', () => {
  it('明确写了的读出来', () => {
    expect(parseSchedule('大小周，餐补交通补').value).toBe('大小周');
    expect(parseSchedule('单双休').value).toBe('大小周');
    expect(parseSchedule('周末双休，弹性打卡').value).toBe('双休');
    expect(parseSchedule('弹性工作时间').value).toBe('弹性');
  });

  it('没提就是 unknown —— 回避是信号，但不是「双休」的证据', () => {
    const s = parseSchedule('负责交易链路开发，参与大促保障');
    expect(s.value).toBeNull();
    expect(s.confidence).toBe('unknown');
  });
});

describe('外包：做成概率，不做布尔', () => {
  it('无信号时是 unknown，不是 0', () => {
    // 0 表示「确定不是外包」，unknown 表示「看不出来」，这是两件事
    const r = parseOutsourcing('负责电商后端开发', '杭州盈通网络科技有限公司');
    expect(r.likelihood).toBeNull();
    expect(r.signals).toEqual([]);
  });

  it('明写外包时概率高', () => {
    const r = parseOutsourcing('人力外派至甲方，驻场开发', '某某信息技术服务有限公司');
    expect(r.likelihood).toBeGreaterThan(0.7);
    expect(r.signals.length).toBeGreaterThanOrEqual(3);
  });

  it('单一弱信号不足以定性', () => {
    // 很多正经公司名字里也有「信息技术」—— 这正是不做布尔的原因
    const r = parseOutsourcing('负责内部系统开发', '北京某某信息技术服务有限公司');
    expect(r.likelihood).toBeLessThan(0.5);
    expect(r.likelihood).toBeGreaterThan(0);
  });

  it('每个信号都带原文，让人自己判断', () => {
    const r = parseOutsourcing('长期驻场银行项目', '甲公司');
    expect(r.signals.every((s) => s.source.length > 0)).toBe(true);
  });
});

describe('技术栈', () => {
  it('抽出 JD 里的技术词并归一化别名', () => {
    const s = parseTechStack('精通 Golang，熟悉 K8s、Postgres 与 RocketMQ');
    expect(s.value).toEqual(expect.arrayContaining(['go', 'kubernetes', 'postgresql', 'rocketmq']));
  });

  it('词边界正确 —— go 不该命中 django / algorithm', () => {
    const s = parseTechStack('熟悉 Django 框架，了解 algorithm 设计');
    expect(s.value ?? []).not.toContain('go');
    expect(s.value).toContain('django');
  });

  it('长词优先 —— mongodb 不该被拆成 go', () => {
    const s = parseTechStack('使用 MongoDB 存储');
    expect(s.value).toContain('mongodb');
    expect(s.value).not.toContain('go');
  });

  it('可以用自己账本里的 tag 扩展词表', () => {
    const s = parseTechStack('熟悉内部的 Tars 框架', ['Tars']);
    expect(s.value).toContain('tars');
  });

  it('一个技术词都没有时是 unknown', () => {
    expect(parseTechStack('负责团队管理与项目推进').confidence).toBe('unknown');
  });

  it('不收泛概念 —— 谁都会写「高并发」', () => {
    const s = parseTechStack('有高并发、微服务、分布式经验');
    expect(s.value).toBeNull();
  });
});

describe('整体解析与 coverage', () => {
  const JD = `高级后端开发工程师（交易方向）· 杭州

岗位职责：
1. 负责交易核心链路的架构设计与开发；
2. 主导订单、库存等核心服务的性能优化。

任职要求：
1. 本科及以上学历，5 年以上后端开发经验；
2. 精通 Go，熟悉 Redis、MySQL、Kafka；
3. 熟悉 Kubernetes、Helm 者优先。

福利：周末双休，弹性打卡。`;

  it('披露充分的 JD coverage 高', () => {
    const r = parseJob({ jdText: JD, companyName: '杭州盈通网络科技有限公司', salaryRaw: '40-60K·15薪' });
    expect(r.attrs.education.value).toBe('本科');
    expect(r.attrs.exp_years_min.value).toBe(5);
    expect(r.attrs.work_schedule.value).toBe('双休');
    expect(r.attrs.tech_stack.value).toEqual(expect.arrayContaining(['go', 'redis', 'kubernetes']));
    expect(r.salary.months).toBe(15);

    const c = coverage(r.attrs);
    expect(c.known).toBeGreaterThanOrEqual(4);
    expect(c.ratio).toBeGreaterThan(0.6);
  });

  it('披露少的 JD coverage 低，而不是被当成「都不限」', () => {
    const r = parseJob({ jdText: '招后端，有意者联系。', companyName: '某公司' });
    const c = coverage(r.attrs);
    expect(c.known).toBe(0);
    expect(c.ratio).toBe(0);
    expect(Object.values(r.attrs).every((a) => a.confidence === 'unknown')).toBe(true);
  });
});
