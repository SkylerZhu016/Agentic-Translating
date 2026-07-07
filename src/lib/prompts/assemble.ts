// ---------------------------------------------------------------------------
// Prompt Assembly — {{var}} interpolation + override priority + stage builder
// ---------------------------------------------------------------------------

// ----- Types -----

export interface ChatMessageInput {
  role: 'system' | 'user'
  content: string
}

export interface InterpolateOptions {
  /** When true, `{{var}}` patterns without a matching key are kept as-is
   *  instead of throwing. Default: false. */
  keepUnknown?: boolean
  /** When true, keys in `vars` that do NOT appear in the template are
   *  reported as warnings. Default: false. */
  warnUnused?: boolean
}

export interface InterpolateResult {
  result: string
  warnings: string[]
}

export interface TranslatorPromptParams {
  source_lang: string
  target_lang: string
  source_text: string
  extra_instructions?: string
}

export interface AgentWithOverride {
  prompt_override?: string | null
}

// ----- Custom Error -----

export class PromptAssemblyError extends Error {
  missingVars: string[]

  constructor(missingVars: string[]) {
    const msg =
      missingVars.length === 1
        ? `Missing required variable: ${missingVars[0]}`
        : `Missing required variables: ${missingVars.join(', ')}`
    super(msg)
    this.name = 'PromptAssemblyError'
    this.missingVars = missingVars
  }
}

// ----- Helpers -----

/** Extract all `{{var}}` variable names from a template string, deduplicated. */
function extractVarNames(template: string): string[] {
  const re = /\{\{(\w+)\}\}/g
  const names = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = re.exec(template)) !== null) {
    names.add(match[1])
  }
  return [...names]
}

// ----- Public API -----

/**
 * Replace `{{var}}` placeholders in `template` with values from `vars`.
 *
 * - By default (strict mode), any `{{var}}` without a matching key in `vars`
 *   throws a `PromptAssemblyError` listing the missing names.
 * - Pass `{ keepUnknown: true }` to preserve unknown `{{var}}` in the output
 *   and collect warnings instead of throwing.
 * - Pass `{ warnUnused: true }` to collect warnings for keys in `vars` that
 *   are never used in the template.
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
  options?: InterpolateOptions,
): InterpolateResult {
  const warnings: string[] = []
  const usedVars = new Set<string>()

  const result = template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (name in vars) {
      usedVars.add(name)
      return vars[name]
    }
    if (options?.keepUnknown) {
      warnings.push(`Unknown variable "{{${name}}}" preserved in output`)
      return match // keep as-is
    }
    // strict mode — collect missing and throw later
    return match // placeholder, will be validated below
  })

  // --- strict-mode validation ---
  const varNames = extractVarNames(template)
  const missing = varNames.filter((n) => !(n in vars))
  if (missing.length > 0 && !options?.keepUnknown) {
    throw new PromptAssemblyError(missing)
  }

  // --- warn about unused vars ---
  if (options?.warnUnused) {
    for (const key of Object.keys(vars)) {
      if (!usedVars.has(key)) {
        warnings.push(`Unused variable "${key}" provided but not used in template`)
      }
    }
  }

  return { result, warnings }
}

/**
 * Resolve which prompt template to use for a translator agent.
 *
 * If `agent.prompt_override` is a non-blank string it wins; otherwise the
 * `defaultTemplate` is returned.
 */
export function resolveTranslatorPrompt(
  agent: AgentWithOverride,
  defaultTemplate: string,
): string {
  if (
    agent.prompt_override &&
    typeof agent.prompt_override === 'string' &&
    agent.prompt_override.trim().length > 0
  ) {
    return agent.prompt_override
  }
  return defaultTemplate
}

/**
 * Build a `{ system, user }` message pair for a translator prompt.
 *
 * The `system` message carries role instructions (plus `extra_instructions`
 * when provided). The `user` message contains the interpolated template with
 * `source_text`, `source_lang`, etc. substituted in.
 */
