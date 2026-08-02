# Source Registry

本文件记录数据集原文的来源、版本和再分发依据。第一轮 8 个样本已经收入正式开发集；
后续 16 个样本是待用户逐项批准的锁定测试集候选。

## 可接受来源

优先顺序：

1. 作者作品已经进入全球公有领域的可靠数字版本；
2. 明确标注开放许可且允许再分发的原始文本；
3. 官方发布且依法不适用著作权保护的法律、法规及正式文件。

不得仅根据“网页可以访问”推断可以公开复制。来源页面、作品本身和数字版本的权利状态需要分别核对。

## 版本规则

- 记录实际使用的版本，不只记录作品名；
- 保留精确 URL、章节、段落或行号；
- 原文转为 UTF-8 后人工校对；
- 英文不擅自现代化拼写或标点；
- 中文统一使用简体字；古籍只转换字形，不改变词句、标点和版本读法；
- 必须修正的明显数字化错误写入来源备注；
- `contentHash` 为 `sourceText` 精确 UTF-8 字节的 SHA-256。

## 登记模板

```markdown
## Sample ID

- Author:
- Title:
- Original publication year:
- Edition / transcription:
- URL:
- Retrieved at:
- Exact excerpt bounds:
- Rights basis:
- License URL, if applicable:
- Digital transcription notes:
- SHA-256:
```

## 已知限制

公开数据集优先使用公有领域和开放许可材料，因此可能偏向历史文本。数据集必须在 README 和最终报告中披露这种年代偏差，不得声称它完整代表所有现代翻译任务。

## 第一轮正式开发集

检索日期均为 2026-07-26。

| Sample ID | Author / title | Edition and exact bounds | Rights basis | SHA-256 |
|---|---|---|---|---|
| `dev-en-zh-rossetti-birthday` | Christina G. Rossetti, “A Birthday” | Project Gutenberg #19188，完整 16 行 | 1862 年作品公版；Gutenberg License | `7732d190a41a886cb0ba763a8f87e1e5e3b15922fcbb89180523f0860e2d771e` |
| `dev-en-zh-wharton-rootlessness` | Edith Wharton, *The House of Mirth* | Project Gutenberg #284，Book II, Chapter XIII，从 “It was no longer” 到 “shifting gusts” 的连续三段 | 1905 年作品公版；Gutenberg License | `e03cc8692da1d5d37557b2fb6eb6bea373b046eaca677dc25d7ece65f04a7b47` |
| `dev-en-zh-wollstonecraft-self-rule` | Mary Wollstonecraft, *A Vindication of the Rights of Woman* | Project Gutenberg #3420，Chapter IV，从 “It is true” 到 “no morality” 的连续两段 | 1792 年作品公版；Gutenberg License | `6a1e4da536621ab5ed3726bf19930a29e1f73a6f35dee7d82e7ce68782d64c7d` |
| `dev-en-zh-nightingale-night-air` | Florence Nightingale, *Notes on Nursing* | Project Gutenberg #17366，Chapter I，从 cold/ventilation 到 night-air 段落，共连续三段 | 1860 年作品公版；Gutenberg License | `41a34d0cae4362f23c3db60ee384f859744db19a8be0cb8ed120df0b45c400cb` |
| `dev-zh-en-liqingzhao-shengshengman` | 李清照《声声慢》 | 维基文库 revision 7902207，采用正文主读、删去行内异文说明，完整上下片；转为简体字 | 宋代作品公版；数字转录 CC BY-SA 4.0 | `f59126de6bb8319e77d019ff8a6d28f8803f1376ab53fe673d64e7045ec92254` |
| `dev-zh-en-shishuo-egg` | 刘义庆《世说新语·忿狷》 | 维基文库 revision 1517699，第二则正文，不含夹注；转为简体字 | 五世纪作品公版；数字转录 CC BY-SA | `fcb29c44769ade784ae50eb75949b3eb6ee9fb0b95f3e4281269cc69b6d44e2a` |
| `dev-zh-en-hanyu-teachers` | 韩愈《师说》 | 维基文库 revision 2806079，开头完整两段；转为简体字 | 唐代作品公版；数字转录 CC BY-SA 4.0 | `eb3244cf6053359e0016b8a4bd5051a0b225adcccf12782acf54f8736374e491` |
| `dev-zh-en-gengju-water-control` | 耿橘《大兴水利申》 | 维基文库《农政全书》卷十五，从 “窃照东南之难” 到 “是什四之赋矣”；转为简体字 | 明代作品公版；数字转录 CC BY-SA 4.0 | `b5b2d65acb6aeca3d2624d2b00178001d5664c9a18f7ff48e949c1b7d2582eb2` |

## 锁定测试集候选第一轮

检索日期均为 2026-07-28。中文古籍正文统一转为简体字。

