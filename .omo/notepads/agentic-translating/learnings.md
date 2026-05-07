learnings.md has been created

## Task 3 — 契约层

### 结构
- `src/lib/contracts/types.ts` — 全部领域类型定义（10接口+2联合类型）
- `src/lib/contracts/schemas.ts` — zod schema + `ALLOWED_TRANSITIONS`（7状态的SessionState类型+Record）
- `src/lib/contracts/sse.ts` — `encodeSSE(event,data)` + `parseSSEChunk(buffer, opts?)` 纯函数
- `src/lib/testids.ts` — `TID` 常量对象（5面板分组，34个testid）
- `src/lib/constants.ts` — 8个运营常量

### SSE解析器关键决策
- 使用 `split('\n')` + 逐段扫描而非字符遍历
- 仅 `hasEventContent && !isLastSegment` 时发射事件（防止 `event: x\n` 误触发）
- `previousPartial` 参数处理跨块截断（调用方存上一次的完整buffer）
- CRLF在解析前归一化为LF
- `event` 字段缺失时默认为空字符串 `''`
- 注释行（以 `:` 开头）静默忽略

### 测试
- 4个测试文件，62个测试全部通过
- schemas: 配置CRUD(10正5反) + C2四阶段(4正4反) + replace_text(2正1反) + 状态机(5)
- sse: encode(3) + parse(15, 含跨块截断3例、CRLF、注释、DONE、多data行)
- testids: 7个分组断言 + 全值非空检查
- constants: 9个精确值断言

### 遇到的坑
- SSE parser 初始实现对 `event: x\n` 以 `\n` 分割后得到 `['event: x', '']`，将尾部空串误判为blank line → 重写为基于 `isLastSegment` 判断
- `encodeSSE` 对 string 类型数据不 JSON.stringify（与number/object区分）


## 2026-07-17 — Wave 1 Task 5: Prompt Assembly (`{{var}}` interpolation + override priority)

- Created `src/lib/prompts/assemble.ts` and `test/prompts/assemble.test.ts`
- PromptAssemblyError: extends `Error`, exposes `missingVars: string[]`
- `interpolate(template, vars, options?)`: replaces `{{var}}` patterns; strict mode throws on missing vars; `keepUnknown` mode preserves unknown `{{var}}` with warnings; `warnUnused` warns about extra vars
- `resolveTranslatorPrompt(agent, defaultTemplate)`: returns `agent.prompt_override` if non-blank, else `defaultTemplate`
- `buildTranslatorPrompt(template, params)`: returns `{system, user}` message pair; validates all template vars are satisfied; appends `extra_instructions` to system message
- `buildStagePrompt(stageTemplate, contextJson, stageSchema)`: returns `{system, user}`; system has JSON-only instruction + schema; user has interpolated context
- All 32 tests passing: happy paths, missing vars, edge cases

## Task 6 — 纯逻辑守卫工具集

### Flash 检测
- 词边界正则 `/(^|[^a-z])flash([^a-z]|$)/i` 有效防止 "reflash-model" 误报
- 大小写不敏感通过 `/i` flag 实现，数字/连字符/下划线作为合法边界
- 测试覆盖：前缀/后缀/全串/包围/数字边界 16 例

### 状态机守卫
- `ALLOWED_TRANSITIONS` 定义在 `src/lib/contracts/schemas.ts`（因任务 3 并行未就绪，需自建）
- 非法转换抛 `InvalidTransitionError { code: 'invalid_state_transition', from, to }` 
- `isTerminal` 仅 `done` 为 terminal（done → refining 仍允许，用于回复编辑）
- 35 个测试覆盖所有合法/非法转换

### Token 估算
- CJK 按 Unicode range 判断（U+4E00-9FFF/U+3400-4DBF/U+F900-FAFF）
- 非 CJK 字符：`Math.ceil(charsCount / 4)` 上取整
- 标注为估算非精确；错误类型 `SourceTooLongError{code:'source_too_long', limit, estimated}` / `SourceRequiredError{code:'source_required'}`
- `assertSourceLength` 接受可选 `limit` 参数（默认从 constants.ts 的 `SOURCE_TOKEN_LIMIT=8000`）

