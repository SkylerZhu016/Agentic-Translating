# Bidirectional Prompt Design

## 1. Direction Is Not a UI Filter Value

`en_to_zh` and `zh_to_en` each have their own complete `DirectionPromptBundle`:

- Main Agent
- Worker shared prompts
- Review, filter, orchestrate, assemble
- Editor Agent
- Tool descriptions
- Agent catalog descriptions

The en-to-zh chain uses Chinese system prompts throughout, while zh-to-en uses English system prompts. The GUI is always in Chinese. User task instructions are not translated or rewritten; they pass through as independent user data.

## 2. Message Hierarchy

System messages contain only:

```text
Direction main prompt
+ Current task fixed rules
+ Short catalog of currently allowed Agents
+ 1 to 3 tools for the current stage
```

User messages contain:

```text
Natural language task instructions
+ Full source text
+ Full successful candidate body
+ Full preceding stage body
+ Latest full translation
+ All relevant chat history
```

The source text is not inserted into the system prompt via `{{source_text}}`. Batch templates only replace `{{file_name}}` and `{{relative_path}}`.

## 3. Session Freezing

When a session is created, the system writes the direction, prompt bundle version, Agent variant snapshot, endpoint security snapshot, model binding, task instructions, constraints, and orchestration strategy. Upgrading built-in prompts does not affect existing sessions.

When opening a historical session, the top bar syncs to that session's direction. No switch warning is shown, and no text is converted.

## 4. Context Window Strategy

- No longer uses a 6000-token stage truncation
- No longer keeps only the last 20 chat messages
- No longer rejects creation with a fixed 8000-token source text threshold
- When `contextWindow` is configured, estimates before calling and reports errors clearly
- When no limit is configured, shows estimates and warnings but allows the call
- API context errors retain original diagnostic information

This does not mean context is unlimited. It means the system no longer silently discards evidence that users and Agents have produced.

## 5. Prompt Versioning Principles

Every built-in bundle and role variant has a stable ID and an incremental `promptVersion`. New seeds use their own seed version records. The system must not skip new built-in data just because old prompts already exist in the database.

Prompt ownership is split by responsibility:

```text
src/lib/prompts/bidirectional/
├─ common.ts       Shared quality, punctuation, and FSBP v2 boundary
├─ archetypes.ts   Ten stable archetypes and catalog metadata
├─ en-to-zh.ts     Ten Chinese roles and the Chinese orchestration chain
├─ zh-to-en.ts     Ten English roles and the English orchestration chain
└─ index.ts        Versions, defaults, and compatibility exports
```

Each translation role contains a mission, explained areas of focus, a separate example, a final check, and the final-annotation rule. Shared criteria cover semantic structure, unsupported additions, punctuation, and FSBP. Role criteria develop distinct evidence around fidelity, naturalness, voice, terminology, culture, long context, regulated text, literature, poetry, and dissent. The criteria guide attention without exhausting every valid translation consideration.

Prompt upgrades must satisfy the following:

1. Keep the prompt's FSBP version and boundary wording synchronized with the parser
2. Do not parse task instructions into a fixed content schema
3. Do not set five-character lines or rhyme as the global default for en-to-zh
4. Do not allow Agents to call other Agents
5. Do not let roles deliberately lower quality just to stand out

Names, sentences, reference answers, and item-specific findings from locked evaluation texts must not enter production prompts. Lessons from testing are generalized, and examples use situations unrelated to the locked items.

## 6. Custom Language Pairs

Advanced users can provide custom direction prompt bundles, but they will not automatically receive the 20 built-in variants from the Chinese-English directions. A custom direction requires at least two compatible custom Agents, and must explicitly provide the main Agent, worker, four-stage, and editor prompts.

Custom language pairs are a self-hosted or API capability. They do not appear in the top bar's "en-to-zh / zh-to-en" quick toggle. The creation process is as follows:

1. `POST /api/direction-prompt-bundles` creates a new `custom` prompt bundle revision
2. Create at least two custom Agent variants with `direction: "custom"` in the Agent library
3. `POST /api/sessions` with `direction: "custom"`, explicit `sourceLang`, `targetLang`, and the two variant IDs
4. The session freezes the prompt bundle, Agent, endpoint, and model snapshots

The backend rejects the following cases: missing source or target language, fewer than two custom Agents, a mismatch between the preset direction and the session direction, or a preset revision that contains Agents from another direction. The system does not automatically translate or reuse builtin Chinese-English prompts to fake compatibility.

Example (field content is illustrative only):

```json
{
  "direction": "custom",
  "sourceText": "Bonjour le monde",
  "sourceLang": "French",
  "targetLang": "German",
  "taskBrief": "Keep a concise, friendly greeting tone.",
  "allowedAgentVariantIds": [
    "custom-faithful.custom.1",
    "custom-natural.custom.1"
  ],
  "reviewMode": "main_editor"
}
```
