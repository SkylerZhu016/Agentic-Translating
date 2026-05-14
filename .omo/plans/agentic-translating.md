# Agentic Translating — 多智能体翻译工作台（从零构建）

## TL;DR

> **Quick Summary**: 从零构建一个多智能体翻译工作流产品：N 个可独立配置（模型+提示词）的翻译 agent 并行翻译 → 统筹 agent 以"审查→筛选→编排→组装"四次独立 LLM 调用（标准提示词、中间可见、完整上下文传递）产出最终译文 → 用户在最终文本上选中片段对话式修改，AI 通过工具调用精确替换文本（上下文=全部对话记录+最新版本）。
>
> **Deliverables**:
> - Next.js 15 (App Router, TypeScript) 全栈应用，`next start` 本地运行
> - OpenAI 兼容端点抽象层（baseURL+key+model，内置预设，服务端代理流式转发）
> - SQLite (better-sqlite3) 持久化：端点/agent/提示词/统筹配置/会话/结果/版本/聊天记录
> - 并行扇出编排器（超时/限流/重试/部分失败容错）+ 四阶段统筹管道（schema 校验+stale 失效）
> - 对话式选中修改（原生 tools 主协议 + JSON 围栏降级协议，级联匹配器，版本历史）
> - 中文 UI 四大面板：配置管理 / 翻译视图 / 统筹视图 / 编辑+聊天视图（visual-engineering 实现）
> - vitest 纯逻辑 TDD 套件 + Mock LLM fixture + Playwright E2E 套件
>
> **Estimated Effort**: XL（27 任务 + 4 终审）
> **Parallel Execution**: YES - 5 waves（W1:7 / W2:7 / W3:6 / W4:4 / W5:3）
> **Critical Path**: 1 → 3 → 8 → 12 → 19 → 24 → 25 → 26 → 27 → F1-F4

---

## Context

### Original Request
用户提供了 `初步设想.txt`：曾因翻译极难文本（英文诗歌→中文五言）使用一套工作流——一套提示词发给六个大模型并行翻译，再交给独立 agent 审查、筛选、编排、组装，最后多轮对话修改至成稿。现要求将此工作流产品化，解决四个问题：自定义配置（R1）、统筹模型 flash 警告（R2）、四步标准提示词+完整上下文管理（R3）、选中调用 AI 工具替换修改（R4）。用户明确：从零构建；前端由 visual-engineering agent 实现。

### Interview Summary
**Key Discussions**（用户逐项确认）:
- 技术栈: Next.js 全栈 TypeScript（Route Handler 代理 LLM 请求，避免 CORS、保护 key）
- LLM 接入: 仅 OpenAI 兼容端点抽象；内置 OpenAI/Gemini(OpenAI-shim)/DeepSeek 等预设；兼容中转站/OpenRouter/Ollama
- 统筹流程: 4 次独立调用串联，中间输出可见、单步可重跑；标准提示词内置且允许用户覆盖
- 存储: SQLite（better-sqlite3 嵌入）
- 测试: 搭建 vitest + TDD；UI 由 agent 执行 Playwright QA 场景

**Research Findings**（librarian，已采纳）:
- 扇出: per-agent P99 超时、信号量限流（≤8）、per-agent catch 返回 {text,error} 不拖垮批次（LangGraph/Swarm/生产经验）
- 阶段边界必须 schema 校验防静默空返回级联；阶段输出持久化可检查
- 编辑工具: `{old_string,new_string}` 精确匹配+唯一性约束是共识（Claude Code/Gemini CLI/Aider）；级联匹配链 exact→trimEnd→trim→unicode 规范化→fuzzy；多处匹配拒绝；CRLF/LF 规范化；版本历史自维护（无内置 undo）
- BYOK 共识: OpenAI 兼容为默认适配器（LibreChat/LobeChat/Cherry Studio）；服务端代理解决 CORS

### Metis Review
**Identified Gaps**（已全部解决并纳入本计划）:
- 6 个阻塞契约（SSE 协议/阶段 schema/阶段间上下文/函数调用回退/流式×工具调用/会话状态机）→ 已在下方"核心契约"中全部定义
- 护栏 G1-G10 + 20 项范围蔓延锁 → 纳入 Must NOT Have
- AC1-AC25 + 边界 E1-E30 → 映射到各任务的验收标准与 QA 场景
- 运营默认值: 超时 120s/并发 8(硬顶16)/重试 2 次(1s,3s 退避,仅 timeout/5xx/429)；阶段校验失败自动重试 1 次→手动重跑；重跑阶段 N → 下游 stale；多替换事务性回滚；源文上限 8k tokens；聊天上下文截断 20 轮+摘要；DB `./data/app.db` + 版本化迁移 + globalThis 单例

---

## 核心契约（Contracts — 所有任务的单一事实来源）

### C1. SSE 事件协议（服务端→客户端，`text/event-stream`，`event:` + `data: JSON`）
- **`POST /api/sessions/[id]/translate` 与 `/agents/[agentKey]/retry`**:
  `agent_start{agent_key}` → 交错 `token{agent_key,delta}` → `agent_complete{agent_key,text,latency_ms}` | `agent_error{agent_key,error}` → `fanout_complete{succeeded,failed}` → `done`
- **`POST /api/sessions/[id]/stages/[stage]/run`**:
  `stage_start{stage}` → `stage_delta{stage,delta}`（仅 orchestrate/assemble 流式转发；review/filter 不转发 delta）→ `stage_complete{stage,output}` | `stage_schema_error{stage,detail}` | `stage_error{stage,error}` → `done`
- **`POST /api/sessions/[id]/chat`**:
  `message_start` → `delta{text}` →（服务端累积 tool_calls，不转发片段）→ `tool_call{id,old_string,new_string}` → `tool_result{id,ok,version_no?,error?}` →（循环≤5 轮）→ `message_complete{version_no?}` → `done`
- 所有流以 `done` 事件终止；错误以 `error{message}` + `done` 终止。**v1 不支持断线续传**：客户端断开 → 服务端 AbortController 传播取消所有子 LLM 请求；重连=重新发起该操作。

### C2. 四阶段输出 zod schema（LLM 输出 → 提取 JSON（容错 markdown fence）→ zod 校验）
- `review`: `{assessments: [{agent_id, strengths: string[], weaknesses: string[], quality_score: number(1-10), keep: boolean}]}`
- `filter`: `{selected_agent_ids: string[], rationale: string, rejected_agent_ids: string[]}`
- `orchestrate`: `{structure_notes: string, segment_assignments: [{segment_index, source_agent_id, source_segment, rationale}]}`
- `assemble`: `{final_text: string(min 1), notes: string}`
- 校验失败：自动重试 1 次（提示词加严"严格输出 JSON"）→ 仍失败发 `stage_schema_error`，阶段标记 failed，允许手动重跑。

### C3. 阶段间上下文（累积式）
每阶段 LLM 输入 = 原文 + 全部成功翻译结果 + 之前所有阶段的结构化输出（JSON）。`buildStageContext` 实施 token 预算（默认 6000 tokens 上下文预算，可配）：超预算时截断翻译结果（保留 filter 选中的优先）并标记 `…[truncated]…`。UI 提示统筹模型建议 ≥8k context。

### C4. 文本替换工具协议（R4）
- 主协议：OpenAI 原生 `tools`（`replace_text(old_string, new_string)`，strict schema）。
- 降级协议：端点报 tools 不支持时自动切换——系统提示指示模型输出 ` ```json {"old_string":"...","new_string":"..."} ``` `，服务端解析。用户无感知。
- 应用语义：级联匹配（exact→trimEnd→trim→NFC 规范化→fuzzy≤2）；多处匹配拒绝并反馈"匹配到 N 处，请提供更长上下文"；未匹配反馈 not_found+当前全文；`new==old` 为 no-op；一轮多个替换**事务性**（任一失败全部回滚，错误反馈 LLM）；每次成功应用创建新 final_versions 行（append-only，恢复旧版本=复制为新版本）。

### C5. 会话状态机
`draft → translating → translated（含部分失败）→ coordinating（stage 1-4）→ assembled → refining ⇄ done`
- 非法转换 → API 返回 409 `{error:"invalid_state_transition"}`
- `coordinating` 中锁定最终文本编辑/聊天；重跑阶段 N → 阶段 N+1..4 标记 `stale`，强制顺序重跑
- 会话创建时冻结 `config_snapshot`（端点/agent/提示词/统筹配置深拷贝）；之后修改配置不影响进行中会话

### C6. UI data-testid 注册表（任务 3 落地为 `src/lib/testids.ts`，FE/BE/QA 共用）
端点:`endpoint-form/name-input/baseurl-input/key-input/save-button`、`endpoint-list-item`；Agent:`agent-card/add-agent-button/model-input/prompt-override-toggle`；统筹:`coordinator-model-input/flash-warning/dont-show-again-checkbox`；翻译:`source-input/translate-button/agent-stream-card/agent-status-{streaming,complete,error}/retry-agent-button`；统筹视图:`stage-stepper/run-stage-button/stage-output-panel/stage-stale-badge`；编辑:`final-text/edit-popover/edit-instruction/edit-submit/chat-panel/chat-message/tool-call-badge/version-history/version-item`。

---

## Work Objectives

### Core Objective
交付一个本地运行的多智能体翻译工作台：可配置的多模型并行翻译 + 标准化四步统筹 + 对话式选中修改（工具调用替换+版本历史），R1-R4 全部落地。

### Concrete Deliverables
- 可 `npm run build && npm start` 运行的 Next.js 应用（Node runtime only）
- 8 张 SQLite 表 + 迁移机制 + 中文内置提示词种子（翻译默认+四阶段）
- 15 个 API 路由（配置 CRUD/会话/翻译 SSE/阶段 SSE/聊天 SSE/版本恢复）
- 4 个 UI 面板（视觉工程级中文界面，单一浅色主题）
- vitest 套件（纯逻辑 TDD）+ Playwright 套件（mock LLM 全链路 E2E）

### Definition of Done
- [ ] `npm run build` 成功（`tsc --noEmit` 零错误、零 lint 错误）
- [ ] `npx vitest run` 全部通过（无真实 LLM 调用）
- [ ] `npx playwright test` 全部通过（mock LLM fixture）
- [ ] R1-R4 各有可执行验证（见各任务 QA）
- [ ] 全部 Must NOT Have 经 F1 审计缺席

### Must Have
- R1: agent 数量增删、每 agent 独立 endpoint/model/prompt 覆盖、全局默认翻译提示词
- R2: 统筹模型名含 "flash"（大小写不敏感）→ 显示"不推荐使用flash模型进行统筹"+"不再提示"持久化抑制
- R3: 四步标准中文提示词内置+可覆盖；4 次独立调用；中间可见；累积上下文；schema 校验
- R4: 选中文本→指令→AI 工具调用替换→新版本；上下文=全部对话+最新文本
- 契约 C1-C6 全部落地
- Metis 护栏: 快照冻结、AbortController 传播、事务性替换、stale 失效、部分失败容错

### Must NOT Have (Guardrails)
- ❌ 自定义/增删/重排四阶段；跳过阶段（G1） ❌ 文本替换之外的任何工具（G2）
- ❌ 单会话多原文/批量翻译（G3） ❌ Edge runtime（G4，一律 `export const runtime='nodejs'`）
- ❌ Anthropic/Gemini 原生 SDK 适配器（G5） ❌ 活动会话读取 live 配置（G6）
- ❌ 流式 token 落库（G7，仅完成态落库） ❌ LangChain/LlamaIndex/NextAuth/BullMQ/Redis（G9）
- ❌ 四大面板之外的页面（无设置页/帮助页/主题切换/i18n 框架）（G10）
- ❌ 翻译记忆库/术语库/导出 PDF-DOCX/diff 视图/成本统计/模型跑分/插件/RAG/语音/自动语言检测/后台队列/分支版本/协作分享/DB 加密/编辑器 undo（版本历史代替）
- ❌ 测试或 CI 调用真实 LLM（一律 mock fixture） ❌ 任何 `as any`/`@ts-ignore`/空 catch

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — 全部验证由 agent 执行。禁止"用户手动确认"类验收。

### Test Decision
- **Infrastructure exists**: NO → 本计划搭建（任务 1）
- **Automated tests**: YES (TDD) — vitest；纯逻辑任务先写测试（RED→GREEN→REFACTOR）
- **Framework**: vitest（node 环境）+ Playwright（独立 testDir=`e2e/`）+ Mock LLM fixture（任务 4）
- **QA 工具分工**: 纯逻辑=Bash(vitest)；API=Bash(curl 打 `next start`)；UI=Playwright；证据落盘 `.omo/evidence/`

### QA Policy
每个任务必须含 ≥1 happy path + ≥1 失败/边界场景，给出确切工具/步骤/断言/证据路径（`.omo/evidence/task-{N}-{slug}.{ext}`）。编排器将核查证据文件存在才允许标记完成。

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1（地基+契约，7 任务全并行）:
├── 1. 项目脚手架（Next.js15+TS+Tailwind+vitest+git）[quick]
├── 2. DB 层：better-sqlite3 单例+迁移+schema v1(8 表) [quick]
├── 3. 契约层：zod schema+领域类型+SSE 事件+testid 注册表 [quick]
├── 4. Mock LLM fixture（可配置流式/错误/无 tools/坏 JSON）[quick]
├── 5. 提示词组装器（插值+覆盖优先级）[TDD, quick]
├── 6. flash 检测+会话状态机+SSE 编解码 [TDD, quick]
└── 7. 级联匹配器+replaceText+版本化 [TDD, deep]

Wave 2（核心服务，7 任务全并行）:
├── 8. LLM 客户端（流式/tools/错误规范化/中止传播）[TDD, deep] (dep:3,4)
├── 9. 阶段上下文构建器+token 预算+聊天截断 [TDD, quick] (dep:3)
├── 10. 扇出编排器（限流/超时/重试/部分失败）[TDD, deep] (dep:8)
├── 11. 四阶段管道运行器（校验/重试/stale）[TDD, deep] (dep:8,9)
├── 12. 聊天工具循环（双协议/事务替换/≤5 轮）[TDD, deep] (dep:7,8)
├── 13. 会话+快照服务（创建/状态转换/冻结）[TDD, quick] (dep:2,3,6)
└── 14. 内置中文提示词种子（翻译默认+四阶段，诗歌级）[writing] (dep:2,3)

Wave 3（API+应用壳，6 任务全并行）:
├── 15. 配置 CRUD 路由（endpoints/agents/coordinator/prompts/settings+flash 警告）[unspecified-high] (dep:2,3,13)
├── 16. 会话路由（create/list/get 全态/版本恢复）[quick] (dep:13)
├── 17. 翻译 SSE 路由（fanout+单 agent 重试）[unspecified-high] (dep:10,13)
├── 18. 阶段 SSE 路由（run 单阶段）[unspecified-high] (dep:11,16)
├── 19. 聊天 SSE 路由（工具循环）[unspecified-high] (dep:12,16)
└── 20. 应用壳+设计 tokens+布局+testid 规范落地 [visual-engineering] (dep:1,3)

Wave 4（UI 四面板，4 任务全并行，全部 visual-engineering）:
├── 21. 配置 UI（端点/agent 编辑器/统筹配置/提示词编辑/flash 弹窗）[visual-engineering] (dep:15,20)
├── 22. 翻译视图（原文输入+agent 流式卡片网格+重试）[visual-engineering] (dep:17,20)
├── 23. 统筹视图（4 步 stepper+阶段输出面板+stale+重跑）[visual-engineering] (dep:18,20)
└── 24. 编辑+聊天视图（final-text 选中 popover+聊天面板+版本历史）[visual-engineering] (dep:19,20)

