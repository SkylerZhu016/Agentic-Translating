# 双向提示词设计

## 1. 方向不是界面筛选值

`en_to_zh` 和 `zh_to_en` 各自拥有完整的 `DirectionPromptBundle`：

- 主 Agent
- worker 公共提示词
- 审查、筛选、编排、组装
- 编辑 Agent
- 工具说明
- Agent 目录描述

英译中的整条链路使用中文系统提示词，中译英则使用英文系统提示词。GUI 始终为中文。用户的任务要求不做翻译或改写，作为独立的用户数据原样传递。

## 2. 消息层级

系统消息只包含：

```text
方向主提示词
+ 当前任务固定规则
+ 当前允许 Agent 的短目录
+ 当前阶段 1—3 个工具
```

用户消息包含：

```text
自然语言任务要求
+ 完整原文
+ 完整成功候选正文
+ 完整前置阶段正文
+ 最新完整译文
+ 全部相关聊天记录
```

原文不会通过 `{{source_text}}` 插入到系统提示词中。批量模板只替换 `{{file_name}}` 和 `{{relative_path}}`。

## 3. 会话冻结

创建会话时，会写入方向、提示词包版本、Agent 变体快照、端点安全快照、模型绑定、任务要求、约束和编排策略。内置提示词升级后，旧会话不会受到影响。

打开历史会话时，顶栏同步为该会话的方向，不会弹出切换警告，也不会转换任何文本。

## 4. 上下文策略

- 不再使用 6000 token 的阶段截断
- 不再只保留最近 20 条聊天记录
- 不再用固定的 8000 token 原文门槛拒绝创建
- 配置了 `contextWindow` 时，在调用前进行估算并明确报错
- 未配置上限时显示估算与警告，但允许调用
- API 上下文错误保留原始可诊断信息

这不意味着上下文无限。而是系统不再悄悄丢弃用户和 Agent 已经产生的证据。

## 5. 提示词版本原则

每个内置包和角色变体都有稳定的 ID 和递增的 `promptVersion`。新增 seed 使用独立的 seed 版本记录，不能因为数据库里已有旧提示词就跳过新版内置数据。

提示词升级应满足以下条件：

1. 不改变 FSBP 边界
2. 不把任务要求解析成固定的内容 schema
3. 不把五言或押韵设为英译中的全局默认
4. 不让 Agent 调用其他 Agent
5. 不让角色为了突出差异而故意降低质量

## 6. 自定义语言对

高级用户可以提供自定义的方向提示词包，但不会自动获得中英方向的 20 个内置变体。一个自定义方向至少需要两个兼容的自定义 Agent，并且必须明确提供主 Agent、worker、四阶段和编辑提示词。

自定义语言对属于自部署或 API 能力，不会出现在顶栏的"英译中 / 中译英"快捷开关中。创建流程如下：

1. `POST /api/direction-prompt-bundles` 创建一个新的 `custom` 提示词包 revision
2. 在 Agent 库中创建至少两个 `direction: "custom"` 的自定义 Agent 变体
3. `POST /api/sessions` 时传入 `direction: "custom"`、明确的 `sourceLang`、`targetLang` 以及这两个变体 ID
4. 会话冻结本次的提示词包、Agent、端点和模型快照

后端拒绝以下情况：缺少源语言或目标语言、自定义 Agent 少于两个、预设方向与会话方向不一致，或者一个预设 revision 混入了其他方向的 Agent。系统不会自动翻译或复用中英内置提示词来伪造兼容性。

示例（字段内容仅作示意）：

```json
{
  "direction": "custom",
  "sourceText": "Bonjour le monde",
  "sourceLang": "French",
  "targetLang": "German",
  "taskBrief": "保留简洁、友好的问候语气。",
  "allowedAgentVariantIds": [
    "custom-faithful.custom.1",
    "custom-natural.custom.1"
  ],
  "reviewMode": "main_editor"
}
```