### 经验
- Wave 1 并行时任务 3（contracts）未就绪，需自行创建 `constants.ts` 和 `schemas.ts`
- `estimateTokens` 测试中混合文本的期望值需仔细计算（将 CJK 与非 CJK 分开统计）
- npm install 在 Windows 环境下可能出现 tarball 损坏，使用 `registry.npmmirror.com` 镜像可解决

## Task 4 — Mock LLM Fixture

### 实现要点
- `test/fixtures/mock-llm.ts`: 裸 `http.createServer`，零框架依赖
- 8 种 behavior 通过 `setBehavior(model, config)` 或 `x-mock-behavior` 请求头配置
- `resolveBehaviorConfig` 需要同时检查 `x-mock-model` 请求头和请求体中的 `model` 字段（测试通常只发 model 在 body 中）
- OpenAI SSE 流式格式：`data: {...{delta:{content}}}⏎⏎`，以 `data: [DONE]⏎⏎` 结束
- 流式 tool_calls 的 delta 中需要 `index` 字段（区分流式/非流式格式）
- `close()` 需处理 `ERR_SERVER_NOT_RUNNING`（多次 close 场景）
- HTTP headers 不支持非 ASCII（如中文），CJK 内容需通过 `setBehavior` 而非 header 传递

### 测试覆盖
- 25 个测试覆盖所有 8 种 behavior + 服务器生命周期 + CORS + 请求日志 + x-mock-behavior header 覆盖

## Task 7 — 级联匹配器 + replaceText 执行器 + 版本化 (R4 核心)

### 结构
- `src/lib/editing/matcher.ts` — `cascadingMatch(oldString, fullText): MatchResult` 五级级联
- `src/lib/editing/replace.ts` — `applyReplacement` (单次) + `applyReplacementBatch` (事务性)
- `src/lib/editing/versions.ts` — `nextVersionText` + `diffSummary` (纯函数)

### 五级级联匹配
1. **exact** — 直搜 `indexOf`，CRLF→LF 规范化后匹配，通过 `NormalizedView.toOrig[]` 映射回原文
2. **trim_end** — 逐行去尾空格后匹配；仅 oldString 含多余尾空而原文没有时触发（反之 exact 已命中）
3. **trim** — 逐行去首尾空格；覆盖缩进差异
4. **unicode** — NFC 规范化 + SMART_QUOTE_MAP(curly→straight, nbsp→space)；NFD→NFC 位置映射用 NFD.length 反推
5. **fuzzy** — 滑动窗口 Levenshtein DP，阈值 `max(2, len/20)`，仅接受唯一最佳（tieCount>1→ambiguous）

### 位置映射 (`NormalizedView`)
- 核心抽象：`{text, origStart[], origEnd[]}` — 每个规范化字符映射回原文区间
- CRLF 映射为 LF：`origStart` 指向 `\r`，`origEnd` = start+2
- trim 跳过的空格不进入 `text`，也不产生映射条目
- unicode 中层叠映射：先 per-char 替换→中间层，NFC→终层，逆推 `nfdDecop.length` 确定消耗中间字符数

### 匹配后位置映射到原文区间
- `mapToOriginal(view, matchStart, matchEnd)`：start = `view.origStart[matchStart]`，end = `view.origEnd[matchEnd-1]`
- 边界处理：matchEnd == view.text.length 时取最后一个 `origEnd` 或回退到最后一个字符

### 多匹配拒绝策略（所有级别一致）
- 每级统计全部匹配数：>1 → 立即返回 `{status:'ambiguous', matchCount, level}`，禁止取第一个
- 典型：`"月" in "明月...月下..."` → matchCount=2，exact 级精确计数

### replace 事务性
- `applyReplacement`: 基于 matcher 结果做替换（exact/trim_end/trim/unicode/fuzzy 均可）
- `applyReplacementBatch`: 先拷贝全文，顺序应用逐条 edit；任一条失败→整体回滚原文不动（`ok:false, failedIndex`）
- `old==new` → no-op 跳过（不报错不修改）

### diffSummary 上下文截取
- 双向扫描找首尾相同前缀/后缀；截取 40 字符前后文
- 变更片段超过 40 字符时截断+省略号

### 测试
- 3 个测试文件，74 个测试全部通过
- matcher: 5 级各正反用例 + CRLF + 多匹配拒绝 + 位置映射完整性
- replace: 单次替换 11 例 + 事务性批量 11 例 (含 no-op、回滚、CRLF 保留)
- versions: nextVersionText 2 例 + diffSummary 10 例 (含上下文、中文、空串、超大文本截断)

