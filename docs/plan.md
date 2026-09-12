# Assit-interview 设计评审与优化计划

评审对象：`docs/DESIGN.md`（2026-09-12 版）。
评审立场：设计整体方向正确，尤其是「证据链」「三态字段」「登记事实与叙事资产分表」「visibility 下沉到路由层」四个判断，不需要动。下面的优化集中在**砍范围、堵漏洞、补缺件**三类，目标是让 M0+M1 更早产出第一份真正投出去的简历。

---

## 0 一页纸结论

| # | 问题 | 改法 | 影响阶段 |
|---|---|---|---|
| 1 | 三种语言四个代码库，单人项目扛不住 | 全 TS：Electron 桌面壳 + 一个 `core` 包承载全部领域逻辑，CLI / 桌面 / 扩展都调它；UI 延后到 M1 | M0–M2 |
| 2 | M0 第一周就做「档案录入 UI」，成本高收益低 | M0 用 YAML/JSON 文件 + 校验器 + CLI，UI 到 M1 再做 | M0 |
| 3 | `cli:*` provider 被当成可处理私有代码的选项，但 CLI 照样把数据发云端 | `cli:*` 的 `max_visibility` 与其背后 API 相同；只有 `local:*` 可到 `nda` | M0 |
| 4 | archify 是靠模型的技能，不是确定性解析器；与「私有代码不出本机」冲突 | 模块图用确定性工具（import graph / tree-sitter），archify 只做解读与可视化 | M0b |
| 5 | `identity_key` 含薪资分桶，跨平台薪资写法不同会漏合 | key 去掉薪资，薪资不一致只做标记 | M1 |
| 6 | 国内求职时 Greenhouse/Lever 覆盖率低，「零风险通道」价值被高估 | M1 先做通用「粘贴入库」通道 + Moka/北森，Greenhouse/Lever 后置 | M1 |
| 7 | JD 副本只在投递时冻结，之前的 JD 变更历史丢失 | JD 每次变更即写 artifacts，`postings` 只存 hash | M1 |
| 8 | 模型调用无缓存，JD 抽取会重复烧钱 | 加 `model_cache`，按 `(task, prompt_sha256, model)` 命中 | M0 |
| 9 | 「答不上来就降级 claim」没有历史表，降级不可追溯、不可撤销 | 加 `claim_events`，所有状态变更走事件 | M0 |
| 10 | 简历 bullet↔claim 对照表只存 JSON 数组，查不了「我在 A 家说过什么」 | 加 `resume_bullets` 表 | M0 |
| 11 | 默认排序 `分数 × 置信度` 违背「未知不惩罚」 | 按分数排，coverage 做筛选和标记，不做乘数 | M1 |
| 12 | 提示注入防线只有原则，没有机制 | 结构化输出 + `evidence` 必须是 JD 原文子串校验 | M1 |
| 13 | 忽略原因被记录但没人消费 | 每周复盘：高分被忽略 / 低分被投递的岗位 → 调 rubric | M1 |
| 14 | 邮箱分类写死「规则 + 单次模型调用」，扩展性差 | M3 保留；core 暴露 MCP server，由 agent 用工具读脱敏邮件并提议事件，人工确认后入库 | M3 |
| 15 | TechSpar 是 Bun+Electron monorepo，Docker 自托管成本可能超过收益 | 试用限时 3 天能起就用，起不来直接自建最小版；TTS 从 MVP 删掉 | M4 |
| 16 | 没有备份、没有测试策略、没有 rubric 版本管理 | 事实库文本文件进私有 git；三类守门测试；rubric 为文件，version = hash | 全程 |

---

## 1 范围与技术栈

### 1.1 全 TS，一个 core 包，三个壳

原设计：Python 后端 + TS 采集器 + TS 扩展 + React 前端。改为单语言 TypeScript，pnpm workspace monorepo：

