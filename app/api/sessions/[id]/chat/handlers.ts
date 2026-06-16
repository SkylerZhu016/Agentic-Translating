// ---------------------------------------------------------------------------
// Chat SSE handlers — canonical co-located handler factory (Wave 3 Task 19).
//
// route.ts lazy-singletons createHandlers(db); tests import this directly to
// avoid the production getDb() call. A thin re-export shim exists at
// src/lib/handlers/chat-handler.ts for legacy import paths.
// ---------------------------------------------------------------------------
//
// POST {message, selection?:{text,start,end}} →
//   - Guard: state∈{assembled,refining}→409 (coordinating→409)
//   - Context: buildChatContext(最新版本全文+最近20轮)
//   - Model: snapshot coordinator.chat_model(缺省=coordinator.model)
//   - SSE: C1 chat events (message_start/delta/tool_call/tool_result/message_complete/done)
//   - Persist: user msg first; assistant after(content+tool_calls); edited→final_versions(source='edit')+version_id
// ---------------------------------------------------------------------------

import type Database from 'better-sqlite3'
import { NextRequest, NextResponse } from 'next/server'
import { createRepositories } from '@/src/lib/db/repositories'
import { runChatTurn } from '@/src/lib/chat/tool-loop'
import { buildChatContext } from '@/src/lib/context/stage-context'
import { encodeSSE } from '@/src/lib/contracts/sse'
import type { ConfigSnapshot, SessionState } from '@/src/lib/contracts/types'

// =============================================================================
// Types
// =============================================================================

interface ChatRequestBody {
  message: string
  selection?: {
    text: string
    start: number
    end: number
  }
}

// =============================================================================
// Helpers
// =============================================================================

function buildUserMessage(body: ChatRequestBody): string {
  if (body.selection) {
    return (
      `【用户指令】${body.message}\n` +
      `【选中片段】（位置 ${body.selection.start}-${body.selection.end}）：\n` +
      `"${body.selection.text}"\n\n` +
      `请针对以上选中片段进行修改。`
    )
  }
  return body.message
}

function resolveChatConfig(snapshot: ConfigSnapshot): {
  baseUrl: string
  apiKey: string
  model: string
} | null {
  const coordinator = snapshot.coordinator
  if (!coordinator) return null

  const endpointConfig = snapshot.endpoint
  if (!endpointConfig) return null

  const model = coordinator.chat_model || coordinator.model
  if (!model) return null

  return {
    baseUrl: endpointConfig.base_url,
    apiKey: endpointConfig.api_key,
    model,
  }
}

// =============================================================================
// Handler factory
// =============================================================================

