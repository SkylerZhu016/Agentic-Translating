# Agentic Translating

[**中文**](docs/readme_cn.md) | [**English**](#)

A personal translation workbench for difficult English and Chinese texts. Submit a source once, compare role-based candidates, and receive a complete translation through a bounded review workflow.

**Latest release: [v0.2.0](https://github.com/SkylerZhu016/Agentic-Translating/releases/tag/v0.2.0)** — Windows installer and portable executable. Other platforms can build from source. See the [release notes](docs/releases/0.2.0.md).

The JSON content contract, integrated review, role output budgets, appearance themes, and bounded reasoning/streaming previews described below are current source updates. They have not yet been packaged in a new release. The v0.2.0 downloads retain the features documented in their release notes.

Multiple roles work on the same source, and their differences remain available as evidence for review. The default workflow completes review, filtering, orchestration, and assembly within configured limits. Tool-assisted editing remains available as an exploratory option. The project prioritizes comfortable local use, visible progress, and recoverable versions.

## Core Features

- Supports both English-to-Chinese and Chinese-to-English modes. Direction is frozen after session creation. Each direction maintains its own independent workspace draft.
- 10 agent archetypes, each with 2 directional variants: fidelity, naturalness, voice, terminology, culture, long text, formal text, literary, poetry, and dissent.
- Dynamic teaming and fixed presets coexist. The system keeps at least two successful candidates from different archetypes before forming the first version.
- New workspaces default to the fixed four-stage process of review, filter, orchestrate, and assemble. Tool-assisted completion is an optional exploratory path.
- A disagreement map aligns candidate bodies by paragraph, sentence, or poetry line and highlights wording, punctuation, number, negation, proper-noun, terminology, and structural differences. It is a deterministic comparison aid, not an automatic verdict on correctness.
- Project-level translation archives maintain terminology, proper nouns, character voice, style rules, approved decisions, and contextual notes. New entries remain suggestions until a user approves them; approval creates an immutable snapshot that a session can freeze.
- A first-run guide and endpoint compatibility doctor report model discovery, ordinary chat, genuine streaming, usage reporting, and tool-call results separately. Quick, balanced, and deep workflows are created as normal user-owned preset revisions.
- A privacy-safe LLM call ledger covers every physical vNext orchestration request and retry, editing chat, the three revision-suggestion lenses, compatibility-doctor chat/stream/tool probes, and standalone Agent tests. It records status, known token usage, first-byte time, and total latency; missing usage remains unknown. Model-list discovery is metadata retrieval and is deliberately not counted as an LLM call.
- Structured output for new built-in prompts: a JSON object separates `body` from optional `annotation`. The original content response is archived, while provider reasoning stays in a separate, bounded live preview. Existing FSBP presets and records retain their frozen parsing behavior.
- In the optional tool-assisted path, tools are exposed in stages: `call_agents`, `write_draft`, `replace_text`, `submit_final`. Each round injects only the tools needed at that point.
- Versioned edits, Unicode diff comparisons, evidence citations, undo and redo.
- User preset revision management, history recovery, safe export, and a batch queue supporting up to 100 files.
- SQLite local-first storage with BYOK and OpenAI-compatible endpoints. API keys never appear in browser DTOs, SSE events, logs, or export files.
- Available as a Next.js web app, self-hosted Docker image, Windows Electron installer, and portable build.

English-to-Chinese output defaults to plain modern Chinese. Forms like five-character or seven-character verse and rhyming are task-specific requirements or constraints for the Poetry agent, not system defaults.

## Quick Start

Requires Node.js 22.12.0 or later.

For daily desktop use, prepare the production build once:

```bash
npm install
npm run build:standalone
npm run desktop
```

After that, Windows users can also open [启动翻译工作台.cmd](启动翻译工作台.cmd). Rebuild after updating the source. On first use, the Configuration page guides you through adding an OpenAI-compatible endpoint, checking its actual capabilities, and creating a user-owned workflow. Experienced users can skip the guide and configure each binding directly.

For production web use:

```bash
npm run build
npm start
```

Open `http://localhost:3000`. Use `npm run dev` only when developing the source with live updates.

## Workflow

1. Select "English to Chinese" or "Chinese to English" in the top-right corner.
2. Enter the source text and task requirements in natural language. Optionally select a translation project, then choose the allowed agents, preset, and deliberation mode. Approved project resources are frozen for the session; later project edits do not rewrite its context.
3. In dynamic mode, the main agent invokes 2 to 4 roles suited to the current text. If no valid selection is available, it falls back to the "semantic fidelity plus target language fluency" combination.
4. The default workflow runs the four review stages and assembles a complete translation. Follow progress in the workflow tab, then read and revise it in the editor tab.
5. Use the disagreement map to inspect where candidates actually differ. It excludes Agent annotations from comparison and falls back to full-text comparison when reliable alignment is unavailable.
6. Subsequent edits must go through precise text tools to create patches and new versions. A candidate fragment can be handed to the editing Agent through the existing revision path, preserving before-and-after comparisons, reasons, and evidence.

Switching directions does not convert the current session. The system saves the current draft, then switches to the other direction's workspace draft. Old sessions remain in history. Background tasks are not canceled when the page is closed.

Built-in bidirectional prompt bundle v24 uses one integrated review covering fidelity and logic, naturalness and voice, and task and genre constraints. Filtering independently checks the review against the source, and assembly checks the result for regressions. A standalone `[review:integrated-v1]` line in the frozen review prompt selects this behavior. Older unmarked sessions retain three independent review calls with at least two successful results.

## Appearance

Open **Configuration → Appearance** to choose Clear Blue, Soft Violet, Warm Coral, or Graphite. Changes apply immediately and are stored on the current device. Each theme can keep a custom accent, with a reset to its original color. Very light accents are adjusted to keep text readable, and the panel shows the color actually applied.

## Structured output and streaming

New built-in prompts use `[protocol:json-v1]` and require exactly these fields:

```json
{"body":"The complete translation or stage deliverable.","annotation":null}
```

`body` is a non-empty string. `annotation` is a brief user-facing note or `null`, and remains separate from the translation. Output is validated before it becomes a successful candidate or final version. Incomplete JSON, duplicate fields, and invalid field types fail explicitly. Streaming incrementally decodes the body so the interface can display readable text before the object finishes.

For allowlisted models and Chat Completions URLs on the official DeepSeek service, the client adds `response_format: {"type":"json_object"}` when a system prompt selects JSON and the request has no tools or tool choice. Third-party gateways retain their existing request format. The [protocol specification](docs/protocol-spec.en.md) lists the exact conditions.

Provider `reasoning_content`, `thinking`, and `reasoning` fields are separate from both fields. The live interface retains a limited recent preview, while history records diagnostic counts rather than the full reasoning text. Long text panels limit both their height and mounted text, with section navigation and downloads for the received content.

Body-only downstream inheritance remains the default. Presets may explicitly include annotations as supporting material. Existing frozen prompts without the new marker retain legacy FSBP compatibility: their final standalone `---` separates body and annotation. Updating the app preserves old sessions and preset revisions. See the [protocol specification](docs/protocol-spec.en.md).

## Presets and Batch

A preset is a reusable work contract created by the user, not a translation strategy imposed by the system. Each content modification creates a new revision. Historical sessions and batches continue to use the frozen snapshot.

Role default profiles and workflow presets expose `maxOutputTokens` as an output budget. Reasoning and the response body share this allowance per call. Enter a positive integer or leave it blank for the application default of 4,096 tokens. For long DeepSeek reasoning, 32,768 is a suggested setting within the selected model's supported limit. Switching models preserves the saved budget, so check it against the new model.

Batch tasks must select a valid revision. They support UTF-8 encoded `.txt` and `.md` files, 1 to 4 concurrent tasks, pause and resume, retry on failure, path mirroring, BOM and line ending preservation, and web ZIP export. See [docs/preset-and-batch.en.md](docs/preset-and-batch.en.md) for details.

## Desktop and Self-Hosting

For ordinary Windows users, download one of the two assets from the [v0.2.0 release](https://github.com/SkylerZhu016/Agentic-Translating/releases/tag/v0.2.0):

- `Agentic Translating-0.2.0-setup-x64.exe` — recommended installer;
- `Agentic Translating-0.2.0-portable-x64.exe` — portable version that runs without installation.

The first startup creates local application data. Upgrading does not delete translation history or custom agents. Before removing an endpoint, the application now shows every live and historical reference and can detach active bindings without deleting agent definitions.

Windows packaging:

```bash
npm run package:win
```

For daily desktop use, run `npm run build:standalone` once, then `npm run desktop`. The desktop uses that production build without keeping a compiler or source-file watchers in memory. Rebuild after source changes. If the build is missing, the app shows the exact preparation commands and exits without starting an implicit build. `npm run desktop:preview` remains an alias for this production mode.

For source development with live updates, use `npm run desktop:dev`. Its Next.js cache is isolated in `.next-electron-dev`, while `npm run dev` uses `.next-web-dev`, so the two development entry points do not mutate each other's output.

Output goes to the `dist-electron/` directory. Both an NSIS installer and a portable build are generated. Desktop data is stored in the Electron `userData` directory. Keys are protected by a local master key wrapped with `safeStorage`.

Docker:

```bash
docker compose up --build
```

Production web deployments must set the `AGENTIC_SECRET_KEY` environment variable. Build, backup, and upgrade instructions are in [docs/desktop-build.en.md](docs/desktop-build.en.md).

## Historical FSBP Dataset

The earlier dataset, selection log, schemas, rubrics, and research boundaries live in
[`FSBP_Test/`](FSBP_Test/README.en.md). The current 8-item development set and
16-item test set are versioned and locked after review. They remain historical development evidence. The [technical report](docs/technical-report.en.md) documents the current engineering design and evaluation boundaries. Current source changes have no completed formal translation-quality evaluation.

Local verification evidence, private research material and datasets, conversation backups, and SQLite data/backups are excluded from the published product source and Docker build context. The versioned historical FSBP documentation remains available at the links above.

```bash
npm run dataset:validate
npm run dataset:validate:locked
```

Draft validation accepts an incomplete selection while validating every present
record. Locked validation requires the complete approved 8-item development set
and 16-item test set (24 items in total).

## CLI Test Harness

`scripts/dev-harness.mts` provides a pure command-line driver for the workbench's
core session, HTTP, SSE, and revision operations (requires Node.js 22.12+). Start
the app first and pass its actual port explicitly:

```bash
npm run harness -- --help
npm run harness -- list --base=http://127.0.0.1:3000
```

Subcommands: `create`, `run`, `translate`, `events`, `chat`, `suggest`,
`state`, `list`, `rm`, `restore`. It reuses the project's SSE parser and has
dedicated protocol-terminal tests. Highlights:

- Incremental SSE output with timestamps and phase labels (`--trace` writes a
  JSONL log under `FSBP_Test/private/debug/`).
- Failures dump the last 50 events plus session state and exit non-zero.
- `suggest` obtains a read-only revision proposal from isolated target-language
  reader, bilingual verifier, and arbiter lenses. Use `chat` to apply a revision.
- `create --request-id=<UUID>` supports idempotent retries; `run` and `events`
  reconnect to the server-owned run and persisted event stream.

The harness intentionally does not reproduce configuration forms or batch-file
selection. The browser remains the tool of choice for layout and visual
regression; core model-flow verification can run entirely from the CLI.

## Current Scope

The built-in product concentrates on difficult general translation and poetry-related work. Users can add their own agents and prompt packs for other domains. Batch input currently supports UTF-8 `.txt` and `.md` files. EPUB support is intentionally deferred: a future implementation should evaluate a mature, appropriately licensed parser and round-trip pipeline instead of rebuilding the format from scratch.

Historical v0.2.0 validation recorded 1,180 Vitest checks in 119 files, TypeScript validation, a standalone production smoke test through migration 18, and 17 focused browser workflows covering bidirectional drafts and responsive internationalization. Its source-development and packaged-preview Electron paths were also exercised through first-launch, persistence, modal, narrow-screen, history, and export-entry journeys.

Current source includes migration 19. An earlier full-suite run during this source iteration recorded 1,416 passing Vitest tests. Subsequent targeted regression checks are separate evidence and are not added to that full-suite count. These records describe engineering validation at the tested revisions, with formal translation-quality evaluation still pending.

## Development Commands

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run desktop` | Open the existing production desktop build for daily use |
| `npm run desktop:dev` | Start the source desktop with live updates and a managed Next.js dev server |
| `npm run desktop:preview` | Alias for the production desktop mode; never builds implicitly |
| `npm run typecheck` | TypeScript type checking |
| `npm test` | Run Vitest tests |
| `npm run build` | Next.js production build |
| `npm run e2e` | Run Playwright end-to-end tests |
| `npm run package:win` | Package Windows NSIS installer and portable build |
| `npm run dataset:validate` | Validate the in-progress FSBP dataset |
| `npm run dataset:validate:locked` | Enforce the complete locked dataset gate |
| `npm run harness -- --help` | Run the CLI test harness |
| `npm run test:cli` | Test CLI terminal and idempotency semantics |
| `npm run experiment:verdict:validate -- --verdict=<path>` | Recompute and validate a gate verdict |

## Documentation

- [Agent Architecture](docs/agent-architecture.en.md)
- [Bidirectional Prompts](docs/bidirectional-prompts.en.md)
- [Protocol Specification](docs/protocol-spec.en.md)
- [Presets and Batch](docs/preset-and-batch.en.md)
- [Desktop Build and Self-Hosting](docs/desktop-build.en.md)
- [Design References and License](docs/design-references.en.md)
- [Technical Report](docs/technical-report.en.md)

## Data and Security

- The web development database is located at `data/app.db` by default.
- Electron stores database, logs, and runtime files in the application's `userData` directory.
- The development environment can generate a key file for local use only. The production environment does not auto-generate weak default keys.
- Deleting sessions, presets, and batches requires confirmation through the interface. Presets use soft deletion by default.
- Old session and preset tables are kept read-only for compatibility. Migrations do not perform destructive deletions.
- Project resources suggested by an Agent are never approved automatically. Historical sessions keep their frozen project snapshot.
- The local analytics overview contains allowlisted aggregates only. It does not expose prompts, source text, translations, full endpoint URLs, or API keys. The schema distinguishes provider-reported, locally estimated, and unknown cost, but known cost appears only when a caller supplies a verifiable amount or price snapshot; current requests normally remain unknown, and the overview is never a provider invoice.

## License

This project is licensed under the [MIT License](LICENSE).