```
Assit-interview/
├── packages/
│   ├── core/                 全部领域逻辑，零 UI 依赖，Node 可直接跑
│   │   ├── db/               better-sqlite3 + 编号 SQL 迁移
│   │   ├── facts/            档案、claim 账本、校验器（移植 ASu 的 validate_claim_ledger）
│   │   ├── repomap/          import 图 + git 归因 + 求交 + 解读
│   │   ├── collectors/       每平台一个模块 + 契约测试
│   │   ├── scoring/          gate / rubric / caps / score_trace
│   │   ├── resume/           claim 选择、改写、HTML 模板渲染、PDF 导出
│   │   ├── applications/     快照、去重、事件、.ics
│   │   ├── interview/        项目深挖出题、转写调度、SM-2
│   │   └── models/           provider 抽象、路由、visibility 拦截、redact、cache、usage
│   └── contract/             posting.schema.json、claim schema，生成 TS 类型供三端共用
├── apps/
│   ├── cli/                  `assit` 命令，M0 的唯一入口，薄封装 core
│   ├── desktop/              Electron + Vite + React，主进程直接 import core，六面板
│   ├── extension/            WXT + Vue3（抄 boss-helper 骨架），通过 localhost 调 desktop 主进程
│   └── mcp/                  MCP server，把 core 的能力（邮件、投递、事实库）以工具暴露给 agent
├── vendor/                   ASu 模板、THIRD_PARTY_NOTICES.md
└── data/                     SQLite + artifacts + facts/（后者是私有 git）
```

几条原则：
- **core 不知道自己跑在哪。** 它不 import Electron，不起 HTTP 服务。CLI 直接调用；桌面主进程直接调用；扩展需要的接口由桌面主进程起一个 `127.0.0.1` 的小 HTTP 层转发。这样 M0 没有桌面壳也能全功能跑，桌面壳只是 UI。
- **M0 只做 `apps/cli`。** Electron 壳到 M1 随岗位池 UI 一起立起来。
- **Electron 而不是 Tauri。** Tauri 的壳是 Rust，把 Node 后端塞进 sidecar 会多一层进程与 IPC；Electron 主进程就是 Node，core 直接跑在里面，SQLite、git、子进程都在同一个运行时。代价是包体大一些，对本地单用户工具无所谓。TechSpar 也是 Electron 全栈，说明这条路走得通。

### 1.1.1 Python 生态的替代品

设计里选 Python 的理由是采集、AI 编排、git 分析、PDF 解析生态。逐项对应：

| 需求 | TS 方案 | 备注 |
|---|---|---|
| SQLite | `better-sqlite3` | 同步 API，WAL，事务简单；Electron 需 rebuild |
| HTTP / 重试 / 限速 | `undici` + 自写 retry/backoff + `p-limit` | 采集器 `_shared` |
| JSON-LD 抽取 | `cheerio` 读 `<script type="application/ld+json">` | 比 Python `extruct` 还直接 |
| git 归因 | 直接 `spawn git log --numstat --author`，解析 stdout | 不用 `simple-git`，输出解析更可控 |
| import 图 | TS/JS 用 `madge` 或 `dependency-cruiser`；Go 用 `go list -json`；Python 仓库用 `tree-sitter` WASM 抽 import | M0b 结构层 |
| PDF 简历 | Playwright chromium `page.pdf()`；ASu 的 `export-resume-pdf.mjs` 本身就是 Node 脚本，直接用 | Electron 内可用自带 chromium 的 `printToPDF` |
| PDF / DOCX 读取 | `pdf-parse`、`mammoth` | M5 面经导入 |
| 模型调用 | `@anthropic-ai/sdk`、`openai`、Ollama HTTP；CLI provider 用 `execa` | 结构化输出用 zod schema + `zod-to-json-schema` |
| 转写 | `whisper.cpp` 二进制作为 sidecar，`execa` 调用；或 `@fugood/whisper.node` | 不用 JS 实现，性能差太多 |
| 凭据 | Electron `safeStorage`（macOS 落 Keychain）；CLI 阶段用 `@napi-rs/keyring` | 不用已停维护的 `keytar` |
| IMAP | `imapflow` | M3 可选 |
| 日历 | `ics` 生成 + macOS `open file.ics`；或 `osascript` 直接写 Calendar | 后者可免手动导入 |
| Mac 通知 | Electron `Notification` | 今日面板的提醒 |

没有一项需要退回 Python。唯一要留意的是 `better-sqlite3` 和 whisper 的原生模块在 Electron 里要用 `electron-rebuild`，第一次搭环境预留半天。
### 1.2 M0 不做 UI

原设计 M0a 一周内含「档案录入 UI」。一个人录入自己的档案，编辑器比表单快，而且文件可 diff、可 git 版本化、模型可以提议改动让你 review。

