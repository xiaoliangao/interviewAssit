# 第三方来源登记

每借一次记一笔。三个月后你不会记得哪个文件是抄的，而许可证问题恰恰在那时候才会浮出来。

格式：来源仓库 · commit/版本 · 许可证 · 用在哪 · 借的是什么

---

## 已借

（M0a 尚未 vendor 任何第三方代码文件。以下是已经参考其设计、但代码为自己重写的。）

| 来源 | 许可证 | 用在哪 | 借的是什么 |
|---|---|---|---|
| Hisn00w/ASu-skills | MIT | `packages/contract/src/claim.ts`、`packages/core/src/facts/validate.ts` | 主张—证据账本的字段设计（`responsibility_level` / `verification_status` / `boundary` / `interview_details`）与校验器的检查项。代码为 TypeScript 重写，非复制 |
| MadsLorentzen/ai-job-search | MIT | `packages/core/src/collectors/`（M1） | 「一个平台 = 一个 CLI + 稳定 JSON 契约 + 契约测试」的目录结构 |
| eatmoreduck/boss-zhipin-scraper | MIT | `vendor/boss-city-codes/`、`packages/core/src/collectors/`（M2） | 城市码表（直接取用）；**被动捕获**的采集姿势与风控识别策略为参考设计，代码是 Python，不复用 |
| shengjidaguai-china/BossHunter | **PolyForm Noncommercial 1.0** | `packages/core/src/models/`、`AccessGuard`（M2） | **仅参考设计，未复制任何代码。** `score_trace` 的 components/caps/hard_gaps 结构、风控预算的 reserve-before-navigate 语义、平台能力分级表 |
| Feashliaa/job-board-aggregator | MIT | `vendor/employer-registry/`（M1.5，**按需导入，未整包 vendor**） | `data/{greenhouse,lever,ashby}_companies.json` 的 board token 清单；以及「GitHub Action 定期刷新数据、数据与代码同仓」的维护姿势 |
| upupming/new-grad-positions | MIT | `vendor/employer-registry/`（M1.5，**当种子不当数据源**） | 国内公司名 → 官网招聘页 URL 的映射。原仓停更在 2023 届，导入后由 `assit sources doctor` 重新验证 |
| sleepinginsummer/agent-browser-cli | MIT（上游 lsdefine/GenericAgent 亦 MIT） | 通道 B 的 `BrowserBridge`（M2，**外部依赖，不并代码**） | 扩展式 CDP 桥的做法、attach/detach 时机、`network` 被动抓包、`snapshot`→`@e` 定位、`DataTransfer` 上传手法 |
| xirichuyi/boss-job-agent | MIT | [7.1](../docs/DESIGN.md) 投递闸门（M2） | **仅设计参考。** 「首轮 perRun=1 + 人工验收后才放开频率」的闸门节奏。它的定时自动打招呼不采用 |
| YangHeng66/interview-coder-cn | **CC BY-NC 4.0** | [8.5](../docs/DESIGN.md) 面试录音（M4） | **仅技术参考，未复制任何代码。** `getDisplayMedia` 取系统音频后停视频轨、双路混音降益 0.5、AudioWorklet 出 PCM、worklet 必须 connect(destination)。其实时云端转写与透明置顶/反录屏的产品形态不采用 |

## 待办

- [ ] M0b 起用 ASu-skills 的简历 HTML 模板时，把模板文件放进 `vendor/asu-resume-templates/` 并保留原 MIT 声明与 commit
- [ ] M4 接入 TechSpar（**AGPL-3.0**）时，走 Docker 自托管 + HTTP，**不并入代码**；在此登记容器镜像版本
- [ ] M1.5 真正导入 job-board-aggregator 的 token 清单时，记下 **commit sha**（注册表是供应链入口，不能跟 HEAD）
- [ ] M2 引入 agent-browser-cli 时记下版本号；它是**运行期外部工具**不是 npm 依赖，
      升级不会被 lockfile 挡住 —— 所以 `BrowserBridge` 要能在版本不匹配时显式报错
- [ ] 商业化前，就 Ocyss/boss-helper 的 LICENSE(MIT) 与 README(禁商用) 冲突向作者开 issue 书面确认

## 规则

1. **PolyForm Noncommercial**、**CC BY-NC** 的代码一行都不能进这个仓库。只读架构文档。
   CC 系列还有一层问题：它不是软件许可证，没有专利授权、不区分源码与目标码 ——
   即使不考虑 NC，也不该拿来当代码依据。
2. **AGPL-3.0** 的代码不并入。进程隔离（独立容器 + HTTP），AGPL 边界在容器外沿。
3. **MIT** 的代码可以拿，但必须保留版权声明到文件头或 `vendor/` 下的 LICENSE 副本，并在上表记一笔。
