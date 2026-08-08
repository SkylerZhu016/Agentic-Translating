# FSBP 质量实验

## 1. 三个结论必须分开

本实验不把“多 Agent 有效”和“FSBP 有效”混成一句话。

| 比较 | 能支持的结论 |
|---|---|
| `direct` vs `multi_fsbp` | Agentic Translating 完整方法相对强模型直译的质量变化 |
| `multi_raw` vs `multi_fsbp` | 只传正文、隔离注释相对完整 raw 传递的贡献 |
| JSON 协议实验 vs FSBP | 内容协议的工程可靠性变化 |

如果 `multi_fsbp` 优于 `direct`，只能表述为“采用多 Agent 与 FSBP 的完整系统
在本测试集上优于该直译基线”。只有 `multi_fsbp` 同时优于 `multi_raw`，才能把
其中一部分增益归因于正文隔离。

## 2. 防止测试集泄漏

- 8 个 `dev` 样本用于提炼通用错误类型和调整提示词；
- 16 个 `test` 样本保持内容与哈希锁定，但其中部分已经参与后续提示词和工作流
  迭代，因此当前全部按开发/诊断证据管理，不能再称为 untouched holdout；
- 测试集人工批注、`reviewerChecklist` 和既有直译问题不进入任何生成上下文；
- 正式运行前冻结 Agent prompt version、prompt bundle version、模型、参数和代码提交；
- 若运行后再修改提示词，必须建立新实验版本，不能覆盖旧结果。

最初实验计划冻结的内置提示词版本为：

- Agent direction variant：v6；
- Direction prompt bundle：v4。

该冻结方案已经退役。当前产品版本为 Agent direction variant v17、Direction
prompt bundle v21；旧实验不得被重新标成当前产品结果。下一次正式未见门禁必须
在配置与 manifest 中冻结当前实际版本、代码提交、数据集哈希和基线模型来源。

## 3. 质量条件

### direct

同一个强模型读取原文、任务要求和方向公共质量规则，直接生成一份完整译文。

### multi_raw

固定的三个互补角色产生候选；审查、筛选、编排、组装均接收上游完整 `raw`，
包括 `---` 后注释。

### multi_fsbp

与 `multi_raw` 共享完全相同的候选、模型、参数和阶段提示词，唯一区别是每个
下游阶段只接收 `body`。所有 `raw` 和 `annotation` 仍保留在实验记录中。

## 4. 固定角色

为避免主 Agent 选角随机性干扰协议消融，每类测试样本使用固定三角色：

| 类别 | 角色 |
|---|---|
| poetry | semantic-fidelity + voice-register + poetry-form |
| literary | semantic-fidelity + voice-register + literary-prose |
| cultural_argument | semantic-fidelity + voice-register + dissenting |
| nonliterary | semantic-fidelity + terminology + long-context |

意象与文化助手的两份前置分析由两个不同模型生成，并被所有多 Agent 条件共享。
它不进入 `direct` 条件。

## 5. 盲评

- 每个样本的三份最终译文随机标为 A、B、C；
- 不显示模型、条件、Agent、注释或生成顺序；
- 人工评审者当前明确记录为 `internal-human, n=1`；
- 模型评审分别记录提供商、模型版本、日期和评分提示词；
- 先独立评分，再查看已有人工问题清单进行漏检复核；
- 不补造缺失评分，不为得到预期胜率修改结果。

评分维度沿用 `rubrics/translation-quality.md`。

## 6. 运行产物

所有真实结果均位于被 Git 忽略的 `FSBP_Test/results/<run-id>/`：

```text
manifest.json
raw.jsonl
final.jsonl
blind-review.md
blind-key.json
scores/
report.md
```

配置文件不得包含 API Key。密钥只从环境变量读取。
