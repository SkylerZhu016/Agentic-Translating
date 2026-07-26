# 设计参考、独立实现与许可证

## 1. lessAI

[GTJasonMK/lessAI](https://github.com/GTJasonMK/lessAI) 仅用作交互参考，其出发点在于文本修改应当清晰对照、可撤销、可追踪。

本项目并未：

- 复制或逐行转写其 Rust 源码；
- 将其 Diff 实现翻译为 TypeScript；
- 复制其 CSS、组件结构、字段命名或提示词；
- 移植其业务数据结构。

本项目的版本管理、Patch 生成、证据引用及工具时间线均围绕多 Agent 翻译审议流程独立设计，与 lessAI 无关。

## 2. Diff

修订对照功能使用 `Intl.Segmenter` 将中英文、组合字符和 emoji 切分为 Unicode grapheme 序列，再交由 TypeScript 包 `fast-array-diff` 计算序列差异。

依赖清单：

| 依赖 | 用途 | 许可证 |
|---|---|---|
| fast-array-diff | grapheme 数组差异计算 | MIT |
| pinyin-pro | 普通话拼音韵母辅助判断 | MIT |
| cmu-pronouncing-dictionary | 现代英语近似韵脚证据 | ISC |
| JSZip | Web 端批量打包 ZIP | MIT 或 GPL-3.0-or-later（本项目按 MIT 选项使用） |
| better-sqlite3 | SQLite 数据库驱动 | MIT |
| Electron / electron-builder | Windows 桌面交付 | MIT |

最初计划使用的 npm `diff` 包实际许可证为 BSD-3-Clause，因此实现阶段改用明确采用 MIT 许可证的 `fast-array-diff`。此项变更仅影响底层差异算法依赖，不改变界面与数据协议。

## 3. 平水韵数据

诗歌辅助检查使用维基文库收录的公共领域《平水韵》一百零六韵字表，并同时保存其简体与繁体渲染结果：

- 来源：[《平水韵》](https://zh.wikisource.org/wiki/%E5%B9%B3%E6%B0%B4%E9%9F%BB)
- 本地用途：查询中文译文行末字可能所属的平水韵韵部；
- 限制：多音字、古今音变化、邻韵通押和变格仍需人工复核。

系统不会根据字表自动改写或拒绝译文。

## 4. 失败隔离

即便 Diff 计算失败，也不影响版本保存。系统会降级为块级 before/after 视图，Patch、原因和证据仍正常写入数据库。

## 5. 未来代码复用

若后续直接复用任何第三方 MIT 代码，须在仓库中保留原始许可证声明、版权声明和明确的来源出处。本轮开发中未直接复用 lessAI 的任何代码。
