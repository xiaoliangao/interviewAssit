# Assit-interview

个人求职工作台。一条主链路：

> 真实代码与经历 → 事实库 → 按 JD 定制简历 → 采集岗位并可解释打分 → 人工确认投递并冻结快照 → 邮箱追踪与日历 → 面试训练与项目深挖 → 错题回流事实库

设计见 [`docs/DESIGN.md`](docs/DESIGN.md)，评审与修订计划见 [`docs/plan.md`](docs/plan.md)。

当前进度：**M0a + M0b + M1 已完成**（事实库 → 定制简历；项目解析 → 候选主张；岗位采集 → 可解释打分）。

## 快速开始

```bash
corepack enable                 # 首次：启用 pnpm
pnpm install
pnpm assit init                 # 在 data/facts/ 生成事实库模板
```

然后用编辑器填 `data/facts/`：

1. `profile.yaml` —— 登记性事实（姓名、学历、公司全称、证书）。**这些值会被原样照抄到简历和网申表单，永不经过改写模型。**
2. `claims/*.json` —— 叙事性资产（你做过什么、做到什么程度）。措辞可改，责任等级不可改。

```bash
pnpm assit validate             # 校验：schema、必填、日期、证书有效期、状态一致性
pnpm assit sync                 # 导入 SQLite（文件是真源，SQLite 是索引层）
pnpm assit resume --jd jd.md --target backend
```

产出三样东西，都在 `data/out/`：

| 文件 | 用途 |
|---|---|
| `*.pdf` | 投出去的那份 |
| `*.html` | 想自己改排版时用 |
| `*.bullets.md` | **bullet ↔ 证据对照表** |

> 面试前一晚看对照表，不要看简历本身。上面有每条 bullet 对应的主张 id、责任等级、
> 边界、代码证据（PR / commit / 文件）、以及被追问时该从哪句话开口。

## 命令

| 命令 | 作用 |
|---|---|
| `assit init` | 生成事实库模板 |
| `assit validate [--json]` | 校验事实库 |
| `assit sync` | 文件 → SQLite |
| `assit resume --jd <file>` | 生成定制简历。`--draft` 允许带「待确认」主张，`--rewrite` 调模型改措辞 |
| `assit authors <path>` | 列出仓库里的 git 身份，用来填 `repos.yaml` 的 `authors` |
| `assit scan` | 扫描仓库：结构层 + 归因层 + 求交（**不调模型**） |
| `assit propose --repo <name>` | 解读你碰过的模块，生成候选主张 + 复核清单（调模型） |
| `assit ingest` | 粘贴入库：零风险、覆盖一切平台（含 BOSS）。`--clipboard` 直接读剪贴板 |
| `assit collect` | 从公开招聘接口采集（Greenhouse / Lever / Ashby / 任意 JSON-LD 页面） |
| `assit sources` | 采集源健康度 |
| `assit score` | 岗位池打分。`--force` 重算 |
| `assit why <jobId>` | 展开一个岗位的完整打分证据 |
| `assit ignore <jobId> --reason` | 忽略并记原因（会被 rubric-review 消费） |
| `assit rubric-review` | 每周复盘：高分被忽略 / 低分被投递的岗位 |
| `assit providers` | 探测可用模型，显示各自能处理的最高敏感级 |
| `assit doctor` | 环境自检 |

`--jd -` 可以从 stdin 读，配合 `pbpaste` 直接粘：

```bash
pbpaste | pnpm assit resume --jd - --target backend
```

## 从代码里长出简历素材

手写 claim 很累，而且你会忘掉一半做过的事。`scan` + `propose` 把这一步变成「系统提议、你确认」：

```bash
assit authors ~/code/order-service     # 先看这仓库里有哪些 git 身份
# 把你用过的邮箱填进 data/facts/repos.yaml 的 authors
assit scan                             # 不调模型，纯算
assit propose --repo order-service     # 调模型，受 visibility 拦截
```

三层，只有最后一层调模型：

| 层 | 干什么 | 调模型 |
|---|---|---|
| 结构层 | 目录结构 + import 语句 → 模块划分与依赖边 | 否 |
| 归因层 | `git log --numstat --author` → 哪些文件是你动的 | 否 |
| **求交** | 两者交集 = **你实际碰过的架构区域** | 否 |
| 解读层 | 这个模块干什么、技术选型为什么、面试官会问什么 | 是 |

**求交那一步是关键。** 只有结构图，你会把整个项目吹成自己的；只有 git 归因，你看到一堆零散 commit，写出来是「修复了若干 bug」这种废话。交集出来的那块，正好就是账本里 `boundary` 该填的内容 —— 而且它是算出来的，不是凭印象写的：