| Sample ID | Author / title | Edition and exact bounds | Rights basis | SHA-256 |
|---|---|---|---|---|
| `test-en-zh-hopkins-pied-beauty` | Gerard Manley Hopkins, “Pied Beauty” | 1918 Bridges edition，Wikisource revision 6593179，完整 11 行 | 作品及版本公版；数字转录 CC BY-SA 4.0 | `a2839cdbbab1479a895e4487dbfd274b9f3ab70e001140ad41d2845e7889d245` |
| `test-en-zh-hardy-neutral-tones` | Thomas Hardy, “Neutral Tones” | Project Gutenberg #3167，完整四节 16 行 | 作品公版；Gutenberg License | `db8f41ef4c21951ede5900c0578fc04924487a9eafff939d2296853811e213ae` |
| `test-en-zh-jerome-sea-trip` | Jerome K. Jerome, *Three Men in a Boat (To Say Nothing of the Dog)* | Project Gutenberg #308，Chapter I 连续三段，从反对短途海上旅行写到卖掉返程票 | 1889 年作品公版；Gutenberg License | `6fb303ede568801e0e20f0f132c98051c44d1affea9dbb1152b534a45a81dc35` |
| `test-en-zh-wells-door-memory` | H. G. Wells, “The Door in the Wall” | *The Door in the Wall, and Other Stories*，Project Gutenberg #456，Section I 开头连续五段 | 1911 年作品公版；Gutenberg License | `65c02634478a659e788026e0a6a6ee0d180b1bec809fd15605c8b9611290da96` |
| `test-en-zh-douglass-literacy` | Frederick Douglass, *Narrative of the Life of Frederick Douglass* | Project Gutenberg #23，Chapter VI 连续三段 | 1845 年作品公版；Gutenberg License | `0f0435558812f539fedde4ae40162f6cdcdd7389802abd834630ecc79e068582` |
| `test-en-zh-mill-opposing-truths` | John Stuart Mill, *On Liberty* | 1869 第四版，Chapter II 连续三段 | 版本公版；数字转录 CC BY-SA 4.0 | `a02a005362e69aba92c0c7a0a67c8b95e1b4b1bf5dc7ff8c7d1b43cc2ed1d0f8` |
| `test-en-zh-lovelace-engine-limits` | Ada Lovelace, Note G | *Scientific Memoirs* Vol. III (1843)，连续三段 | 1843 年作品公版 | `669c84d0bb7e165f4680f3417b647d6492c31564e079611cea0b1280fb3de7be` |
| `test-en-zh-darwin-selection` | Charles Darwin, *On the Origin of Species* | 1860 第二版，Project Gutenberg #22764，Chapter IV 连续三段 | 作品公版；Gutenberg License | `c21fe9629324efc11d1e252541cd899c305f31f2ebeb7e9192e293a567ad7dd6` |
| `test-zh-en-sushi-shuidiaogetou` | 苏轼《水调歌头（明月几时有）》 | 维基文库 revision 5183215，完整小序与全词 | 北宋作品公版；数字转录 CC BY-SA 4.0 | `4cfd6f701b495271a39e144034a1abb2ad10a5788fbe5568565f4bc43e45acf7` |
| `test-zh-en-wentingyun-pusaman` | 温庭筠《菩萨蛮（小山重叠金明灭）》 | 维基文库 revision 2644541，完整全词 | 唐代作品公版；数字转录 CC BY-SA 4.0 | `3c843a5f707e51b344b6cd5d79a872d23ee254e59bb2faf2ff18c936a323be36` |
| `test-zh-en-zhangdai-west-lake-snow` | 张岱《湖心亭看雪》 | 《陶庵梦忆》卷三，开头完整两段 | 明末清初作品公版；数字转录 CC BY-SA 4.0 | `9454ca65b75d654f48b81aa28a39bd3c217741ba6a07750aa3483bcb835edbe0` |
| `test-zh-en-shenfu-childhood-vision` | 沈复《浮生六记·闲情记趣》 | 卷二开头蚊鹤想象单元 | 清代作品公版；数字转录 CC BY-SA 4.0 | `f4cc528d10ab41e5e4f939695dc58a43b09fd7ad35d6d453d98078b79b4f0ef3` |
| `test-zh-en-wanganshi-reform-defense` | 王安石《答司马谏议书》 | 维基文库 revision 2562156，第二段完整论证 | 北宋作品公版；数字转录 CC BY-SA 4.0 | `468eb5b04f1da0aeea842d8d3e8750aeec4488f31405e9b096fd15524c72dcda` |
| `test-zh-en-guyanwu-shame` | 顾炎武《日知录·廉耻》 | 卷十三，从“四者之中”至“是谓国耻” | 清代作品公版；香港教育局公开教学资料 | `241207520ebcea36bcf191d5bd92bffc507aad678b4e649920b0270753164bd2` |
| `test-zh-en-songyingxing-coal-mining` | 宋应星《天工开物·煤炭》 | 维基文库 revision 459326，完整采煤段 | 明代作品公版；数字转录 CC BY-SA 4.0 | `01eb449648b1fe997b74378757a068b37a7e34909a31780885ed6de07e7deeab` |
| `test-zh-en-shenkuo-magnetic-needle` | 沈括《梦溪笔谈·磁石指南柏指西》 | 《事实类苑》卷五十八所录条目全文 | 北宋作品公版；数字转录 CC BY-SA 4.0 | `97a3d126750bf81c454486ee568596aaaba36bdf24fb7e5b56872cf491d98913` |
