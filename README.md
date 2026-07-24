# Agentic Translating · 智能体翻译工作台

面向高难度翻译任务的双向、多模型、多视角审议与证据化成稿系统。

它与通用编码 Agent 的关键区别不是“把翻译当成另一种任务”，而是让多个角色处理同一个开放问题：候选间的分歧被保留为可比较证据，主 Agent 决定调用哪些视角、如何审议与融合，并通过可追溯的文本工具形成版本。

## 核心能力

- 英译中 / 中译英双向模式；会话创建后方向冻结，两个方向分别保存工作台草稿。
- 10 个 Agent 原型 × 2 个方向变体：忠实、自然、声音、术语、文化、长文本、规范文本、文学、诗歌与异议视角。
- 动态组队与固定预设并存；第一版前至少保有两个不同原型的成功候选。
- 主 Agent 编辑与经典“审查 → 筛选 → 编排 → 组装”两条成稿路径。
- FSBP 自由文本语义边界协议：首个独立 `---` 分隔正文与注释；完整原文留档，下游只继承正文。
- `call_agents`、`write_draft`、`replace_text`、`submit_final` 分阶段暴露，每轮只注入必要工具。
- 版本化修改、Unicode 修订对照、证据引用、撤销与恢复。
- 用户预设 revision、历史恢复、安全导出、100 文件级批量队列。
- SQLite 本地优先、BYOK、OpenAI 兼容端点；API Key 不进入浏览器 DTO、SSE、日志或导出。
- Next.js Web、自部署 Docker、Windows Electron 安装版与便携版。

英译中默认产出普通中文。五言、七言、押韵等属于任务要求或诗歌 Agent 的专门约束，不再作为系统默认。

## 快速开始

要求 Node.js 22+。

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。首次使用请在“配置”页添加 OpenAI 兼容端点并绑定模型。

生产模式：

```bash
npm run build
npm start
```

## 工作方式

1. 在右上角选择“英 → 中”或“中 → 英”。
2. 输入原文与自然语言任务要求，选择允许的 Agent、预设与审议模式。
3. 动态模式由主 Agent 调用 2—4 个适合当前文本的角色；无有效选择时自动启用“语义忠实 + 目标语表达”保底组合。
4. 主 Agent 基于至少两个候选建立第一版，或执行固定的四阶段深度审议。
5. 后续修改必须通过精确文本工具创建 Patch 和新版本，界面可查看修改前后、理由与候选证据。

切换方向不会转换现有会话。系统先保存当前草稿，然后切到另一方向的工作台草稿；旧会话仍在历史中，后台运行不因页面离开而取消。

## FSBP

Agent 可自由表达：

```text
完整候选译文正文
---
可选的取舍说明、歧义或术语注释
```

规则：

- 只识别首个独立成行、去除空白后等于 `---` 的分隔符；
- 支持 LF 与 CRLF；
- `raw` 永久保存并展示；
- 下游只获得 `body`；
- `annotation` 只供用户查看；
- 产品中的四阶段不会要求严格 JSON。

配置 API、SSE 事件和工具参数使用 JSON，是为了精确改变系统状态，不属于 Agent 内容协议。完整定义见 [docs/protocol-spec.md](docs/protocol-spec.md)。

## 预设与批量

预设是用户创建的可重复工作契约，不是系统替用户决定的翻译套路。执行内容的每次修改都会建立新 revision，历史会话和批次继续使用冻结快照。

批量任务必须选择一个有效 revision，支持 UTF-8 `.txt` / `.md`、1—4 并发、暂停恢复、失败项重试、路径镜像、BOM/换行符保持以及 Web ZIP 导出。详见 [docs/preset-and-batch.md](docs/preset-and-batch.md)。

## 桌面与自部署

Windows 打包：

```bash
npm run package:win
```

产物位于 `dist-electron/`，同时生成 NSIS 安装版与便携版。桌面数据位于 Electron `userData`，密钥由 `safeStorage` 包装的本地主密钥保护。

Docker：

```bash
docker compose up --build
```

生产 Web 必须设置 `AGENTIC_SECRET_KEY`。构建、备份与升级说明见 [docs/desktop-build.md](docs/desktop-build.md)。

## 协议实验

先编辑 `experiments/configs/main.json` 的模型名称，并只通过环境变量提供 API Key：

```bash
npm run experiment:protocol -- --config experiments/configs/main.json
npm run experiment:report -- --run <run-id>
```

实验固定 20 个公共领域双向样本和 6 个误导性注释压力样本，对比 `strict-json`、`freeform-raw` 与 `fsbp-v1`。执行器可按记录键断点续跑，不将 API Key 写入结果。

真实模型实验会产生 API 费用；仓库不预置或伪造实验结果。

## 开发命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | Vitest 测试 |
| `npm run build` | Next.js 生产构建 |
| `npm run e2e` | Playwright 端到端测试 |
| `npm run package:win` | Windows NSIS + portable |
| `npm run experiment:protocol` | 运行协议消融 |
| `npm run experiment:report` | 生成 CSV、Markdown 与 HTML 报告 |

## 文档

- [Agent 架构](docs/agent-architecture.md)
- [双向提示词](docs/bidirectional-prompts.md)
- [协议规范](docs/protocol-spec.md)
- [预设与批量](docs/preset-and-batch.md)
- [桌面与自部署](docs/desktop-build.md)
- [设计参考与许可证](docs/design-references.md)
- [技术报告](docs/technical-report.md)

## 数据与安全

- Web 开发数据库默认位于 `data/app.db`。
- Electron 将数据库、日志和运行文件放入应用 `userData`。
- 开发环境可生成仅供本机使用的密钥文件；生产环境不会自动生成弱默认密钥。
- 删除会话、预设和批次前由界面确认；预设默认软删除。
- 旧会话和旧预设表保留只读兼容，迁移不做破坏性删除。