改法：
```
data/facts/                 # 私有 git 仓库，单独 .gitignore 于主仓库之外
├── profile.yaml            # profile_fields + profile_records + preference_defaults
├── claims/claim-proj-003.json
├── rubric/v1.yaml
└── repos.yaml              # 手选的 3–5 个仓库路径与 visibility
```
- `assit validate` 用 zod 重写 ASu 的 `validate_claim_ledger.py`（逻辑照搬，约 150 行）加本项目扩展（`code_evidence`、`visibility`、证书 `expires_at`）。
- `assit sync` 把文件导入 SQLite（文件是真源，SQLite 是索引与关联层）。
- UI 到 M1 随岗位池一起做；档案与 claim 的 UI 到 M2 之后按需要再说。

### 1.3 面板分阶段落地

六面板设计保留，但落地顺序：

| 阶段 | 面板 |
|---|---|
| M1 | 岗位池（含采集源健康度）、今日（只有「新增高分岗位」一张卡） |
| M2 | 投递管线 |
| M4 | 面试训练 |
| M5 | 题库 & 复习、今日补全 |
| 按需 | 事实库 & 简历（在此之前用文件 + CLI） |

---

## 2 数据模型修订

### 2.1 岗位去重 `identity_key` 去掉薪资

BOSS 写 `25-40K·15薪`，51job 写 `2.5-4万/月`，猎聘写年薪。分桶后仍可能落到不同桶，导致同一岗位漏合，而漏合是设计自己认定的体验杀手。

```python
identity_key = sha256("|".join([company.canonical_name, normalize_title(title), city]))
```
薪资不一致时在 `jobs.attrs.salary_conflict` 标记，UI 显示两个 posting 的薪资。

### 2.2 JD 变更历史进 artifacts

`postings.jd_text` 重采即覆盖。改为：
- 每次采集，JD 内容写 `artifacts/<sha256>/jd.md`，`postings.jd_sha256` 指向最新。
- 新表 `posting_jd_history(posting_id, jd_sha256, seen_at)`。
- `applications.jd_sha256` 直接引用，不再需要投递时单独复制。

副作用：能看到「这个岗位两周内改了 3 次 JD」，本身是个信号。

### 2.3 新增四张表

```sql
-- claim 状态变更事件，降级/升级/确认全部走这里，可追溯可撤销
CREATE TABLE claim_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  field TEXT NOT NULL,                 -- verification_status | responsibility_level | risk_notes
  old_value TEXT, new_value TEXT,
  source TEXT NOT NULL,                -- manual | mock_interview | real_interview | expiry_job
  evidence_ref TEXT,                   -- interview session id / question id
  occurred_at TEXT DEFAULT (datetime('now'))
);

-- 简历每条 bullet 的落点，回答「我在 A 家简历里怎么写的这条 claim」
CREATE TABLE resume_bullets (
  id TEXT PRIMARY KEY,
  resume_version_id TEXT NOT NULL REFERENCES resume_versions(id),
  claim_id TEXT NOT NULL REFERENCES claims(id),
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  sort_order INTEGER
);

-- 模型输出缓存
CREATE TABLE model_cache (
  task TEXT NOT NULL, prompt_sha256 TEXT NOT NULL, model TEXT NOT NULL,
  response TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (task, prompt_sha256, model)
);

-- 公司别名，替代 companies.aliases JSON 数组
CREATE TABLE company_aliases (
  alias TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  confirmed_by_user INTEGER DEFAULT 0
);
```

### 2.4 小修

- `applications.confirmed_by_user` 「恒为 1」改成 `CHECK (confirmed_by_user = 1)`，让约束在 schema 层生效。
- 连接初始化必须 `PRAGMA foreign_keys = ON`，SQLite 默认不开。
- `resume_versions.claim_ids` 保留但改为派生字段，真源是 `resume_bullets`。
- `rubric_version` = rubric 文件内容的 sha256 前 8 位，不手写版本号。

---

## 3 模型路由与隐私

### 3.1 `cli:*` 不是本地

设计 10.2 把 `cli:*` 列为私有代码解析的可选项。`claude` / `codex` / `gemini` CLI 全部把内容发到各自云端，隐私边界与 `api:*` 完全相同。

改法：`model_providers.max_visibility` 按 provider 实际去向设：

