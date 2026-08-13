# Agentic Translating

[**中文**](docs/readme_cn.md) | [**English**](#)

A multi-option translation decision workbench for difficult texts. It supports bidirectional, multi-model deliberation, evidence-based decisions, and reusable project memory.

**Latest release: [v0.1.2](https://github.com/SkylerZhu016/Agentic-Translating/releases/tag/v0.1.2)** — Windows installer and portable executable. Other platforms can build from source. See the [release notes](docs/releases/0.1.2.md).

The key difference from a general-purpose coding agent is not treating translation as just another coding task. Instead, it lets multiple roles work on the same open problem. Disagreements between candidate versions are kept as comparable evidence. The main agent decides which perspectives to call on, how to deliberate and merge them, and produces the final version through traceable text operations.

## Core Features

- Supports both English-to-Chinese and Chinese-to-English modes. Direction is frozen after session creation. Each direction maintains its own independent workspace draft.
- 10 agent archetypes, each with 2 directional variants: fidelity, naturalness, voice, terminology, culture, long text, formal text, literary, poetry, and dissent.
- Dynamic teaming and fixed presets coexist. The system keeps at least two successful candidates from different archetypes before forming the first version.
- Two completion paths: direct editing by the main agent, or the classic four-stage process of review, filter, orchestrate, and assemble.
- A disagreement map aligns candidate bodies by paragraph, sentence, or poetry line and highlights wording, punctuation, number, negation, proper-noun, terminology, and structural differences. It is a deterministic comparison aid, not an automatic verdict on correctness.
- Project-level translation archives maintain terminology, proper nouns, character voice, style rules, approved decisions, and contextual notes. New entries remain suggestions until a user approves them; approval creates an immutable snapshot that a session can freeze.
- A first-run guide and endpoint compatibility doctor report model discovery, ordinary chat, genuine streaming, usage reporting, and tool-call results separately. Quick, balanced, and deep workflows are created as normal user-owned preset revisions.
- A privacy-safe LLM call ledger covers every physical vNext orchestration request and retry, editing chat, the three revision-suggestion lenses, compatibility-doctor chat/stream/tool probes, and standalone Agent tests. It records status, known token usage, first-byte time, and total latency; missing usage remains unknown. Model-list discovery is metadata retrieval and is deliberately not counted as an LLM call.
- FSBP (Free-form Semantic Boundary Protocol). The final standalone `---` in a document acts as a divider. Content above is the body, content below is annotation, and the full original is always archived. Workflows default to body-only inheritance and may explicitly opt into passing the separated annotation as untrusted supporting material.
- Tools are exposed in stages: `call_agents`, `write_draft`, `replace_text`, `submit_final`. Each round injects only the tools needed at that point.
- Versioned edits, Unicode diff comparisons, evidence citations, undo and redo.
- User preset revision management, history recovery, safe export, and a batch queue supporting up to 100 files.
- SQLite local-first storage with BYOK and OpenAI-compatible endpoints. API keys never appear in browser DTOs, SSE events, logs, or export files.
- Available as a Next.js web app, self-hosted Docker image, Windows Electron installer, and portable build.

English-to-Chinese output defaults to plain modern Chinese. Forms like five-character or seven-character verse and rhyming are task-specific requirements or constraints for the Poetry agent, not system defaults.

## Quick Start

Requires Node.js 22 or later.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. On first use, the Configuration page guides you through adding an OpenAI-compatible endpoint, checking its actual capabilities, and creating a user-owned workflow. Experienced users can skip the guide and configure each binding directly.

Production mode:

```bash
npm run build
npm start
```

## Workflow

1. Select "English to Chinese" or "Chinese to English" in the top-right corner.
2. Enter the source text and task requirements in natural language. Optionally select a translation project, then choose the allowed agents, preset, and deliberation mode. Approved project resources are frozen for the session; later project edits do not rewrite its context.
3. In dynamic mode, the main agent invokes 2 to 4 roles suited to the current text. If no valid selection is available, it falls back to the "semantic fidelity plus target language fluency" combination.
4. The main agent builds the first version from at least two candidates, or runs the fixed four-stage deep deliberation process.
5. Use the disagreement map to inspect where candidates actually differ. It excludes Agent annotations from comparison and falls back to full-text comparison when reliable alignment is unavailable.
6. Subsequent edits must go through precise text tools to create patches and new versions. A candidate fragment can be handed to the editing Agent through the existing revision path, preserving before-and-after comparisons, reasons, and evidence.

Switching directions does not convert the current session. The system saves the current draft, then switches to the other direction's workspace draft. Old sessions remain in history. Background tasks are not canceled when the page is closed.

## FSBP

Agents can express themselves freely:

```text
Full candidate translation body
---
Optional notes on trade-offs, ambiguities, or terminology
```

Rules:

- Only the final standalone separator that equals `---` after trimming whitespace is recognized.
- Supports both LF and CRLF line endings.
- The `raw` content is saved and displayed permanently.
- Body-only inheritance is the default. A workflow preset may explicitly choose `body_and_annotation`, which passes the annotation downstream as untrusted supporting material.
- The `annotation` is always stored separately for inspection. The disagreement map compares only `body`, regardless of that workflow setting.
- The four-stage process in the product does not require strict JSON.

Configuration APIs, SSE events, and tool parameters use JSON for precise system state control. This is not part of the agent content protocol. See [docs/protocol-spec.en.md](docs/protocol-spec.en.md) for the full specification.

## Presets and Batch

A preset is a reusable work contract created by the user, not a translation strategy imposed by the system. Each content modification creates a new revision. Historical sessions and batches continue to use the frozen snapshot.

Batch tasks must select a valid revision. They support UTF-8 encoded `.txt` and `.md` files, 1 to 4 concurrent tasks, pause and resume, retry on failure, path mirroring, BOM and line ending preservation, and web ZIP export. See [docs/preset-and-batch.en.md](docs/preset-and-batch.en.md) for details.

## Desktop and Self-Hosting

For ordinary Windows users, download one of the two assets from the [v0.1.2 release](https://github.com/SkylerZhu016/Agentic-Translating/releases/tag/v0.1.2):

- `Agentic Translating-0.1.2-setup-x64.exe` — recommended installer;
- `Agentic Translating-0.1.2-portable-x64.exe` — portable version that runs without installation.

The first startup creates local application data. Upgrading does not delete translation history or custom agents. Before removing an endpoint, the application now shows every live and historical reference and can detach active bindings without deleting agent definitions.

Windows packaging:

```bash
npm run package:win
```

Output goes to the `dist-electron/` directory. Both an NSIS installer and a portable build are generated. Desktop data is stored in the Electron `userData` directory. Keys are protected by a local master key wrapped with `safeStorage`.

Docker:

```bash
docker compose up --build
```

Production web deployments must set the `AGENTIC_SECRET_KEY` environment variable. Build, backup, and upgrade instructions are in [docs/desktop-build.en.md](docs/desktop-build.en.md).

## FSBP Dataset

The previous pilot experiment has been retired. The replacement dataset,
selection log, schemas, rubrics, and research boundaries live in
[`FSBP_Test/`](FSBP_Test/README.en.md). The current 8-item development set and
16-item test set are versioned and locked after review.

```bash
npm run dataset:validate
npm run dataset:validate:locked
```

Draft validation accepts an incomplete selection while validating every present
record. Locked validation requires the complete approved 8-item development set
and 16-item test set (24 items in total).

## CLI Test Harness

`scripts/dev-harness.mts` provides a pure command-line driver for the workbench's
core session, HTTP, SSE, and revision operations (requires Node.js 22+). Start
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

Version 0.1.2 has passed 911 Vitest checks, TypeScript validation, a standalone production smoke test, and 21 active Playwright workflows; 13 legacy manual-workflow fixtures are explicitly skipped because v3 orchestration supersedes them. These engineering checks do not claim that FSBP has already proved superior translation quality on a formal unseen evaluation set.

## Development Commands

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
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
