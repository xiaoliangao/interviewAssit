# Assit-interview

个人求职工作台。一条主链路：

> 真实代码与经历 → 事实库 → 按 JD 定制简历 → 采集岗位并可解释打分 → 人工确认投递并冻结快照 → 邮箱追踪与日历 → 面试训练与项目深挖 → 错题回流事实库

设计见 [`docs/DESIGN.md`](docs/DESIGN.md)，评审与修订计划见 [`docs/plan.md`](docs/plan.md)。

当前进度：**M0a 已完成**（事实库 + 定制简历 + 模型路由 + 守门测试）。

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
| `assit providers` | 探测可用模型，显示各自能处理的最高敏感级 |
| `assit doctor` | 环境自检 |

`--jd -` 可以从 stdin 读，配合 `pbpaste` 直接粘：

```bash
pbpaste | pnpm assit resume --jd - --target backend
```

## 三条不会松动的规则

这三条在代码层强制，并且有测试证明（`pnpm test`）：

**① 简历里不能出现你在面试中讲不清的东西。**
`verification_status` 是「待确认 / 已过期」的主张进不了最终 PDF；账本写「参与」，
渲染层就拒绝输出「主导 / 负责 / Owner / led」；`metrics.status=待补` 的数字
永远由你填，模型不代填。

**② 私有代码不出这台机器。**
`api:*` 和 `cli:*` 的敏感级上限都是 `public` —— CLI 同样把内容发到云端，
把它当「本地」是错的。没配本地模型时，`private` / `nda` 的载荷会**硬失败**
并提示你去装一个，而不是悄悄降级发出去。

**③ 岗位去重和投递去重是两件事。**
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