export function createHandlers(db: Database.Database) {
  const repos = createRepositories(db)

  async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    const { id: sessionId } = await params

    // 1. Parse body
    let body: ChatRequestBody
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'invalid_body', message: 'Request body must be valid JSON' },
        { status: 400 },
      )
    }

    if (!body.message || typeof body.message !== 'string' || body.message.trim().length === 0) {
      return NextResponse.json(
        { error: 'message_required', message: 'Field "message" is required and must be a non-empty string' },
        { status: 400 },
      )
    }

    // 2. Get session
    const session = repos.sessions.getById(sessionId)
    if (!session) {
      return NextResponse.json(
        { error: 'session_not_found', message: `Session not found: ${sessionId}` },
        { status: 404 },
      )
    }

    // 3. Guard: state ∈ {assembled, refining}
    const state = session.state as SessionState
    if (state !== 'assembled' && state !== 'refining') {
      return NextResponse.json(
        { error: 'state_not_ready', message: `Chat only available in assembled/refining state, current: ${state}` },
        { status: 409 },
      )
    }

    // 4. Resolve chat config from snapshot
    let snapshot: ConfigSnapshot
    try {
      snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
    } catch {
      return NextResponse.json(
        { error: 'invalid_snapshot', message: 'Failed to parse session config snapshot' },
        { status: 500 },
      )
    }

    const chatConfig = resolveChatConfig(snapshot)
    if (!chatConfig) {
      return NextResponse.json(
        { error: 'no_chat_config', message: 'No chat endpoint or model configured in session snapshot' },
        { status: 400 },
      )
    }

    // 5. Get current text and recent messages
    const latestVersion = repos.finalVersions.getLatestBySession(sessionId)
    const currentText = latestVersion?.text ?? ''
    const recentMessages = repos.chatMessages.listBySessionWithLimit(sessionId, 20)

    // 6. Insert user message
    const userMessageContent = buildUserMessage(body)
    repos.chatMessages.insert({
      session_id: sessionId,
      role: 'user',
      content: userMessageContent,
      tool_calls: null,
      tool_results: null,
      version_id: null,
    })

    // 7. Build chat context
    const contextMessages = buildChatContext(
      recentMessages.map((m) => ({
        id: m.id,
        session_id: m.session_id,
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
        tool_results: m.tool_results,
        version_id: m.version_id,
        created_at: m.created_at,
      })),
      currentText,
    )

    const llmMessages = contextMessages.map((cm) => ({
      role: cm.role,
      content: cm.content,
    }))

    // 8. Create SSE stream
    const encoder = new TextEncoder()
    let isAborted = false

    const stream = new ReadableStream({
      async start(controller) {
        const enqueue = (data: string) => {
          if (!isAborted) {
            controller.enqueue(encoder.encode(data))
          }
        }

        enqueue(encodeSSE('message_start', { session_id: sessionId }))

        let fullText = ''
        let didProtocolFallback = false

        try {
          const result = await runChatTurn({
            endpoint: { baseUrl: chatConfig.baseUrl, apiKey: chatConfig.apiKey },
            model: chatConfig.model,
            messages: llmMessages,
            currentText,
            callbacks: {
              onDelta: (text) => {
                fullText += text
                enqueue(encodeSSE('delta', { text }))
              },
              onToolCall: (name, args) => {
                enqueue(encodeSSE('tool_call', { name, arguments: args }))
              },
              onToolResult: (ok, resultData) => {
                if (ok && resultData) {
                  enqueue(
                    encodeSSE('tool_result', {
                      ok: true,
                      diff_summary: resultData.diffSummary,
                    }),
                  )
                } else {
                  enqueue(encodeSSE('tool_result', { ok: false }))
                }
              },
              onProtocolFallback: () => {
                didProtocolFallback = true
              },
            },
            stream: true,
          })

          if (result.ok) {
            if (didProtocolFallback) {
              enqueue(
                encodeSSE('delta', {
                  text: '\n\n（已切换兼容模式，使用 JSON fence 进行编辑）',
                }),
              )
            }

            // Persist assistant message + optional version
            const txn = db.transaction(() => {
              let versionId: number | null = null

              if (result.kind === 'edited') {
                const latest = repos.finalVersions.getLatestBySession(sessionId)
                const versionNo = (latest?.version_no ?? 0) + 1

                const vResult = repos.finalVersions.insert({
                  session_id: sessionId,
                  version_no: versionNo,
                  text: result.newText,
                  source: 'edit',
                })
                versionId = vResult.lastInsertRowid as number

                enqueue(
                  encodeSSE('tool_result', {
                    ok: true,
                    version_no: versionNo,
                    new_text_preview:
                      result.newText.slice(0, 200) +
                      (result.newText.length > 200 ? '…' : ''),
                  }),
                )
              }

              repos.chatMessages.insert({
                session_id: sessionId,
                role: 'assistant',
                content: fullText,
                tool_calls: null,
                tool_results: null,
                version_id: versionId,
              })
            })

            txn()

            enqueue(
              encodeSSE('message_complete', {
                kind: result.kind,
                ...(result.kind === 'edited'
                  ? { diff_summary: result.diffSummary }
                  : {}),
              }),
            )
          } else {
            enqueue(
              encodeSSE('message_complete', {
                error: result.code,
                message: result.message ?? 'Chat turn failed',
              }),
            )
          }
        } catch (error) {
          enqueue(
            encodeSSE('message_complete', {
              error: 'chat_error',
              message: error instanceof Error ? error.message : 'Unknown error',
            }),
          )
        }

        enqueue(encodeSSE('done', {}))
        controller.close()
      },

      cancel() {
        isAborted = true
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  return { POST }
}
