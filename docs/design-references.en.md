# Design References, Independent Implementation, and Licenses

## 1. lessAI

[GTJasonMK/lessAI](https://github.com/GTJasonMK/lessAI) is used solely as an interaction reference, grounded in the principle that text modifications should be clearly comparable, reversible, and traceable.

This project does **not**:

- Copy or transcribe its Rust source code line by line;
- Translate its Diff implementation into TypeScript;
- Replicate its CSS, component hierarchy, field names, or prompts;
- Port its business data structures.

This project's version management, Patch generation, evidence citation, and tool timelines are all independently designed around a multi-agent translation review workflow, and are unrelated to lessAI.

## 2. Diff

The revision comparison feature uses `Intl.Segmenter` to split Chinese, English, combining characters, and emoji into Unicode grapheme sequences, and then delegates sequence diffing to the TypeScript package `fast-array-diff`.

Dependency list:

| Dependency | Purpose | License |
|---|---|---|
| fast-array-diff | Grapheme array diffing | MIT |
| pinyin-pro | Mandarin pinyin vowel matching | MIT |
| cmu-pronouncing-dictionary | Modern English approximate rhyme evidence | ISC |
| JSZip | Web-based batch ZIP packaging | MIT or GPL-3.0-or-later (used under MIT option) |
| better-sqlite3 | SQLite database driver | MIT |
| Electron / electron-builder | Windows desktop distribution | MIT |

The npm `diff` package originally considered for use is actually licensed under BSD-3-Clause, so the implementation phase switched to `fast-array-diff`, which uses the MIT license. This change only affects the underlying diff algorithm dependency and does not alter the interface or data protocol.

## 3. Failure Isolation

A Diff computation failure must not prevent version saving. The system degrades to a block-level before/after view, while Patches, reasons, and evidence are still written to the database normally.

## 4. Future Code Reuse

If any third-party MIT code is directly reused in the future, the original license notice, copyright notice, and clear source attribution must be retained in the repository. In this development cycle, no code from lessAI has been directly reused.
