# 设计参考、独立实现与许可证

## 1. lessAI

[GTJasonMK/lessAI](https://github.com/GTJasonMK/lessAI) 仅作为“文本修改应当清晰对照、可撤销、可追踪”的交互参考。

本项目没有：

- 复制或逐行转写其 Rust 源码；
- 将其 Diff 实现翻译成 TypeScript；
- 复制 CSS、组件层级、字段命名或提示词；
- 把其业务数据结构移植进本项目。

本项目的版本、Patch、证据引用和工具时间线围绕多 Agent 翻译审议独立设计。

## 2. Diff

修订对照使用 `Intl.Segmenter` 将中英文、组合字符和 emoji 切成 Unicode grapheme，再交给 TypeScript 包 `fast-array-diff` 计算序列差异。

依赖核对：

| 依赖 | 用途 | 许可证 |
|---|---|---|
| fast-array-diff | grapheme 数组差异 | MIT |
| pinyin-pro | 普通话拼音韵母辅助 | MIT |
| cmu-pronouncing-dictionary | 现代英语近似韵脚证据 | ISC |
| JSZip | Web 批量 ZIP | MIT 或 GPL-3.0-or-later（本项目按 MIT 选项使用） |
| better-sqlite3 | SQLite 驱动 | MIT |
| Electron / electron-builder | Windows 交付 | MIT |

原计划中提到的 npm `diff` 实际许可证是 BSD-3-Clause，因此实现阶段没有继续使用它，而改用明确为 MIT 的 `fast-array-diff`。这项变更只影响底层差异算法依赖，不改变界面与数据协议。

## 3. 失败隔离

Diff 计算失败不能阻止版本保存。系统退化为块级 before/after 视图，Patch、原因和证据仍然落库。

## 4. 未来代码复用

若以后直接复用任何第三方 MIT 代码，必须在仓库中保留原许可证、版权声明和明确来源。本轮没有直接复用 lessAI 代码。