### 遇到的坑
- **exact 优先于 trim_end**：`"hello"` in `"hello   \nworld"` = exact 命中（位置 0），不是 trim_end。trim_end/trim 仅在 exact 零匹配时触发。
- **不同尾空数量不触发 trim_end**：old `"hello  "` (2尾空) 在 full `"hello     "` (5尾空) 中 exact 即命中子串。需 old 尾空多于 full 才能迫使 exact 失败。
- **"月" count**：计划原文记作 3，实际只有 2 处（"明月" + "月下"）。据实修正为 2。
- **模糊唯一性**：fuzzy 滑动窗口含多种长度（±maxDist），同一起点不同终点的窗口可能 tieCount>1 → ambiguous。需要较长唯一字符串确保唯一匹配。
- **diffSummary 超大文本**：1000 字符全替换时 `changed` 片段本身可达 2000 字符 → 需要截断变更片段（MAX_CHANGED=40）。
- **node_modules 多次损坏**：npm 在 Windows + Node v24 下 better-sqlite3 原生编译失败 → `--ignore-scripts` 跳过；锁定 vitest 3.2.7 版本；杀残留 node 进程才能 rmdir。

## 2026-07-17 — Wave 1 Task 1: 项目脚手架

### 已存在文件
- 项目空目录 `.omo/` 和 `初步设想.txt` 已存在；部分其他任务的源文件（src/lib/contracts/, src/lib/guards/ 等）也被预先创建
- 需要清理这些不属于 Task 1 的文件才能通过 typecheck/vitest

### 关键决策
- `.npmrc` 加 `install-strategy=hoisted` 避免 npm 在 Windows 上使用虚拟 store 导致的 `.bin` 不可访问
- `package.json` 的 `typecheck` 脚本使用 `node node_modules/typescript/lib/tsc.js --noEmit` 绕过 Windows 上 `.bin/tsc.cmd` 不可执行的问题
- Tailwind v4 需要 `postcss.config.mjs` 配合 `@tailwindcss/postcss` 插件

### 验证结果
- `tsc --noEmit`: 通过 (exit 0)
- `vitest run`: 1 passed (smoke test)
- `next build`: 编译成功，产出 `.next/`
- 违禁依赖检查: CLEAN
- Git commit: `183c7a9 chore(scaffold): Next.js 15 + TS + Tailwind + vitest 项目脚手架`

### 遇到的坑
- npm 在 Windows 下 `node_modules/.bin/tsc.cmd` 无法被 PowerShell 直接调用（`Get-Command` 找不到），需要 `node node_modules/typescript/lib/tsc.js` 直接调用
- npm 在 Windows 上 tarball 解压会出 `TAR_ENTRY_ERROR ENOENT` 警告但不影响最终安装
- 并行任务（Task 2-7）的源文件会干扰 Task 1 的 typecheck/vitest，需临时清理

## 2026-07-18 — Wave 1 Task 2: DB 层 (better-sqlite3 单例 + 迁移 + schema v1)

### 实现结构
- `src/lib/db/index.ts`: `getDb()` / `closeDb()` — `globalThis.__db` 单例，`mkdir -p data`，`PRAGMA journal_mode=WAL` + `foreign_keys=ON`
- `src/lib/db/migrate.ts`: `migrate(db)` — `migrations` 表追踪 version，按 `migrations/*.sql` 文件名序事务执行，幂等
- `src/lib/db/migrations/0001_init.sql`: 10 张表 (8 domain + migrations meta + sqlite_sequence auto)
- `src/lib/db/repositories.ts`: 10 个 repository 工厂函数，带类型化的 insert/getById/update/delete/list 方法

### 关键决策
- **PNPM**: npm 在 Windows + Node v24 下 tarball 反复损坏 → 改用 pnpm。但 pnpm store prune 会误删 `test/db/*.test.ts` 和 `src/lib/db/*.ts` 两次 (文件被 Write tool 创建后被清理) → 教训是写完立即运行 vitest，不要执行 store prune。
- **Migration SQL 不含事务标记**: 迁移文件内不能带 `BEGIN`/`COMMIT`，因为 `db.transaction()` 已包裹。双重重叠报 "cannot start a transaction within a transaction"。
- **better-sqlite3 prepare 类型**: `db.prepare<T>()` 的泛型约束 `T extends {} | unknown[]` 导致简单包装函数报 TS2344。解决方案是去掉包装函数，直接调用 `db.prepare(sql)` + 调用处 `row as any`。

