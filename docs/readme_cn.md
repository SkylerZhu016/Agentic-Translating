# Agentic Translating · 智能体翻译工作台

[**中文**](#) | [**English**](../README.md)

面向高难文本的多方案翻译决策台，支持双向、多模型审议、证据化取舍与可复用的项目档案。

**最新版本：[v0.1.2](https://github.com/SkylerZhu016/Agentic-Translating/releases/tag/v0.1.2)**——提供 Windows 安装版和便携版，其他系统可从源码自行构建。更新内容见[发行日志](releases/0.1.2.md)。

它和通用编码 Agent 的核心区别在于，不是把翻译当作另一种编码任务来处理，而是让多个角色共同面对同一个开放问题。不同候选版本之间的分歧会作为可比较的证据保留下来，由主 Agent 决定调用哪些视角、怎样审议和融合，最终通过可追溯的文本操作生成定稿。

## 核心能力

- 支持英译中和中译英双向模式。会话创建后方向冻结，两个方向各自保存独立的工作台草稿。
- 10 个 Agent 原型，每个有 2 个方向变体：忠实、自然、声音、术语、文化、长文本、规范文本、文学、诗歌、异议。
- 动态组队和固定预设两种模式并存。第一版形成前，系统至少保留两个不同原型的成功候选。
- 两条成稿路径：主 Agent 直接编辑，或经典的"审查、筛选、编排、组装"四阶段流程。
- 分歧地图按段落、句子或诗行对齐候选正文，突出措辞、标点、数字、否定、专名、术语和结构差异。它是确定性的比较辅助，不会自动判定哪份译文正确。
- 项目级翻译档案用于维护术语、专名、人物声音、风格规则、已确认决定和背景说明。新条目先作为建议保存，只有用户批准后才进入不可变快照；会话可以冻结该快照。
- 首次运行向导与端点兼容性医生分别呈现模型列表、普通对话、真实流式响应、usage 和工具调用的检查结果。快速、均衡、深度工作流都会成为用户拥有的普通预设 revision。
- 隐私安全的 LLM 调用账本覆盖 vNext 编排链中的每次实际请求与重试、编辑对话、三镜头修订建议、兼容性医生的 chat/stream/tools 探测，以及 Agent 独立测试。它记录状态、已知 token、首包时间和总耗时；缺失 usage 时保持“未知”。模型列表查询属于元数据读取，明确不计作 LLM 调用。
- FSBP 自由文本语义边界协议。文档中最后一个独立的 `---` 作为分隔线，上方是正文，下方是注释，完整的原文始终存档。工作流默认只继承正文，也允许用户显式选择把已经分离的注释作为不受信任的辅助材料传给下游。
- 工具分阶段暴露：`call_agents`、`write_draft`、`replace_text`、`submit_final`，每轮只注入当前需要的工具。
- 版本化修改、Unicode 修订对照、证据引用、撤销与恢复。
- 用户预设版本管理、历史恢复、安全导出，支持最多 100 个文件的批量队列。
- SQLite 本地优先存储，支持 BYOK 和 OpenAI 兼容端点。API Key 不会出现在浏览器 DTO、SSE 事件、日志或导出文件中。
- 提供 Next.js Web 版、自部署 Docker 版、Windows Electron 安装版和便携版。

英译中默认产出普通中文。五言、七言、押韵等格式属于任务要求或诗歌 Agent 的专门约束，不作为系统默认行为。

## 快速开始

需要 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。首次使用时，"配置"页面会引导你添加 OpenAI 兼容端点、检查实际能力，并创建用户拥有的工作流。熟悉配置的用户也可以跳过向导，直接设置各项模型分工。

生产模式：

```bash
npm run build
npm start
```

## 工作方式

1. 在右上角选择"英译中"或"中译英"。
2. 输入原文和自然语言任务要求。可以选择一个翻译项目，再选择允许的 Agent、预设和审议模式。项目中获批准的资源会随会话冻结，之后修改项目不会改写本次上下文。
3. 动态模式下，主 Agent 会调用 2 到 4 个适合当前文本的角色。如果没有有效的选择，自动启用"语义忠实 + 目标语表达"保底组合。
4. 主 Agent 基于至少两个候选版本建立第一版，或者执行固定的四阶段深度审议。
5. 使用分歧地图查看候选真正不同的位置。比较过程不读取 Agent 注释；无法可靠对齐时会退化为全文比较。
6. 后续修改必须通过精确文本工具创建 Patch 和新版本。候选片段可以沿用现有修订流程交给编辑 Agent 采用，继续保留修改前后对比、理由和证据。

切换方向不会转换现有会话。系统会先保存当前草稿，然后切换到另一个方向的工作台草稿。旧会话仍然保留在历史中，后台任务不会因为页面关闭而取消。

## FSBP

Agent 可以自由表达：

```text
完整候选译文正文
---
可选的取舍说明、歧义或术语注释
```

规则：

- 只识别最后一个独立成行、去除空白后等于 `---` 的分隔符。
- 支持 LF 和 CRLF 换行符。
- `raw` 内容永久保存并展示。
- 默认只把 `body` 传给下游。工作流预设可以显式选择 `body_and_annotation`，此时注释作为不受信任的辅助材料一并传递。
- `annotation` 始终单独保存供用户检查。无论工作流怎样设置，分歧地图只比较 `body`。
- 产品中的四阶段流程不会要求严格的 JSON 格式。

配置 API、SSE 事件和工具参数使用 JSON，是为了精确控制系统状态，不属于 Agent 内容协议。完整定义见 [协议规范](protocol-spec.md)。

## 预设与批量

预设是用户创建的可重复工作契约，不是系统替用户决定的翻译策略。每次内容修改都会建立新的 revision，历史会话和批次继续使用冻结时的快照。

批量任务必须选择一个有效的 revision。支持 UTF-8 编码的 `.txt` 和 `.md` 文件，支持 1 到 4 个并发任务、暂停和恢复、失败项重试、路径镜像、BOM 和换行符保持，以及 Web ZIP 导出。详见 [预设与批量](preset-and-batch.md)。

## 桌面与自部署

普通 Windows 用户可直接从 [v0.1.2 Release](https://github.com/SkylerZhu016/Agentic-Translating/releases/tag/v0.1.2) 下载：

- `Agentic Translating-0.1.2-setup-x64.exe`——推荐使用的安装版；
- `Agentic Translating-0.1.2-portable-x64.exe`——无需安装的便携版。

首次启动会创建本地应用数据；覆盖升级不会删除翻译历史或用户自定义 Agent。删除端点前，程序现在会展示其当前与历史引用，并可仅解除活动绑定，不删除 Agent 定义。

Windows 打包：

```bash
npm run package:win
```

产物位于 `dist-electron/` 目录，同时生成 NSIS 安装版和便携版。桌面版数据存储在 Electron 的 `userData` 目录，密钥由 `safeStorage` 封装的本地主密钥保护。

Docker：

```bash
docker compose up --build
```

生产 Web 部署必须设置 `AGENTIC_SECRET_KEY` 环境变量。构建、备份与升级说明见 [桌面与自部署](desktop-build.md)。

## FSBP 数据集

旧版试运行实验已经退役。新版数据集、选型记录、schema、评分规则和研究
边界位于 [`FSBP_Test/`](../FSBP_Test/README.md)，对应的英文说明见
[`FSBP_Test/README.en.md`](../FSBP_Test/README.en.md)。当前 8 个开发样本和
16 个测试样本已经完成审阅并锁定。

```bash
npm run dataset:validate
npm run dataset:validate:locked
```

草稿校验允许选型尚未完成，但会严格验证已经存在的每条记录；锁定校验要求
8 个开发样本和 16 个测试样本全部确认完成，共 24 项。

## CLI 测试驾驶舱

`scripts/dev-harness.mts` 通过纯命令行驱动工作台的核心会话、HTTP、SSE 与
对话修订操作（需要 Node.js 22+）。请先启动应用，并明确传入应用实际端口：

```bash
npm run harness -- --help
npm run harness -- list --base=http://127.0.0.1:3000
```

子命令：`create`、`run`、`translate`、`events`、`chat`、`suggest`、
`state`、`list`、`rm`、`restore`。它直接复用项目自己的 SSE 解析器，并有
独立的协议终态自动测试。特点：

- 增量 SSE 输出带时间戳和阶段标签；`--trace` 在 `FSBP_Test/private/debug/` 下
  落盘 JSONL 日志。
- 失败时自动转储最近 50 条事件和会话状态并以非零码退出。
- `suggest` 只生成只读修订建议，由相互隔离的目标语读者、双语核验者和
  仲裁者三镜头组成；需要真正落版时再使用 `chat`。
- `create --request-id=<UUID>` 支持幂等重试；`run` 与 `events` 可重新连接服务端
  持有的任务和已经持久化的事件流。

测试驾驶舱不复刻配置表单和批量文件选择。浏览器仍用于布局与视觉回归；
核心模型流程验证可以完全在命令行完成。

## 当前范围

内置能力集中在通用高难翻译与诗歌相关任务，其他领域可以由用户增加自定义 Agent 和提示词包。批量输入目前支持 UTF-8 `.txt` 和 `.md`。EPUB 支持明确延期：后续应评估成熟且许可证合适的解析与回写方案，不从零重做完整格式处理。

0.1.2 已通过 911 项 Vitest 检查、TypeScript 校验、standalone 生产启动冒烟，以及 21 条当前 Playwright 流程；另有 13 条旧手动工作流夹具因已被 v3 编排取代而明确跳过。这些工程验证不等同于“FSBP 已在正式未见集上证明翻译质量优于直译”。

## 开发命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动开发服务器 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 运行 Vitest 测试 |
| `npm run build` | Next.js 生产构建 |
| `npm run e2e` | 运行 Playwright 端到端测试 |
| `npm run package:win` | 打包 Windows NSIS 安装版和便携版 |
| `npm run dataset:validate` | 校验选型中的 FSBP 数据集 |
| `npm run dataset:validate:locked` | 执行完整锁定数据集门禁 |
| `npm run harness -- --help` | 运行 CLI 测试驾驶舱 |
| `npm run test:cli` | 测试 CLI 终态与幂等语义 |
| `npm run experiment:verdict:validate -- --verdict=<路径>` | 重新计算并校验门禁裁决 |

## 文档

- [Agent 架构](agent-architecture.md)
- [双向提示词](bidirectional-prompts.md)
- [协议规范](protocol-spec.md)
- [预设与批量](preset-and-batch.md)
- [桌面与自部署](desktop-build.md)
- [设计参考与许可证](design-references.md)
- [技术报告](technical-report.md)

## 数据与安全

- Web 开发环境数据库默认位于 `data/app.db`。
- Electron 将数据库、日志和运行文件存放在应用的 `userData` 目录。
- 开发环境可以生成仅供本机使用的密钥文件。生产环境不会自动生成弱默认密钥。
- 删除会话、预设和批次前需要界面确认。预设默认采用软删除。
- 旧会话和旧预设表保留只读兼容性，迁移时不做破坏性删除。
- Agent 提出的项目资源永远不会自动批准；历史会话继续使用当时冻结的项目快照。
- 本地统计概览只返回白名单聚合，不包含提示词、原文、译文、完整端点 URL 或 API Key。数据结构能够区分供应商返回、本地估算和未知费用，但只有调用方提供可核验金额或价格快照时才会出现已知费用；当前请求通常保持“未知”，该概览永远不能当作供应商账单。

## 许可证

本项目采用 [MIT License](../LICENSE)。
