# Agentic Translating

[**中文**](docs/readme_cn.md) | [**English**](#)

A bidirectional translation system for difficult translation tasks. It supports multi-model, multi-perspective deliberation and evidence-based workflows.

The key difference from a general-purpose coding agent is not treating translation as just another coding task. Instead, it lets multiple roles work on the same open problem. Disagreements between candidate versions are kept as comparable evidence. The main agent decides which perspectives to call on, how to deliberate and merge them, and produces the final version through traceable text operations.

## Core Features

- Supports both English-to-Chinese and Chinese-to-English modes. Direction is frozen after session creation. Each direction maintains its own independent workspace draft.
- 10 agent archetypes, each with 2 directional variants: fidelity, naturalness, voice, terminology, culture, long text, formal text, literary, poetry, and dissent.
- Dynamic teaming and fixed presets coexist. The system keeps at least two successful candidates from different archetypes before forming the first version.
- Two completion paths: direct editing by the main agent, or the classic four-stage process of review, filter, orchestrate, and assemble.
- FSBP (Free-form Semantic Boundary Protocol). The first standalone `---` in a document acts as a divider. Content above is the body, content below is annotation. The full original is always archived. Downstream components only inherit the body.
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

Open `http://localhost:3000`. On first use, add an OpenAI-compatible endpoint and bind a model on the Configuration page.

Production mode:

```bash
npm run build
npm start
```

## Workflow

1. Select "English to Chinese" or "Chinese to English" in the top-right corner.
2. Enter the source text and task requirements in natural language. Choose the allowed agents, preset, and deliberation mode.
3. In dynamic mode, the main agent invokes 2 to 4 roles suited to the current text. If no valid selection is available, it falls back to the "semantic fidelity plus target language fluency" combination.
4. The main agent builds the first version from at least two candidates, or runs the fixed four-stage deep deliberation process.
5. Subsequent edits must go through precise text tools to create patches and new versions. The interface shows before-and-after comparisons, revision reasons, and candidate evidence.

Switching directions does not convert the current session. The system saves the current draft, then switches to the other direction's workspace draft. Old sessions remain in history. Background tasks are not canceled when the page is closed.

## FSBP

Agents can express themselves freely:

```text
Full candidate translation body
---
Optional notes on trade-offs, ambiguities, or terminology
```

Rules:

- Only the first standalone separator that equals `---` after trimming whitespace is recognized.
- Supports both LF and CRLF line endings.
- The `raw` content is saved and displayed permanently.
- Downstream components only receive the `body`.
- The `annotation` is for user reference only.
- The four-stage process in the product does not require strict JSON.

Configuration APIs, SSE events, and tool parameters use JSON for precise system state control. This is not part of the agent content protocol. See [docs/protocol-spec.en.md](docs/protocol-spec.en.md) for the full specification.

## Presets and Batch

A preset is a reusable work contract created by the user, not a translation strategy imposed by the system. Each content modification creates a new revision. Historical sessions and batches continue to use the frozen snapshot.

Batch tasks must select a valid revision. They support UTF-8 encoded `.txt` and `.md` files, 1 to 4 concurrent tasks, pause and resume, retry on failure, path mirroring, BOM and line ending preservation, and web ZIP export. See [docs/preset-and-batch.en.md](docs/preset-and-batch.en.md) for details.

## Desktop and Self-Hosting

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

## Protocol Experiments

First edit the model names in `experiments/configs/main.json` and provide the API key through environment variables:

```bash
npm run experiment:protocol -- --config experiments/configs/main.json
npm run experiment:report -- --run <run-id>
```

The experiment uses a fixed set of 20 public-domain bidirectional samples and 6 misleading-annotation stress samples. It compares three protocols: `strict-json`, `freeform-raw`, and `fsbp-v1`. The executor supports checkpoint resume by record key and does not write API keys to result files.

Running experiments with real models incurs API costs. The repository does not include pre-generated or fabricated experimental results.

## Development Commands

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run typecheck` | TypeScript type checking |
| `npm test` | Run Vitest tests |
| `npm run build` | Next.js production build |
| `npm run e2e` | Run Playwright end-to-end tests |
| `npm run package:win` | Package Windows NSIS installer and portable build |
| `npm run experiment:protocol` | Run protocol ablation experiment |
| `npm run experiment:report` | Generate CSV, Markdown, and HTML reports |

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

## License

This project is licensed under the [MIT License](LICENSE).
