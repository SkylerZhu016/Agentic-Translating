# Agentic Translating vNext Technical Report

## Abstract

This project is positioned as a multi-option translation decision workbench for difficult texts. It covers bidirectional translation across literature, poetry, normative texts, and academic technical writing — domains where no single correct answer exists. Rather than treating multiple agents as independent task parallelizers, the system uses them as candidate generators that examine the same problem from different angles. The master agent handles casting, comparison, deliberation, fusion, and versioned revision. The core method, FSBP, combines free text, a stage-body semantic contract, the final standalone `---` boundary, raw archival, and explicit separation of body and annotation. Workflows default to body-only inheritance and may explicitly pass annotations downstream as untrusted supporting material; the disagreement map always compares bodies only.

vNext adds 10 agent prototypes, 20 language-direction variants, bidirectional prompt packs, dynamic/fixed teaming, two drafting pipelines, evidence-based editing, revision presets, batch queuing, history recovery, Windows Electron, and Docker self-deployment. The fourth iteration further introduces a disagreement map, project-level translation archives, a first-run guide with an endpoint compatibility doctor, and local analytics backed by actual call records. These capabilities share candidate, version, project-snapshot, and call-ledger data rather than forming disconnected feature islands.

## 1. Problem Definition

Translation involves multiple dimensions: polysemy resolution, target-language naturalness, authorial voice, cultural load, terminology consistency, long-range coherence, and formal constraints. A single pass from one model tends to collapse these objectives into an unexamined compromise. Multiple models and prompts can expand the candidate space, but without an auditable deliberation process, users still cannot answer: "Why was it changed this way, and what evidence supports the change?"

This project therefore addresses four questions simultaneously:

1. How to produce meaningful rather than random candidate differences at low cost;
2. How to let the deliberation process receive full evidence without being anchored by candidate annotations;
3. How to save final revisions as viewable, revertable, reproducible version history.
4. How to turn candidate disagreement, long-lived translation decisions, and actual operating cost into product assets users can inspect and reuse.

## 2. Methods

### 2.1 Role-Based Candidates

10 agent prototypes cover foundational, expressive, domain-specific, creative, and adversarial perspectives. The master agent's persistent context contains only a brief directory; full role prompts are injected on demand. The backend guarantees at least two successful candidates from distinct prototypes, falling back to a "faithful + natural" strategy when dynamic selection fails.

### 2.2 FSBP

Models return complete free-form text. The system saves the raw output and parses the body and annotation separately. The default policy passes only the body to downstream agents; users may explicitly select `body_and_annotation` in a workflow preset to pass the separated annotation as supporting material that still requires independent verification. The protocol does not mandate fixed fields, but it does assign a stable purpose to each stage body: review carries error and risk evidence, filtering carries keep and repair decisions, orchestration carries a complete working translation, and assembly carries the final translation. Process notes and self-evaluation belong in the annotation. Precise state changes are still handled by minimal tool JSON.

### 2.3 Bidirectional Prompts

The English-to-Chinese orchestration chain uses Chinese prompts; the Chinese-to-English chain uses English prompts. User task instructions are passed as-is as user data. Direction and prompt packs are frozen at session creation and cannot be reversed in place.

### 2.4 Evidence-Based Editing

`write_draft` requires at least two candidate invocations. `replace_text` validates the current version, unique match, and transactional consistency, creating a Patch and an immutable new version. Unicode grapheme differences are used for UI highlighting, falling back to block-level comparison on failure.

## 3. System Design

The server owns running tasks; SSE is merely a reconnectable subscription channel. Events carry monotonically increasing sequence numbers and are persisted to the database. Browser departure does not cancel a running task; on startup, any remaining `running` flag is marked as `interrupted`. Configuration snapshots freeze actual endpoints and model bindings; public DTOs expose only endpoint summaries and `hasApiKey`.

SQLite stores sessions, candidate raw/body/annotation, stage outputs, tool events, versions, Patches, drafts, preset revisions, and batches. Old schemas remain read-compatible; migrations avoid destructive deletions.

