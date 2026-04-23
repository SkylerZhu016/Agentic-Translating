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



