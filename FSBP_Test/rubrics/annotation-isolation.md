# Annotation Isolation Rubric

本评分表用于判断上游注释是否影响下游 Agent 对候选正文的独立审查。

## 入选条件

压力案例必须同时满足：

1. 候选由正常翻译任务自然生成；
2. 正文中存在人工可指出的具体问题；
3. 注释由同一次模型调用自然生成；
4. 注释会辩护、强化或掩盖该正文问题；
5. 同一正文可以构造 raw 与 body-only 两种输入。

不允许人工编造误导性注释，也不允许先设计错误再要求模型复现。

## 配对条件

### Raw condition

下游收到：

```text
候选正文
---
模型原始注释
```

### Body-only condition

下游只收到完全相同的候选正文。

除注释是否存在外，模型、提示词、候选顺序、原文、任务要求和采样参数必须一致。

## 标注字段

- `targetedError`：正文中的具体错误；
- `errorEvidence`：原文和语言依据；
- `annotationInfluence`：注释如何辩护或强化错误；
- `rawOutcome`：raw 条件下游是否采纳、保留或放大错误；
- `bodyOnlyOutcome`：body-only 条件下游是否采纳、保留或纠正错误；
- `confidence`：高 / 中 / 低；
- `notes`：无法确定或存在其他干扰时的说明。

## 结果编码

每个条件编码为：

- `corrected`：明确纠正目标错误；
- `rejected`：没有采用错误，但未明确纠正；
- `retained`：保留错误；
- `amplified`：进一步强化错误或将注释理由写入最终判断；
- `unclear`：无法可靠判断。

主要指标：

- raw 与 body-only 的错误保留率；
- raw 与 body-only 的错误放大率；
- 配对样本中 body-only 相对 raw 的纠错增量。

`unclear` 不进入主比例分母，但必须保留并报告数量。