export function buildTranslatorPrompt(
  template: string,
  params: TranslatorPromptParams,
): { system: ChatMessageInput; user: ChatMessageInput } {
  // Prepare interpolation variables
  // extra_instructions 是可选槽位：缺省置空串，使含 {{extra_instructions}} 的
  // 内置模板在严格插值下不抛 PromptAssemblyError（下方预检同样豁免该变量）。
  const vars: Record<string, string> = {
    source_lang: params.source_lang,
    target_lang: params.target_lang,
    source_text: params.source_text,
    extra_instructions: params.extra_instructions ?? '',
  }

  // Validate all template variables are satisfiable
  const varNames = extractVarNames(template)
  const missing = varNames.filter(
    (n) => n !== 'extra_instructions' && vars[n] === undefined,
  )
  if (missing.length > 0) {
    throw new PromptAssemblyError(missing)
  }

  // Build system message
  const systemParts: string[] = [
    'You are a professional translator. Translate the following text accurately and naturally.',
  ]
  if (params.extra_instructions) {
    systemParts.push('')
    systemParts.push(params.extra_instructions)
  }
  const system: ChatMessageInput = {
    role: 'system',
    content: systemParts.join('\n'),
  }

  // Build user message — interpolate template
  const { result: userContent } = interpolate(template, vars)
  const user: ChatMessageInput = {
    role: 'user',
    content: userContent,
  }

  return { system, user }
}

/**
 * Build a `{ system, user }` message pair for a translation stage.
 *
 * The `system` message is a JSON-only instruction referencing the stage
 * schema. The `user` message contains the stage template interpolated with
 * the provided context JSON.
 *
 * Individual variables (source_text, translations, review_output, etc.) are
 * extracted from the context JSON so the seeded prompt templates (which use
 * {{source_text}}, {{translations}}, …) interpolate correctly.  The full JSON
 * is also available as {{context}} for templates that prefer that form.
 */
export function buildStagePrompt(
  stageTemplate: string,
  contextJson: string,
  stageSchema: string,
): { system: ChatMessageInput; user: ChatMessageInput } {
  const system: ChatMessageInput = {
    role: 'system',
    content: [
      'You must output ONLY valid JSON that conforms to the schema below.',
      'Do not include any explanation, markdown formatting, or code fences.',
      '',
      '--- stage_schema ---',
      stageSchema,
      '--- end stage_schema ---',
    ].join('\n'),
  }

  // Parse context JSON to extract individual variables for template interpolation.
  let ctx: Record<string, unknown> = {}
  try { ctx = JSON.parse(contextJson) } catch { /* ignore */ }
  const source = (ctx.source as Record<string, string> | undefined) ?? {}
  const translations = (ctx.translations as Array<Record<string, unknown>> | undefined) ?? []
  const priorStages = (ctx.prior_stages as Record<string, { parsed_output?: string } | undefined> | undefined) ?? {}

  // Format translations as a readable list for {{translations}} / {{selected_translations}}
  const translationsText = translations
    .map((t, i) => `[${i + 1}] ${(t.name as string) ?? (t.agent_id as string) ?? 'unknown'}\n${(t.text as string) ?? ''}`)
    .join('\n\n')

  // Provide every variable the seeded prompt templates use
  const vars: Record<string, string> = {
    context: contextJson,
    source_text: source.text ?? '',
    source_lang: source.from ?? '',
    target_lang: source.to ?? '',
    translations: translationsText,
    selected_translations: translationsText,
    review_output: (priorStages.review as { parsed_output?: string } | undefined)?.parsed_output ?? '',
    filter_output: (priorStages.filter as { parsed_output?: string } | undefined)?.parsed_output ?? '',
    orchestrate_output: (priorStages.orchestrate as { parsed_output?: string } | undefined)?.parsed_output ?? '',
    extra_instructions: '',
  }

  const { result: userContent } = interpolate(stageTemplate, vars)

  const user: ChatMessageInput = {
    role: 'user',
    content: userContent,
  }

  return { system, user }
}
