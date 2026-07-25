# Agentic Translating · 智能体翻译工作台

面向高难度翻译任务的双向翻译系统，支持多模型、多视角审议与证据化流程。

它和通用编码 Agent 的核心区别在于，不是把翻译当作另一种编码任务来处理，而是让多个角色共同面对同一个开放问题。不同候选版本之间的分歧会作为可比较的证据保留下来，由主 Agent 决定调用哪些视角、怎样审议和融合，最终通过可追溯的文本操作生成定稿。

## 核心能力

- 支持英译中和中译英双向模式。会话创建后方向冻结，两个方向各自保存独立的工作台草稿。
- 10 个 Agent 原型，每个有 2 个方向变体：忠实、自然、声音、术语、文化、长文本、规范文本、文学、诗歌、异议。
- 动态组队和固定预设两种模式并存。第一版形成前，系统至少保留两个不同原型的成功候选。
- 两条成稿路径：主 Agent 直接编辑，或经典的"审查、筛选、编排、组装"四阶段流程。
- FSBP 自由文本语义边界协议。文档中第一个独立的 `---` 作为分隔线，上方是正文，下方是注释。完整的原文始终存档，下游只继承正文部分。
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

打开 `http://localhost:3000`。首次使用请在"配置"页面添加 OpenAI 兼容端点并绑定模型。

生产模式：

```bash
npm run build
npm start
```

## 工作方式

1. 在右上角选择"英译中"或"中译英"。
2. 输入原文和自然语言任务要求，选择允许的 Agent、预设和审议模式。
3. 动态模式下，主 Agent 会调用 2 到 4 个适合当前文本的角色。如果没有有效的选择，自动启用"语义忠实 + 目标语表达"保底组合。
4. 主 Agent 基于至少两个候选版本建立第一版，或者执行固定的四阶段深度审议。
5. 后续修改必须通过精确文本工具创建 Patch 和新版本。界面可以查看修改前后的对比、修改理由和候选证据。

切换方向不会转换现有会话。系统会先保存当前草稿，然后切换到另一个方向的工作台草稿。旧会话仍然保留在历史中，后台任务不会因为页面关闭而取消。

## FSBP

Agent 可以自由表达：

```text
完整候选译文正文
---
可选的取舍说明、歧义或术语注释
```

规则：

- 只识别第一个独立成行、去除空白后等于 `---` 的分隔符。
- 支持 LF 和 CRLF 换行符。
- `raw` 内容永久保存并展示。
- 下游只获取 `body` 部分。
- `annotation` 仅供用户查看。
- 产品中的四阶段流程不会要求严格的 JSON 格式。

配置 API、SSE 事件和工具参数使用 JSON，是为了精确控制系统状态，不属于 Agent 内容协议。完整定义见 [docs/protocol-spec.md](docs/protocol-spec.md)。

## 预设与批量

预设是用户创建的可重复工作契约，不是系统替用户决定的翻译策略。每次内容修改都会建立新的 revision，历史会话和批次继续使用冻结时的快照。

批量任务必须选择一个有效的 revision。支持 UTF-8 编码的 `.txt` 和 `.md` 文件，支持 1 到 4 个并发任务、暂停和恢复、失败项重试、路径镜像、BOM 和换行符保持，以及 Web ZIP 导出。详见 [docs/preset-and-batch.md](docs/preset-and-batch.md)。

## 桌面与自部署

Windows 打包：

```bash
npm run package:win
```

产物位于 `dist-electron/` 目录，同时生成 NSIS 安装版和便携版。桌面版数据存储在 Electron 的 `userData` 目录，密钥由 `safeStorage` 封装的本地主密钥保护。

Docker：

```bash
docker compose up --build
```

生产 Web 部署必须设置 `AGENTIC_SECRET_KEY` 环境变量。构建、备份与升级说明见 [docs/desktop-build.md](docs/desktop-build.md)。

## 协议实验

先编辑 `experiments/configs/main.json` 中的模型名称，并通过环境变量提供 API Key：

```bash
npm run experiment:protocol -- --config experiments/configs/main.json
npm run experiment:report -- --run <run-id>
```

实验使用固定的 20 个公共领域双向样本和 6 个误导性注释压力样本，对比 `strict-json`、`freeform-raw` 和 `fsbp-v1` 三种协议。执行器可以按照记录键断点续跑，不会将 API Key 写入结果文件。

使用真实模型进行实验会产生 API 费用。仓库中不预置也不伪造实验结果。

## 开发命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动开发服务器 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 运行 Vitest 测试 |
| `npm run build` | Next.js 生产构建 |
| `npm run e2e` | 运行 Playwright 端到端测试 |
| `npm run package:win` | 打包 Windows NSIS 安装版和便携版 |
| `npm run experiment:protocol` | 运行协议消融实验 |
| `npm run experiment:report` | 生成 CSV、Markdown 和 HTML 报告 |

## 文档

- [Agent 架构](docs/agent-architecture.md)
- [双向提示词](docs/bidirectional-prompts.md)
- [协议规范](docs/protocol-spec.md)
- [预设与批量](docs/preset-and-batch.md)
- [桌面与自部署](docs/desktop-build.md)
- [设计参考与许可证](docs/design-references.md)
- [技术报告](docs/technical-report.md)

## 数据与安全

- Web 开发环境数据库默认位于 `data/app.db`。
- Electron 将数据库、日志和运行文件存放在应用的 `userData` 目录。
- 开发环境可以生成仅供本机使用的密钥文件。生产环境不会自动生成弱默认密钥。
- 删除会话、预设和批次前需要界面确认。预设默认采用软删除。
- 旧会话和旧预设表保留只读兼容性，迁移时不做破坏性删除。

## 许可证

本项目采用 [MIT License](LICENSE)。
