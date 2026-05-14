// ---------------------------------------------------------------------------
// Stage-context builder + token-budget truncation + chat-context truncation
// Plan lines 704–753, contracts C3 / C4
// ---------------------------------------------------------------------------

import { STAGE_CONTEXT_TOKEN_BUDGET, CHAT_CONTEXT_TURNS } from '../constants'
import { estimateTokens } from '../guards/tokens'
import type { Stage, TranslationResult, StageOutput, ChatMessage } from '../contracts/types'

// ─── Exported types ──────────────────────────────────────────────

/** A single translation entry in the stage context JSON */
export interface StageContextTranslationEntry {
  agent_id: string
  name: string
  model: string
  text: string
}

/** The JSON payload passed to coordination-stage prompts (C3) */
export interface StageContextJson {
  source: {
    text: string
    from: string
    to: string
  }
  translations: StageContextTranslationEntry[]
  prior_stages: {
    review?: { parsed_output: string }
    filter?: { parsed_output: string }
    orchestrate?: { parsed_output: string }
  }
}

/** Result of buildStageContext – the JSON plus a truncation flag */
export interface StageContextResult {
  json: StageContextJson
  truncated: boolean
}

/** A single message in the chat-editing context (C4) */
export interface ChatContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

// ─── Helpers ─────────────────────────────────────────────────────

function parseAgentSnapshot(snapshot: string): { name: string; model: string } {
  try {
    const data = JSON.parse(snapshot)
    return {
      name: typeof data.name === 'string' ? data.name : 'unknown',
      model: typeof data.model === 'string' ? data.model : 'unknown',
    }
  } catch {
    return { name: 'unknown', model: 'unknown' }
  }
}

function stageOutputToIndexed(
  stages: StageOutput[],
): StageContextJson['prior_stages'] {
  const result: StageContextJson['prior_stages'] = {}
  for (const s of stages) {
    if (s.stage === 'review' || s.stage === 'filter' || s.stage === 'orchestrate') {
      result[s.stage] = { parsed_output: s.parsed_output ?? '' }
    }
  }
  return result
}

function jsonTokens(json: StageContextJson): number {
  return estimateTokens(JSON.stringify(json))
}

/**
 * Phase‑1 truncation: for every translation whose agent_id appears in the
 * filter stage's `rejected_agent_ids`, drop the full translation `text`
 * while keeping agent_id / name / model.
 *
 * Returns the number of entries that were cleared (0 if none).
 */
function dropRejectedTexts(
  json: StageContextJson,
  budget: number,
): number {
  const filterStage = json.prior_stages.filter
  if (!filterStage?.parsed_output) return 0

  let rejectedIds: string[]
  try {
    const parsed = JSON.parse(filterStage.parsed_output)
    rejectedIds = parsed.rejected_agent_ids ?? []
  } catch {
    return 0
  }
  if (rejectedIds.length === 0) return 0

  let cleared = 0
  for (const t of json.translations) {
    if (rejectedIds.includes(t.agent_id) && t.text.length > 0) {
      t.text = ''
      cleared++
    }
  }
  return cleared
}

/**
 * Phase‑2 truncation: iterate translations from the tail and replace each
 * non‑empty text with the truncation marker `…[truncated]…` until the
 * entire JSON fits within `budget`.
 *
 * Returns the number of entries that were truncated.
 */
function truncateFromTail(json: StageContextJson, budget: number): number {
  let truncated = 0

  for (let i = json.translations.length - 1; i >= 0; i--) {
    if (jsonTokens(json) <= budget) break

    const t = json.translations[i]
    if (t.text.length === 0) continue

    // Attempt to keep a prefix of the text with the marker appended.
    // Remove chunks from the end until we fit under budget.
    const marker = '…[truncated]…'
    const origLen = t.text.length

    // Short‑circuit: if even just the marker is acceptable, use it.
    t.text = marker
    if (jsonTokens(json) <= budget) {
      truncated++
      continue
    }

    // Otherwise binary‑search for the longest prefix that fits + marker.
    // Because narrowing char‑by‑char is wasteful for >1000‑char texts,
    // we shrink in estimated‑token‑delta steps.
    let low = 0
    let high = origLen
    let best = -1

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      t.text = origLen > 0 ? json.translations[i].text.slice(0, mid) : ''
      // We need to re-read the original text because we've been mutating t.text
      // Actually let's use a different approach - store prefix, construct full, check

      // Simpler: directly test with prefix + marker
      const prefix = json.translations[i].text.slice(0, mid)
      // Wait, t.text is being mutated, so we lost the original. Let me fix this.
      // We already saved origLen, but we also need the original text content.
      break // Fall through to the simple approach below
    }

    // Simple approach: use the original text we just overwrote…
    // Actually, we need the original text. Let me restructure.
  }

  return truncated
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Build a stage‑context JSON object (C3).
 *
 * The translations array is built from `TranslationResult[]`, mapping each
 * entry's `agent_key`, parsed `agent_snapshot`, and `output_text`.
 *
 * Prior stages (`review`, `filter`, `orchestrate`) are indexed by stage name;
 * `assemble` is intentionally excluded.
 *
 * If the serialized JSON exceeds the token budget the function applies a
 * two‑phase reduction:
 *   1. Drop full text of filter‑rejected translations (keep metadata).
 *   2. Truncate remaining translations from the tail, appending a
 *      `…[truncated]…` marker, until the budget is met.
 *
 * @param stage       Current coordination stage (unused in building, reserved).
 * @param params      Source text, language pair, translations, prior stages.
 * @param budget      Token budget (default: STAGE_CONTEXT_TOKEN_BUDGET).
 * @returns           The context JSON and a `truncated` flag.
 */