| provider | max_visibility |
|---|---|
| `api:*` / `cli:*` | `public`（用户在设置里明确开启后可提到 `private`，且需自己确认雇佣合同允许） |
| `local:*` | `nda` |

结果：没配本地模型时，`code_analysis` 对 `private` 仓库会硬失败并提示。这是正确行为。

### 3.2 脱敏是一个有测试的函数，不是一句话

设计多处写「只发脱敏摘要」，但没有定义脱敏产出什么。定义 `redact(payload, level) -> RedactedPayload`：

| level | 保留 | 去除 |
|---|---|---|
| `signatures` | 函数/类签名、模块路径、控制流骨架、注释里的设计说明 | 函数体、字符串常量、配置值、URL、密钥形态的 token |
| `summary` | 本地模型生成的自然语言摘要 | 任何代码 |

`model_usage` 加 `redaction_level` 列。每个 level 配一组测试：输入含 `AKIA…` / 内网 IP / 数据库连接串的样例，断言输出不含。

### 3.3 缓存

所有 `complete()` 调用先查 `model_cache`。JD 抽取按 `jd_sha256` 天然命中，重跑打分不会重复付费。

---

## 4 项目解析（M0b）重构

### 4.1 archify 的角色

archify 是 Claude Code 技能，架构解析由模型完成。它不是确定性的，也不能保证私有代码不出本机。设计 5.4 说「解析在本地跑」在这个前提下不成立。（此判断基于设计文档对 archify 的描述；实施前确认其实际运行方式。）

改法，分两层：

| 层 | 工具 | 输出 | 是否调模型 |
|---|---|---|---|
| 结构层 | TS/JS 用 `madge` / `dependency-cruiser`，Go 用 `go list -json`，其他语言用 tree-sitter WASM 抽 import；统一在 core 里以子进程或 WASM 调用 | `repo_modules.path`、依赖边、文件→模块归属 | 否 |
| 归因层 | `git log --numstat --author` | `my_commits` / `my_share` / `touched_by_me` | 否 |
| 解读层 | archify 或本项目 prompt，走路由表 | `repo_modules.role` / `tech` / `evidence_refs`、候选 claim、候选追问题 | 是，受 visibility 拦截 |

结构层和归因层求交后再进解读层，解读层只拿到「你碰过的模块」的脱敏上下文，而不是整个仓库。

### 4.2 去掉 GitHub OAuth

M0b 只扫本地克隆的 3–5 个仓库，`git log` 够用。PR 编号映射用 `execa('gh', ['pr','list','--author','@me','--json','number,title,mergeCommit'])`，需要时再做。OAuth 流程整个删掉。

---

## 5 打分与采集（M1）修订

### 5.1 通道顺序调整

国内程序员求职时目标公司多在 BOSS / 官网 / Moka / 北森，Greenhouse 与 Lever 主要覆盖外企与出海公司。M1 顺序改为：

1. **粘贴入库通道**（零风险，覆盖一切平台）：`assit ingest --from-clipboard`（macOS 用 `pbpaste`），M1 桌面壳里是一个粘贴框，输入 URL + JD 全文，走同一套归一化与打分。这让 BOSS 岗位在扩展做出来之前就能进岗位池。
2. Moka、北森（JSON-LD / 站内接口）。
3. Greenhouse、Lever（接口最干净，留作契约测试的样板）。
4. Ashby 后置到 M1.5。

### 5.2 排序不乘置信度

`分数 × coverage` 会系统性压低信息少的岗位，等价于对 unknown 记负分。改为：
- 默认按 `final_score` 排序；
- coverage < 0.5 显示低置信标记；
- 提供 coverage 下限筛选。

### 5.3 提示注入的具体机制

- JD 抽取任务强制 JSON schema 输出，字段全部枚举或数值，没有自由文本入口。
- `score_trace.components[*].evidence` 必须通过校验：`evidence in jd_text`（归一化空白后子串匹配），不满足则该组件置 `unknown` 并标记 `suspicious`。
- 对 JD 做一次关键词扫描（「ignore previous」「忽略以上」「给…打…分」），命中即在岗位卡上打标，不改分数。

### 5.4 消费忽略原因

