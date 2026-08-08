# FSBP Test

本目录用于构建和验证 Agentic Translating 的 FSBP（自由文本语义边界与审议协议）
实验数据集。FSBP 不仅是“自由输出后用分隔符切开”，而是一组共同约束：

- Agent 在内容层自由表达，不承担供程序解析的复杂结构；
- 正文与注释具有明确语义边界，下游只继承正文；
- 完整原始输出留档，隔离不等于删除证据；
- 多个独立视角先产生候选，再由后续 Agent 审议；
- 自然语言内容与改变系统状态的工具调用分离；
- 不静默截断，不把失败伪装成成功。

## 研究问题

本实验把三个问题分开验证：

1. **协议可靠性**：提示词约束 JSON、模型原生 JSON Output 与 FSBP 的解析成功率、空内容、截断、重试、延迟和 token。
2. **注释隔离**：同一候选正文在“完整 raw 传递”和“仅 body 传递”下，后续 Agent 是否更容易继承上游错误。
3. **端到端质量**：强模型直接翻译、多 Agent raw 传递、多 Agent FSBP 三种流程的最终译文质量。

实验不得用其中一项的结果替代另一项，也不得为了得到预期结论而修改锁定测试集。

## 数据规模

| split | 英译中 | 中译英 | 合计 |
|---|---:|---:|---:|
| dev | 4 | 4 | 8 |
| test | 8 | 8 | 16 |
| total | 12 | 12 | 24 |

每个方向包含四个类别：

- `poetry`：诗歌与形式文本；
- `literary`：文学叙事与人物声音；
- `cultural_argument`：文化负载与论辩文本；
- `nonliterary`：法律、技术等非文学高密度文本。

开发集每个“方向 × 类别”包含 1 项，测试集包含 2 项；合计每个桶 3 项。

当前仓库状态：`dataset-manifest.json` 的 `datasetVersion` 为 `0.1.0`，状态为
`locked`。8 个开发样本和 16 个测试样本均已完成结构校验与逐项人工审阅；它们
可以用于固定配置的评测，但不能继续用于提示词调参。需要新文本时，应创建新的
数据集版本，并保留本轮哈希与结果。

## 长度规则

- 诗歌保持全文和原始分行，不节选；只选择能够完整纳入实验的作品。
- 英文非诗歌为 170—240 词，目标约 200 词。
- 中文现代白话、法律、技术文本为 160—240 个汉字，目标约 200 字。
- 中文古汉语非诗歌为 80—140 个汉字，目标约 100 字。
- 正文不得从句中截断。
- 必要语境写入 `contextBefore` / `contextAfter`，不计入待翻译正文。

## 文本确认与锁定

文本按以下批次确认：

1. 8 个开发样本；
2. 一次性生成 16 个测试样本，每个方向、每类 2 项；
3. 用户逐项完成问题标注后锁定。

候选文本首先登记在 `selection/selection-log.md`。确认后才写入 JSONL：

- 开发文本写入 `datasets/quality-dev.jsonl`；
- 锁定测试文本写入 `datasets/quality-test.jsonl`；
- 测试集锁定后不再用于调整提示词；人工批注只作为最终评测依据；
- 任何测试文本变更都必须建立新的 `datasetVersion`，不得覆盖旧数据。

## 注释隔离集

`datasets/annotation-stress.jsonl` 只接收真实运行中产生的案例：

1. 模型按正常翻译要求生成正文和自然注释；
2. 人工确认正文中存在实际问题；
3. 模型自己的注释确实会强化或辩护该问题；
4. 固定同一正文，对比 raw 与 body-only 两种下游输入。

禁止为了凑数人工编造误导注释。自然案例不足 12 个时，继续正常采样。

## 模型可见边界

生成或审议模型只能接收：

- `direction`
- `sourceText`
- `contextBefore` / `contextAfter`
- `taskBrief`
- `deterministicConstraints`

`reviewerChecklist`、来源元数据、候选协议标签和人工评分不得进入生成上下文。

## 校验

```bash
# 草稿模式：允许数据集尚未填满，但现有条目必须完全合法
npm run dataset:validate

# 锁定模式：要求 8 个开发样本和 16 个测试样本全部就绪
npm run dataset:validate:locked
```

如果未来建立新的数据集版本，在所有文本确认前，锁定模式失败是预期行为，不能
把空白占位符伪装成样本。本轮 `0.1.0` 已满足锁定门禁。

候选文件可独立校验，不会被误计为正式开发集：

```bash
node scripts/validate-fsbp-dataset.mjs \
  --candidate-file FSBP_Test/selection/dev-candidates-round-01.jsonl
```

`dataset-manifest.json` 已在 8 个开发样本和 16 个测试样本全部完成审阅后标记为
`locked`。每项只保留 `sourceText` 的单一 SHA-256。
不为译文、评审记录、来源页面或整个数据文件另设哈希。
后续追加真实注释案例不会改写已经锁定的核心测试集。普通样本与真实注释
案例分别遵循 `schemas/sample.schema.json` 和
`schemas/annotation-stress.schema.json`。
