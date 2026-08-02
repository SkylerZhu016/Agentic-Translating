# Text Selection Log

本文件只登记选型过程，不代表候选已经进入数据集。

## 排除项

- 已删除的旧版实验中的全部 20 个样本；题名与正文哈希保存在
  `legacy-exclusions.json`，旧正文和实验结果不再保留；
- 已用于人工流程测试的 Robert Frost 诗歌片段；
- 已用于人工流程测试的李商隐《无题·相见时难别亦难》；
- 已经存在于开发集或测试集中的作者、作品和段落；
- 无法确认版本、来源或再分发依据的文本；
- 只能截取名句、无法形成完整意义单元的文本。

## 批次状态

| 批次 | 目标数量 | 状态 | 说明 |
|---|---:|---|---|
| 开发集 | 8 | formalized | 第一轮问题标注完成，已收入 `quality-dev.jsonl` |
| 诗歌测试集 | 4 | review_pending | 全文、原始分行、直译与预审风险均已生成 |
| 文学叙事测试集 | 4 | review_pending | 完整叙述或描写单元、直译与预审风险均已生成 |
| 文化/论辩测试集 | 4 | review_pending | 完整论证单元、直译与预审风险均已生成 |
| 非文学测试集 | 4 | review_pending | 科学、计算与古代技术文本、直译与预审风险均已生成 |

## 槽位清单

| Split | Direction | Category | Slot | Status |
|---|---|---|---:|---|
| dev | en_to_zh | poetry | 1 | formal: `dev-en-zh-rossetti-birthday` |
| dev | en_to_zh | literary | 1 | formal: `dev-en-zh-wharton-rootlessness` |
| dev | en_to_zh | cultural_argument | 1 | formal: `dev-en-zh-wollstonecraft-self-rule` |
| dev | en_to_zh | nonliterary | 1 | formal: `dev-en-zh-nightingale-night-air` |
| dev | zh_to_en | poetry | 1 | formal: `dev-zh-en-liqingzhao-shengshengman` |
| dev | zh_to_en | literary | 1 | formal: `dev-zh-en-shishuo-egg` |
| dev | zh_to_en | cultural_argument | 1 | formal: `dev-zh-en-hanyu-teachers` |
| dev | zh_to_en | nonliterary | 1 | formal: `dev-zh-en-gengju-water-control` |
| test | en_to_zh | poetry | 1 | review: `test-en-zh-hopkins-pied-beauty` |
| test | en_to_zh | poetry | 2 | review: `test-en-zh-hardy-neutral-tones` |
| test | en_to_zh | literary | 1 | review: `test-en-zh-jerome-sea-trip` |
| test | en_to_zh | literary | 2 | review: `test-en-zh-wells-door-memory` |
| test | en_to_zh | cultural_argument | 1 | review: `test-en-zh-douglass-literacy` |
| test | en_to_zh | cultural_argument | 2 | review: `test-en-zh-mill-opposing-truths` |
| test | en_to_zh | nonliterary | 1 | review: `test-en-zh-lovelace-engine-limits` |
| test | en_to_zh | nonliterary | 2 | review: `test-en-zh-darwin-selection` |
| test | zh_to_en | poetry | 1 | review: `test-zh-en-sushi-shuidiaogetou` |
| test | zh_to_en | poetry | 2 | review: `test-zh-en-wentingyun-pusaman` |
| test | zh_to_en | literary | 1 | review: `test-zh-en-zhangdai-west-lake-snow` |
| test | zh_to_en | literary | 2 | review: `test-zh-en-shenfu-childhood-vision` |
| test | zh_to_en | cultural_argument | 1 | review: `test-zh-en-wanganshi-reform-defense` |
| test | zh_to_en | cultural_argument | 2 | review: `test-zh-en-guyanwu-shame` |
| test | zh_to_en | nonliterary | 1 | review: `test-zh-en-songyingxing-coal-mining` |
| test | zh_to_en | nonliterary | 2 | review: `test-zh-en-shenkuo-magnetic-needle` |

## 候选登记模板

```markdown
### Candidate ID

- Split / direction / category:
- Author and title:
- Exact source and edition:
- Rights basis:
- Exact excerpt bounds:
- Source form:
- Length:
- Full text:
- Optional context:
- Difficulty tags:
- Why this text:
- Canonicality risk:
- Existing translation / memorization risk:
- Reviewer decision: pending / approved / rejected
- Decision notes:
```

## 开发集第一轮

- 结构化原文：`dev-candidates-round-01.jsonl`
- 本地逐项审阅稿：`../private/review/dev-round-01.md`
- 本地结构化直译：`../private/review/dev-round-01.jsonl`
- 状态：全部通过机器校验并完成人工问题标注，已经写入
  `datasets/quality-dev.jsonl`。

## 测试集第一轮候选

- 结构化原文：`test-candidates-round-01.jsonl`
- 本地集中审阅稿：`../private/review/test-round-01.md`
- 本地结构化直译：`../private/review/test-round-01.jsonl`
- 状态：16 项已通过结构、长度、方向和类别校验；等待用户逐项审阅，尚未写入
  `datasets/quality-test.jsonl`。

## 确认检查

每项获准写入 JSONL 前必须确认：

- [ ] 正文是完整意义单元；
- [ ] 长度符合相应 source form；
- [ ] 诗歌为全文并保留原始分行；
- [ ] 不与任何既有样本重复；
- [ ] 作者没有在其他槽位出现；
- [ ] 至少包含两个实际翻译难点；
- [ ] 来源和版本可以复核；
- [ ] 再分发依据清晰；
- [ ] 没有把现成译文写入模型可见字段；
- [ ] 用户已明确批准。