Wave 5（集成+硬化，3 任务）:
├── 25. Playwright E2E 套件（mock LLM 全链路 AC16-22）[unspecified-high+playwright] (dep:21-24)
├── 26. 边界硬化+集成测试（中止/并发/DB 锁/E 案例, AC1-4,23-25）[deep] (dep:25)
└── 27. README+运行脚本+最终构建验证 [writing] (dep:26)

Wave FINAL（4 并行终审→用户确认）:
├── F1. 计划合规审计 [oracle]
├── F2. 代码质量审查 [unspecified-high]
├── F3. 真实手动 QA [unspecified-high+playwright]
└── F4. 范围保真检查 [deep]

Critical Path: 1→3→8→12→19→24→25→26→27→F1-F4
Max Concurrent: 7（Wave 1/2）
```

### Dependency Matrix（全任务）
- **1-7**: 无依赖 | 被依赖: 1→20； 2→13,14,15； 3→8,9,13,15,20； 4→8； 5→10,11,14； 6→13； 7→12
- **8**: dep 3,4 | →10,11,12 **9**: dep 3 | →11 **10**: dep 8(5) | →17 **11**: dep 8,9(5,14) | →18
- **12**: dep 7,8(14) | →19 **13**: dep 2,3,6 | →15,16,17 **14**: dep 2,3(5) | →15
- **15**: dep 2,3,13,14 | →21 **16**: dep 13 | →18,19 **17**: dep 10,13 | →22
- **18**: dep 11,16 | →23 **19**: dep 12,16 | →24 **20**: dep 1,3 | →21,22,23,24
- **21-24**: dep 见上 | →25 **25**: dep 21-24 | →26 **26**: dep 25 | →27 **27**: dep 26 | →F1-F4
- （括号内为软依赖——使用该产物但不阻塞启动）

### Agent Dispatch Summary
- **Wave 1 (7)**: 1-6 → `quick`；7 → `deep`
- **Wave 2 (7)**: 8,10,11,12 → `deep`；9,13 → `quick`；14 → `writing`
- **Wave 3 (6)**: 15,17,18,19 → `unspecified-high`；16 → `quick`；20 → `visual-engineering`
- **Wave 4 (4)**: 21-24 → `visual-engineering`
- **Wave 5 (3)**: 25 → `unspecified-high`(+playwright skill)；26 → `deep`；27 → `writing`
- **FINAL (4)**: F1 → `oracle`；F2,F3 → `unspecified-high`；F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task。每个任务含 Agent Profile + Parallelization + QA Scenarios。
> 标签格式：TODO 用裸数字 `1.`，终审波用 `F1.`。

- [x] 1. 项目脚手架（Next.js 15 + TS + Tailwind + vitest + git）

  **What to do**:
  - 在 `D:\Agentic Translating` 初始化 git 仓库并创建 `.gitignore`（`node_modules/`, `.next/`, `data/`, `.omo/evidence/`）
  - 脚手架 Next.js 15 App Router + TypeScript + Tailwind CSS v4（`create-next-app` 或手工等价：`package.json`, `tsconfig.json`, `next.config.ts`, `app/layout.tsx`, `app/page.tsx` 占位, `app/globals.css`）
  - 安装并配置 vitest（`vitest.config.ts`，node 环境，`include: ['src/**/*.test.ts','test/**/*.test.ts']`，`exclude: ['e2e/**']`）+ npm scripts：`dev/build/start/test/test:watch/lint/typecheck/e2e`
  - 配置 ESLint（next lint 等价）+ `paths` 别名 `@/* → ./*`
  - 安装核心依赖：`better-sqlite3`, `zod`；dev 依赖：`vitest`, `@types/better-sqlite3`, `@playwright/test`（playwright 仅安装不配置，任务 25 配置）
  - 写冒烟测试 `test/smoke.test.ts`（1+1=2）验证 vitest 链路
  - 验证 `npm run dev` 可启动、`npm run build` 可编译

  **Must NOT do**:
  - 不安装 LangChain/LlamaIndex/Vercel AI SDK/NextAuth/Prisma/Drizzle（G9，原生 SQL）
  - 不配置 Docker/Electron；不创建任何 `docs/` 目录文件
  - 不使用 bun 运行 Next.js（统一 npm + Node，避免 better-sqlite3 原生模块兼容问题）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 标准脚手架，无业务逻辑
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `frontend-ui-ux`（本任务无 UI 设计）

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 1（与 2-7）
  - **Blocks**: 20, 25, 26, 27 — **Blocked By**: None

  **References**:
  - Next.js App Router 项目结构: `https://nextjs.org/docs/app/getting-started/project-structure` — 目录约定
  - vitest 配置: `https://vitest.dev/config/` — node 环境 + include/exclude
  - Tailwind v4 安装: `https://tailwindcss.com/docs/installation/framework-guides/nextjs` — `@import "tailwindcss"` 方式
  - **WHY**: 后续所有任务的目录与脚本约定以本任务产物为准

  **Acceptance Criteria**:
  - [ ] `npm run typecheck`（`tsc --noEmit`）退出码 0
  - [ ] `npx vitest run` 通过冒烟测试（1 passed）
  - [ ] `npm run build` 成功产出 `.next/`
  - [ ] `git log --oneline` 有首次提交；`data/` 在 `.gitignore`

  **QA Scenarios**:
  ```
  Scenario: 脚手架完整可用（happy path）
    Tool: Bash
    Preconditions: 任务完成，依赖已安装
    Steps:
      1. 运行 `npm run typecheck` → 期望退出码 0，无输出错误
      2. 运行 `npx vitest run` → 期望输出包含 "1 passed"
      3. 运行 `npm run build` → 期望输出 "Compiled successfully"，无 Error
    Expected Result: 三条命令全部成功
    Failure Indicators: 任一命令退出码非 0 或输出含 "Error"
    Evidence: .omo/evidence/task-1-scaffold-build.txt（三命令完整输出）

  Scenario: 违禁依赖缺席（negative）
    Tool: Bash
    Preconditions: package.json 已生成
    Steps:
      1. 运行 `node -e "const p=require('./package.json');const bad=['langchain','@langchain/core','llamaindex','ai','next-auth','bullmq','ioredis','prisma','drizzle-orm'];const all={...p.dependencies,...p.devDependencies};const hit=bad.filter(b=>all[b]);if(hit.length){console.error('FORBIDDEN:',hit);process.exit(1)}console.log('CLEAN')"`
    Expected Result: 输出 "CLEAN"，退出码 0
    Failure Indicators: 输出 FORBIDDEN 列表
    Evidence: .omo/evidence/task-1-forbidden-deps.txt
  ```

  **Commit**: YES — `chore(scaffold): Next.js 15 + TS + Tailwind + vitest 项目脚手架`
  - Files: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `app/*`, `test/smoke.test.ts`, `.gitignore`
  - Pre-commit: `npm run typecheck && npx vitest run`

- [x] 2. DB 层：better-sqlite3 单例 + 迁移机制 + schema v1（8 表）

  **What to do**（TDD：先写 `test/db/migrations.test.ts` 与 `test/db/singleton.test.ts`）:
  - `src/lib/db/index.ts`：better-sqlite3 单例（`globalThis.__db` 模式防 Next.js HMR 句柄泄漏）；DB 路径 `./data/app.db`（启动时 `mkdir -p data`）；开启 `PRAGMA journal_mode=WAL`、`foreign_keys=ON`
  - `src/lib/db/migrate.ts`：版本化迁移机制——`migrations` 表记录 `version`；`migrations/*.sql` 按序执行；事务包裹；重复执行幂等
  - `src/lib/db/migrations/0001_init.sql` 建 8 表：
    - `endpoints(id INTEGER PK, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`
    - `prompt_templates(id INTEGER PK, kind TEXT NOT NULL CHECK(kind IN ('translator','review','filter','orchestrate','assemble')), name TEXT NOT NULL, content TEXT NOT NULL, is_builtin INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`
    - `translator_agents(id INTEGER PK, name TEXT NOT NULL, endpoint_id INTEGER NOT NULL REFERENCES endpoints(id), model TEXT NOT NULL, prompt_override TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`
    - `coordinator_config(id INTEGER PK CHECK(id=1), endpoint_id INTEGER REFERENCES endpoints(id), model TEXT NOT NULL DEFAULT '', chat_endpoint_id INTEGER REFERENCES endpoints(id), chat_model TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')))`
    - `settings(key TEXT PK, value TEXT NOT NULL)`
    - `sessions(id TEXT PK, source_text TEXT NOT NULL, source_lang TEXT NOT NULL DEFAULT '英文', target_lang TEXT NOT NULL DEFAULT '中文五言', state TEXT NOT NULL DEFAULT 'draft', config_snapshot TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`
    - `translation_results(id INTEGER PK, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, agent_key TEXT NOT NULL, agent_snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','streaming','complete','error')), output_text TEXT, error TEXT, latency_ms INTEGER, attempt INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, agent_key))`
    - `stage_outputs(id INTEGER PK, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, stage TEXT NOT NULL CHECK(stage IN ('review','filter','orchestrate','assemble')), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','failed','stale')), prompt_used TEXT, raw_output TEXT, parsed_output TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, stage))`
    - `final_versions(id INTEGER PK, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, version_no INTEGER NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('assemble','edit','restore')), created_at TEXT DEFAULT (datetime('now')), UNIQUE(session_id, version_no))`
    - `chat_messages(id INTEGER PK, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')), content TEXT NOT NULL DEFAULT '', tool_calls TEXT, tool_results TEXT, version_id INTEGER REFERENCES final_versions(id), created_at TEXT DEFAULT (datetime('now')))`
  - `src/lib/db/repositories.ts`：每表的类型化 CRUD 函数（better-sqlite3 prepared statements，同步 API）

  **Must NOT do**:
  - 不引入 ORM（Prisma/Drizzle/Kysely）；不写流式 token 相关表（G7）
  - 不创建 users/accounts 相关表；不使用 Edge 兼容层
  - 不把 `data/` 提交进 git

  **Recommended Agent Profile**:
  - **Category**: `quick` — 静态 schema + 成熟单例模式
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 1（与 1,3-7）
  - **Blocks**: 13, 14, 15 — **Blocked By**: None（仅依赖任务 1 的 package.json，可并行写文件）

  **References**:
  - better-sqlite3 API: `https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md` — prepared statement/事务/pragma
  - Next.js HMR 单例模式（globalThis）: `https://www.prisma.io/docs/orm/more/help-and-troubleshooting/nextjs-help`（模式通用，仅借单例思路，不装 prisma）
  - **WHY**: 8 表结构是 C5 状态机、G6 快照、R4 版本历史的落库载体，字段名全计划共用

  **Acceptance Criteria**:
  - [ ] `test/db/migrations.test.ts`：全新 DB 执行迁移后 `sqlite_master` 含全部 8 表；重复迁移不报错且版本不重复
  - [ ] `test/db/singleton.test.ts`：两次 `getDb()` 返回同一实例；WAL 模式已开启
  - [ ] repositories 各表 insert/select 往返测试通过
  - [ ] `npx vitest run test/db` 全绿

  **QA Scenarios**:
  ```
  Scenario: 迁移与 CRUD 往返（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/db` → 期望全部 passed
      2. 运行 `node -e "const{getDb}=require('./src/lib/db')..."`（或 vitest 内断言）→ 8 表存在
    Expected Result: 8 表创建成功，CRUD 往返一致
    Failure Indicators: 表缺失 / 外键报错 / 非幂等
    Evidence: .omo/evidence/task-2-db-migrations.txt

  Scenario: 幂等与级联删除（negative/edge）
    Tool: Bash
    Steps:
      1. vitest 断言：对同一 DB 连跑 3 次 migrate() → migrations 表仅 1 行 version=1
      2. vitest 断言：删除一个 sessions 行 → 其 translation_results/stage_outputs/final_versions/chat_messages 子行被 CASCADE 删除
    Expected Result: 幂等成立；级联生效
    Failure Indicators: 重复 version 行 / 子行残留
    Evidence: .omo/evidence/task-2-db-idempotent-cascade.txt
  ```

  **Commit**: YES — `feat(db): better-sqlite3 单例 + 版本化迁移 + schema v1`
  - Files: `src/lib/db/*`, `test/db/*`
  - Pre-commit: `npx vitest run test/db`

- [x] 3. 契约层：zod schema + 领域类型 + SSE 事件 + testid 注册表

  **What to do**（TDD：先写 `test/contracts/*.test.ts`）:
  - `src/lib/contracts/types.ts`：领域类型——`EndpointConfig`, `TranslatorAgentConfig`, `CoordinatorConfig`, `SessionState`（枚举：draft/translating/translated/coordinating/assembled/refining/done）, `Stage`（枚举：review/filter/orchestrate/assemble）, `TranslationResult`, `StageOutput`, `FinalVersion`, `ChatMessage`, `ConfigSnapshot`
  - `src/lib/contracts/schemas.ts`：zod schema——配置 CRUD 入参（endpoint/agent/coordinator/prompt）；**C2 四阶段输出 schema**（review/filter/orchestrate/assemble，严格按契约节定义）；`replace_text` 工具参数 `{old_string: string(min 1), new_string: string}`；`SessionState` 合法转换表 `ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]>`（draft→translating；translating→translated；translated→coordinating,translating；coordinating→assembled,coordinating；assembled→refining,done；refining→refining,done；done→refining）
  - `src/lib/contracts/sse.ts`：SSE 事件类型联合（按 C1 三组事件全量枚举）+ `encodeSSE(event, data): string`（`event: X\ndata: JSON\n\n`）+ `parseSSEChunk(buffer)` 解析器（处理跨 chunk 截断、多事件 chunk、注释行、`\r\n`）
  - `src/lib/testids.ts`：C6 全部 data-testid 常量对象（按面板分组），导出 `TID`
  - `src/lib/constants.ts`：运营默认值——`AGENT_TIMEOUT_MS=120_000`, `MAX_CONCURRENCY=8`, `HARD_CONCURRENCY_CAP=16`, `RETRY_DELAYS_MS=[1000,3000]`, `STAGE_CONTEXT_TOKEN_BUDGET=6000`, `SOURCE_TOKEN_LIMIT=8000`, `CHAT_LOOP_MAX=5`, `CHAT_CONTEXT_TURNS=20`

  **Must NOT do**:
  - 不定义四阶段之外的 Stage 值（G1）；不定义 replace_text 之外的工具（G2）
  - 不在本任务实现任何 LLM 调用或 DB 访问（纯类型/纯函数）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 静态契约定义 + 纯函数编解码
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 1（与 1,2,4-7）
  - **Blocks**: 8, 9, 13, 15, 20 — **Blocked By**: None

  **References**:
  - zod: `https://zod.dev/?id=basic-usage` — discriminatedUnion/enum/min
  - OpenAI streaming SSE 格式: `https://platform.openai.com/docs/api-reference/chat/create`（stream 选项的 data 行格式）— parseSSEChunk 需兼容
  - 计划"核心契约 C1/C2/C5/C6"节 — 逐字实现
  - **WHY**: 本文件是全计划 FE/BE/QA 的唯一契约源，任何偏差会导致波次间接口漂移

  **Acceptance Criteria**:
  - [ ] 四阶段 schema 对合法样例 parse 成功、对缺字段/错类型样例 safeParse 失败（每阶段正反各 1 例）
  - [ ] `parseSSEChunk` 通过：跨 chunk 截断拼接、单 chunk 多事件、注释行忽略、CRLF
  - [ ] `ALLOWED_TRANSITIONS` 覆盖 7 状态且非法转换（如 done→translating）被拒绝
  - [ ] `TID` 覆盖 C6 全部条目；`npx vitest run test/contracts` 全绿

  **QA Scenarios**:
  ```
  Scenario: 契约正反向校验（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/contracts` → 全部 passed
      2. 断言 assemble schema 接受 {final_text:"月落乌啼霜满天",notes:"x"} 并拒绝 {final_text:"",notes:"x"}
    Expected Result: 全部断言通过
    Failure Indicators: 合法样例被拒 / 非法样例被收
    Evidence: .omo/evidence/task-3-contracts.txt

  Scenario: SSE 解析器边界（negative/edge）
    Tool: Bash
    Steps:
      1. vitest：输入被截断的 "event: token\nda" + 下一 chunk "ta: {\"a\":1}\n\n" → 解析出完整 token 事件
      2. vitest：输入 ": ping\n\n"（注释）→ 产出 0 事件不抛错
    Expected Result: 截断拼接正确；注释安全忽略
    Failure Indicators: 抛异常 / 事件丢失 / 事件重复
    Evidence: .omo/evidence/task-3-sse-parser.txt
  ```

  **Commit**: YES — `feat(contracts): zod schema + SSE 协议 + 状态机 + testid 注册表`
  - Files: `src/lib/contracts/*`, `src/lib/testids.ts`, `src/lib/constants.ts`, `test/contracts/*`
  - Pre-commit: `npx vitest run test/contracts`

- [x] 4. Mock LLM fixture（可配置的 OpenAI 兼容模拟服务器）

  **What to do**:
  - `test/fixtures/mock-llm.ts`：Node `http.createServer` 实现 `POST /v1/chat/completions`，模拟 OpenAI 兼容端点，行为通过请求头 `x-mock-behavior` 或 `setBehavior(model, behavior)` 配置：
    - `stream`：SSE delta 流（`data: {...delta:{content}}` 多块 + `data: [DONE]`），每块可配 `chunkDelayMs`
    - `non_stream`：一次性完整 JSON 响应
    - `error`：可配 status（401/429/500）+ OpenAI 风格错误 body `{error:{message,type,code}}`
    - `malformed_json`：content 返回非法 JSON（用于阶段 schema 校验失败路径）
    - `json_content`：content 返回可配 JSON 字符串（用于阶段成功路径）
    - `no_tools_error`：带 `tools` 参数的请求返回 400 `{error:{message:"tools is not supported"}}`
    - `tool_call`：返回含 `tool_calls`（`replace_text`）的响应（流式 tool_calls delta 或非流式，可配）
    - `echo`：回显最后一条 user message 前 N 字符（通用兜底）
  - 记录请求日志（body/headers 快照数组）供测试断言；`startMockLLM({port})` 返回 `{url, close(), setBehavior(), getRequests()}`
  - `test/fixtures/mock-llm.test.ts`：fixture 自测（每种行为 1 例）

  **Must NOT do**:
  - 不依赖外部网络；不引入 express/koa 等框架（裸 http 足够）
  - 不在 fixture 中写死业务提示词（fixture 无领域知识，只按 behavior 响应）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 协议明确的测试工具
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 1（与 1-3,5-7）
  - **Blocks**: 8（间接 10,11,12）, 25 — **Blocked By**: None

  **References**:
  - OpenAI chat completions 流式 chunk 格式: `https://platform.openai.com/docs/api-reference/chat/streaming` — delta/tool_calls/[DONE] 逐字节对齐
  - OpenAI function calling 响应格式: `https://platform.openai.com/docs/guides/function-calling` — tool_calls 数组结构
  - **WHY**: 本 fixture 是 AC3/AC5/AC6/AC18-24 的硬依赖（Metis 指令：CI 永不调真实 LLM），格式偏差会让全部下游测试失真

  **Acceptance Criteria**:
  - [ ] 8 种 behavior 各有自测通过；流式输出可被任务 3 的 `parseSSEChunk` 正确解析
  - [ ] `getRequests()` 返回完整请求快照（含 tools 参数存在性）
  - [ ] `npx vitest run test/fixtures` 全绿；server `close()` 后端口释放

  **QA Scenarios**:
  ```
  Scenario: 流式与非流式行为（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/fixtures/mock-llm.test.ts` → 全部 passed
      2. 断言 stream 行为输出以 `data: ` 行组成、以 `data: [DONE]` 结束
    Expected Result: 各行为响应格式与 OpenAI 规范一致
    Failure Indicators: SSE 格式缺 \n\n / [DONE] 缺失 / JSON 缺 usage 字段
    Evidence: .omo/evidence/task-4-mock-behaviors.txt

  Scenario: 错误与工具拒绝行为（negative）
    Tool: Bash
    Steps:
      1. vitest：behavior=error(429) → 响应 status 429 且 body 含 error.type
      2. vitest：behavior=no_tools_error，请求带 tools → 400；不带 tools → 正常 200
    Expected Result: 错误形态精确可配
    Failure Indicators: 错误 status 不对 / 带 tools 也返回 200
    Evidence: .omo/evidence/task-4-mock-errors.txt
  ```

  **Commit**: YES — `test(fixtures): OpenAI 兼容 Mock LLM 服务器`
  - Files: `test/fixtures/mock-llm.ts`, `test/fixtures/mock-llm.test.ts`
  - Pre-commit: `npx vitest run test/fixtures`

- [x] 5. 提示词组装器（插值 + 覆盖优先级）（TDD）

  **What to do**（先写 `test/prompts/assemble.test.ts`）:
  - `src/lib/prompts/assemble.ts`：
    - `interpolate(template, vars: Record<string,string>)`：`{{var}}` 语法替换；未知变量保留原文并收集到 `warnings`；模板中变量在 vars 缺失时抛 `PromptAssemblyError`（含缺失变量名列表）
    - `resolveTranslatorPrompt(agent, defaultTemplate)`：覆盖优先级——`agent.prompt_override`（非空字符串）→ 否则 `defaultTemplate`（R1 核心逻辑）
    - `buildTranslatorPrompt(template, {source_lang, target_lang, source_text, extra_instructions?})`：产出 `{system, user}` 消息对；user 含 `{{source_lang}}/{{target_lang}}/{{source_text}}` 插值后的完整内容；`extra_instructions` 存在时追加"附加要求"段落
    - `buildStagePrompt(stageTemplate, contextJson)`：注入阶段上下文 JSON（C3）→ `{system, user}`；system 固定含"只输出符合 schema 的 JSON，不要 markdown 之外的文字"与对应阶段 JSON schema 文本
  - 纯函数、零 IO；导出类型 `ChatMessageInput {role:'system'|'user'|'assistant'|'tool', content:string}`

  **Must NOT do**:
  - 不做 HTML/Markdown 转义（纯文本管道）；不内置任何具体提示词文案（文案归任务 14）
  - 不实现 token 截断（归任务 9）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 纯字符串逻辑，测试先行
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 1（与 1-4,6,7）
  - **Blocks**: 10, 11, 14 — **Blocked By**: None

  **References**:
  - 计划契约 C2/C3 节 — 阶段消息结构与 JSON-only 指令
  - 设想文件 R1「每个agent的提示词是否单独设置」— resolveTranslatorPrompt 的语义来源
  - **WHY**: 覆盖优先级是 R1 的直接实现，阶段消息结构是 C2/C3 的载体

  **Acceptance Criteria**（TDD 全绿）:
  - [ ] 插值：正常替换/缺失变量抛错含变量名/未知 `{{x}}` 保留+warning
  - [ ] 覆盖优先级：override 非空用 override、null/空串用 default
  - [ ] buildTranslatorPrompt 输出含插值后的原文且不含残留 `{{source_text}}`
  - [ ] buildStagePrompt 的 system 含 JSON-only 指令与对应 stage schema 文本

  **QA Scenarios**:
  ```
  Scenario: 组装与优先级（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/prompts` → 全部 passed
      2. 断言 override="译为七言" 时输出 system 含 "七言"，default 含 "五言" 时被覆盖
    Expected Result: 优先级与插值全部符合规格
    Failure Indicators: 优先级颠倒 / 残留模板变量
    Evidence: .omo/evidence/task-5-prompt-assembly.txt

  Scenario: 缺失变量报错（negative）
    Tool: Bash
    Steps:
      1. vitest：interpolate("{{a}}{{b}}", {a:"1"}) → 抛 PromptAssemblyError 且 message 含 "b"
    Expected Result: 精确报出缺失变量名
    Failure Indicators: 静默通过 / 报错不含变量名
    Evidence: .omo/evidence/task-5-missing-var.txt
  ```

  **Commit**: YES — `feat(prompts): 提示词组装器（插值+覆盖优先级）`
  - Files: `src/lib/prompts/assemble.ts`, `test/prompts/assemble.test.ts`
  - Pre-commit: `npx vitest run test/prompts`

- [x] 6. 纯逻辑守卫工具集：flash 检测 + 状态机守卫 + token 估算（TDD）

  **What to do**（先写 `test/guards/*.test.ts`）:
  - `src/lib/guards/flash.ts`：`detectFlashModel(modelName)`——大小写不敏感、词边界匹配 "flash"（正则 `/flash/i` 但排除… 注：按 Metis AC14，`"reflash-model"` 不应误报——实现为 `/(^|[^a-z])flash([^a-z]|$)/i`，即 flash 前后为非字母或边界）；测试样例：`gemini-1.5-flash`✓、`flash-2.0`✓、`GPT-4_FLASH`✓、`reflash-model`✗、`gpt-4o`✗
  - `src/lib/guards/state-machine.ts`：`canTransition(from,to)`（查任务 3 的 ALLOWED_TRANSITIONS）、`assertTransition(from,to)`（非法抛 `InvalidTransitionError{code:'invalid_state_transition'}`）、`isTerminal(state)`
  - `src/lib/guards/tokens.ts`：`estimateTokens(text)`——启发式：CJK 字符计 1、其他按 ≈chars/4，返回整数（文档注明是估算非精确）；`assertSourceLength(text)`——超 `SOURCE_TOKEN_LIMIT` 抛 `SourceTooLongError{code:'source_too_long', limit}`；`assertSourceNonEmpty(text)`——空/纯空白抛 `SourceRequiredError{code:'source_required'}`
  - 全部纯函数零 IO

  **Must NOT do**:
  - 不引入 token 化库（tiktoken 等，估算即可）；不把阈值写死（从 constants.ts 读）
  - 不实现 DB 或网络访问

  **Recommended Agent Profile**:
  - **Category**: `quick` — 小型纯函数集
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 1（与 1-5,7）
  - **Blocks**: 13（状态机守卫）, 15（flash 检测）, 17（源文守卫） — **Blocked By**: 任务 3 的 ALLOWED_TRANSITIONS/constants（同波次按契约节实现，无文件冲突）

  **References**:
  - 计划契约 C5 状态机 + Metis AC14（flash 词边界）+ E1/E2（空/超长源文）
  - **WHY**: flash 词边界是 R2 的精确语义（"reflash" 误报是真实用户痛点）；状态机守卫是 API 409 的来源

  **Acceptance Criteria**（TDD 全绿）:
  - [ ] flash 5 组样例全对（含 `reflash-model` 不误报）
  - [ ] 非法转换 done→translating 抛 InvalidTransitionError；合法 refining→refining 通过
  - [ ] 空源文/超长源文分别抛 source_required/source_too_long；中英混合文本估算返回正整数

  **QA Scenarios**:
  ```
  Scenario: 守卫全样例（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/guards` → 全部 passed
    Expected Result: 全部断言通过
    Evidence: .omo/evidence/task-6-guards.txt

  Scenario: 误报与非法转换（negative）
    Tool: Bash
    Steps:
      1. vitest：detectFlashModel("reflash-model") === false
      2. vitest：assertTransition("done","translating") 抛错且 code==="invalid_state_transition"
    Expected Result: 无误报；非法转换精确报错
    Evidence: .omo/evidence/task-6-guards-negative.txt
  ```

  **Commit**: YES — `feat(guards): flash 检测 + 状态机守卫 + token 估算`
  - Files: `src/lib/guards/*`, `test/guards/*`
  - Pre-commit: `npx vitest run test/guards`

- [x] 7. 级联匹配器 + replaceText 执行器 + 版本化（TDD，R4 核心）

  **What to do**（先写 `test/editing/*.test.ts`）:
  - `src/lib/editing/matcher.ts`：`cascadingMatch(oldString, fullText): MatchResult`——按研究共识级联：
    1. `exact`：逐字节 `indexOf`
    2. `trim_end`：逐行 trimEnd 后对齐匹配（映射回原文位置）
    3. `trim`：逐行 trim 后对齐匹配
    4. `unicode`：NFC 规范化 + 弯引号→直引号 + nbsp→空格后匹配（映射回原文）
    5. `fuzzy`：滑动窗口 Levenshtein，阈值 ≤max(2, len/20)，仅接受唯一最佳
    - 每级先统计匹配数：>1 → 立即返回 `{status:'ambiguous', matchCount, level}`（拒绝，不猜测）；=1 → `{status:'found', level, start, end}`；=0 → 下一级；全部失败 → `{status:'not_found', suggestions?: string[]}`（给最接近的 1-3 个候选片段）
    - 匹配前对两侧做 CRLF→LF 规范化（应用时保留原文行尾风格）
  - `src/lib/editing/replace.ts`：
    - `applyReplacement(fullText, oldString, newString): ReplaceResult`——基于 matcher；found → `{ok:true, newText, level}`；ambiguous/not_found → `{ok:false, reason, matchCount?, suggestions?}`
    - `applyReplacementBatch(fullText, edits: Array<{old_string,new_string}>): BatchResult`——**事务性**：先在副本上顺序应用全部 edits，任一失败 → 整体返回 `{ok:false, failedIndex, reason}`，原文不动；全部成功才返回 `{ok:true, newText}`；`new==old` 的 edit 记为 no-op（跳过不报错但不产生变化）
  - `src/lib/editing/versions.ts`：`nextVersionText(currentText, appliedEdit)` 纯函数 + `diffSummary(oldText,newText)`（替换前后各取 40 字符上下文生成人类可读摘要，供聊天面板展示，非 diff 视图）

  **Must NOT do**:
  - 多处匹配时禁止"取第一个"（必须拒绝——Claude Code 模式）
  - 不实现行号/offset 定位模式（仅文本锚定）；不实现 undo API（版本历史即 undo）
  - 不引入 diff 库（diffSummary 手写上下文截取即可）

  **Recommended Agent Profile**:
  - **Category**: `deep` — 级联匹配的位置映射（规范化后↔原文）是已知的微妙易错点，需仔细推理
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `artistry`（逻辑虽微妙但有研究共识可循，非非常规问题）

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 1（与 1-6）
  - **Blocks**: 12 — **Blocked By**: None

  **References**:
  - 研究（bg_67b3fe33）：dyad 级联实现、Amazon Q 3 策略链、Aider 策略栈——级联顺序与多匹配拒绝语义
  - Metis AC11/AC12/AC13 + E19-E23 — 测试样例来源
  - **WHY**: R4「通过调用工具替换对应文本」的可靠性完全取决于本模块；静默错配=文本损坏，必须宁可拒绝

  **Acceptance Criteria**（TDD 全绿，覆盖 AC11-13/E19-23）:
  - [ ] 5 级匹配各有正反用例（exact 命中 / 尾部空白差异走 trim_end / 缩进差异走 trim / NFD vs NFC 走 unicode / 单字符差异走 fuzzy）
  - [ ] 多处匹配在每级都返回 ambiguous 且 matchCount 正确
  - [ ] CRLF 文本 + LF oldString 匹配成功且结果保留 CRLF
  - [ ] 批量：第 2 个 edit 失败 → ok:false 且原文不变（事务性）；new==old → no-op
  - [ ] diffSummary 输出含替换前后上下文片段

  **QA Scenarios**:
  ```
  Scenario: 级联匹配五级（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/editing` → 全部 passed
      2. 断言 NFC 源文 + NFD oldString 经 unicode 级命中且返回原文正确区间
    Expected Result: 各级命中/拒绝行为与规格一致
    Failure Indicators: 级别跳跃 / 位置映射错位 / ambiguous 被静默应用
    Evidence: .omo/evidence/task-7-cascading-matcher.txt

  Scenario: 事务性批量与歧义拒绝（negative）
    Tool: Bash
    Steps:
      1. vitest：edits=[{old:"A",new:"X"},{old:"不存在",new:"Y"}] 对 "A B C" → ok:false 且返回原文未变
      2. vitest：oldString="月" 在 "明月松间照，清泉石上流，月下飞天镜" → ambiguous, matchCount=3
    Expected Result: 整体回滚；歧义精确计数
    Evidence: .omo/evidence/task-7-transactional.txt
  ```

  **Commit**: YES — `feat(editing): 级联匹配器 + 事务性替换 + 版本摘要`
  - Files: `src/lib/editing/*`, `test/editing/*`
  - Pre-commit: `npx vitest run test/editing`

- [x] 8. LLM 客户端（OpenAI 兼容：流式/tools/错误规范化/中止传播）（TDD）

  **What to do**（先写 `test/llm/client.test.ts`，用任务 4 的 mock fixture）:
  - `src/lib/llm/client.ts`：裸 `fetch` 实现 `chatCompletion(endpoint: {baseUrl,apiKey}, request): Promise<...>`：
    - `request`: `{model, messages, tools?, stream: boolean, timeoutMs?, signal?}`
    - 非流式 → 返回 `{content, toolCalls?, usage}`；流式 → 返回 `AsyncIterable<LLMStreamEvent>`（`{type:'text',delta}` / `{type:'tool_call_delta',index,argumentsDelta}` / `{type:'done',content,toolCalls?,usage}`），tool_calls delta 服务端累积合并为完整 toolCalls
    - `supportsTools` 探测：收到 400 且 message 含 "tools"/"function" 不支持字样 → 抛 `ToolsNotSupportedError`（供任务 12 降级）
    - 错误规范化：401→`AuthError`、429→`RateLimitError(retryable)`、5xx→`ServerError(retryable)`、超时/网络→`TimeoutError/NetworkError(retryable)`、其他 4xx→`ClientError(non-retryable)`；统一 `LLMError{code,status?,retryable,message}`
    - 超时：默认 `AGENT_TIMEOUT_MS`（constants），`AbortSignal.timeout` 与外部 signal 合并（`AbortSignal.any`），外部中止 → 取消 fetch 并抛 `AbortedError`
    - SSE 解析复用任务 3 `parseSSEChunk`；非流式端点（`stream:true` 但返回整 JSON）自动识别 content-type 回退解析
  - 零框架依赖；不读写 DB

  **Must NOT do**:
  - 不引入 openai npm 包/ai SDK（裸 fetch，G9 精神：一层薄抽象）
  - 不实现重试循环（重试策略归任务 10/11；本模块只标注 retryable）
  - 不做任何流式 token 落库（G7）

  **Recommended Agent Profile**:
  - **Category**: `deep` — 流式 tool_calls delta 合并 + 双 signal 合并 + 非流式回退是三个易错点
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 2（与 9-14）
  - **Blocks**: 10, 11, 12 — **Blocked By**: 3（parseSSEChunk/types）, 4（mock fixture）

  **References**:
  - OpenAI streaming tool_calls delta 格式: `https://platform.openai.com/docs/api-reference/chat/streaming` — `delta.tool_calls[].function.arguments` 分片
  - `AbortSignal.any`: `https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static` — 超时+外部中止合并
  - 研究（bg_67b3fe33）：流式兼容性陷阱、`disableStreaming` 回退 — 非流式自动识别
  - **WHY**: 全部 LLM 流量的唯一出口；错误规范化决定上层重试策略的正确性

  **Acceptance Criteria**（TDD 全绿，对 mock fixture）:
  - [ ] 非流式：解析 content/toolCalls/usage 正确
  - [ ] 流式：text delta 按序产出；tool_calls 分片合并为完整参数 JSON；`[DONE]` 后迭代结束
  - [ ] 错误：401/429/500/超时/网络分别映射为对应 LLMError 且 retryable 标注正确
  - [ ] `no_tools_error` behavior → 抛 ToolsNotSupportedError
  - [ ] 外部 signal abort → 进行中的流式请求被取消且抛 AbortedError；mock 端收到连接中断
  - [ ] mock non_stream behavior + `stream:true` 请求 → 自动回退解析成功

  **QA Scenarios**:
  ```
  Scenario: 流式与工具合并（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/llm` → 全部 passed
      2. 断言流式 tool_call 分 3 片到达 → 最终 toolCalls[0].arguments 为完整合法 JSON
    Expected Result: 流式/非流式/工具合并全部正确
    Failure Indicators: 分片乱序 / arguments 拼接错位 / done 提前触发
    Evidence: .omo/evidence/task-8-llm-client.txt

  Scenario: 错误映射与中止传播（negative）
    Tool: Bash
    Steps:
      1. vitest：mock behavior=error(429) → RateLimitError 且 retryable===true
      2. vitest：流式消费中途 abort → 抛 AbortedError 且 mock getRequests() 记录到连接
    Expected Result: 错误码精确映射；中止确实取消底层 fetch
    Evidence: .omo/evidence/task-8-errors-abort.txt
  ```

  **Commit**: YES — `feat(llm): OpenAI 兼容客户端（流式/tools/错误规范化/中止）`
  - Files: `src/lib/llm/client.ts`, `test/llm/client.test.ts`
  - Pre-commit: `npx vitest run test/llm`

- [x] 9. 阶段上下文构建器 + token 预算 + 聊天上下文截断（TDD）

  **What to do**（先写 `test/context/*.test.ts`）:
  - `src/lib/context/stage-context.ts`：`buildStageContext(stage, {sourceText, sourceLang, targetLang, translations: TranslationResult[], priorStages: StageOutput[]}): StageContextJson`——实现 C3 累积式：
    - 输入 JSON 结构：`{source: {text, from, to}, translations: [{agent_id, agent_name, model, text}], prior_stages: {review?: ..., filter?: ..., orchestrate?: ...}}`（仅含已完成阶段的 parsed_output）
    - token 预算（`STAGE_CONTEXT_TOKEN_BUDGET`，用任务 6 `estimateTokens`）：超预算时按序截断——先丢弃 filter 阶段 rejected 的翻译全文（保留 agent_id+评审摘要），再对保留翻译从尾部截断并标注 `…[truncated]…`，返回 `{json, truncated: boolean}`
    - `buildChatContext(messages: ChatMessage[], currentText, maxTurns=CHAT_CONTEXT_TURNS)`：C4 上下文——`[{system: 当前最新全文+编辑工具说明}, ...最近 maxTurns 轮, {user: 新指令}]`；超轮时丢弃最旧轮次并插入一条 `{role:'system', content:'（早期 N 轮对话已省略，当前文本为最新版本）'}` 占位
  - 纯函数零 IO

  **Must NOT do**:
  - 不做 LLM 调用；不读取 DB（输入已物化）；不实现摘要 LLM 调用（v1 用占位句，G 范围锁）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 明确的结构化纯逻辑
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 2（与 8,10-14）
  - **Blocks**: 11 — **Blocked By**: 3, 6（同 Wave 1 已完成）

  **References**:
  - 计划契约 C3/C4 + Metis Q3/A9/E17/E24
  - **WHY**: C3「完整上下文管理」的直接实现；预算截断防止小 context 模型爆窗

  **Acceptance Criteria**（TDD 全绿）:
  - [ ] 累积式：orchestrate 阶段输入含 review+filter 的 parsed_output 且不含 assemble
  - [ ] 超预算：6×长翻译 + 预算 6000 → truncated:true 且估算 tokens ≤ 预算
  - [ ] 聊天截断：50 轮消息 → 输出仅最近 20 轮 + 1 条省略占位 + 首条 system 含当前全文
  - [ ] rejected 翻译优先被截断（selected 保留全文）

  **QA Scenarios**:
  ```
  Scenario: 累积上下文与预算（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/context` → 全部 passed
    Expected Result: 结构/预算/截断优先级全部符合 C3
    Evidence: .omo/evidence/task-9-stage-context.txt

  Scenario: 超窗截断（negative/edge）
    Tool: Bash
    Steps:
      1. vitest：构造超限输入 → truncated:true；断言 rejected 翻译全文缺席但 selected 在场
    Expected Result: 截断策略精确执行
    Evidence: .omo/evidence/task-9-truncation.txt
  ```

  **Commit**: YES — `feat(context): 阶段上下文构建 + token 预算 + 聊天截断`
  - Files: `src/lib/context/stage-context.ts`, `test/context/*`
  - Pre-commit: `npx vitest run test/context`

- [x] 10. 扇出编排器：并行翻译 + 限流/超时/重试/部分失败容错（TDD）

  **What to do**（先写 `test/orchestration/fanout.test.ts`，用 mock fixture）:
  - `src/lib/orchestration/fanout.ts`：`runFanOut(agents: AgentRuntime[], callbacks: FanOutCallbacks): Promise<FanOutSummary>`：
    - `AgentRuntime = {agentKey, name, endpoint, model, messages, timeoutMs?}`
    - 并发信号量：`min(agents.length, MAX_CONCURRENCY)`，硬顶 `HARD_CONCURRENCY_CAP`（30 个 agent 也只 16 在飞）
    - 每 agent：流式调用（任务 8 client）→ `callbacks.onAgentStart/onToken/onComplete/onError`；per-agent try/catch——失败返回 `{agentKey,status:'error',error}` **绝不 throw 拖垮批次**（研究核心结论）
    - 重试：仅 retryable 错误（timeout/5xx/429），`RETRY_DELAYS_MS` 指数退避，最多 2 次；`attempt` 计数经 callbacks 暴露
    - 中止：传入 AbortSignal 传播到全部在飞请求；中止后已完成 agent 结果保留，未完成的标 `aborted`
    - 返回 `FanOutSummary {results: AgentResult[], succeeded, failed, durationMs}`
  - 可选并发测试钩子：client 层包计数器记录同时在飞数

  **Must NOT do**:
  - 不写 DB（持久化归路由层任务 17）；不做 UI 事件（callbacks 抽象，SSE 编码归 17）
  - 不因单 agent 失败 reject Promise；不重试 4xx 认证/解析错误

  **Recommended Agent Profile**:
  - **Category**: `deep` — 并发控制+中止传播+部分失败语义的组合是并发 bug 高发区
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 2（与 8,9,11-14）
  - **Blocks**: 17 — **Blocked By**: 8（5 软依赖：buildTranslatorPrompt）

  **References**:
  - 研究（bg_07622339）：LangGraph 并行回滚教训（节点内 catch）、信号量上限 8、P99 超时、WorkerResult error 字段
  - Metis Q8/AC3/AC4/E7/E8/E10/E11
  - **WHY**: R1 多模型并行的运行引擎；部分失败容错是用户设想工作流（6 模型可有不稳定端点）的刚需

  **Acceptance Criteria**（TDD 全绿，覆盖 AC3/AC4）:
  - [ ] 6 agent（1 个 mock error 500）→ summary succeeded=5 failed=1，Promise resolve 不 reject
  - [ ] 12 agent + cap 8 → 计数器峰值 ≤8
  - [ ] 429 → 重试 2 次（1s/3s 退避，测试用假计时器或缩短注入）后失败；401 → 0 重试
  - [ ] 流式中途 abort → 未完成 agent 标 aborted，已完成的结果保留在 summary
  - [ ] callbacks 事件序：start×N → token 交错 → complete/error×N → 返回 summary

  **QA Scenarios**:
  ```
  Scenario: 部分失败容错（happy path of failure tolerance）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/orchestration` → 全部 passed
      2. 断言 1 个 500 agent 的 error 字段含状态码且其余 5 个 output 完整
    Expected Result: 批次不被单点失败拖垮
    Evidence: .omo/evidence/task-10-fanout-partial.txt

  Scenario: 并发上限与重试（negative/edge）
    Tool: Bash
    Steps:
      1. vitest：12 agents → 断言 maxInFlight<=8
      2. vitest：429 agent → 断言 mock getRequests() 中该 agent 请求数===3（1+2 重试）；401 agent → 请求数===1
    Expected Result: 限流与重试策略精确执行
    Evidence: .omo/evidence/task-10-concurrency-retry.txt
  ```

  **Commit**: YES — `feat(orchestration): 扇出编排器（限流/超时/重试/容错）`
  - Files: `src/lib/orchestration/fanout.ts`, `test/orchestration/fanout.test.ts`
  - Pre-commit: `npx vitest run test/orchestration`

- [x] 11. 四阶段管道运行器：schema 校验 + 重试 + stale 失效（TDD，R3 核心）

  **What to do**（先写 `test/orchestration/pipeline.test.ts`，用 mock fixture）:
  - `src/lib/orchestration/pipeline.ts`：`runStage(stage, sessionContext, callbacks): Promise<StageRunResult>`：
    - 流程：`buildStageContext`（任务 9）→ `buildStagePrompt`（任务 5，模板来自快照配置）→ LLM 调用（review/filter 非流式；orchestrate/assemble 流式转发 `callbacks.onDelta`）
    - 输出解析：`extractJson(rawText)`——剥离 markdown fence/前后噪声提取首个完整 JSON 对象 → zod（C2 schema）safeParse
    - 校验失败 → 自动重试 1 次（user 消息追加"上次输出未通过校验，请严格只输出 JSON"）→ 仍失败返回 `{ok:false, code:'stage_schema_error', detail}`（Metis Q9/E14/E15）
    - `markDownstreamStale(stage)` 纯函数：给定重跑阶段返回需置 stale 的下游阶段列表（review→[filter,orchestrate,assemble] 等）
    - 阶段顺序守卫：运行阶段 N 时若前置阶段未 complete → 返回 `{ok:false, code:'stage_prerequisite_missing'}`
    - assemble 成功 → `callbacks.onAssembled(finalText)`（版本落库归服务/路由层）
  - `callbacks`: `onStageStart/onDelta/onStageComplete/onSchemaError/onError`

  **Must NOT do**:
  - 不允许跳过/重排/自定义阶段（G1）；不写 DB（归 13/18）
  - 不对 review/filter 做 token 流式转发（结构化输出不流式，C1）

  **Recommended Agent Profile**:
  - **Category**: `deep` — JSON 提取容错 + 校验重试 + 阶段依赖守卫的状态组合需仔细
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 2（与 8-10,12-14）
  - **Blocks**: 18 — **Blocked By**: 8, 9（5,14 软依赖）

  **References**:
  - 计划契约 C2/C3 + 研究（bg_07622339）：阶段边界 schema 校验防静默级联
  - Metis Q2/Q7/Q9/AC6/AC7/E14-E17
  - **WHY**: R3「四步标准提示词+完整上下文管理」的执行引擎；stale 失效防止组装基于过期编排

  **Acceptance Criteria**（TDD 全绿，覆盖 AC6/AC7）:
  - [ ] 4 阶段各跑通：mock 返回对应合法 JSON → parsed_output 与 schema 一致
  - [ ] malformed_json → 自动重试 1 次（mock 收到 2 请求）→ 仍坏 → stage_schema_error 且 detail 含 zod 信息
  - [ ] fence 包裹/前后带散文的 JSON 也能被 extractJson 正确提取
  - [ ] markDownstreamStale("filter") === ["orchestrate","assemble"]
  - [ ] review 未 complete 时运行 filter → stage_prerequisite_missing

  **QA Scenarios**:
  ```
  Scenario: 四阶段全通（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/orchestration/pipeline` → 全部 passed
      2. 断言 assemble 的 onAssembled 回调收到非空 final_text
    Expected Result: 管道端到端正确
    Evidence: .omo/evidence/task-11-pipeline.txt

  Scenario: 校验失败重试与 stale（negative）
    Tool: Bash
    Steps:
      1. vitest：连续 malformed → 2 次请求后 stage_schema_error
      2. vitest：断言 stale 列表与前置守卫行为
    Expected Result: 失败路径精确符合 Metis Q7/Q9
    Evidence: .omo/evidence/task-11-schema-retry-stale.txt
  ```

  **Commit**: YES — `feat(orchestration): 四阶段管道运行器（校验/重试/stale）`
  - Files: `src/lib/orchestration/pipeline.ts`, `test/orchestration/pipeline.test.ts`
  - Pre-commit: `npx vitest run test/orchestration/pipeline`

- [x] 12. 聊天工具循环：双协议 + 事务替换 + ≤5 轮（TDD，R4 引擎）

  **What to do**（先写 `test/chat/tool-loop.test.ts`，用 mock fixture）:
  - `src/lib/chat/tool-loop.ts`：`runChatTurn({endpoint, model, messages, currentText, callbacks}): Promise<ChatTurnResult>`——实现 C4/C5：
    - 循环（≤`CHAT_LOOP_MAX`）：调用 LLM（流式；带 `tools=[replace_text]`）→ text delta 实时 `callbacks.onDelta`；tool_calls 服务端累积
    - 无 tool_calls → 纯讨论：返回 `{ok:true, kind:'message', text}`（E18，不改文本）
    - 有 tool_calls → `applyReplacementBatch`（任务 7，事务性）→ 成功：`callbacks.onToolCall/onToolResult(ok)`，返回 `{ok:true, kind:'edited', newText, diffSummary, text}`；失败（ambiguous/not_found/schema）→ 把错误作为 tool 角色消息回注（含"匹配到 N 处请提供更长上下文"/当前全文），继续循环让模型自我纠正（E20/E22）
    - `ToolsNotSupportedError` → **自动降级 JSON 围栏协议**（C4）：system 追加指令要求模型输出 ` ```json {"old_string","new_string"}``` `，从 text 提取解析后走同一替换路径；`callbacks.onProtocolFallback` 通知
    - 循环上限 → 返回 `{ok:false, code:'chat_loop_exhausted', lastText}`
  - `src/lib/chat/tools.ts`：`REPLACE_TEXT_TOOL` 的 OpenAI tools schema 定义（strict，description 强调 old_string 必须原文唯一片段、new==old 无效）

  **Must NOT do**:
  - 不定义 replace_text 之外的工具（G2）；不写 DB（版本落库归路由层 19）
  - 不把 tool_calls 分片转发给客户端（C1：只发完整 tool_call 事件）
  - 不在降级协议下放弃 zod 校验（解析出的参数同样过 schema）

  **Recommended Agent Profile**:
  - **Category**: `deep` — 双协议切换+自我纠正循环+事务语义的三态组合
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 2（与 8-11,13,14）
  - **Blocks**: 19 — **Blocked By**: 7, 8（14 软依赖：编辑工具说明文案）

  **References**:
  - 计划契约 C4 + 研究（bg_67b3fe33）：工具拒绝反馈循环、strict schema、步骤上限
  - Metis Q4/Q5/Q10/A1/E18-E22
  - **WHY**: R4 的核心引擎；双协议保证 Ollama/中转站等弱端点也可用（用户现实环境）

  **Acceptance Criteria**（TDD 全绿）:
  - [ ] 原生 tools：mock 返回 tool_call → onToolCall/Result 触发且返回 edited+newText
  - [ ] 无 tool_call → kind:'message' 且文本未被触碰
  - [ ] ambiguous → 错误回注后 mock 第 2 轮返回合法 tool_call → 成功（自我纠正循环）
  - [ ] no_tools_error → onProtocolFallback 触发且 JSON 围栏路径完成替换
  - [ ] 连续 5 轮都非法 → chat_loop_exhausted；批量中 1 个失败 → 全部回滚且错误回注

  **QA Scenarios**:
  ```
  Scenario: 工具替换与自我纠正（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/chat` → 全部 passed
      2. 断言第 1 轮 ambiguous → 第 2 轮成功时 mock 共收 2 请求且最终 newText 正确
    Expected Result: 双协议与纠正循环全部正确
    Evidence: .omo/evidence/task-12-tool-loop.txt

  Scenario: 降级协议与循环上限（negative）
    Tool: Bash
    Steps:
      1. vitest：no_tools_error 端点 → fallback 标志 true 且替换成功
      2. vitest：永远返回非法 JSON → 5 轮后 chat_loop_exhausted
    Expected Result: 降级可用；循环有硬顶
    Evidence: .omo/evidence/task-12-fallback-loop.txt
  ```

  **Commit**: YES — `feat(chat): 聊天工具循环（双协议/事务替换/自我纠正）`
  - Files: `src/lib/chat/*`, `test/chat/*`
  - Pre-commit: `npx vitest run test/chat`

- [x] 13. 会话 + 快照服务：创建/状态转换/配置冻结（TDD）

  **What to do**（先写 `test/services/session.test.ts`，内存 DB）:
  - `src/lib/services/session-service.ts`：
    - `createSession({sourceText, sourceLang, targetLang})`：守卫（任务 6：非空+长度上限+agents≥1 否则 `no_agents_configured`）→ 读取当前全部配置（endpoints/agents/prompts/coordinator）深拷贝为 `config_snapshot` JSON（G6）→ 插入 sessions(state='draft') + 为每个 agent 插入 translation_results(agent_key=`agent-{id}`, agent_snapshot, status='pending') → 返回完整 session
    - `getSessionFull(id)`：session + results + stages + versions + messages 一次装配（路由层 GET 用）
    - `transitionState(id, to)`：`assertTransition`（任务 6）→ 更新 state+updated_at；非法抛 InvalidTransitionError（路由层映射 409，AC1）
    - `snapshotConfig(snapshot)` 类型化读取器：从快照 JSON 还原 agents/coordinator/prompts（后续任务 10/11/12 的运行时输入）
    - `listSessions({limit,offset})`：列表（id/源文前 50 字/state/created_at 倒序）
  - 会话恢复辅助：`markInterruptedInFlight()`——启动时将 status='streaming'/'running' 的孤儿记录标为 error/interrupted（E13）

  **Must NOT do**:
  - 不做 LLM 调用；不在快照后回读 live 配置（G6 的关键实现点）
  - 不实现多用户/权限（G 范围锁）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 明确的 DB 服务逻辑
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 2（与 8-12,14）
  - **Blocks**: 15, 16, 17 — **Blocked By**: 2, 3, 6

  **References**:
  - 计划契约 C5 + G6 快照冻结 + Metis AC1/AC2/E5/E9/E13
  - **WHY**: 快照冻结是「配置改动不影响进行中会话」的唯一保证点，必须在创建时深拷贝

  **Acceptance Criteria**（TDD 全绿，覆盖 AC1/AC2/E5）:
  - [ ] 创建后快照含当时 agents 完整副本；之后改 agents 表 → 快照读取仍返回旧配置（AC2）
  - [ ] 0 agents 时创建 → no_agents_configured；空源文 → source_required（E1/E5）
  - [ ] 非法转换抛错；getSessionFull 装配 5 类子记录齐全
  - [ ] markInterruptedInFlight 将 streaming 孤儿标 interrupted

  **QA Scenarios**:
  ```
  Scenario: 快照冻结与装配（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/services` → 全部 passed
      2. 断言 AC2：创建→改 agent prompt→snapshotConfig() 仍返回旧 prompt
    Expected Result: G6 语义成立
    Evidence: .omo/evidence/task-13-session-snapshot.txt

  Scenario: 守卫与非法转换（negative）
    Tool: Bash
    Steps:
      1. vitest：0 agents 创建 → code==='no_agents_configured'
      2. vitest：draft→assembled 直跳 → InvalidTransitionError
    Expected Result: 守卫精确触发
    Evidence: .omo/evidence/task-13-guards.txt
  ```

  **Commit**: YES — `feat(services): 会话+快照服务（创建/转换/冻结）`
  - Files: `src/lib/services/session-service.ts`, `test/services/*`
  - Pre-commit: `npx vitest run test/services`

- [x] 14. 内置中文提示词种子：翻译默认 + 四阶段（诗歌级）

  **What to do**:
  - `src/lib/db/seed.ts`：首次启动时（`prompt_templates` 表无 is_builtin=1 记录）插入 5 条内置模板（is_builtin=1）+ 默认 settings（`suppress_flash_warning='0'`）：
    - **translator 默认**（`{{source_lang}}/{{target_lang}}/{{source_text}}/{{extra_instructions}}` 变量）：角色=精通中英双语的资深文学翻译家；要求——忠实原意、意象再现、音韵节奏（目标为中文五言时严格五字一句、注意平仄与押韵自然）、保留结构（行数/节）；输出仅译文不加解释
    - **review（审查）**：逐一评估每份译稿——逐条列出 strengths/weaknesses（意象忠实度/格律合规/语言自然度三维）、1-10 quality_score、keep 建议；**严格只输出符合 schema 的 JSON**（内嵌 C2 review schema 文本）
    - **filter（筛选）**：基于审查结果选择进入编排的译稿（可全选/可淘汰低分），给出 rationale；严格只输出 C2 filter schema JSON
    - **orchestrate（编排）**：规划最终文本结构——逐段（segment）从入选译稿中挑选最佳片段并说明理由（可同段融合多稿之长）；严格只输出 C2 orchestrate schema JSON
    - **assemble（组装）**：按编排方案组装完整连贯的最终译文——统一风格/修订衔接/校验格律；输出 final_text+notes；严格只输出 C2 assemble schema JSON
  - 每条同时含"变量/上下文说明"注释段（对应 C3 注入的 JSON 结构）；文案保持模型无关（不点名任何厂商）
  - `test/db/seed.test.ts`：种子幂等（跑 2 次仍各 1 条）、5 类 kind 齐全、模板含全部必需变量

  **Must NOT do**:
  - 不写英文 UI 文案（提示词中文，G 范围锁）；不内置第四方工具/联网指令
  - 不允许内置模板被 UPDATE（is_builtin 行只可整体 reset，归任务 15 路由）

  **Recommended Agent Profile**:
  - **Category**: `writing` — 提示词工程质量直接决定翻译产品质量，需文学翻译领域语感
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 2（与 8-13）
  - **Blocks**: 15（路由暴露）, 11/12（软：运行时读取） — **Blocked By**: 2, 3（5 软：变量约定一致）

  **References**:
  - 设想文件 R3「四步要有标准的提示词」+ 用户原始工作流（英诗→五言）
  - 计划契约 C2（schema 文本需逐字嵌入对应模板）
  - **WHY**: R3 的「标准」就体现在这 4 条提示词的质量；schema 文本必须与 C2 逐字一致否则校验必然失败

  **Acceptance Criteria**:
  - [ ] 5 条内置模板种子幂等插入；translator 模板含 4 个变量；四阶段模板各含对应 C2 schema 全文与"严格只输出 JSON"指令
  - [ ] `npx vitest run test/db/seed.test.ts` 全绿

  **QA Scenarios**:
  ```
  Scenario: 种子幂等与完整性（happy path）
    Tool: Bash
    Steps:
      1. 运行 `npx vitest run test/db/seed.test.ts` → 全部 passed
      2. 断言 review 模板 content 含 '"quality_score"' 与 "strengths"
    Expected Result: 内置模板完整可用
    Evidence: .omo/evidence/task-14-seed.txt

  Scenario: schema 一致性（negative/edge）
    Tool: Bash
    Steps:
      1. vitest：从四阶段模板中提取内嵌 JSON schema 关键字段名 → 与 C2 zod schema 字段名逐一比对一致
    Expected Result: 提示词与校验器零漂移
    Failure Indicators: 字段名不一致（将导致运行时必然 schema_error）
    Evidence: .omo/evidence/task-14-schema-consistency.txt
  ```

  **Commit**: YES — `feat(seed): 内置中文提示词（翻译默认+四阶段）`
  - Files: `src/lib/db/seed.ts`, `test/db/seed.test.ts`
  - Pre-commit: `npx vitest run test/db/seed.test.ts`

- [ ] 15. 配置 CRUD 路由：endpoints/agents/coordinator/prompts/settings + flash 警告

  **What to do**:
  - `app/api/endpoints/route.ts`（GET 列表/POST 创建）+ `app/api/endpoints/[id]/route.ts`（PUT/DELETE）；DELETE 前检查被 sessions 快照引用次数，响应含 `usedBySessions` 供 UI 警告（E30）
  - `app/api/agents/route.ts`（GET/POST）+ `app/api/agents/[id]/route.ts`（PUT/DELETE）；POST/PUT 校验 endpoint_id 存在、model 非空、prompt_override 可空；sort_order 按入参重排
  - `app/api/coordinator/route.ts`（GET/PUT）：PUT 时 `detectFlashModel(model)` 或 `detectFlashModel(chat_model)` 命中 → 响应 `{..., warning:'不推荐使用flash模型进行统筹', warning_id:'flash_coordinator'}`；请求体带 `suppress_warnings:['flash_coordinator']` → 写 settings 后不再返回 warning（AC8）；chat_endpoint_id/chat_model 缺省回落到统筹 endpoint/model（G8）
  - `app/api/prompts/route.ts`（GET 按 kind）+ `app/api/prompts/[id]/route.ts`（PUT）+ `app/api/prompts/reset/route.ts`（POST：is_builtin 行恢复种子原文）；is_builtin 行 PUT 时自动另存为 is_builtin=0 的副本（保护内置）
  - `app/api/settings/route.ts`（GET/PUT key-value）
  - 全部 `export const runtime='nodejs'`（G4）；zod 校验入参（任务 3 schemas），非法 → 400 `{error, issues}`
  - 路由集成测试 `test/api/config-routes.test.ts`：直接调用 route handler 函数（传入构造的 Request），内存 DB

  **Must NOT do**:
  - 不做 `/v1/models` 自动拉取代理（v1 手动输入模型名，范围锁）
  - 不在响应中回显 api_key 明文以外的任何加密/解密逻辑（明文存储是已确认决策，但不出现在日志）
  - 不实现分页之外的过滤/搜索（范围锁）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — 5 组路由的重复性工作 + 细节校验多
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 3（与 16-20）
  - **Blocks**: 21 — **Blocked By**: 2, 3, 13, 14

  **References**:
  - Next.js Route Handlers: `https://nextjs.org/docs/app/building-your-application/routing/route-handlers` — 签名/动态段/Request
  - 计划契约 C5/C6 + Metis AC8（flash 警告 API 语义）/E30
  - **WHY**: R1/R2 的 API 面；flash 警告的 suppress 语义在此定型（AC8）

  **Acceptance Criteria**:
  - [ ] CRUD 全绿：endpoint/agent 增删改查往返；非法入参 400 含 issues
  - [ ] AC8：PUT coordinator model="gemini-1.5-flash" → warning 文案精确命中；带 suppress 再 PUT → warning 消失且 settings 落库
  - [ ] is_builtin 模板 PUT → 生成副本而内置原文不变；reset 恢复种子
  - [ ] DELETE endpoint 被引用 → 响应含 usedBySessions≥1
  - [ ] `npx vitest run test/api/config-routes` 全绿

  **QA Scenarios**:
  ```
  Scenario: CRUD 与 flash 警告（happy path）
    Tool: Bash（对 `npm start` 运行的实例 curl）
    Steps:
      1. `curl -s -X POST localhost:3000/api/endpoints -d '{"name":"测试","base_url":"http://x/v1","api_key":"k"}' -H 'content-type: application/json'` → 200 含 id
      2. `curl -s -X PUT localhost:3000/api/coordinator -d '{"model":"gemini-1.5-flash",...}'` → 响应含 "不推荐使用flash模型进行统筹"
      3. 带 suppress_warnings 重 PUT → 响应无 warning 字段
    Expected Result: AC8 全链路成立
    Evidence: .omo/evidence/task-15-config-crud-flash.txt

  Scenario: 非法入参与内置保护（negative）
    Tool: Bash（curl）
    Steps:
      1. POST agent 缺 model → HTTP 400 且 body 含 issues
      2. PUT is_builtin=1 模板 → 200 且 GET ?kind=review 返回 2 行（内置原文未变）
    Expected Result: 校验与保护语义正确
    Evidence: .omo/evidence/task-15-validation-builtin.txt
  ```

  **Commit**: YES — `feat(api): 配置 CRUD 路由 + flash 警告 + 内置保护`
  - Files: `app/api/endpoints/*`, `app/api/agents/*`, `app/api/coordinator/*`, `app/api/prompts/*`, `app/api/settings/*`, `test/api/config-routes.test.ts`
  - Pre-commit: `npx vitest run test/api/config-routes`

- [ ] 16. 会话路由：create/list/get 全态/版本恢复

  **What to do**:
  - `app/api/sessions/route.ts`：POST（调用任务 13 createSession；守卫错误映射 400 `{error:code}`）/ GET（listSessions 分页）
  - `app/api/sessions/[id]/route.ts`：GET——getSessionFull 装配（session+results+stages+versions+messages）+ 当前最新 version_no；不存在 → 404 `{error:'session_not_found'}`
  - `app/api/sessions/[id]/versions/[versionNo]/restore/route.ts`：POST——取该版本文本 → 插入新 final_versions 行（version_no=max+1, source='restore'）→ 插入 chat_messages 系统说明行（"已恢复到版本 N"）→ 返回新版本（append-only，E 范围锁：无 undo API）
  - 全部 nodejs runtime；集成测试 `test/api/session-routes.test.ts`（内存 DB 直调 handler）

  **Must NOT do**:
  - 不在本路由实现翻译/阶段/聊天逻辑（各归 17/18/19）
  - 不提供物理删除版本/消息的 API（append-only 历史）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 薄路由层，逻辑已在 13
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 3（与 15,17-20）
  - **Blocks**: 18, 19, 24 — **Blocked By**: 13

  **References**:
  - 计划契约 C5 状态机 + Metis E29（无编辑时版本=1 条）
  - **WHY**: 前端全态加载的唯一入口；恢复语义在此定型（append-only 复制）

  **Acceptance Criteria**:
  - [ ] POST 创建返回 state='draft' 且 translation_results 按 agents 数生成；0 agents → 400 no_agents_configured
  - [ ] GET 全态装配齐全；restore 后版本数+1 且 source='restore'、文本与被恢复版本一致
  - [ ] `npx vitest run test/api/session-routes` 全绿

  **QA Scenarios**:
  ```
  Scenario: 创建与全态读取（happy path）
    Tool: Bash（curl）
    Steps:
      1. POST /api/sessions {source_text:"The woods are lovely, dark and deep"} → 200 state=draft
      2. GET /api/sessions/[id] → body 含 results/stages/versions/messages 五键
    Expected Result: 创建-读取往返正确
    Evidence: .omo/evidence/task-16-session-routes.txt

  Scenario: 守卫与恢复（negative/edge）
    Tool: Bash（curl）
    Steps:
      1. POST {source_text:""} → 400 source_required
      2. restore 不存在的 versionNo=99 → 404 version_not_found
    Expected Result: 错误码精确
    Evidence: .omo/evidence/task-16-guards-restore.txt
  ```

  **Commit**: YES — `feat(api): 会话路由（create/list/get/restore）`
  - Files: `app/api/sessions/route.ts`, `app/api/sessions/[id]/route.ts`, `app/api/sessions/[id]/versions/*`, `test/api/session-routes.test.ts`
  - Pre-commit: `npx vitest run test/api/session-routes`

- [ ] 17. 翻译 SSE 路由：fanout 流式 + 单 agent 重试

  **What to do**:
  - `app/api/sessions/[id]/translate/route.ts`：POST——
    - 守卫：session 存在；state ∈ {draft, translated}（assertTransition draft→translating / translated→translating 允许重跑）；快照 agents ≥1
    - 构建 AgentRuntime 数组（快照 agents + resolveTranslatorPrompt 每 agent 消息）
    - SSE Response（`text/event-stream`，`encodeSSE`）：`runFanOut` callbacks → C1 事件流（agent_start/token/agent_complete/agent_error/fanout_complete/done）
    - 完成态落库（G7：仅完成态）：每个 agent complete/error → UPDATE translation_results（status/output/error/latency/attempt）；fanout_complete → transitionState→translated
    - 中止传播：`request.signal` 断开 → AbortController abort 传入 fanOut；已完成结果保留落库（E10/E11）
  - `app/api/sessions/[id]/agents/[agentKey]/retry/route.ts`：POST——单 agent 重跑（清该行 error，status='pending'，复用 fanout 单 agent 路径，同样 SSE）
  - 集成测试 `test/api/translate-route.test.ts`：内存 DB + mock LLM + 消费 SSE 流断言事件序（AC5）

  **Must NOT do**:
  - 不持久化 token delta（G7）；不在 state=coordinating 时允许翻译（409）
  - 不对失败 agent 自动无限重试（手动 retry 路由提供）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — SSE 生命周期+落库时机+中止传播的细节密集
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 3（与 15,16,18-20）
  - **Blocks**: 22 — **Blocked By**: 10, 13

  **References**:
  - 计划契约 C1（事件序）+ Next.js streaming Response: `https://nextjs.org/docs/app/building-your-application/routing/route-handlers#streaming`
  - Metis AC5/E10/E11
  - **WHY**: R1 的用户可见引擎；事件序契约（AC5）是 FE 卡片网格的对接面

  **Acceptance Criteria**:
  - [ ] AC5：事件序精确——agent_start×N → token 交错（带 agent_key）→ complete/error×N → fanout_complete → done
  - [ ] 1 个 mock error agent → 该行 status='error' 且其余 complete；fanout_complete {succeeded:2,failed:1}
  - [ ] state=coordinating 时 POST → 409 invalid_state_transition
  - [ ] retry 路由仅重跑指定 agent_key 行
  - [ ] `npx vitest run test/api/translate-route` 全绿

  **QA Scenarios**:
  ```
  Scenario: fanout SSE 全事件序（happy path）
    Tool: Bash（vitest 消费 SSE / curl -N）
    Steps:
      1. 运行 `npx vitest run test/api/translate-route` → 全部 passed
      2. 断言收到的事件名序列匹配 C1 契约正则
    Expected Result: AC5 成立
    Evidence: .omo/evidence/task-17-translate-sse.txt

  Scenario: 状态守卫与部分失败（negative）
    Tool: Bash（curl）
    Steps:
      1. 将 session 置 coordinating（先跑一阶段）后再 POST translate → 409
      2. 配置 1 个 error agent → fanout_complete 的 failed=1 且该行落库 error 非空
    Expected Result: 状态机与容错落库正确
    Evidence: .omo/evidence/task-17-guard-partial.txt
  ```

  **Commit**: YES — `feat(api): 翻译 SSE 路由（fanout+retry）`
  - Files: `app/api/sessions/[id]/translate/route.ts`, `app/api/sessions/[id]/agents/*`, `test/api/translate-route.test.ts`
  - Pre-commit: `npx vitest run test/api/translate-route`

- [ ] 18. 阶段 SSE 路由：单阶段运行 + stale 联动

  **What to do**:
  - `app/api/sessions/[id]/stages/[stage]/run/route.ts`：POST——
    - 守卫：stage ∈ 四枚举（否则 404）；session state ∈ {translated, coordinating, assembled, refining}；首次进入 coordinating → transitionState
    - 前置守卫：runStage 返回 stage_prerequisite_missing → 409 `{error, missing:['review']}`
    - 读取快照 coordinator 配置 + 对应阶段模板（快照 prompts，用户覆盖优先）+ buildStageContext 物化输入
    - SSE 流：C1 阶段事件（stage_start / stage_delta 仅 orchestrate,assemble / stage_complete / stage_schema_error / stage_error / done）
    - 完成态落库：UPSERT stage_outputs（status/prompt_used/raw_output/parsed_output/error）；成功 → `markDownstreamStale` 下游行置 stale；assemble 成功 → 插入 final_versions（version_no=max+1, source='assemble'）+ transitionState→assembled
    - 并发守卫：同 session 已有 stage 在跑 → 409 `stage_already_running`（E12）；request.signal 中止传播
  - 集成测试 `test/api/stage-route.test.ts`（mock LLM + 内存 DB）

  **Must NOT do**:
  - 不允许一次请求跑多阶段（前端顺序调用 4 次）；不缓存阶段结果复用（每次必跑）
  - 不在 schema 错误时写入 parsed_output（保持 NULL）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — 状态联动（stale/版本/状态机）细节密集
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 3（与 15-17,19,20）
  - **Blocks**: 23 — **Blocked By**: 11, 16

  **References**:
  - 计划契约 C1/C2/C3/C5 + Metis AC7（stale）/E12（并发）/E16
  - **WHY**: R3 的 API 面；stale 联动保证组装不基于过期编排（AC7）

  **Acceptance Criteria**:
  - [ ] 4 阶段顺序跑通：mock 合法 JSON → stage_complete 且落库 parsed_output；assemble 后 versions+1
  - [ ] AC7：重跑 filter → orchestrate/assemble 行 status='stale'
  - [ ] 前置缺失 → 409 stage_prerequisite_missing；schema 连续失败 → stage_schema_error 事件
  - [ ] 并发跑同 session 两阶段 → 后者 409
  - [ ] `npx vitest run test/api/stage-route` 全绿

  **QA Scenarios**:
  ```
  Scenario: 四阶段串联与版本生成（happy path）
    Tool: Bash（vitest/curl -N）
    Steps:
      1. 运行 `npx vitest run test/api/stage-route` → 全部 passed
      2. 断言 assemble 完成后 final_versions 最新行 source='assemble' 且文本非空
    Expected Result: R3 全链路成立
    Evidence: .omo/evidence/task-18-stage-sse.txt

  Scenario: stale 与并发守卫（negative）
    Tool: Bash（curl）
    Steps:
      1. 重跑 filter 后 GET /api/sessions/[id] → stages 中 orchestrate/assemble status==='stale'
      2. 一阶段运行中（延迟 mock）并发跑另一阶段 → 409
    Expected Result: AC7/E12 精确成立
    Evidence: .omo/evidence/task-18-stale-concurrency.txt
  ```

  **Commit**: YES — `feat(api): 阶段 SSE 路由（stale 联动+版本生成）`
  - Files: `app/api/sessions/[id]/stages/*`, `test/api/stage-route.test.ts`
  - Pre-commit: `npx vitest run test/api/stage-route`

- [ ] 19. 聊天 SSE 路由：工具循环 + 版本落库

  **What to do**:
  - `app/api/sessions/[id]/chat/route.ts`：POST `{message, selection?: {text, start, end}}`——
    - 守卫：state ∈ {assembled, refining}（否则 409）；有 selection 时把选中片段+用户指令组合为 user 消息（"针对选中文段「{selection.text}」：{message}"）
    - 上下文：buildChatContext（任务 9：当前最新版本全文 + 最近 20 轮）
    - 模型：快照 coordinator.chat_model（缺省=统筹 model，G8）
    - SSE：C1 聊天事件（message_start/delta/tool_call/tool_result/message_complete/done）；`onProtocolFallback` → 注入一条 `delta` 提示"当前端点不支持原生工具调用，已切换兼容模式"
    - 落库：user 消息先入 chat_messages；assistant 完成后入（content+tool_calls JSON）；edited 时插入 final_versions（source='edit'）+ assistant 行 version_id 关联；state→refining
    - 中止传播；nodejs runtime
  - 集成测试 `test/api/chat-route.test.ts`（mock LLM + 内存 DB）

  **Must NOT do**:
  - 不允许 coordinating 中的聊天请求（UI 锁定+API 409 双保险，E25）
  - 不实现消息编辑/删除 API（append-only）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — SSE 编排+多表落库时序
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 3（与 15-18,20）
  - **Blocks**: 24 — **Blocked By**: 12, 16

  **References**:
  - 计划契约 C1/C4/C5 + Metis E18/E25
  - **WHY**: R4 的 API 面；version_id 关联使「每轮对话↔文本版本」可追溯（设想原文"上下文=对话记录+最新修改"）

  **Acceptance Criteria**:
  - [ ] 编辑轮：mock tool_call → tool_result{ok:true,version_no} 且 versions+1、assistant 行关联 version_id
  - [ ] 讨论轮（无 tool_call）→ message_complete 无 version_no 且文本不变
  - [ ] 带 selection 的请求 → mock 收到的 user 消息含「选中」片段与指令
  - [ ] state=coordinating → 409；`npx vitest run test/api/chat-route` 全绿

  **QA Scenarios**:
  ```
  Scenario: 选中修改全链路（happy path）
    Tool: Bash（vitest/curl -N）
    Steps:
      1. 运行 `npx vitest run test/api/chat-route` → 全部 passed
      2. 断言最终版本文本==替换后文本且 chat_messages 出现 tool 角色行
    Expected Result: R4 语义完整落地
    Evidence: .omo/evidence/task-19-chat-sse.txt

  Scenario: 状态守卫与降级提示（negative）
    Tool: Bash（curl）
    Steps:
      1. coordinating 中 POST chat → 409
      2. no_tools_error 端点 → 事件流含"已切换兼容模式"提示且替换仍成功
    Expected Result: 双保险与降级 UX 成立
    Evidence: .omo/evidence/task-19-guard-fallback.txt
  ```

  **Commit**: YES — `feat(api): 聊天 SSE 路由（工具循环+版本落库）`
  - Files: `app/api/sessions/[id]/chat/route.ts`, `test/api/chat-route.test.ts`
  - Pre-commit: `npx vitest run test/api/chat-route`

- [ ] 20. 应用壳 + 设计 tokens + 布局 + testid 规范落地

  **What to do**:
  - 设计 tokens（`app/globals.css` Tailwind v4 `@theme`）：中文优先字体栈（系统宋/黑+西文 serif 混搭，译文区 serif 提升文学感）、墨色+宣纸色系浅色主题（单色，无暗色切换）、间距/圆角/阴影刻度、译文专用排版类（`.poem-text`：字号/行高/字间距，适合五言竖排横排皆可）
  - `app/layout.tsx`：`<html lang="zh-CN">`、字体、顶栏（产品名"Agentic Translating · 智能体翻译工作台"+导航：工作台/配置/历史）
  - `app/page.tsx`：工作台三栏响应式布局骨架（左：原文+翻译卡片网格；右：统筹 stepper；下/侧：最终文本+聊天）——仅布局容器与空态，面板实现归 21-24
  - `app/config/page.tsx` + `app/history/page.tsx`：布局容器
  - `src/components/ui/*`：基础件——Button/Input/Textarea/Card/Modal/Badge/Spinner/Toast（极简 API，data-testid 透传）
  - `src/lib/testids.ts` 常量贯穿：所有容器元素挂上对应 TID（C6）
  - 视觉验证：Playwright 截图 3 页面（1280×800 + 375×812）

  **Must NOT do**:
  - 不实现面板业务逻辑（21-24 的活）；不加暗色模式/主题切换/i18n（G10）
  - 不引入组件库（shadcn/MUI/AntD——自研极简件，避免视觉同质化与依赖膨胀）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering` — 设计系统与布局质感定调，决定整个产品的视觉水准
  - **Skills**: [`frontend-ui-ux`] — 设计 tokens 与排版是核心交付
  - **Skills Evaluated but Omitted**: `playwright`（仅截图验证，非交互测试）

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 3（与 15-19）
  - **Blocks**: 21, 22, 23, 24 — **Blocked By**: 1, 3

  **References**:
  - Tailwind v4 theme: `https://tailwindcss.com/docs/theme` — `@theme` tokens
  - 计划 C6 testid 注册表 — 挂载清单
  - **WHY**: 用户指定前端由 visual-engineering 实现；本任务定设计基调+组件 API+TID 挂载规范，21-24 必须严格复用

  **Acceptance Criteria**:
  - [ ] 3 页面在 1280×800 无横向滚动；375×812 下三栏折为单列
  - [ ] 基础件 Storybook-less 示例页（或临时页）渲染正常且每个组件带 data-testid
  - [ ] `app/page.tsx` 空态含"请先配置端点与翻译 Agent"CTA（链 /config）
  - [ ] 截图证据 3 页×2 尺寸共 6 张

  **QA Scenarios**:
  ```
  Scenario: 三页渲染与响应式（happy path）
    Tool: Playwright
    Preconditions: `npm run dev` 运行中
    Steps:
      1. page.goto('http://localhost:3000/') → 断言 `h1` 含"工作台"字样且无 JS 报错
      2. setViewportSize(375x812) → 断言无横向滚动条（document.scrollWidth<=innerWidth）
      3. 截图 3 页 × 2 尺寸
    Expected Result: 布局正确响应式成立
    Evidence: .omo/evidence/task-20-shell-desktop.png + task-20-shell-mobile.png

  Scenario: 空态 CTA（negative/edge）
    Tool: Playwright
    Steps:
      1. 全新 DB 访问 / → 断言 [data-testid="empty-state-cta"] 可见且点击跳转 /config
    Expected Result: 空态引导正确
    Evidence: .omo/evidence/task-20-empty-state.png
  ```

  **Commit**: YES — `feat(ui): 应用壳 + 设计 tokens + 基础组件`
  - Files: `app/layout.tsx`, `app/page.tsx`, `app/config/page.tsx`, `app/history/page.tsx`, `app/globals.css`, `src/components/ui/*`
  - Pre-commit: `npm run build`

- [ ] 21. 配置 UI：端点/Agent 编辑器/统筹配置/提示词编辑/flash 弹窗

  **What to do**（`app/config/page.tsx` 及 `src/components/config/*`，全部 client component 调任务 15 API）:
  - **端点管理**：列表（TID endpoint-list-item）+ 表单（name/base_url/api_key；api_key 用 password 输入+显示切换）+ 删除确认（usedBySessions>0 时警告文案"被 N 个会话引用，删除不影响这些会话"）；内置预设按钮组（OpenAI/Gemini/DeepSeek/OpenRouter/Ollama——点击自动填 base_url 占位）
  - **翻译 Agent 编辑器**（R1）：卡片列表（TID agent-card）——每卡片：名称、端点下拉、模型名文本输入（TID model-input）、提示词覆盖开关（TID prompt-override-toggle，开=textarea 覆盖/关=显示"使用全局默认提示词"灰态）、删除；`add-agent-button` 追加；拖拽或上下按钮调整 sort_order；≥2 个同 model+同 prompt 卡片时显示非阻塞提示"存在配置相同的 Agent"（E6）
  - **统筹配置**：端点下拉+模型输入（TID coordinator-model-input）+ 聊天模型（可选，缺省同统筹）；"保存"后若响应含 warning → 居中 Modal（TID flash-warning）显示"不推荐使用flash模型进行统筹"+ checkbox"不再提示"（TID dont-show-again-checkbox）→ 勾选后再保存时带 suppress_warnings（R2 完整闭环）
  - **提示词编辑**：5 个 kind 选项卡（翻译默认/审查/筛选/编排/组装）——textarea 编辑器+变量说明侧注（{{source_text}} 等）+"恢复内置默认"按钮（调 reset）；编辑内置模板时提示"将另存为自定义副本"
  - 表单错误 toast；加载骨架；全部文案中文

  **Must NOT do**:
  - 不做模型名自动补全/远程拉取（v1 手动输入，范围锁）
  - 不加"测试连接"按钮（范围锁，v1.1）；不增加设置页之外的入口
  - 不绕过任务 20 的基础件（Button/Input/Modal 必须复用）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering` — 配置表单密度高，需保持视觉呼吸感与交互清晰
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 4（与 22-24）
  - **Blocks**: 25 — **Blocked By**: 15, 20

  **References**:
  - 任务 15 API 形状（warning/suppress/usedBySessions）+ C6 testid 注册表
  - 设想文件 R1（数量/独立提示词/独立模型）+ R2（flash 警告+不再提示）
  - **WHY**: R1/R2 的用户界面全部在本任务；flash 闭环（检测→警告→抑制→不再出现）是 AC22 的考点

  **Acceptance Criteria**:
  - [ ] AC16：空库首访 → "添加端点"CTA → 填 Ollama 预设 → 列表出现该端点
  - [ ] AC17：创建 3 个 agent（不同 prompt 覆盖）→ 3 张卡片且刷新后仍在
  - [ ] AC22：统筹模型填 gemini-1.5-flash → 弹窗文案精确；勾"不再提示"后改模型再改回 → 不再弹
  - [ ] 提示词编辑内置模板 → 生成副本且"恢复内置默认"可用

  **QA Scenarios**:
  ```
  Scenario: 端点+Agent+flash 闭环（happy path）
    Tool: Playwright
    Preconditions: npm start 运行，DB 已清空
    Steps:
      1. goto /config → click [data-testid="add-endpoint-button"] → 填 name="Mock" base_url=mock → save → 断言 endpoint-list-item 含 "Mock"
      2. 点 add-agent-button × 3，各填不同 model → 断言 agent-card 计数===3
      3. coordinator-model-input 填 "gemini-1.5-flash" → 保存 → 断言 flash-warning 可见且文本=="不推荐使用flash模型进行统筹"
      4. 勾 dont-show-again-checkbox → 确定 → 改 model 为 "gpt-4o" 保存 → 再改回 "gemini-1.5-flash" 保存 → 断言 flash-warning 不存在
    Expected Result: R1+R2 UI 闭环全通
    Evidence: .omo/evidence/task-21-config-ui.png + task-21-flash-flow.png

  Scenario: 非法表单与重复提示（negative）
    Tool: Playwright
    Steps:
      1. agent 表单 model 留空保存 → 断言错误提示可见且请求未发出（网络监听无 POST）
      2. 建 2 个同 model 同 prompt agent → 断言"配置相同的 Agent"提示可见但不阻止保存
    Expected Result: 校验与 E6 提示正确
    Evidence: .omo/evidence/task-21-validation.png
  ```

  **Commit**: YES — `feat(ui): 配置面板（端点/Agent/统筹/提示词/flash 弹窗）`
  - Files: `app/config/page.tsx`, `src/components/config/*`
  - Pre-commit: `npm run build`

- [ ] 22. 翻译视图：原文输入 + Agent 流式卡片网格 + 单卡重试

  **What to do**（`app/page.tsx` 左栏 + `src/components/translate/*`）:
  - **原文区**：语言对显示（快照 source_lang→target_lang，默认 英文→中文五言）+ 大 textarea（TID source-input，字数/估算 token 显示，超 8k 红字警告禁提交）+ `translate-button`（主 CTA，创建 session 并触发翻译）
  - **会话创建流程**：POST /api/sessions → 取得 id → POST translate（SSE，`fetch`+ReadableStream 读取，复用任务 3 parseSSEChunk 浏览器版）
  - **卡片网格**（R1 可视化）：每 agent 一卡（TID agent-stream-card）——头部：agent 名+模型名+状态徽章（streaming 脉冲动画/complete 墨绿/error 朱红）；体部：流式文本逐字渲染（等宽→译文完成切换 `.poem-text` 排版）；error 卡显示错误摘要+`retry-agent-button`（调 retry 路由，仅该卡重置流式）
  - **完成态**：`fanout_complete` 后显示汇总条（"成功 5 / 失败 1"）+ 失败卡片保持可重试；全部 complete 后右栏统筹 stepper 亮起可进入
  - 进行中禁用原文编辑与翻译按钮；页面卸载取消 SSE（AbortController）

  **Must NOT do**:
  - 不自动轮询刷新（SSE 是唯一实时通道）；不做翻译进度百分比假条（流式即进度）
  - 不在卡片内做编辑功能（编辑归任务 24 最终文本区）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering` — 多卡流式并发渲染的节奏感与状态可读性是体验核心
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 4（与 21,23,24）
  - **Blocks**: 25 — **Blocked By**: 17, 20

  **References**:
  - 契约 C1 translate 事件序 + 任务 17 API + C6 testid
  - 设想文件 R1（多模型并行的可视化）+ Metis AC18
  - **WHY**: 用户原始工作流的第一步（6 模型并行）在此产品化；状态徽章语义（agent-status-*）是 AC18 考点

  **Acceptance Criteria**:
  - [ ] AC18：输入原文 → 点翻译 → N 卡流式填充 → 全部 agent-status-complete → 汇总条正确
  - [ ] 1 卡 error → retry-agent-button 点击后仅该卡重流式且其余卡不动
  - [ ] 超 8k token 输入 → 按钮禁用+警告文案
  - [ ] SSE 中断（杀 mock）→ 在飞卡片转 error 态而非永远 streaming

  **QA Scenarios**:
  ```
  Scenario: 并行流式翻译（happy path）
    Tool: Playwright（mock LLM：3 agent 不同延迟流式）
    Preconditions: 已配 endpoint(mock)+3 agents
    Steps:
      1. goto / → source-input 填 "The woods are lovely, dark and deep,\nBut I have promises to keep" → click translate-button
      2. 断言 agent-stream-card 计数===3 且各卡陆续出现文本（流式：首文本出现时 status===streaming）
      3. 等待全部 agent-status-complete → 断言汇总条文本含 "成功 3"
    Expected Result: AC18 全通
    Evidence: .omo/evidence/task-22-translate-grid.png + task-22-translate-stream.webm(可选)

  Scenario: 单卡失败重试（negative）
    Tool: Playwright（mock：agent-2 behavior=error(500)）
    Steps:
      1. 翻译 → 断言第 2 卡 agent-status-error 可见且其余 complete
      2. mock 改为正常 → click 该卡 retry-agent-button → 断言仅第 2 卡重置为 streaming 后 complete，其余卡文本未变
    Expected Result: 部分失败+单卡恢复成立
    Evidence: .omo/evidence/task-22-retry.png
  ```

  **Commit**: YES — `feat(ui): 翻译视图（原文+流式卡片网格+重试）`
  - Files: `app/page.tsx`, `src/components/translate/*`
  - Pre-commit: `npm run build`

- [ ] 23. 统筹视图：4 步 stepper + 阶段输出面板 + stale + 单步重跑

  **What to do**（`app/page.tsx` 右栏 + `src/components/coordinator/*`）:
  - **stepper**（TID stage-stepper）：4 节点"审查→筛选→编排→组装"，节点状态：pending 灰/running 脉冲/complete 墨绿/failed 朱红/stale 琥珀+`stage-stale-badge`"已过期"；当前可运行节点高亮（前置 complete 才可点，C5 顺序守卫 UI 化）
  - **运行**：点击节点或 `run-stage-button` → POST stages/[stage]/run（SSE）——orchestrate/assemble 节点体内流式渲染 delta；review/filter 显示运行动画等待 complete
  - **输出面板**（每阶段一张，`stage-output-panel`）：
    - review： assessments 表格（agent/优劣/score/keep 徽章）
    - filter：选中名单+rationale；被淘汰者灰显理由
    - orchestrate：structure_notes + segment_assignments 列表（段序/来源 agent/片段/理由）
    - assemble：最终译文 `.poem-text` 排版展示（即写入 final-text 区的内容）+ notes
    - failed：错误详情+重跑按钮；schema_error：解析细节折叠展示
  - **stale 联动**：收到 complete 后刷新 session 状态，下游节点转琥珀 stale 且 tooltip"上游已重跑，需重新运行"
  - 全部 complete → 自动滚动至最终文本区并提示"可开始对话修改"

  **Must NOT do**:
  - 不允许跨节点点击运行（顺序守卫 UI 不绕）；不缓存前端阶段结果（以服务端为准）
  - 不折叠/隐藏任何阶段输出（R3 中间可见是硬需求）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering` — 多状态 stepper + 异构输出面板的排版层级
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 4（与 21,22,24）
  - **Blocks**: 25 — **Blocked By**: 18, 20

  **References**:
  - 契约 C1 阶段事件/C2 schema（面板渲染的数据形状）/C5（顺序+stale）+ 任务 18 API
  - Metis AC19 + 设想 R3「中间可见」
  - **WHY**: R3「四步流程标准提示词+完整上下文」的用户可见面；stale 徽章是 AC19 之后防误用的关键

  **Acceptance Criteria**:
  - [ ] AC19：翻译完成后 stepper 可见 4 节点 → 逐节点运行 → 各输出面板渲染对应结构化内容 → assemble 后最终文本区出现译文
  - [ ] 重跑 filter → orchestrate/assemble 节点显示 stage-stale-badge 且不可跳过运行
  - [ ] schema_error（mock malformed）→ failed 节点显示详情+重跑按钮，点击后恢复

  **QA Scenarios**:
  ```
  Scenario: 四步统筹全通（happy path）
    Tool: Playwright（mock：各阶段返回合法 JSON）
    Preconditions: 已完成翻译（3 卡 complete）
    Steps:
      1. 断言 stage-stepper 4 节点存在 → click [data-stage="review"] 的 run-stage-button
      2. 等待 [data-stage="review"] stage-output-panel 出现 assessments 表格（断言含 "quality_score" 列或对应中文表头）
      3. 依次运行 filter/orchestrate（断言流式）/assemble
      4. 断言 [data-testid="final-text"] 含组装译文非空
    Expected Result: AC19 全通
    Evidence: .omo/evidence/task-23-coordinator-stepper.png + task-23-stage-outputs.png

  Scenario: stale 联动（negative/edge）
    Tool: Playwright
    Steps:
      1. 四步全完后重跑 filter → 等待 complete → 断言 orchestrate/assemble 节点出现 stage-stale-badge
      2. 尝试点击 assemble 的 run-stage-button（其前置 stale）→ 断言被禁或点击后提示顺序错误
    Expected Result: stale 防误用成立
    Evidence: .omo/evidence/task-23-stale.png
  ```

  **Commit**: YES — `feat(ui): 统筹视图（stepper+阶段面板+stale）`
  - Files: `src/components/coordinator/*`, `app/page.tsx`
  - Pre-commit: `npm run build`

- [ ] 24. 编辑+聊天视图：final-text 选中 popover + 聊天面板 + 版本历史

  **What to do**（`app/page.tsx` 底部/侧栏 + `src/components/editor/*`）:
  - **final-text 区**（TID final-text）：`.poem-text` 排版展示当前最新版本文本；`coordinating` 中只读（`data-readonly="true"`+锁图标，E25）；可选中（`window.getSelection`）
  - **选中 popover**（R4 核心交互）：选中非空文本 → 浮层（TID edit-popover，定位在选区上方，视口边缘防溢出）——显示所选片段预览（截 40 字）+ 指令输入框（TID edit-instruction，placeholder"如何修改这段文字？"）+ 提交按钮（TID edit-submit）；提交时快照 selection 坐标（研究：快照技巧防响应期间光标移动）→ POST chat `{message, selection:{text}}`
  - **聊天面板**（TID chat-panel）：消息流（用户右/AI 左，`chat-message`）——AI 消息流式渲染；工具调用消息特殊渲染（TID tool-call-badge：`替换「old 前 20 字…」→「new 前 20 字…」`+成功墨绿/失败朱红+diffSummary）；降级提示系统消息（"已切换兼容模式"）；输入框+发送（Enter 发送/Shift+Enter 换行）
  - **版本历史**（TID version-history）：侧栏列表（`version-item`：v1 组装/v2 编辑/v3 恢复…+时间+摘要首行），点击非当前版本 → 确认后调 restore API → 全文刷新为新版本（append-only）；当前版本高亮
  - 编辑完成后 final-text 平滑滚动到变更处并短暂高亮变更片段

  **Must NOT do**:
  - 不做行内 diff 视图/并排对比（范围锁；diffSummary 文案即可）
  - 不做 undo/redo 按钮（版本历史即恢复，范围锁）；不允许编辑 final-text DOM 内容（修改只能走聊天工具路径）
  - 不持久化 popover 草稿（刷新即弃）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering` — 选中 popover 定位/流式聊天/版本历史三合一的交互精度
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES — **Parallel Group**: Wave 4（与 21-23）
  - **Blocks**: 25 — **Blocked By**: 19, 20

  **References**:
  - 契约 C1 聊天事件/C4 工具语义 + 任务 19 API（selection 组装/message_complete.version_no）+ 任务 16 restore
  - 设想 R4 原文 + 研究（bg_67b3fe33）：快照技巧/工具结果反馈渲染
  - Metis AC20/AC21 + **WHY**: R4「选中并调用 AI 修改，通过工具替换」是用户工作流的最后一公里，交互精度决定可用性

  **Acceptance Criteria**:
  - [ ] AC20：选中 final-text 片段 → edit-popover 出现含片段预览 → 输入"更典雅一些"提交 → 聊天面板出现用户消息+AI 响应+tool-call-badge → final-text 对应片段被替换
  - [ ] AC21：2 轮编辑后 version-history 显示 3 条；点击 v1 恢复 → final-text 回到 v1 内容且列表出现 v4（source=restore）
  - [ ] 纯讨论消息（"你觉得这首译得如何"）→ AI 回复但 final-text 不变、无 tool-call-badge
  - [ ] coordinating 中 final-text data-readonly="true" 且 popover 不触发

  **QA Scenarios**:
  ```
  Scenario: 选中修改+版本历史（happy path）
    Tool: Playwright（mock：首轮返回 tool_call 替换选中片段）
    Preconditions: assemble 完成，final-text 有译文
    Steps:
      1. 用 page.evaluate 选中 final-text 的前 7 个字符 → 断言 edit-popover 可见且预览含该片段
      2. edit-instruction 填 "更典雅一些" → click edit-submit
      3. 等待 tool-call-badge(ok) → 断言 final-text 前 7 字符已变为 mock 的 new_string
      4. 断言 version-history 有 2 条；再次编辑后 3 条；click 第 1 条恢复 → 断言 final-text 回到最初且出现第 4 条
    Expected Result: AC20+AC21 全通
    Evidence: .omo/evidence/task-24-selection-edit.png + task-24-version-history.png

  Scenario: 讨论不改文+锁定（negative）
    Tool: Playwright
    Steps:
      1. 不发 selection，聊天输入 "评价一下" → 断言 AI 回复出现但 final-text 文本未变且无 tool-call-badge
      2. （置 coordinating 状态）→ 断言 final-text[data-readonly="true"] 且选中文本不弹 popover
    Expected Result: E18/E25 成立
    Evidence: .omo/evidence/task-24-discussion-lock.png
  ```

  **Commit**: YES — `feat(ui): 编辑+聊天视图（选中 popover+聊天+版本历史）`
  - Files: `src/components/editor/*`, `app/page.tsx`
  - Pre-commit: `npm run build`

- [ ] 25. Playwright E2E 套件：mock LLM 全链路（AC16-AC22）

  **What to do**:
  - `playwright.config.ts`：testDir=`e2e/`；`webServer` 启动 `npm run build && npm start`（端口 3100）；globalSetup 启动 mock LLM（端口 41099，复用任务 4 fixture 的独立可执行封装 `test/fixtures/mock-llm-server.ts`：读 `MOCK_SCENARIO` 环境变量/控制端口切换行为）；baseURL=localhost:3100；trace/video 仅失败保留
  - 控制通道：mock server 暴露 `POST /__control`（`{behavior, model?, delayMs?}`）供 spec 内动态切换
  - spec 文件（每 spec 独立重置 DB：删 `data/app.db` 或调 `POST /__test__/reset-db`——新增仅 test 环境注册的 `app/api/__test__/reset-db/route.ts`，`NODE_ENV!=='production'` 才挂载）：
    - `e2e/config.spec.ts`：AC16 端点添加 + AC17 三 agent 配置 + AC22 flash 警告闭环
    - `e2e/translate.spec.ts`：AC18 流式网格 + 单卡重试（AC23 部分失败场景并入）
    - `e2e/coordinator.spec.ts`：AC19 四步全通 + stale 联动
    - `e2e/editing.spec.ts`：AC20 选中修改 + AC21 版本历史 + 讨论不改文
    - `e2e/performance.spec.ts`：AC24 基线——6 agent×10ms/token 延迟 mock 下 fanout 完成 <5s、四阶段 <10s（页面计时埋点断言）
  - 证据：关键步骤截图+失败 trace 存 `.omo/evidence/e2e/`

  **Must NOT do**:
  - 不在 E2E 调任何真实 LLM（base_url 一律指向 mock）；不跳过 build 直接 dev server（验证生产形态）
  - 不用 `page.waitForTimeout` 做同步（一律 web-first assertions / waitForSelector）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — E2E 编排+环境生命周期管理复杂
  - **Skills**: [`playwright`] — spec 编写与环境搭建核心技能

  **Parallelization**:
  - **Can Run In Parallel**: NO — **Parallel Group**: Sequential（需 21-24 全部就位）
  - **Blocks**: 26 — **Blocked By**: 21, 22, 23, 24

  **References**:
  - Playwright webServer/globalSetup: `https://playwright.dev/docs/test-webserver` + `https://playwright.dev/docs/test-global-setup-teardown`
  - 任务 21-24 的 QA 场景（本任务将其固化为 spec）+ Metis AC16-22/AC23/AC24
  - **WHY**: 四大面板各自单测过不等于全链路通；本套件是 R1-R4 端到端可演示的最终证据

  **Acceptance Criteria**:
  - [ ] 5 个 spec 全绿覆盖 AC16-AC24；`npx playwright test` 退出码 0
  - [ ] mock 控制通道可动态切行为（spec 内验证 error→retry 路径）
  - [ ] reset-db 路由在 production 构建中不生效（404）

  **QA Scenarios**:
  ```
  Scenario: 全链路 happy path（R1→R4 串联）
    Tool: Playwright
    Preconditions: 干净 DB；mock 正常流式+合法阶段 JSON+tool_call
    Steps:
      1. 运行 `npx playwright test e2e/` → 全部 passed
      2. 抽查 editing.spec 证据截图：tool-call-badge 可见且 final-text 已替换
    Expected Result: AC16-AC24 全绿
    Evidence: .omo/evidence/task-25-e2e-run.txt + .omo/evidence/e2e/*.png

  Scenario: 生产形态验证（negative）
    Tool: Bash
    Steps:
      1. `npm run build` 后 `curl -s -o /dev/null -w "%{http_code}" localhost:3100/api/__test__/reset-db`（NODE_ENV=production 启动）→ 断言 404
    Expected Result: 测试后门不出现在生产
    Evidence: .omo/evidence/task-25-prod-safety.txt
  ```

  **Commit**: YES — `test(e2e): Playwright 全链路套件（mock LLM）`
  - Files: `playwright.config.ts`, `e2e/*`, `test/fixtures/mock-llm-server.ts`, `app/api/__test__/*`
  - Pre-commit: `npx playwright test`

- [ ] 26. 边界硬化 + 集成测试：中止/并发/DB 锁/E 案例（AC1-AC4, AC23-25）

  **What to do**:
  - 集成测试 `test/integration/`（vitest，内存 DB+mock LLM，直调 handler）：
    - AC1：非法状态转换全表扫描式断言（每对 from→to 验 200/409）
    - AC2：快照隔离（创建后改配置 → translate 仍用旧 prompt，断言 mock 收到的消息）
    - AC3+AC23：6 agent 1 失败 → 统筹仍跑通且 final_text 非空
    - AC4：12 agent 并发上限 ≤8（计数器）
    - AC25：两 session 并行 translate → 双双完成无 SQLITE_BUSY（WAL）
    - E10/E11：SSE 客户端中断 → 5s 内无孤儿 LLM 请求（mock getRequests 不再增长）
    - E13：模拟重启（新 DB 句柄）→ streaming 孤儿被标 interrupted
    - E27：DB 文件被外部句柄占用时错误为可读 500（不崩溃进程）
    - E28：版本历史 100+ 行查询分页正确
  - 修复测试暴露的真实缺陷（允许小幅改 Wave 2/3 文件，但须保持其原 QA 场景全绿）
  - 全量回归：`npx vitest run` + `npx playwright test` 双绿

  **Must NOT do**:
  - 不为通过测试而放松契约（C1-C6 不可动）；不新增范围外功能
  - 不用 `as any`/跳过测试等手段

  **Recommended Agent Profile**:
  - **Category**: `deep` — 并发/中止/锁的缺陷定位需要强推理
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — **Parallel Group**: Sequential
  - **Blocks**: 27 — **Blocked By**: 25

  **References**:
  - Metis AC1-4/AC23-25/E10-E28 + 契约 C5
  - **WHY**: 生产可靠性收尾；并发与中止是 mock 单测覆盖不到的真实风险面

  **Acceptance Criteria**:
  - [ ] `test/integration` 全绿（≥9 个用例覆盖上列清单）
  - [ ] 全量 `npx vitest run` 与 `npx playwright test` 双绿
  - [ ] 发现的缺陷有对应回归测试

  **QA Scenarios**:
  ```
  Scenario: 集成套件全绿（happy path）
    Tool: Bash
    Steps:
      1. `npx vitest run test/integration` → 全部 passed
      2. `npx vitest run` 全量 → 全部 passed
    Expected Result: AC1-4/23-25 与 E 案例全部覆盖
    Evidence: .omo/evidence/task-26-integration.txt

  Scenario: 并发与中断（negative）
    Tool: Bash
    Steps:
      1. vitest AC25：两并行 translate → 无 SQLITE_BUSY 且双 session 均 translated
      2. vitest E11：SSE 断开后轮询 mock getRequests 5s → 数量冻结
    Expected Result: 硬化有效
    Evidence: .omo/evidence/task-26-concurrency-abort.txt
  ```

  **Commit**: YES — `test(integration): 边界硬化与集成测试`
  - Files: `test/integration/*`, （少量）Wave2/3 缺陷修复
  - Pre-commit: `npx vitest run && npx playwright test`

- [ ] 27. README + 运行脚本 + 最终构建验证

  **What to do**:
  - `README.md`（中文）：产品简介（R1-R4 功能点）、快速开始（`npm install && npm run build && npm start` → localhost:3000）、端点配置指引（预设列表+自定义 base_url 说明，含中转站/OpenRouter/Ollama 提示）、工作流说明（配置→翻译→四步统筹→选中修改）、开发命令（test/e2e/typecheck）、架构速览（目录树+契约 C1-C6 指针）、FAQ（flash 警告含义/兼容模式提示/数据位置 `./data/app.db`）
  - `package.json` scripts 最终核对：`dev/build/start/test/e2e/typecheck/lint` 齐全
  - 最终验证：全新 clone 模拟——删 node_modules+data → `npm install` → build → start → 冒烟（/api/endpoints 200 + 首页 200）
  - `.gitignore` 复核：data/、.omo/evidence/、playwright-report/、test-results/

  **Must NOT do**:
  - 不写英文 README（G 范围锁）；不添加 LICENSE/CONTRIBUTING 等额外文件（范围锁）
  - 不在 README 承诺未实现的功能（对照 Must NOT Have 清单复核）

  **Recommended Agent Profile**:
  - **Category**: `writing` — 文档清晰准确
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — **Parallel Group**: Sequential
  - **Blocks**: F1-F4 — **Blocked By**: 26

  **References**:
  - 本计划 Must Have/Must NOT Have（README 功能描述的唯一事实源）
  - **WHY**: 交付物的门面；冒烟验证保证「全新环境可跑」这一最终验收

  **Acceptance Criteria**:
  - [ ] README 存在且快速开始章节命令逐一可执行
  - [ ] 全新冒烟：install→build→start→`curl /api/endpoints` 200 + `curl /` 200 含中文标题
  - [ ] `git status` 干净（无应忽略文件被追踪）

  **QA Scenarios**:
  ```
  Scenario: 全新环境冒烟（happy path）
    Tool: Bash
    Steps:
      1. 删 node_modules data .next → `npm install` → `npm run build` → 后台 `npm start`
      2. `curl -s localhost:3000/api/endpoints` → {"endpoints":[]}
      3. `curl -s localhost:3000/` → 200 且含 "智能体翻译工作台"
    Expected Result: 全新环境零手工干预可跑
    Evidence: .omo/evidence/task-27-fresh-smoke.txt

  Scenario: 文档一致性（negative）
    Tool: Bash
    Steps:
      1. grep README 中的命令与 package.json scripts 比对 → 全部存在
      2. grep README 违禁功能词（导出/暗色/术语库）→ 0 命中
    Expected Result: 文档与实现零漂移
    Evidence: .omo/evidence/task-27-readme-consistency.txt
  ```

  **Commit**: YES — `docs: README 与最终构建验证`
  - Files: `README.md`, `package.json`（scripts 核对）
  - Pre-commit: 全新冒烟通过

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 个审查 agent 并行运行，全部 APPROVE 后向用户汇报并取得明确 "okay" 才算完成。
> **禁止**在验证后自动继续；F1-F4 未获用户 okay 前不得勾掉。拒绝或用户反馈 → 修复 → 重跑 → 再汇报。

- [ ] F1. **计划合规审计** — `oracle`
  通读本计划。逐条 Must Have：读文件/curl 端点/运行命令验证实现存在。逐条 Must NOT Have：全库搜索违禁模式（edge runtime、原生 SDK import、LangChain、流式 token 落库 SQL、自定义阶段 API、diff 视图组件……），命中即 file:line 拒绝。核查 `.omo/evidence/` 证据文件齐全。对照交付物清单。
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [27/27] | VERDICT: APPROVE/REJECT`

- [ ] F2. **代码质量审查** — `unspecified-high`
  运行 `npx tsc --noEmit` + `npm run lint` + `npx vitest run`。审查全部变更文件：`as any`/`@ts-ignore`、空 catch、生产 console.log、注释掉的死代码、未用 import。检查 AI slop：过度注释、过度抽象、generic 命名（data/result/item/temp）。
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N/N] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **真实手动 QA** — `unspecified-high`（+ `playwright` skill）
  从干净状态启动（删 data/ + `npm start`）。执行每个任务的每个 QA 场景——严格按步骤，采集证据到 `.omo/evidence/final-qa/`。测跨任务集成（配置→翻译→统筹→聊天修改全链路串联）。测边界：空状态、非法输入、快速连续操作。
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **范围保真检查** — `deep`
  逐任务：读 "What to do" + 实际 git diff，验证 1:1——规格内全部实现（无遗漏）、规格外零新增（无蔓延）。核查 "Must NOT do" 遵守。检测跨任务污染（任务 N 改了任务 M 的文件）。标记未归属变更。
  Output: `Tasks [27/27 compliant] | Contamination [CLEAN/N] | Unaccounted [CLEAN/N] | VERDICT`

---

## Commit Strategy

- 每任务一次提交（TDD 任务：测试+实现同一提交）；Wave 5 各任务独立提交
- 格式：`type(scope): desc`，type ∈ feat/test/chore/docs/fix
- 预提交：`npx vitest run --related <files>`（或该任务验收命令）必须通过

---

## Success Criteria

### Verification Commands
```bash
npm run build                 # 期望: 编译成功，0 type error
npx vitest run                # 期望: 全部 pass（纯逻辑+服务+路由集成，mock LLM）
npx playwright test           # 期望: 全部 pass（mock LLM 全链路）
curl -s http://localhost:3000/api/endpoints   # 期望: {"endpoints":[]}
```

### Final Checklist
- [ ] R1-R4 全部可演示（Playwright 证据）
- [ ] 契约 C1-C6 全部落地
- [ ] 全部 Must Have 在场 / 全部 Must NOT Have 缺席
- [ ] vitest + Playwright 全绿
- [ ] F1-F4 全部 APPROVE 且用户明确 okay
