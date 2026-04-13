learnings.md has been created

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

