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

