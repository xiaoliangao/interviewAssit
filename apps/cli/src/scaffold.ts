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

const REPOS = `# 项目解析要扫的仓库。只填你手选的 3–5 个，别全量 ——
# 全量扫的结果是一堆你自己都不想写进简历的噪音候选。
#
# 填完跑：
#   assit authors <local_path>   # 看这个仓库里有哪些 git 身份，把你用过的抄进 authors
#   assit scan                   # 结构层 + 归因层 + 求交（不调模型）
#   assit propose --repo <name>  # 解读并生成候选主张（调模型，受 visibility 拦截）

repos: []
  # - full_name: org/order-service
  #   local_path: /Users/you/code/order-service
  #
  #   # 决定这个仓库的代码能不能发给云端模型。路由层按它强制拦截，不是标签。
  #   # private/nda 的仓库没有本地模型就跑不了 propose —— 这是设计如此。
  #   visibility: private
  #
  #   # 你在这个仓库用过的 git 身份（邮箱或姓名）。**不填归因结果就是空的。**
  #   # 人在不同公司、不同时期用不同邮箱是常态，把用过的都列上。
  #   authors: ["you@company.com", "you@gmail.com"]
  #
  #   # 可选：只看这个日期之后的提交。老仓库全量扫会把早年的练手代码算进来。
  #   since: "2021-01-01"
  #   exclude: ["docs", "scripts/legacy"]
`;

const RUBRIC = `# 打分规则。rubric_version 由这个文件的内容 hash 派生 ——
# 不要手写版本号，手写的一定会忘记改，然后你就有两套规则产出的分数
# 共用一个标签，永远对不上账。
#
# 打分是「这个岗位对你合不合适」，不是「这个岗位好不好」，
# 所以下面 profile 那一段写的是**你**。

note: v1

profile:
  degree: 本科              # 大专 | 本科 | 硕士 | 博士
  exp_years: 5
  cities: [杭州, 上海]
  accept_remote: true

  salary_floor_yuan: 45000  # 月薪下限：低于它这一项记 0 分
  salary_target_yuan: 65000 # 月薪目标：到这个数这一项满分

  # 你的技术栈。打分时和 JD 的要求求交。
  # 写你真能扛住追问的，不是你听说过的。
  stack: [go, redis, mysql, kubernetes, kafka, docker, linux]

  acceptable_schedules: [双休, 弹性]

# 各维度权重。未披露的维度不计入分母，所以这里的总和不一定是 100。
weights:
  core_stack: 40
  experience: 15
  salary: 15
  location: 10
  schedule: 10
  company: 10

# 硬门槛。不过**不淘汰**，只标记 hard_gaps 并沉底 ——
# JD 的门槛常常是虚标的，真去聊了往往也能谈。
hard_gates:
  - key: education
  - key: exp_years_min
    slack: 1                # 要 5 年而你 4 年，仍算通过

# 封顶规则。when 是封闭枚举，不是可写表达式：
#   core_stack_below_half | core_stack_zero | hard_gate_failed
#   outsourcing_likely | schedule_bad | salary_below_floor | coverage_low
caps:
  - label: missing_core_stack
    when: core_stack_below_half
    final_score_max: 55
  - label: likely_outsourcing
    when: outsourcing_likely
    threshold: 0.6
    final_score_max: 50
  - label: schedule_unacceptable
    when: schedule_bad
    final_score_max: 45

# 未知维度不计入分母。记 0 分等于对信息披露少的岗位加负分 ——
# 而那恰好是你最该警惕的一批岗位。
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