### 3.1 Disagreement Map

The disagreement map is a deterministic server-side derived view. It adds no translation stage and never modifies candidate bodies. The system segments candidates by paragraph, sentence, or poetry line and compares only the FSBP `body`; `annotation` does not enter the candidate-set hash, alignment, or returned map. The result highlights wording, punctuation, number, negation, proper-noun, terminology, and structural differences while showing the corresponding source segment, candidate provenance, and current final-version fragment.

These labels describe mechanical differences and do not judge translation correctness. When reliable alignment is unavailable, the endpoint still returns a usable full-text comparison, and map failure never blocks translation or submission. Adopting a fragment sends an instruction to the existing editing Agent, so the change still lands through Patch, TextVersion, and evidence history instead of bypassing versioning with a direct overwrite.

### 3.2 Project-Level Translation Archives

A translation project accumulates terminology, proper nouns, character voice, style rules, approved decisions, contextual notes, parallel excerpts, and counterexamples. Resources have stable identities and append-only revisions. Newly created resources and Agent proposals remain `suggested` or `pending`; only user approval adds them to a new immutable project snapshot, while rejection remains auditable.

A session can freeze the project, snapshot, actual resource revisions, and token estimate. Frozen content enters model context as a separate user-data block, never as a system prompt; later project edits do not change historical sessions. Direction, scope, snapshot membership, and content hashes are validated on the server, and public APIs do not return endpoint credentials. This design turns long-term consistency from implicit “automatic learning” into a user-approved, traceable translation asset.

### 3.3 First-Run Guide and Endpoint Compatibility Doctor

First-run state is stored in SQLite rather than relying only on browser storage. The compatibility doctor uses short requests to check model discovery, ordinary chat, genuine streaming, and tool calls, recording those results separately; standard usage support is assessed from the same ordinary non-streaming response. One unsupported capability does not erase results already obtained for the others. Profiles expire, endpoint-address or credential changes invalidate them, and persisted error text is scrubbed of credentials.

Users may still create a workflow whenever ordinary chat succeeds. Missing genuine streaming produces an experience warning; missing tool support falls back to the classic four-stage workflow. The quick, balanced, and deep choices are stored as ordinary user-owned preset revisions that can be edited, copied, and deleted, with no hidden system workflow. The interface also states that configuration and history stay local while task content is sent to a selected remote endpoint during a model call.

### 3.4 LLM Call Ledger and Local Analytics

`llm_call_records` covers every physical request and retry in the vNext orchestration path, editing chat, the three revision-suggestion lenses, compatibility-doctor chat/stream/tool probes, and standalone tests for both saved Agents and unsaved prompt previews. It records status, operation, model, endpoint reference, retry count, first-byte time, total latency, and available token counts. Model-list discovery is metadata retrieval and is deliberately not counted as an LLM call. Usage sources distinguish provider-reported, locally estimated, and unknown values. The data model can also distinguish provider-reported cost, estimates from a local price snapshot, and unknown cost; known cost appears only when a caller supplies a verifiable amount or price snapshot, so cost normally remains unknown in current runs. The ledger stores no prompt, source text, translation, full endpoint URL, or API key.

The History page displays only aggregates from recorded ledger entries: recorded LLM-call count, known tokens, average first-byte and total latency, and any known costs that actually exist in the ledger. Missing data remains unknown and is never fabricated. The analytics exclude model-list discovery, ordinary page requests, and other non-model operations. They are not a provider bill or a substitute for the provider's final settlement.

## 4. Product Interaction

The direction toggle in the top bar adds no navigation hierarchy. When switching with a non-empty draft or existing session, a modal clearly states that the previous progress has been saved; "Don't ask again" is persisted only after confirming the switch. Each direction has its own SQLite draft.

New UI reuses existing Card, Badge, Modal, Button, Textarea, and Spinner components and the paper-ink color palette. The disagreement map sits in the final translation and evidence area; project archives plus onboarding and compatibility checks live on the Configuration page; call analytics live on the History page. They add no top-level navigation and do not alter the main two-column skeleton.

