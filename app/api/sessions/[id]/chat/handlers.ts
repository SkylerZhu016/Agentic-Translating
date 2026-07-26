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
import { createHash, randomUUID } from 'crypto'
import { buildDiffSpans } from '@/src/lib/editing/diff-spans'
import { decryptSecret } from '@/src/lib/security/secrets'

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

export function expectedStrictReplacement(
  message: string,
  currentText: string,
): string | null {
  const strictScope =
    /(?:只|仅|其余.{0,8}不变|其他.{0,8}不变|\bonly\b|leave .{0,24} unchanged)/iu
  const replacementIntent = /(?:改为|替换为|换成|\breplace\b.{0,80}\bwith\b)/iu
  if (!strictScope.test(message) || !replacementIntent.test(message)) {
    return null
  }
  const quoted = [
    ...message.matchAll(/[“"]([^”"]+)[”"]/gu),
  ].map((match) => match[1])
  if (quoted.length !== 2) return null
  const [oldText, newText] = quoted
  const first = currentText.indexOf(oldText)
  if (
    first < 0 ||
    currentText.indexOf(oldText, first + oldText.length) >= 0
  ) {
    return null
  }
  return (
    currentText.slice(0, first) +
    newText +
    currentText.slice(first + oldText.length)
  )
}

function resolveChatConfig(snapshot: ConfigSnapshot): {
  baseUrl: string
  chatCompletionsPath?: string
  apiKey: string
  model: string
} | null {
  const editingBinding = snapshot.modelBindings?.editingAgent
  if (editingBinding?.model) {
    const endpoint = snapshot.endpointSnapshots?.find(
      (candidate) => candidate.id === editingBinding.endpointId,
    )
    if (endpoint) {
      return {
        baseUrl: endpoint.baseUrl,
        chatCompletionsPath:
          endpoint.chatCompletionsPath ?? '/v1/chat/completions',
        apiKey: decryptSecret(endpoint.apiKey),
        model: editingBinding.model,
      }
    }
  }
  const coordinator = snapshot.coordinator
  if (!coordinator) return null

  const endpointConfig =
    snapshot.endpoints?.find(
      (endpoint) => endpoint.id === coordinator.chat_endpoint_id,
    ) ??
    snapshot.endpoints?.find(
      (endpoint) => endpoint.id === coordinator.endpoint_id,
    ) ??
    snapshot.endpoint
  if (!endpointConfig) return null

  const model = coordinator.chat_model || coordinator.model
  if (!model) return null

  return {
    baseUrl: endpointConfig.base_url,
    chatCompletionsPath:
      endpointConfig.chat_completions_path ?? '/v1/chat/completions',
    apiKey: decryptSecret(endpointConfig.api_key),
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

    // 5. Get current text
    const latestVersion = repos.finalVersions.getLatestBySession(sessionId)
    const currentText = latestVersion?.text ?? ''

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
    // Read history only after persisting this turn so the model always receives
    // the current instruction as the latest user message.
    const recentMessages = repos.chatMessages.listBySession(sessionId)

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
    if (snapshot.promptBundleSnapshot) {
      const bundle = snapshot.promptBundleSnapshot
      contextMessages[0].content =
        `${bundle.editingPrompt}\n\n` +
        (bundle.promptLanguage === 'en'
          ? `Current complete translation:\n${currentText}\n\nAvailable editing tool: replace_text. Every textual change must use the tool.`
          : `当前最新完整译文：\n${currentText}\n\n可用编辑工具：replace_text。任何文本修改都必须调用工具。`)
    }

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
        const appliedToolCalls: Array<{
          old_string: string
          new_string: string
        }> = []

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
                if (
                  name === 'replace_text' &&
                  typeof args.old_string === 'string' &&
                  typeof args.new_string === 'string'
                ) {
                  appliedToolCalls.push({
                    old_string: args.old_string,
                    new_string: args.new_string,
                  })
                }
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
            const strictReplacement = expectedStrictReplacement(
              body.message,
              currentText,
            )
            if (
              result.kind === 'edited' &&
              strictReplacement != null &&
              (
                appliedToolCalls.length !== 1 ||
                result.newText !== strictReplacement
              )
            ) {
              throw new Error(
                '编辑 Agent 超出了用户明确指定的单处修改范围，正文未发生变化',
              )
            }
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
                if (!latest || latestVersion?.id !== latest.id) {
                  throw new Error('版本已发生变化，请基于最新版本重新修改')
                }
                const hasPatchTable = Boolean(
                  db.prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='text_patches'",
                  ).get(),
                )
                let versionNo = latest.version_no
                if (hasPatchTable) {
                  if (appliedToolCalls.length === 0) {
                    throw new Error('编辑结果缺少 replace_text 工具证据')
                  }
                  let workingText = currentText
                  let baseVersionId = latest.id
                  for (const edit of appliedToolCalls) {
                    const first = workingText.indexOf(edit.old_string)
                    const second =
                      first < 0
                        ? -1
                        : workingText.indexOf(
                            edit.old_string,
                            first + edit.old_string.length,
                          )
                    if (first < 0 || second >= 0) {
                      throw new Error(
                        first < 0
                          ? 'oldText 不存在，未修改正文'
                          : 'oldText 不唯一，未修改正文',
                      )
                    }
                    const nextText =
                      workingText.slice(0, first) +
                      edit.new_string +
                      workingText.slice(first + edit.old_string.length)
                    const patchId = randomUUID()
                    versionNo += 1
                    const hash = createHash('sha256')
                      .update(nextText)
                      .digest('hex')
                    const vResult = db.prepare(`
                      INSERT INTO final_versions
                        (session_id, version_no, text, source, parent_version_id,
                         content_hash, created_by_patch_id)
                      VALUES (?, ?, ?, 'edit', ?, ?, ?)
                    `).run(
                      sessionId,
                      versionNo,
                      nextText,
                      baseVersionId,
                      hash,
                      patchId,
                    )
                    const resultVersionId = Number(vResult.lastInsertRowid)
                    db.prepare(`
                      INSERT INTO text_patches
                        (id, session_id, base_version_id, result_version_id,
                         old_text, new_text, reason, evidence_refs_json,
                         diff_spans_json)
                      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)
                    `).run(
                      patchId,
                      sessionId,
                      baseVersionId,
                      resultVersionId,
                      edit.old_string,
                      edit.new_string,
                      body.message,
                      JSON.stringify(
                        buildDiffSpans(edit.old_string, edit.new_string),
                      ),
                    )
                    workingText = nextText
                    baseVersionId = resultVersionId
                    versionId = resultVersionId
                    enqueue(
                      encodeSSE('patch.applied', {
                        patch_id: patchId,
                        version_no: versionNo,
                        old_text: edit.old_string,
                        new_text: edit.new_string,
                      }),
                    )
                  }
                  if (workingText !== result.newText) {
                    throw new Error('工具调用结果与模型返回文本不一致，未提交版本')
                  }
                  db.prepare(
                    "UPDATE sessions SET final_version_id=?, updated_at=datetime('now') WHERE id=?",
                  ).run(versionId, sessionId)
                } else {
                  versionNo += 1
                  const vResult = repos.finalVersions.insert({
                    session_id: sessionId,
                    version_no: versionNo,
                    text: result.newText,
                    source: 'edit',
                  })
                  versionId = vResult.lastInsertRowid as number
                }

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
                tool_calls:
                  appliedToolCalls.length > 0
                    ? JSON.stringify(appliedToolCalls)
                    : null,
                tool_results:
                  versionId != null
                    ? JSON.stringify({ versionId })
                    : null,
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
