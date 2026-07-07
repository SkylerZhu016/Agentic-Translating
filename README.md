# Agentic Translating · 智能体翻译工作台

多智能体翻译工作台。配置多个翻译 Agent（各用不同模型与提示词）并行翻译，经过四阶段统筹编排（审查、筛选、编排、组装），产出最终译文，并支持对话式选中修改。

## 项目背景

这个项目来自一个真实的翻译实践。

笔者曾需要翻译一篇英文诗歌为中文五言——极难的文本：既要忠实原意，又要保持五言格律和诗歌意象。尝试过程是这样的：

先用一套提示词发送给六个不同的大模型，获得六份翻译。然后将所有译稿交给另一个独立的 Agent，让它按流程执行审查（逐一评估质量）、筛选（选择可用译稿）、编排（规划文本结构，从各译稿中挑选最佳片段）、组装（合成最终连贯译文）。这一步之后文本已经足够好，但还需要精调，于是又在对话框里进行多轮对话，要求 AI 修改特定片段。最终得到了几乎完整的文本。

这个工作流效果很好，但如果要做成产品，还面临几个问题：

1. **同一套提示词**——不同大模型、不同提示词可以组合出大量可能，更好的做法是允许用户自定义配置：翻译 Agent 的数量、每个 Agent 的提示词、每个 Agent 使用什么模型
2. **统筹模型的选择**——轻量模型（如 flash 系列）处理复杂统筹任务可能力不从心，需要提示用户
3. **四步流程应该有标准提示词**——审查、筛选、编排、组装应该有精心设计的标准提示词，四步之间的上下文需要完整传递
4. **最终文本应该允许选中修改**——通过 AI 工具调用精确替换文本，上下文包含全部对话记录和最新版本

以上四个问题对应本产品的四个核心功能模块。

## 功能

**R1 - 多 Agent 灵活配置**
- 任意增删翻译 Agent，每个 Agent 可独立选择端点、模型、覆盖提示词
- 全局默认翻译提示词，按需覆盖

**R2 - Flash 模型警告**
- 统筹模型名含 "flash"（大小写不敏感）时，弹出"不推荐使用 flash 模型进行统筹"提示
- 支持"不再提示"持久化抑制

**R3 - 四阶段标准统筹**
- 四次独立 LLM 调用：审查、筛选、编排、组装
- 每阶段中间输出可见，可单步重跑
- 累积上下文传递，schema 校验防静默错误

**R4 - 对话式选中修改**
- 选中最终译文片段，输入修改指令
- AI 通过工具调用精确替换指定文本
- 级联匹配算法处理格式差异，歧义时拒绝并反馈
- 版本历史管理，支持恢复到任意历史版本

## 快速开始

```bash
npm install
npm run build
npm start
```

浏览器打开 `http://localhost:3000`。

首页标题显示"Agentic Translating · 智能体翻译工作台"即启动成功。

## 端点配置指引

### 预设端点

内置预设一键填入 base_url：

| 预设 | base_url |
|------|----------|
| OpenAI | `https://api.openai.com/v1` |
| Gemini (OpenAI 兼容) | `https://generativelanguage.googleapis.com/v1beta/openai` |
| DeepSeek | `https://api.deepseek.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama | `http://localhost:11434/v1` |

### 自定义 base_url

支持任何 OpenAI 兼容端点，包括：

- **中转站 / 代理**：填入中转站提供的 base_url，使用对应 API Key
- **OpenRouter**：选 OpenRouter 预设或手动填 `https://openrouter.ai/api/v1`，Key 为 OpenRouter API Key
- **Ollama 本地模型**：`http://localhost:11434/v1`，API Key 留空

## 工作流程

1. **配置**（`/config` 页面）：添加端点，创建翻译 Agent（选择端点、填入模型名、按需覆盖提示词），配置统筹模型

2. **翻译**（工作台页面）：输入原文，点击翻译按钮。所有 Agent 并行开始翻译，流式结果实时展示在卡片网格中。单 Agent 失败可单独重试，不影响其他 Agent。

3. **四步统筹**：按顺序执行四个阶段。
   - **审查**：评估每份译稿的质量（意象忠实度、格律合规、语言自然度）
   - **筛选**：选择进入编排的译稿
   - **编排**：规划最终文本结构，从各译稿中挑选最佳片段
   - **组装**：按编排方案组装最终译文

   每阶段输出结构化的 JSON 结果，可在界面中查看。重跑上游阶段后，下游阶段自动标记为过期（stale），需重新运行。