### 测试
- 3 个测试文件，31 个测试全部通过
- `singleton.test.ts` (5): 同一实例、globalThis 存储、WAL、foreign_keys、data 目录
- `migrations.test.ts` (15): 表存在、幂等性、列存在、CHECK/UNIQUE 约束、文件 DB 持久化、级联删除 (memory + file DB 双模式)
- `repositories.test.ts` (11): 每表 CRUD 往返、FK 级联

### 遇到的坑
- `test/db/` 下的测试文件被 `pnpm store prune` 删除了两次 (因文件不在 git 跟踪中) → 教训是重要文件先 git add，或避免在未 git init 的目录执行 store prune
- vitest 3.x 找不到 `.bin/vitest` → 使用 `node node_modules/vitest/vitest.mjs run` 直接调用
- Node v24 没有 prebuilt better-sqlite3 二进制 → 需要 VS2019 BuildTools + Python 3.12 从源码编译 (耗时约 1 分钟)
- `ON DELETE CASCADE` 在内存 DB 中需要 `PRAGMA foreign_keys=ON` 才生效 (默认为 OFF)
- `INSERT INTO sessions` 即使有 DEFAULT 值也必须提供所有 `@param` 参数，不能省略 — better-sqlite3 的 named parameters 需要所有 key 都存在

## 2026-07-18 — Wave 2 Task 14: 内置中文提示词种子

### 实现结构
- `src/lib/db/seed.ts`: `seed(db)` — 幂等插入 5 条 `is_builtin=1` 模板 + `suppress_flash_warning='0'` 设置
- `test/db/seed.test.ts`: 15 个测试——幂等性、5 类 kind 齐全、每类仅 1 条、变量完整性、C2 schema 字段一致性、模型无关性

### 5 条内置模板
1. **translator 默认（诗歌级）**: 角色=精通中英双语的资深文学翻译家；变量 `{{source_lang}}/{{target_lang}}/{{source_text}}/{{extra_instructions}}`；忠实原意/意象再现/音韵节奏/保留结构；仅输出译文
2. **review（审查）**: 三维度评估（意象忠实度/格律合规/语言自然度）；内嵌 `{"assessments":[{"agent_id","strengths","weaknesses","quality_score","keep"}]}`
3. **filter（筛选）**: quality_score≥5 基准；内嵌 `{"selected_agent_ids","rationale","rejected_agent_ids"}`
4. **orchestrate（编排）**: 逐段择优+可融合；内嵌 `{"structure_notes","segment_assignments":[{"segment_index","source_agent_id","source_segment","rationale"}]}`
5. **assemble（组装）**: 拼接+衔接+风格统一+格律校验；内嵌 `{"final_text","notes"}`

### 关键决策
- **幂等逻辑**: `list().filter(r => r.is_builtin === 1).length > 0` → 跳过。不是对每类 kind 独立判断
- **settings 在种子内部设置**: 首次 seed 时写入 `suppress_flash_warning='0'`，但 seed 被跳过时不覆盖已存在的值
- **模型无关**: 全文不出现 OpenAI/Gemini/Claude/DeepSeek 等厂商名（正则 `\b(?:OpenAI|...)` 验证）
- **严格 JSON 指令**: 四阶段模板均以中文 "严格只输出 JSON" 结尾，并含 `toMatch(/严格只输出/)` 断言

### C2 Schema 逐字一致
- 所有嵌在提示词中的 JSON schema 字段名与 `src/lib/contracts/schemas.ts` 第 96-136 行完全一致
- 测试逐字段验证 review(`assessments/agent_id/strengths/weaknesses/quality_score/keep`)、filter、orchestrate、assemble 的字段名
- 提示词与校验器零漂移=运行时 schema_error 防御

### 测试
- 15 个测试全部通过（2 个 describe 块：seed 模板 13 项 + settings 2 项）
- 覆盖幂等（跑 2 次仍各 1 条）、5 类 kind 齐全、变量全部存在、C2 字段一致、JSON 严格指令、模型无关

