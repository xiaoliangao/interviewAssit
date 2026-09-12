import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, paths } from '@assit/core';

const PROFILE = `# 结构化档案 —— 登记性事实
#
# 这个文件里的每一个值都会被【原样照抄】到简历和网申表单里，
# 永远不会经过改写模型。写错了就是错的，所以照抄真实信息。
#
# 叙事性内容（"我做了什么、做得怎么样"）不写在这里，写在 claims/ 里。

fields:
  name.zh: 张三
  name.en: San Zhang
  phone: "13800000000"
  email: you@example.com
  city: 杭州
  github: https://github.com/yourname
  # website: https://yourblog.dev

records:
  education:
    - school: 某某大学
      degree: 本科          # 大专 | 本科 | 硕士 | 博士 | 其他
      major: 计算机科学与技术
      start_at: 2016-09
      end_at: 2020-06
      is_statutory: true    # 统招。国内表单里是独立字段，如实填

  employment:
    - company: 杭州某某科技有限公司    # 全称，不是简称 —— 表单和背调用全称
      department: 交易平台部
      title: 高级后端工程师
      city: 杭州
      start_at: 2021-03
      end_at: null
      is_current: true

  certificate: []
    # - name: AWS Certified Solutions Architect – Associate
    #   issuer: Amazon Web Services
    #   issued_at: 2023-05-10
    #   expires_at: 2026-05-10   # 过期证书会被渲染层直接剔除

  language: []
    # - language: 英语
    #   exam: CET-6
    #   score: "540"

  award: []

# 期望不属于档案 —— 它随岗位而变。这里只是默认值，每次投递可覆盖。
preferences:
  expected_salary_min: 45000
  expected_cities: [杭州, 上海]
  available_from: 2026-10-01
  willing_relocate: false
`;

const CLAIM = `{
  "id": "claim-example-001",
  "source_fact": "重构订单服务的库存扣减逻辑，解决大促期间的超卖问题",

  "candidate_wording": "重构订单服务库存扣减链路，以分布式锁 + 幂等令牌替换原有乐观锁重试，消除大促并发下的超卖",

  "responsibility_level": "主导方案或交付",

  "verification_status": "待确认",

  "boundary": "方案设计与核心实现由我完成；压测由 QA 团队执行；上下游改造由另外两位同事配合",

  "visibility": "private",

  "code_evidence": {
    "repo": "org/order-service",
    "prs": ["#412", "#430"],
    "commits": ["a1b2c3d", "e4f5g6h"],
    "files_touched": ["internal/inventory/deduct.go", "internal/inventory/lock.go"],
    "modules": ["internal/inventory"],
    "loc": { "added": 340, "deleted": 180 },
    "author_share_in_pr": 0.86,
    "is_core_path": true,
    "visibility": "private"
  },

  "interview_details": {
    "decision": "为什么用分布式锁而不是数据库乐观锁：热点 SKU 下乐观锁重试率超过 40%，尾延迟不可接受",
    "difficulty": "热点 SKU 的锁争用；锁超时与业务超时的关系",
    "verification": "压测 5k QPS 持续 10 分钟，超卖数 0，P99 从 820ms 降到 210ms",
    "result": "上线后连续 3 个月零超卖工单"
  },

  "metrics": [
    { "name": "超卖工单", "before": null, "after": 0, "unit": "单/月", "status": "待补" },
    { "name": "P99 延迟", "before": 820, "after": 210, "unit": "ms", "status": "已确认" }
  ],

  "allowed_uses": [],
  "tags": ["Go", "分布式锁", "高并发", "订单"],
  "risk_notes": "before 的超卖工单数缺失，需要翻工单系统确认",
  "last_verified": null
}
`;

const REPOS = `# M0b 项目解析要扫的仓库。只填你手选的 3–5 个，别全量。
# visibility 决定这个仓库的代码能不能发给云端模型 —— 路由层按它强制拦截。

repos: []
  # - full_name: org/order-service
  #   local_path: /Users/you/code/order-service
  #   visibility: private
`;

const RUBRIC = `# 打分规则（M1 用）。rubric_version 由这个文件的内容 hash 派生，
# 不要手写版本号 —— 手写的一定会忘记改。

weights:
  core_stack: 40        # 技术栈命中
  domain_fit: 15        # 业务领域相关度
  salary: 15            # 薪资结构
  commute: 10           # 城市 / 通勤
  schedule: 10          # 作息（大小周等）
  company: 10           # 公司性质（含外包概率）

hard_gates:
  - key: education
    rule: "JD 要求学历 <= 我的最高学历"
  - key: exp_years_min
    rule: "JD 要求年限 <= 我的年限 + 1"

caps:
  - when: "core_stack 得分 < max*0.5"
    final_score_max: 55
    label: missing_core_stack

# 未知的维度不计入分母，不记 0 分。
unknown_policy: exclude_from_denominator
`;

const FACTS_README = `# 事实库

这个目录是整个项目里**唯一不可重建的数据**。代码没了可以重写，采集来的岗位没了可以重采，
这里面的东西没了就真没了。

建议把它做成一个独立的私有 git 仓库：

    cd data/facts
    git init
    git add -A && git commit -m "初始事实库"
    git remote add origin <你的私有远端>
    git push -u origin main

主仓库的 .gitignore 已经把整个 data/ 排除掉了，所以这里的 git 不会和主仓库打架。

## 文件说明

| 文件 | 是什么 | 能否被模型改写 |
|---|---|---|
| profile.yaml | 登记性事实：姓名、学历、公司全称、证书 | **否，只能照抄** |
| claims/*.json | 叙事性资产：你做过什么、做到什么程度 | 措辞可改，责任等级不可改 |
| repos.yaml | 项目解析要扫哪些仓库 | — |
| rubric/*.yaml | 打分规则 | — |

改完跑 \`assit validate\`。
`;

export function scaffold(force: boolean): string[] {
  const files: [string, string][] = [
    [paths.profile, PROFILE],
    [path.join(paths.claimsDir, 'claim-example-001.json'), CLAIM],
    [paths.reposFile, REPOS],
    [path.join(paths.rubricDir, 'v1.yaml'), RUBRIC],
    [path.join(paths.facts, 'README.md'), FACTS_README],
  ];
  const created: string[] = [];
  for (const [file, content] of files) {
    if (fs.existsSync(file) && !force) continue;
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, content, 'utf8');
    created.push(file);
  }
  return created;
}