> 模块共 8 个文件、21 次提交、另有 3 位作者参与。我的部分：6 次提交、+340/-180 行，占该模块全部改动的 62%。

产出两样东西：`data/facts/claims/*.json`（状态一律**待确认**，进不了最终 PDF）和一份复核清单，上面列着等你回答的追问题。**答不上来的，就不要把对应的主张写进简历** —— 这正是整套东西存在的意义。

## 岗位池与可解释打分

```bash
assit ingest --clipboard --company 某某科技 --title 后端工程师 --city 杭州 --salary "40-60K·15薪"
assit collect          # 公开接口，无需登录、无封号风险
assit score
assit why <jobId>      # 这个分数凭什么
```

**先有粘贴通道，才有采集器。** 粘贴零风险、零维护、覆盖一切平台 —— 意味着浏览器扩展
做出来之前，BOSS 的岗位就能进岗位池了。后面每个采集器都只是「省掉复制粘贴」。

打分三段式：**硬门槛**（不过不淘汰，只沉底 —— JD 门槛常常虚标）→ **加权 rubric**
（未披露的维度不计入分母）→ **封顶规则**。规则写在 `data/facts/rubric/*.yaml`，
`rubric_version` 由文件内容 hash 派生。

```
原始分 89 → 最终分 89
  core_stack    33/40  JD 要求 6 项，命中 5 项：go、helm、kubernetes、mysql、redis；缺 java
                JD 原文：「…推动 Kubernetes 上的标准化…」
  experience    15/15  JD 要求 5 年，你 5 年
  salary        13/15  40-60K·15薪 → 年包约 75.0 万；你的下限 54.0 万
  schedule        —    未披露，不计入分母
```

## 四条不会松动的规则

这三条在代码层强制，并且有测试证明（`pnpm test`）：

**① 简历里不能出现你在面试中讲不清的东西。**
`verification_status` 是「待确认 / 已过期」的主张进不了最终 PDF；账本写「参与」，
渲染层就拒绝输出「主导 / 负责 / Owner / led」；`metrics.status=待补` 的数字
永远由你填，模型不代填。

**② 私有代码不出这台机器。**
`api:*` 和 `cli:*` 的敏感级上限都是 `public` —— CLI 同样把内容发到云端，
把它当「本地」是错的。没配本地模型时，`private` / `nda` 的载荷会**硬失败**
并提示你去装一个，而不是悄悄降级发出去。

**③ 模型指不回具体文件的结论一律丢弃。**
AI 读代码画架构的幻觉率很高。解读层要求每条结论的 `evidence` 都是这个模块里真实存在的
文件路径，指不回去的直接扔掉并标「未识别」—— 和打分那边要求 evidence 必须是 JD 原文
子串是同一套机制。简历上一句编造的技术描述，在面试第二轮就会被拆穿。

**④ 岗位去重和投递去重是两件事。**
`identity_key`（公司 + 归一化职位 + 城市）回答「这两条是不是同一个岗位」；
`application_key`（公司 + 职能族 + 90 天窗口）回答「我最近是不是投过这家的这类岗」。
一个 key 表达不了这两件事。

## 开发

```bash
pnpm test          # 守门测试：渲染 / 路由 / 去重 / 脱敏 / 事实库
pnpm typecheck
```

```
packages/contract/   zod schema，三端共用的类型
packages/core/       全部领域逻辑，零 UI 依赖
  db/                better-sqlite3 + 编号 SQL 迁移
  facts/             档案、主张账本、校验器、同步
  repomap/           结构层 + 归因层 + 求交 + 解读层 + 候选主张
  collectors/        公开接口采集 + 契约测试 + 采集源健康度
  jobs/              三态解析、归一化、入库、去重
  scoring/           硬门槛 / rubric / 封顶 / score_trace / rubric-review
  models/            provider 抽象、任务路由、visibility 拦截、脱敏、缓存、用量
  resume/            主张选择、诚实性闸门、HTML/PDF 渲染、对照表
  dedup/             公司归并、岗位身份键、投递冷却
apps/cli/            assit 命令
tests/               守门测试
data/                SQLite + artifacts + facts（全部 gitignore）
```

## 备份

`data/facts/` 是整个项目里**唯一不可重建的数据**。建议把它做成独立的私有 git 仓库：

```bash
cd data/facts && git init && git add -A && git commit -m "初始事实库"
```

主仓库的 `.gitignore` 已经排除了整个 `data/`，两个 git 不会打架。
