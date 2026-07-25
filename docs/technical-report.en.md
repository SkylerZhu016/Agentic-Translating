# Agentic Translating vNext Technical Report

## Abstract

This project tackles high-stakes bidirectional translation across literature, poetry, normative texts, and academic technical writing — domains where no single correct answer exists. Rather than treating multiple agents as independent task parallelizers, the system uses them as candidate generators that offer different perspectives on the same problem. The master agent handles casting, comparison, deliberation, fusion, and versioned revision. The core method, FSBP (Free-Stream Body Protocol), uses the first standalone `---` to separate body from annotations, blocking annotation propagation downstream while preserving free-form expression.

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

Models return complete free-form text. The system saves the raw output, parses the body and annotation separately, and passes only the body to all downstream agents. The protocol does not require strict JSON within the product, nor does it mandate fixed fields. Precise state changes are still handled by minimal tool JSON.

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

## 6. Protocol Ablation Experiments

The repository provides an interrupt-resumable CLI using a fixed set of 20 public-domain samples (10 per direction, including poetry and prose) and 6 misleading-annotation stress samples. First drafts from three candidate models are generated once and frozen; all three groups share the same candidates:

1. `strict-json`: stage outputs in strict JSON, with one allowed format-fix retry;
2. `freeform-raw`: free text, annotations passed downstream;
3. `fsbp-v1`: free text, only body passed downstream.

The deliberation model, stage objectives, and sampling parameters are consistent across all groups. An independent judge performs anonymous ranking, then re-evaluates in reverse order. Run records include format success, retries, stage completion, latency, tokens, scores, and failure reasons; reports compute win rates, Wilson 95% confidence intervals, and paired sign tests.

### 6.1 First Real Run

Run `2026-07-24T15-25-09-239Z-e5ee2aaa` used three candidate models, one deliberation model, and one independent judge model, completing all 20 public-domain samples (6 of which included misleading-annotation stress conditions). A total of 60 frozen candidates, 240 stage invocations, and 40 judge evaluations with swapped candidate order were recorded. No invocation or stage failures occurred. Stage completion rates and minimum verse-structure compliance rates were 100% across all three groups. `strict-json` incurred 1 format-fix retry; both free-text protocols had 0.

When aggregating the two ordered evaluations per source sample, 12 samples yielded a single unique preference, and 8 were ties. The sample-level unique-preference win rates were:

- `strict-json`: 33.3%, Wilson 95% CI 13.8%–60.9%;
- `freeform-raw`: 41.7%, Wilson 95% CI 19.3%–68.0%;
- `fsbp-v1`: 25.0%, Wilson 95% CI 8.9%–53.2%.

All paired sign tests failed to reach statistical significance. Among the 6 stress samples, unique preferences were `strict-json=1`, `freeform-raw=2`, `fsbp-v1=1`, with 2 ties. Therefore, this small-sample automated evaluation **did not demonstrate that FSBP produces superior translation quality compared to either control group, nor did it confirm that annotation isolation increases judge preference under the current stress design**. This is a negative result and should not be rewritten as a supportive conclusion.

FSBP consumed 118,719 stage tokens in this run, lower than `strict-json`'s 153,619 and `freeform-raw`'s 155,766 — reductions of approximately 22.7% and 23.8%, respectively. However, its average stage latency of 22.0 seconds was faster than `freeform-raw`'s 25.1 seconds but slower than `strict-json`'s 18.0 seconds. FSBP's current, more defensible value proposition is "structural invariants that prevent annotations from reaching downstream while preserving raw output for auditability," rather than experimentally proven quality gains.

The forward and reverse judge preference agreement rate was only 35.0% (7/20), indicating significant model-judge noise and positional sensitivity. Future work should expand the sample size, improve stress construction, and incorporate expert human blind evaluation. Full data is available at `experiments/results/2026-07-24T15-25-09-239Z-e5ee2aaa/`; auto-generated Markdown/HTML reports at `experiments/reports/2026-07-24T15-25-09-239Z-e5ee2aaa.*`.

## 7. Threats and Limitations

- Model judges may favor their own writing style; order swapping can only mitigate positional bias, not eliminate it.
- 20 samples are suitable for engineering ablation and failure analysis but insufficient to represent all languages and domains.
- FSBP can isolate explicit annotations but cannot detect meta-instructions disguised as translation text within the body.
- Token estimation is not each vendor's precise tokenizer; when `contextWindow` is unconfigured, only a warning can be issued.
- Pinyin rhyme and CMU approximate rhyme carry no classical or poetic authority.
- Outputs in legal, medical, and other regulated domains cannot substitute for professional review.

## 8. Engineering Completeness

This delivery expands the prototype into a complete system encompassing data migration, protocols, bidirectional agents, server-side orchestration, auditable versioning, batch processing, desktop distribution, self-deployment, and experimental tooling. The final quality gate relies on `typecheck`, Vitest, Next build, Playwright, Windows packaging, and Docker health checks. Actual execution status should be determined by development delivery records; this report does not pre-assert passage.

## 9. Future Work

- Expert translator double-blind evaluation and cross-domain sample expansion;
- Prompt pack editor for custom non-Chinese-English directions;
- More precise vendor tokenizer and cost estimation;
- DOCX/PDF format-preserving import and export;
- Multi-device encrypted sync and team review permissions.