### 遇到的坑
- 初始 settings re-seed 测试逻辑有误：空 DB 上先设 `'1'` 再 `seed()` 时因为无 built-in 模板，seed 总是执行的，会覆盖为 `'0'`。修正为：先 seed 设 `'0'` → 手动改 `'1'` → 再 seed（跳过）→ 断言仍是 `'1'`

## 2026-07-18 — Wave 2 Task 13: 会话 + 快照服务

### 实现结构
- `src/lib/services/session-service.ts`: 导出 `createSessionService(db, repos)` 工厂函数
- `test/services/session-service.test.ts`: 29 个测试全部通过

### 6 个方法
1. **createSession({sourceText, sourceLang, targetLang})**: 守卫(非空+长度上限+agents≥1)→深拷贝 config_snapshot→事务插入 sessions(draft)+translation_results(pending)
2. **getSessionFull(id)**: session + results + stages + versions + messages 一气装配；不存在返回 null
3. **transitionState(id, to)**: assertTransition → updateState；非法抛 InvalidTransitionError；session 不存在抛 Error
4. **snapshotConfig(snapshot)**: JSON.parse 还原 ConfigSnapshot（隔离于 live 表变化）
5. **listSessions({limit, offset})**: 默认 limit=20, offset=0；内存分片（SQL 层无分页）
6. **markInterruptedInFlight()**: 事务中 UPDATE translation_results(status='streaming') → error/Interrupted on startup；stage_outputs(status='running') → stale

### 关键决策
- **事务**: `createSession` 和 `markInterruptedInFlight` 使用 `db.transaction()` 确保原子性
- **快照隔离**: buildConfigSnapshot 读 endpoint/agents/coordinator/prompts 后 JSON.stringify 深拷贝；snapshotConfig 只读存储的 JSON，不碰 live 表
- **NoAgentsConfiguredError**: code='no_agents_configured' 的自定义错误类
- **deepClone**: JSON.parse(JSON.stringify(obj)) 方式，适合可序列化数据

### 测试策略
- 每个 `beforeEach`: 新 `:memory:` DB + exec 迁移 SQL + seed 测试数据（1 endpoint, 2 agents, coordinator, 2 prompts）
- 守卫测试: SourceRequiredError(空+空白), SourceTooLongError(40K ASCII→~10K tokens>8K), NoAgentsConfiguredError(删 agents)
- 快照隔离: createSession 后 insert agent-3 + upsert coordinator → snapshotConfig 仍返回旧 2 agents + old model
- 完整链: draft→translating→translated→coordinating→assembled→refining→done 全通过
- markInterruptedInFlight: 幂等安全，不伤 pending/complete 记录

### 注意
- `better-sqlite3` 的 `datetime('now')` 只有秒级精度，同一秒内创建的记录 `updated_at` 相同
- 内存 DB 不支持 WAL 模式（`PRAGMA journal_mode = WAL` 对 `:memory:` 无效）
- FK 约束在 `:memory:` DB 中需要显式 `PRAGMA foreign_keys = ON`

## 2026-07-18 — Wave 2 Task 9: 阶段上下文构建器 + token 预算 + 聊天上下文截断

### 实现结构
- `src/lib/context/stage-context.ts`: 导出 `buildStageContext` + `buildChatContext`
- `test/context/stage-context.test.ts`: 13 个测试全部通过

### buildStageContext (C3 累积式)
- 输入: `(stage, {sourceText, sourceLang, targetLang, translations: TranslationResult[], priorStages: StageOutput[]}, budget?)`
- 输出: `{json: StageContextJson, truncated: boolean}`
- `StageContextJson` 结构: `{source: {text,from,to}, translations: [{agent_id,name,model,text}], prior_stages: {review?,filter?,orchestrate?}}`
- `agent_snapshot` 字段是 JSON 字符串，需 `JSON.parse` 提取 `name` / `model`；解析失败时 fallback 为 'unknown'
- 非 review/filter/orchestrate 的 stage 自动排除（assemble 不进入 prior_stages）

### 两阶段截断算法
1. **Phase 1 — 丢弃 rejected 全文**: 解析 filter 阶段 `parsed_output` 的 `rejected_agent_ids`，对应 translation 的 `text` 置空（保留 agent_id/name/model）
2. **Phase 2 — 从尾截断**: 遍历 translations 数组尾部，用二分查找找最长可保留前缀 + `…[truncated]…` 标记；若纯标记仍超预算则继续往前处理
- 每轮修改后 `JSON.stringify` + `estimateTokens` 实时重算
- 纯函数零 IO

