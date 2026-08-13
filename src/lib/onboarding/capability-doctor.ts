import type Database from 'better-sqlite3'
import { discoverEndpointModels } from '../llm/model-discovery'
import {
  chatCompletion,
  isAsyncIterable,
  LLMError,
  type ChatCompletionResponse,
  type LLMStreamEvent,
} from '../llm/client'
import { createRepositories } from '../db/repositories'
import {
  endpointCapabilityProfileSchema,
  type CapabilityCheckRequest,
  type CapabilityResult,
  type EndpointCapabilityProfile,
} from './contracts'
import { createOnboardingRepository } from './repository'
import { beginBestEffortLlmCall } from '../services/llm-call-ledger'

export const CAPABILITY_PROFILE_TTL_MS = 24 * 60 * 60 * 1_000

const PROBE_TIMEOUT_MS = 20_000
const PROBE_MAX_DURATION_MS = 30_000
const PROBE_MAX_TOKENS = 8

export class EndpointCapabilityNotFoundError extends Error {
  constructor(readonly endpointId: number) {
    super(`Endpoint ${endpointId} was not found`)
    this.name = 'EndpointCapabilityNotFoundError'
  }
}

export interface CapabilityDoctorDependencies {
  discoverModels?: typeof discoverEndpointModels
  complete?: typeof chatCompletion
  now?: () => Date
  monotonicNow?: () => number
  createDiagnosticId?: () => string
}

interface ProbeEndpoint {
  baseUrl: string
  chatCompletionsPath: string
  apiKey: string
}