`jobs_ignored(job_id, reason, score_at_ignore)` 已在设计里，但没有消费方。加一个每周命令 `assit rubric-review`，输出两张表：
- 分数 ≥ 75 但被忽略的岗位，按忽略原因聚类；
- 分数 < 55 但被投递的岗位。
输出是给你看的，改 rubric 文件仍由你手动做，改完 `rubric_version` 变化会触发重算。

---

## 6 后段阶段（M2–M5）修订

- **M2**：不变，但扩展的采集能力先做「当前详情页一键入库」，列表页批量读取延后。这与粘贴通道是同一条数据路径，只是省了复制。
- **M3 邮箱**：保留，但实现方式改为 **MCP 工具 + agent**，不再是「规则分类 + 单次模型调用」的硬编码管线。
  - `apps/mcp` 用 `@modelcontextprotocol/sdk` 起一个 stdio server，工具集：
    | 工具 | 返回 | 隐私 |
    |---|---|---|
    | `email.search(since, domains?, keywords?)` | 命中白名单的邮件列表：message-id、发件域、主题、日期 | 脱敏 |
    | `email.summary(message_id)` | 发件域 + 主题 + 正文前 200 字，去签名、去电话、去链接参数 | 脱敏，`public` 级 |
    | `email.body(message_id)` | 全文 | **仅 `local:*` provider 可调用**，路由层拦截 |
    | `applications.list(status?)`、`applications.add_event(id, type, occurred_at, evidence_ref)` | 投递记录读写 | 写入的事件 `confirmed_by_user=0` |
    | `calendar.propose(application_id, when, notes)` | 生成待确认的 .ics | — |
  - IMAP 连接、白名单过滤、脱敏、凭据（Keychain）全在 core 里，MCP 层只是薄封装。agent 拿不到未脱敏内容，这一点不靠提示词，靠工具根本不返回。
  - 桌面壳内置一个 agent 会话（走路由表的 `api:*`），定时或手动触发「处理新邮件」：agent 调 `email.search` → `email.summary` → 判断类型 → `applications.add_event`。
  - 同一个 MCP server 也能挂到 Claude Code 或其他 MCP 客户端，让你在终端里问「这周有哪些约面」。
  - **人工确认位不变**：agent 写入的事件在投递管线里标「待确认」，确认后才改状态、才写日历。
  - 手动事件录入 `assit event add …` 仍然做，是 MCP 不可用时的兜底。
- **M4 面试**：
  - TechSpar 试用限时 3 天。3 天内 `docker compose up` 起不来或 API 对不上就放弃，不再试。
  - 项目深挖自建部分不变，是全项目最独特的功能。
  - TTS 从 MVP 删掉，文字问答先跑通。语音是体验加分项，不是闭环的一部分。
  - 录音转写用 faster-whisper 本地，不变。
- **M5**：不变。SM-2 与 FTS5 的判断都对。

---

## 7 工程基础（全程）

### 7.1 备份

`data/facts/` 是私有 git 仓库（推到私有远端）。`data/*.sqlite` 与 `artifacts/` 每日 `sqlite3 .backup` + rsync 到一个你信任的位置。事实库是这个项目唯一不可重建的数据。

### 7.2 三类守门测试，M0 就写

测试框架用 `vitest`，core 的测试不依赖 Electron，CI 上纯 Node 跑。

设计 13.7 的诚实性防线声称「在代码层强制」，必须有测试证明：

| 测试 | 断言 |
|---|---|
| 渲染守门 | 含 `待确认` / `已过期` claim 的 PDF 渲染抛错；`metrics.status=待补` 渲染为占位符；`responsibility_level=参与` 的 bullet 不含「主导/负责/Owner/led」 |
| 路由守门 | `private` 载荷在只有 `api:*` 时抛 `PrivacyBlocked`；降级链跳过不合格 provider |
| 去重守门 | 同岗位不同平台合并；同公司不同 role_family 放行；90 天内同 key 告警 |

### 7.3 rubric 与 prompt 版本化

`data/facts/rubric/*.yaml` 与 `apps/api/prompts/*.md` 进 git，`rubric_version` / `prompt_version` 由内容 hash 派生，写进 `score_trace` 和 `model_usage`。这样任何一个分数都能还原到当时的规则与提示词。

---

## 8 修订后路线图

