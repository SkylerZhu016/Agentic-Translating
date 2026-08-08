# FSBP Test

[中文说明](README.md)

This directory builds and validates the FSBP (Free-form Semantic Boundary and
Deliberation Protocol) dataset for Agentic Translating. FSBP is more than
splitting free output at a delimiter. It combines:

- free-form semantic generation at the content layer;
- an explicit semantic boundary between body and annotation;
- downstream inheritance of body only;
- permanent archival of the complete raw response;
- independent perspectives before deliberation;
- a separation between natural-language content and state-changing tools;
- explicit failure instead of silent truncation or false success.

## Research questions

The experiment keeps three questions separate:

1. **Protocol reliability**: parse success, empty content, truncation, retries,
   latency, and tokens for prompt-constrained JSON, provider-native JSON Output,
   and FSBP.
2. **Annotation isolation**: whether downstream agents inherit upstream errors
   differently when the same candidate is passed as complete raw or body only.
3. **End-to-end quality**: final quality for strong-model direct translation,
   multi-agent raw inheritance, and multi-agent FSBP.

One result must not be used as a substitute for another, and the locked test set
must not be edited to obtain a preferred conclusion.

## Dataset size

| split | English-to-Chinese | Chinese-to-English | total |
|---|---:|---:|---:|
| dev | 4 | 4 | 8 |
| test | 8 | 8 | 16 |
| total | 12 | 12 | 24 |

Each direction contains four categories:

- `poetry`: poetry and formal texts;
- `literary`: literary narrative and character voice;
- `cultural_argument`: culturally loaded and argumentative texts;
- `nonliterary`: legal, technical, and other dense non-literary texts.

Each direction/category bucket has one development item and two test items.

## Length rules

- Poetry is kept complete with its original lineation and is never excerpted.
- English non-poetry uses 170–240 words, with a target near 200 words.
- Modern Chinese, legal, and technical texts use 160–240 Chinese characters,
  with a target near 200 characters.
- Classical Chinese non-poetry uses 80–140 Chinese characters, with a target near
  100 characters.
- The source must not be cut in the middle of a sentence or meaning unit.
- Necessary context is stored in `contextBefore` / `contextAfter` and is not part
  of the translation body.

## Confirmation and locking

The original confirmation batches were:

1. eight development samples;
2. sixteen test samples, two per direction/category bucket;
3. item-by-item review and problem annotation before locking.

Candidates were first registered in `selection/selection-log.md`, then written
to `datasets/quality-dev.jsonl` or `datasets/quality-test.jsonl` after review.
Changing a locked text requires a new `datasetVersion`; the old version is not
overwritten.

The current repository state is `datasetVersion: 0.1.0` with status `locked`.
All 8 development and 16 test items passed structural validation and item-level
human review. They are suitable for fixed-configuration evaluation and must not
be reused for prompt tuning. A new holdout or replacement must receive a new
dataset version.

## Annotation stress set

`datasets/annotation-stress.jsonl` accepts only cases from normal model runs:

1. the model produces a normal candidate and natural annotation;
2. a human confirms a real error in the body;
3. the model's own annotation reinforces or defends that error;
4. the identical body is evaluated with raw and body-only downstream input.

Misleading annotations may not be fabricated to reach a target count. If fewer
than 12 natural cases exist, sampling continues.

## Model-visible boundary

Generation and deliberation models may receive only:

- `direction`;
- `sourceText`;
- `contextBefore` / `contextAfter`;
- `taskBrief`;
- `deterministicConstraints`.

`reviewerChecklist`, source metadata, protocol labels, and human scores must not
enter generation context.

## Validation

```bash
# Draft mode: validate every present record without requiring a full dataset
npm run dataset:validate

# Locked mode: require 8 development and 16 test records
npm run dataset:validate:locked
```

Locked validation is expected to fail for an incomplete future dataset version;
empty placeholders must never be presented as samples.

Candidate files can be checked independently:

```bash
node scripts/validate-fsbp-dataset.mjs \
  --candidate-file FSBP_Test/selection/dev-candidates-round-01.jsonl
```

Each item retains one SHA-256 for the exact UTF-8 `sourceText`. No separate hash
is created for translations, reviews, source pages, or the complete data file.
The ordinary sample and annotation-stress records follow
`schemas/sample.schema.json` and `schemas/annotation-stress.schema.json`.

See [EXPERIMENT.en.md](EXPERIMENT.en.md) for the experimental conditions and
[sources/SOURCES.md](sources/SOURCES.md) for source and rights records.