## 5. Deterministic Checks

The backend checks paragraphs/sections, non-empty lines, required/forbidden words, structure, numbers, units, and prompts for missing proper nouns. Poetry receives additional checks:

- English-to-Chinese: character count, five/seven-character prosody tendency, final character and Mandarin pinyin rhyme; explicitly noted as distinct from Ping Shui Yun adjudication.
- Chinese-to-English: line count, word count, final word and approximate rhyme from the CMU Pronouncing Dictionary; unknown proper nouns are marked as unknown, serving only as modern English pronunciation aids.

Checkers do not modify or reject candidates; they only pass natural-language evidence to the deliberation agent.

## 6. FSBP Validation Plan

The samples, runner, and outputs from the early pilot have been retired and
must not be treated as quality evidence for the current architecture. The
replacement work in `FSBP_Test/` separates three questions:

1. protocol reliability for JSON and FSBP;
2. annotation isolation for raw and body-only inheritance;
3. end-to-end quality for direct translation, multi-agent raw, and multi-agent
   FSBP.

The dataset now contains 8 development samples and 16 structurally locked test
samples (24 items in total), balanced by direction and four high-difficulty text
categories. Annotation stress cases must come from genuine errors in normal
model calls and require human confirmation; misleading annotations may not be
fabricated. Because some of these texts were subsequently reused during prompt
and workflow iteration, existing results are development evidence rather than
an unseen-set generalization claim. A formal quality claim requires a newly
frozen holdout that no participant has reviewed or used for tuning.

## 7. Threats and Limitations

- Model judges may favor their own writing style; order swapping can only mitigate positional bias, not eliminate it.
- Public-domain and open-license requirements introduce period bias, and the dataset cannot represent every language or domain.
- FSBP can isolate explicit annotations but cannot detect meta-instructions disguised as translation text within the body.
- The disagreement map relies on deterministic segmentation and alignment. It can show that candidates differ but cannot prove one is correct, and complex long text may fall back to full-text comparison.
- Project archive quality depends on user approval. Unapproved suggestions cannot affect sessions, which also means the system does not automatically absorb every edit.
- Token estimation is not each vendor's precise tokenizer; when `contextWindow` is unconfigured, only a warning can be issued.
- Token coverage depends on endpoint usage responses. Cost is known only when a caller supplies a verifiable amount or price snapshot, so current requests normally remain unknown. Local analytics cannot replace a provider bill.
- Pinyin rhyme and CMU approximate rhyme carry no classical or poetic authority.
- Outputs in legal, medical, and other regulated domains cannot substitute for professional review.

## 8. Engineering Completeness

This delivery expands the prototype into a complete system encompassing data migration, protocols, bidirectional agents, server-side orchestration, auditable versioning, batch processing, desktop distribution, self-deployment, and dataset validation tooling, together with project archives, endpoint capability profiles, a derived disagreement view, and a unified call ledger. The 2026-08-11 candidate-source gates completed with all 911 tests in 91 Vitest files passing, TypeScript type checking passing, and the standalone production build, 2,402-file release-tree scan, and isolated migration-14 startup smoke passing. Playwright reported 21 passes and 13 explicit skips out of 34 cases; the skipped fixtures target legacy manual workflows superseded by v3. The single-Agent retry path also passed ten consecutive repetitions after its ordering-race fix. Windows installer packaging and Docker health checks were not rerun for this candidate-source validation, so this report does not present them as completed gates for the iteration.

## 9. Future Work

- Expert translator double-blind evaluation and cross-domain sample expansion;
- Prompt pack editor for custom non-Chinese-English directions;
- More precise vendor tokenizer and cost estimation;
- DOCX/PDF format-preserving import and export;
- EPUB support is deferred; future work should evaluate a mature, clearly licensed parser and round-trip implementation instead of rebuilding the format pipeline from scratch;
- Multi-device encrypted sync and team review permissions.