function redactErrorText(value: string, secrets: string[]): string {
  let redacted = value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
  for (const secret of secrets) {
    if (!secret) continue
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted.replace(/[\r\n]+/g, ' ').slice(0, 1_000)
}

function describeProbeError(error: unknown, apiKey: string): string {
  const message = redactErrorText(
    error instanceof Error ? error.message : String(error),
    [apiKey],
  )
  if (error instanceof LLMError) {
    const status = error.status == null ? '' : `:http_${error.status}`
    return `${error.code}${status}: ${message}`.slice(0, 1_000)
  }
  return message || 'unknown_probe_error'
}

function result(
  supported: boolean,
  error: string | null = null,
): CapabilityResult {
  return { supported, error }
}

function readConfiguredModel(
  db: Database.Database,
  endpointId: number,
): string | null {
  const translator = db.prepare(`
    SELECT model
    FROM translator_agents
    WHERE endpoint_id = ? AND length(trim(model)) > 0
    ORDER BY sort_order, id
    LIMIT 1
  `).get(endpointId) as { model: string } | undefined
  if (translator) return translator.model.trim()

  const coordinator = db.prepare(`
    SELECT model, chat_model, endpoint_id, chat_endpoint_id
    FROM coordinator_config
    WHERE id = 1
  `).get() as
    | {
        model: string
        chat_model: string
        endpoint_id: number | null
        chat_endpoint_id: number | null
      }
    | undefined
  if (
    coordinator?.endpoint_id === endpointId &&
    coordinator.model.trim().length > 0
  ) {
    return coordinator.model.trim()
  }
  if (
    coordinator?.chat_endpoint_id === endpointId &&
    coordinator.chat_model.trim().length > 0
  ) {
    return coordinator.chat_model.trim()
  }

  const profileRows = db.prepare(`
    SELECT default_worker_json, main_agent_json, review_agent_json,
           filter_agent_json, orchestrate_agent_json, assemble_agent_json,
           editing_agent_json
    FROM workspace_model_profiles
    ORDER BY direction
  `).all() as Array<Record<string, string | null>>
  for (const row of profileRows) {
    for (const encoded of Object.values(row)) {
      if (!encoded) continue
      try {
        const binding = JSON.parse(encoded) as Record<string, unknown>
        if (
          binding.endpointId === endpointId &&
          typeof binding.model === 'string' &&
          binding.model.trim().length > 0
        ) {
          return binding.model.trim()
        }
      } catch {
        // Existing malformed profile data is diagnosed by its owning
        // repository and must not prevent capability probing.
      }
    }
  }
  return null
}

async function probeChatAndUsage(
  db: Database.Database,
  endpointId: number,
  endpoint: ProbeEndpoint,
  model: string,
  complete: typeof chatCompletion,
): Promise<{ chat: CapabilityResult; usage: CapabilityResult }> {
  const ledger = beginBestEffortLlmCall({
    db,
    endpointId,
    model,
    operation: 'capability.chat',
  })
  try {
    const response = await complete(endpoint, {
      model,
      messages: [{ role: 'user', content: 'Reply exactly: OK' }],
      stream: false,
      maxTokens: PROBE_MAX_TOKENS,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxDurationMs: PROBE_MAX_DURATION_MS,
      onActivity: () => ledger.markReceiving(),
    })
    if (isAsyncIterable(response)) throw new Error('unexpected_stream_response')
    ledger.markReceiving()
    const hasOutput = Boolean(
      response.content.trim() || response.toolCalls?.length,
    )
    if (!hasOutput) {
      ledger.fail(
        new Error('provider returned no visible content or tool call'),
        response.usage,
        'empty_response',
      )
      return {
        chat: result(false, 'empty_response'),
        usage: response.usage
          ? result(true)
          : result(false, 'usage_not_returned'),
      }
    }
    ledger.complete(response.usage)
    return {
      chat: result(true),
      usage: response.usage
        ? result(true)
        : result(false, 'usage_not_returned'),
    }
  } catch (error) {
    ledger.fail(error)
    const description = describeProbeError(error, endpoint.apiKey)
    return {
      chat: result(false, description),
      usage: result(false, `chat_probe_failed: ${description}`.slice(0, 1_000)),
    }
  }
}

async function probeStreaming(
  db: Database.Database,
  endpointId: number,
  endpoint: ProbeEndpoint,
  model: string,
  complete: typeof chatCompletion,
  monotonicNow: () => number,
): Promise<{ streaming: CapabilityResult; firstByteMs: number | null }> {
  const startedAt = monotonicNow()
  let firstByteMs: number | null = null
  const ledger = beginBestEffortLlmCall({
    db,
    endpointId,
    model,
    operation: 'capability.stream',
  })
  try {
    const response = await complete(endpoint, {
      model,
      messages: [{ role: 'user', content: 'Reply exactly: OK' }],
      stream: true,
      maxTokens: PROBE_MAX_TOKENS,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxDurationMs: PROBE_MAX_DURATION_MS,
      onActivity: () => {
        if (firstByteMs == null) {
          firstByteMs = Math.max(0, Math.round(monotonicNow() - startedAt))
        }
      },
    })
    if (!isAsyncIterable(response)) throw new Error('stream_not_returned')

    let done: Extract<LLMStreamEvent, { type: 'done' }> | null = null
    for await (const event of response) {
      ledger.markReceiving()
      if (event.type === 'done') done = event
    }
    if (!done) throw new Error('stream_completion_marker_missing')
    if (!done.content.trim() && !done.toolCalls?.length) {
      ledger.fail(
        new Error('provider returned no visible content or tool call'),
        done.usage,
        'empty_response',
      )
      return {
        streaming: result(false, 'empty_response'),
        firstByteMs,
      }
    }
    ledger.complete(done.usage)
    if (done.transport === 'json_fallback') {
      return {
        streaming: result(false, 'provider_returned_json_fallback'),
        firstByteMs,
      }
    }
    return { streaming: result(true), firstByteMs }
  } catch (error) {
    ledger.fail(error)
    return {
      streaming: result(false, describeProbeError(error, endpoint.apiKey)),
      firstByteMs,
    }
  }
}

async function probeTools(
  db: Database.Database,
  endpointId: number,
  endpoint: ProbeEndpoint,
  model: string,
  complete: typeof chatCompletion,
): Promise<CapabilityResult> {
  const ledger = beginBestEffortLlmCall({
    db,
    endpointId,
    model,
    operation: 'capability.tools',
  })
  try {
    const response = await complete(endpoint, {
      model,
      messages: [{ role: 'user', content: 'Call capability_probe now.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'capability_probe',
            description: 'Return a minimal endpoint capability signal.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        },
      ],
      toolChoice: {
        type: 'function',
        function: { name: 'capability_probe' },
      },
      stream: false,
      maxTokens: PROBE_MAX_TOKENS,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxDurationMs: PROBE_MAX_DURATION_MS,
      onActivity: () => ledger.markReceiving(),
    })
    if (isAsyncIterable(response)) throw new Error('unexpected_stream_response')
    ledger.markReceiving()
    const supported = Boolean(
      (response as ChatCompletionResponse).toolCalls?.some(
        (call) => call.name === 'capability_probe',
      ),
    )
    const hasOutput = Boolean(
      response.content.trim() || response.toolCalls?.length,
    )
    if (hasOutput) {
      ledger.complete(response.usage)
    } else {
      ledger.fail(
        new Error('provider returned no visible content or tool call'),
        response.usage,
        'empty_response',
      )
      return result(false, 'empty_response')
    }
    return supported
      ? result(true)
      : result(false, 'tool_call_not_returned')
  } catch (error) {
    ledger.fail(error)
    return result(false, describeProbeError(error, endpoint.apiKey))
  }
}

export async function runEndpointCapabilityCheck(
  db: Database.Database,
  endpointId: number,
  input: CapabilityCheckRequest = {},
  dependencies: CapabilityDoctorDependencies = {},
): Promise<EndpointCapabilityProfile> {
  const endpointRow = createRepositories(db).endpoints.getById(endpointId)
  if (!endpointRow) throw new EndpointCapabilityNotFoundError(endpointId)

  const discoverModels = dependencies.discoverModels ?? discoverEndpointModels
  const complete = dependencies.complete ?? chatCompletion
  const now = dependencies.now ?? (() => new Date())
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
  const createDiagnosticId =
    dependencies.createDiagnosticId ?? (() => crypto.randomUUID())
  const endpoint: ProbeEndpoint = {
    baseUrl: endpointRow.base_url,
    chatCompletionsPath:
      endpointRow.chat_completions_path ?? '/v1/chat/completions',
    apiKey: endpointRow.api_key,
  }

  let discoveredModels: Array<{ id: string }> = []
  let models: EndpointCapabilityProfile['models']
  try {
    discoveredModels = await discoverModels({
      baseUrl: endpoint.baseUrl,
      chatCompletionsPath: endpoint.chatCompletionsPath,
      apiKey: endpoint.apiKey,
    })
    models = { supported: true, count: discoveredModels.length, error: null }
  } catch (error) {
    models = {
      supported: false,
      count: null,
      error: describeProbeError(error, endpoint.apiKey),
    }
  }

  const testedModel =
    input.model?.trim() ||
    readConfiguredModel(db, endpointId) ||
    discoveredModels[0]?.id ||
    ''

  let chat = result(false, 'no_test_model')
  let usage = result(false, 'no_test_model')
  let streaming = result(false, 'no_test_model')
  let tools = result(false, 'no_test_model')
  let firstByteMs: number | null = null

  if (testedModel) {
    const chatAndUsage = await probeChatAndUsage(
      db,
      endpointId,
      endpoint,
      testedModel,
      complete,
    )
    chat = chatAndUsage.chat
    usage = chatAndUsage.usage

    const streamingProbe = await probeStreaming(
      db,
      endpointId,
      endpoint,
      testedModel,
      complete,
      monotonicNow,
    )
    streaming = streamingProbe.streaming
    firstByteMs = streamingProbe.firstByteMs

    tools = await probeTools(db, endpointId, endpoint, testedModel, complete)
  }

  const checked = now()
  const profile = endpointCapabilityProfileSchema.parse({
    endpointId,
    checkedAt: checked.toISOString(),
    expiresAt: new Date(
      checked.getTime() + CAPABILITY_PROFILE_TTL_MS,
    ).toISOString(),
    models,
    chat,
    streaming,
    usage,
    tools,
    reasoningContent: result(false, 'not_probed'),
    firstByteMs,
    testedModel,
    diagnosticId: createDiagnosticId(),
  })

  const repository = createOnboardingRepository(db)
  return db.transaction(() => {
    const stored = repository.saveCapabilityProfile(profile)
    repository.updateState({
      lastDoctorRunAt: profile.checkedAt,
      selectedEndpointId: endpointId,
    })
    return stored
  })()
}