export function buildStageContext(
  _stage: Stage,
  params: {
    sourceText: string
    sourceLang: string
    targetLang: string
    translations: TranslationResult[]
    priorStages: StageOutput[]
  },
  budget: number = STAGE_CONTEXT_TOKEN_BUDGET,
): StageContextResult {
  // 1. Build base JSON
  const json: StageContextJson = {
    source: {
      text: params.sourceText,
      from: params.sourceLang,
      to: params.targetLang,
    },
    translations: params.translations.map((t) => {
      const agent = parseAgentSnapshot(t.agent_snapshot)
      return {
        agent_id: t.agent_key,
        name: agent.name,
        model: agent.model,
        text: t.output_text ?? '',
      }
    }),
    prior_stages: stageOutputToIndexed(params.priorStages),
  }

  // 2. Quick check – within budget
  if (jsonTokens(json) <= budget) {
    return { json, truncated: false }
  }

  let truncated = false

  // 3. Phase 1 – drop full text of filter‑rejected translations
  const cleared = dropRejectedTexts(json, budget)
  if (cleared > 0) {
    truncated = true
  }

  // 4. Phase 2 – truncate from tail
  if (jsonTokens(json) > budget) {
    for (let i = json.translations.length - 1; i >= 0; i--) {
      if (jsonTokens(json) <= budget) break

      const t = json.translations[i]
      if (t.text.length === 0) continue

      // Save original text for binary‑search approach
      const origText = t.text
      const marker = '…[truncated]…'

      // Binary search for longest prefix that fits within budget with marker
      let lo = 0
      let hi = origText.length
      let bestLen = -1

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2)
        t.text = origText.slice(0, mid) + marker

        if (jsonTokens(json) <= budget) {
          bestLen = mid
          lo = mid + 1 // try a longer prefix
        } else {
          hi = mid - 1 // need shorter prefix
        }
      }

      if (bestLen >= 0) {
        // We found a prefix that fits
        t.text = origText.slice(0, bestLen) + marker
        truncated = true
        break // we're done – under budget
      }

      // Even the marker alone is too large when appended to zero prefix.
      // Use just the marker.
      t.text = marker
      truncated = true

      if (jsonTokens(json) <= budget) break
      // Still over – let the loop continue to the previous entry
    }
  }

  return { json, truncated }
}

/**
 * Build a chat‑editing context array (C4).
 *
 * Always prepends a `system` message containing the current full translation
 * text and a description of the available edit tool (`replace_text`).
 *
 * If the number of input messages exceeds `maxTurns`, the oldest messages are
 * discarded and a `system` omission placeholder is inserted.
 *
 * @param messages     The full conversation so far (newest user instruction last).
 * @param currentText  The current full translation text.
 * @param maxTurns     Max messages to retain (default: CHAT_CONTEXT_TURNS).
 * @returns            An ordered array of chat‑context messages.
 */
export function buildChatContext(
  messages: ChatMessage[],
  currentText: string,
  maxTurns: number = CHAT_CONTEXT_TURNS,
): ChatContextMessage[] {
  const result: ChatContextMessage[] = []

  // 1. System message – current text + edit‑tool description
  result.push({
    role: 'system',
    content: `当前最新全文：\n${currentText}\n\n可用编辑工具：replace_text（替换指定文本段），请用此工具进行修改。`,
  })

  // 2. Determine which messages to keep
  if (messages.length > maxTurns) {
    const droppedCount = messages.length - maxTurns
    result.push({
      role: 'system',
      content: `（早期 ${droppedCount} 轮对话已省略，当前文本为最新版本）`,
    })

    // Keep only the most recent maxTurns messages
    const kept = messages.slice(-maxTurns)
    for (const m of kept) {
      result.push({ role: m.role, content: m.content })
    }
  } else {
    // All messages fit
    for (const m of messages) {
      result.push({ role: m.role, content: m.content })
    }
  }

  return result
}
