# Agentic Translating vNext Technical Report

## Abstract

This project tackles high-stakes bidirectional translation across literature, poetry, normative texts, and academic technical writing — domains where no single correct answer exists. Rather than treating multiple agents as independent task parallelizers, the system uses them as candidate generators that offer different perspectives on the same problem. The master agent handles casting, comparison, deliberation, fusion, and versioned revision. The core method, FSBP, combines free text, a stage-body semantic contract, the final standalone `---` boundary, raw archival, body-only inheritance, and annotation isolation. It preserves free-form expression while preventing candidate self-explanation from propagating downstream.

vNext adds 10 agent prototypes, 20 language-direction variants, bidirectional prompt packs, dynamic/fixed teaming, two drafting pipelines, evidence-based editing, revision presets, batch queuing, history recovery, Windows Electron and Docker self-deployment, and fixes for context truncation, multi-endpoint snapshots, and API key leak boundaries.

## 1. Problem Definition

Translation involves multiple dimensions: polysemy resolution, target-language naturalness, authorial voice, cultural load, terminology consistency, long-range coherence, and formal constraints. A single pass from one model tends to collapse these objectives into an unexamined compromise. Multiple models and prompts can expand the candidate space, but without an auditable deliberation process, users still cannot answer: "Why was it changed this way, and what evidence supports the change?"

This project therefore addresses three questions simultaneously:

1. How to produce meaningful rather than random candidate differences at low cost;
2. How to let the deliberation process receive full evidence without being anchored by candidate annotations;
3. How to save final revisions as viewable, revertable, reproducible version history.

## 2. Methods

### 2.1 Role-Based Candidates

10 agent prototypes cover foundational, expressive, domain-specific, creative, and adversarial perspectives. The master agent's persistent context contains only a brief directory; full role prompts are injected on demand. The backend guarantees at least two successful candidates from distinct prototypes, falling back to a "faithful + natural" strategy when dynamic selection fails.

### 2.2 FSBP

Models return complete free-form text. The system saves the raw output, parses the body and annotation separately, and passes only the body to all downstream agents. The protocol does not mandate fixed fields, but it does assign a stable purpose to each stage body: review carries error and risk evidence, filtering carries keep and repair decisions, orchestration carries a complete working translation, and assembly carries the final translation. Process notes and self-evaluation belong in the annotation. Precise state changes are still handled by minimal tool JSON.

### 2.3 Bidirectional Prompts

The English-to-Chinese orchestration chain uses Chinese prompts; the Chinese-to-English chain uses English prompts. User task instructions are passed as-is as user data. Direction and prompt packs are frozen at session creation and cannot be reversed in place.

### 2.4 Evidence-Based Editing

`write_draft` requires at least two candidate invocations. `replace_text` validates the current version, unique match, and transactional consistency, creating a Patch and an immutable new version. Unicode grapheme differences are used for UI highlighting, falling back to block-level comparison on failure.

## 3. System Design

The server owns running tasks; SSE is merely a reconnectable subscription channel. Events carry monotonically increasing sequence numbers and are persisted to the database. Browser departure does not cancel a running task; on startup, any remaining `running` flag is marked as `interrupted`. Configuration snapshots freeze actual endpoints and model bindings; public DTOs expose only endpoint summaries and `hasApiKey`.

SQLite stores sessions, candidate raw/body/annotation, stage outputs, tool events, versions, Patches, drafts, preset revisions, and batches. Old schemas remain read-compatible; migrations avoid destructive deletions.

## 4. Product Interaction

The direction toggle in the top bar adds no navigation hierarchy. When switching with a non-empty draft or existing session, a modal clearly states that the previous progress has been saved; "Don't ask again" is persisted only after confirming the switch. Each direction has its own SQLite draft.

New UI reuses existing Card, Badge, Modal, Button, Textarea components and the paper-ink color palette. Candidate and final cards add only compact evidence badges, expandable details, and revision diff views, without altering the main two-column skeleton.

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

The planned dataset contains 8 development samples and 24 locked test samples,
balanced by direction and four high-difficulty text categories. Annotation
stress cases must come from genuine errors in normal model calls and require
human confirmation; misleading annotations may not be fabricated. No texts
have been approved yet, so this report currently makes no experimental quality
claim.

## 7. Threats and Limitations

- Model judges may favor their own writing style; order swapping can only mitigate positional bias, not eliminate it.
- Public-domain and open-license requirements introduce period bias, and the dataset cannot represent every language or domain.
- FSBP can isolate explicit annotations but cannot detect meta-instructions disguised as translation text within the body.
- Token estimation is not each vendor's precise tokenizer; when `contextWindow` is unconfigured, only a warning can be issued.
- Pinyin rhyme and CMU approximate rhyme carry no classical or poetic authority.
- Outputs in legal, medical, and other regulated domains cannot substitute for professional review.

## 8. Engineering Completeness

This delivery expands the prototype into a complete system encompassing data migration, protocols, bidirectional agents, server-side orchestration, auditable versioning, batch processing, desktop distribution, self-deployment, and dataset validation tooling. The final quality gate relies on `typecheck`, Vitest, Next build, Playwright, Windows packaging, and Docker health checks. Actual execution status should be determined by development delivery records; this report does not pre-assert passage.

## 9. Future Work

- Expert translator double-blind evaluation and cross-domain sample expansion;
- Prompt pack editor for custom non-Chinese-English directions;
- More precise vendor tokenizer and cost estimation;
- DOCX/PDF format-preserving import and export;
- Multi-device encrypted sync and team review permissions.
