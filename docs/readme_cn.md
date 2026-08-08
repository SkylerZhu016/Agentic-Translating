# Agentic Translating · 智能体翻译工作台

[**中文**](#) | [**English**](../README.md)

面向高难度翻译任务的双向翻译系统，支持多模型、多视角审议与证据化流程。

它和通用编码 Agent 的核心区别在于，不是把翻译当作另一种编码任务来处理，而是让多个角色共同面对同一个开放问题。不同候选版本之间的分歧会作为可比较的证据保留下来，由主 Agent 决定调用哪些视角、怎样审议和融合，最终通过可追溯的文本操作生成定稿。

## 核心能力

- 支持英译中和中译英双向模式。会话创建后方向冻结，两个方向各自保存独立的工作台草稿。
- 10 个 Agent 原型，每个有 2 个方向变体：忠实、自然、声音、术语、文化、长文本、规范文本、文学、诗歌、异议。
- 动态组队和固定预设两种模式并存。第一版形成前，系统至少保留两个不同原型的成功候选。
- 两条成稿路径：主 Agent 直接编辑，或经典的"审查、筛选、编排、组装"四阶段流程。
- FSBP 自由文本语义边界协议。文档中最后一个独立的 `---` 作为分隔线，上方是正文，下方是注释。完整的原文始终存档，下游只继承正文部分。
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

- 只识别最后一个独立成行、去除空白后等于 `---` 的分隔符。
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

## FSBP 数据集

旧版试运行实验已经退役。新版数据集、选型记录、schema、评分规则和研究
边界位于 [`FSBP_Test/`](../FSBP_Test/README.md)。具体文本在逐项审查确认前
保持为空。

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