4. **选中修改**：选中最终译文中的任意片段，输入修改指令。AI 通过工具调用精确替换文本。歧义（多处匹配）时拒绝修改并提示提供更多上下文。

## 开发命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 (localhost:3000) |
| `npm run build` | 生产构建 |
| `npm start` | 启动生产服务器 |
| `npm test` | 运行 vitest 单元测试 |
| `npm run test:watch` | 监听模式运行测试 |
| `npm run e2e` | 运行 Playwright E2E 测试 |
| `npm run typecheck` | TypeScript 类型检查 (tsc --noEmit) |
| `npm run lint` | 运行 Next.js lint |

## 架构速览

```
agentic-translating/
├── app/                          # Next.js App Router
│   ├── layout.tsx                # 根布局（中文标题、顶栏）
│   ├── page.tsx                  # 工作台页面（翻译+统筹+编辑）
│   ├── config/page.tsx           # 配置页面
│   ├── history/page.tsx          # 历史会话页面
│   └── api/                      # Route Handlers
│       ├── endpoints/            # 端点 CRUD
│       ├── agents/               # Agent CRUD
│       ├── coordinator/          # 统筹配置（含 flash 检测）
│       ├── prompts/              # 提示词 CRUD + 重置
│       ├── settings/             # 设置 key-value
│       └── sessions/             # 会话（翻译 SSE / 阶段 SSE / 聊天 SSE）
├── src/
│   ├── lib/
│   │   ├── contracts/            # 契约层（C1 SSE / C2 schema / C5 状态机）
│   │   ├── db/                   # SQLite 单例 + 迁移 + 仓库
│   │   ├── guards/               # flash 检测 / 状态机守卫 / token 估算
│   │   ├── prompts/              # 提示词组装器（插值 + 覆盖优先级）
│   │   ├── llm/                  # OpenAI 兼容客户端（流式 / tools / 错误规范化）
│   │   ├── orchestration/        # 扇出编排器 + 四阶段管道
│   │   ├── chat/                 # 聊天工具循环（双协议 / 事务替换）
│   │   ├── editing/              # 级联匹配器 + 事务性替换 + 版本摘要
│   │   ├── context/              # 阶段上下文构建 + token 预算
│   │   └── services/             # 会话 + 快照服务
│   ├── components/               # UI 组件
│   └── lib/testids.ts            # data-testid 注册表（C6）
├── e2e/                          # Playwright E2E 测试
├── test/                         # vitest 单元测试 + fixture
└── data/                         # SQLite 数据库（gitignored）
    └── app.db
```

### 核心契约

- **C1 - SSE 事件协议**：翻译 / 阶段 / 聊天三种 SSE 流的事件格式
- **C2 - 阶段输出 Schema**：四阶段输出的 zod 校验 schema
- **C3 - 阶段间上下文**：累积式上下文传递与 token 预算
- **C4 - 文本替换协议**：原生 tools 协议 + JSON 围栏降级协议
- **C5 - 会话状态机**：draft → translating → translated → coordinating → assembled → refining ⇄ done
- **C6 - data-testid 注册表**：UI 测试标识符规范

详见 `src/lib/contracts/` 下各文件。

## FAQ

**Q: 统筹模型名带 "flash" 有什么影响？**
A: Flash 系列模型通常为轻量快速设计，处理复杂统筹任务（四阶段、累积上下文、schema 校验）时可能输出质量不足。系统会检测模型名中的 "flash" 字样并提示，可勾选"不再提示"抑制。

**Q: 兼容模式是什么？**
A: 当端点不支持原生 tools/function calling 时（如某些 Ollama 模型或轻量中转站），系统自动降级为 JSON 围栏协议——AI 在文本输出中嵌入 ` ```json {"old_string":"...","new_string":"..."} ``` `，服务端解析后执行替换。用户无感知，聊天面板会提示"已切换兼容模式"。

**Q: 数据存在哪里？**
A: SQLite 数据库位于 `./data/app.db`（运行启动时自动创建）。该目录已在 `.gitignore` 中，不会提交到 Git。

**Q: 如何恢复旧版本？**
A: 在版本历史面板中点击任意历史版本，确认后系统将其内容复制为新版本（append-only，不覆盖现有版本）。