| 阶段 | 内容 | 周 | 验收 |
|---|---|---|---|
| **M0a** | pnpm monorepo + `core` + `cli`；schema + 事实库文件格式 + `validate` / `sync` + provider 抽象（1 API + 1 local，`cli:*` 视同 API）+ `model_cache` + `redact()` + 简历生成 CLI + `resume_bullets` + 三类守门测试 | 1 | 粘一份 JD，命令行产出 PDF + bullet↔claim 表；私有 claim 在无本地模型时硬失败 |
| **M0b** | 结构层（import 图）+ 归因层（git log）+ 求交 + 解读层（受路由拦截）+ draft claim + `claim_events` | 1–1.5 | 一个真实仓库产出候选 claim，半数可直接进简历，每条指回模块与 commit |
| **M1** | 粘贴通道 → Moka/北森 → Greenhouse/Lever；归一化、去重（无薪资 key）、`posting_jd_history`、三态解析、三段式打分、evidence 子串校验、`rubric-review`；**立起 Electron 壳**，岗位池 + 采集源健康度两个面板 | 2–3 | 200 岗位落库，分数可解释，`unknown_dims` 清单可见；高分被忽略的岗位能聚出原因 |
| **自用一周** | 真投 10 份简历 | 1 | 用 M0+M1 完成投递，记录痛点 |
| **M2** | 扩展：详情页一键入库 → 岗位角标 → 表单填写（三类字段、绝不提交）→ 投递确认 + 快照 → `application_key` 冷却；投递管线 UI | 3 | 投完能还原当时 PDF / JD / 表单 |
| **M3** | IMAP 只读 + 白名单 + 脱敏（core）；`apps/mcp` 工具集；桌面内置 agent 会话处理新邮件；事件待确认位；`.ics` / `osascript` 写日历 | 1–2 | agent 从一封约面邮件提议出事件与日程，你确认一次即入库入日历；`email.body` 在无本地模型时被拦截 |
| **M4** | TechSpar 3 天试用门槛；项目深挖自建；答不上来 → `claim_events` 降级；文字问答；本地转写 | 2 | 对一条 claim 追问到 commit 级别；答砸后账本状态变化可追溯 |
| **M5** | 题库、面经粘贴拆题、两层解答、错题本、SM-2、看板 | 2 | 每日队列可用 |

总时长与原设计相当，但 M0a 去掉 UI 与 OAuth 后更可能真的在一周内完成，M1 的第一个通道从「外企 ATS」换成「任何平台都能用的粘贴入库」。

---

## 9 已定事项

1. **云端 provider（`api:*` / `cli:*`）不允许处理 `private` / `nda` 载荷。** `max_visibility` 固定为 `public`，设置页不提供放开的开关。没有本地模型时，私有仓库解析、`email.body`、私有 claim 的 diff 追问一律硬失败并提示配置 `local:*`。
2. **桌面壳用 Electron。** core 跑在主进程，无 sidecar。
3. **邮箱追踪保留，走 MCP + agent。** 见 §6 M3。

## 10 对 DESIGN.md 的具体修改清单

- §1.5 / §5.4：archify 定位改为「解读层与可视化」，新增结构层与归因层的确定性工具说明。
- §4.1：通道顺序改为 粘贴入库 → Moka/北森 → Greenhouse/Lever。
- §5.5：删除 GitHub OAuth，改为本地 git + 可选 `gh`。
- §6.1：删除 `分数 × 置信度` 排序，改为分数排序 + coverage 标记。
- §6.3 / §13.8：补 evidence 子串校验与注入关键词扫描。
- §8.3：TTS 移出 MVP。
- §10.1 / §10.3：`cli:*` 与 `api:*` 的 `max_visibility` 固定为 `public`，不可放开。
- §7.3：邮箱分类改为 MCP 工具 + agent，补工具表与 `email.body` 的路由拦截。
- §11.2：新增 `claim_events` `resume_bullets` `model_cache` `company_aliases` `posting_jd_history`；`identity_key` 去薪资；`confirmed_by_user` 改 CHECK；注明 `PRAGMA foreign_keys`。
- §12：整体改为 TS pnpm monorepo（`packages/core` + `apps/{cli,desktop,extension,mcp}`），Electron 桌面壳替代 FastAPI + 浏览器前端；补 Python 生态替代表；新增 `data/facts/` 私有 git。
- §14：按本文 §8 替换路线图，M0a 去 UI，M1 前加「自用一周」。
- 新增 §7.5 备份、§12.1 守门测试。