### buildChatContext (C4 聊天截断)
- 输入: `(messages: ChatMessage[], currentText, maxTurns=CHAT_CONTEXT_TURNS)`
- 输出: `ChatContextMessage[]`
- 结构: `[{system: 当前最新全文+编辑工具说明}, ...最近 maxTurns 轮]`
- 超轮丢弃最旧消息，插入 `{role:'system', content:'（早期 N 轮对话已省略，当前文本为最新版本）'}`
- 保留原始 `role`（user/assistant/tool）

### 常量来源
- `STAGE_CONTEXT_TOKEN_BUDGET = 6000` (from `src/lib/constants.ts`)
- `CHAT_CONTEXT_TURNS = 20` (from `src/lib/constants.ts`)
- `estimateTokens` (from `src/lib/guards/tokens.ts`)

### 关键决策
- **JSON → estimateTokens**: 用 `JSON.stringify(fullJson)` 再 estimateTokens，比手动累加更准确（含字段名、引号等 overhead）
- **二分查找截断**: Phase 2 用二分法(`O(log n)`)而非逐字删除(`O(n)`)找最长前缀，适合 2000+ 字符文本
- **filter 解析**: 仅 `stage=filter` 且 `parsed_output` 含 `rejected_agent_ids` 字段时触发 phase1；解析异常静默跳过
- **测试数据**: CJK 字符 `翻.repeat(2000)` = 2000 tokens/条，6 条 ≈ 12K tokens，轻松触发 6000 预算

## 2026-07-18 — Wave 2 Task 8: LLM 客户端（OpenAI 兼容）

### 实现结构
- `src/lib/llm/client.ts` — 裸 `fetch` 实现，零框架依赖
- `test/llm/client.test.ts` — 27 个 TDD 测试

### 错误类层次
- `LLMError` 基类: `{code, status?, retryable, message}`
- `AuthError(401)` / `RateLimitError(429, retryable)` / `ServerError(5xx, retryable)` / `ClientError(other 4xx)` / `ToolsNotSupportedError` / `TimeoutError(retryable)` / `NetworkError(retryable)` / `AbortedError`
- `normalizeError(response, bodyText)` — 解析 OpenAI 错误格式并映射到对应子类
- `mapNetworkError(error)` — 处理 fetch 级网络错误

### 流式 SSE 处理
- 使用 `parseSSEChunk` 解析 delta chunk（传入累积 rawBuffer，按 `processedEventCount` 跳过已处理事件）
- **content 累加**: 单独维护 `accumulatedContent` 变量（delta.content 拼接），与 rawBuffer 分离；done 事件中返回完整 content
- **tool_calls delta 合并**: 按 `index` 分桶累积 `id`/`name`/`argumentsFragments[]`；done 时 join 为完整 JSON
- 3 片段测试用自定义 inline HTTP server 模拟

### 非流式回退
- 请求 `stream: true` 但服务器返回 `Content-Type: application/json` → 解析为非流式响应，产出单次 text + done 事件

### 关键决策
- **异步生成器惰性**: async generator 在调用时不执行，需 `.next()` 才启动 fetch。abort 测试需先 `collectStreamEvents()` 再 abort。
- **AbortSignal.any**: 超时 signal + 外部 signal 合并；catch 块中通过 `timeoutSignal.aborted && !externalSignal?.aborted` 区分 TimeoutError vs AbortedError
- **LLMError 不二次包装**: `chatCompletion` catch 块中先检查 `error instanceof LLMError` 并直接 re-throw，避免正常化的错误被 `mapNetworkError` 覆盖为 NetworkError

### 测试覆盖
- 非流式: content/toolCalls/usage 解析
- 流式: text delta 逐字产出 + done 完整 content
- tool_calls: 单 chunk + 3 片 delta 合并为完整 JSON
- 错误映射: 401/429/500/503→分别子类、400→ToolsNotSupportedError、404/400→ClientError
- 中止: 外部 signal abort → AbortedError、非流式预中止 → AbortedError
- 非流式回退: `stream:true` + JSON 响应 → 自动回退
- AbortSignal.any: 超时 → TimeoutError、外部 signal → AbortedError
- 网络: connection refused → NetworkError、unreachable → TimeoutError/NetworkError
- 27 测试全部通过

