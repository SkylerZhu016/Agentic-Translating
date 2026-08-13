import { NextResponse } from 'next/server'
import type { ConfigSnapshot } from '@/src/lib/contracts/types'
import { getDb } from '@/src/lib/db'
import { createRepositories } from '@/src/lib/db/repositories'
import { resolveChatConfig } from '../chat/handlers'
import { generateRevisionSuggestion } from '@/src/lib/chat/revision-suggestions'
import { sessionProjectContextBlock } from '@/src/lib/projects/session-context'
import {
  logSafeDiagnostic,
  publicDiagnosticError,
} from '@/src/lib/security/diagnostic-error'

function inferRevisionPromptLanguage(params: {
  snapshot: ConfigSnapshot
  direction?: string
  targetLang: string
}): 'zh' | 'en' {
  const frozenLanguage = params.snapshot.promptBundleSnapshot?.promptLanguage
  if (frozenLanguage === 'zh' || frozenLanguage === 'en') {
    return frozenLanguage
  }
  if (params.direction === 'en_to_zh') return 'zh'
  if (params.direction === 'zh_to_en') return 'en'

  const target = params.targetLang.trim().toLowerCase()
  return /^(?:zh(?:-cn|-hans)?|chinese|中文|简体中文)$/.test(target)
    ? 'zh'
    : 'en'
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db = getDb()
  const repos = createRepositories(db)
  const session = repos.sessions.getById(id)
  if (!session) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 })
  }

  let body: { message?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  if (typeof body.message !== 'string' || !body.message.trim()) {
    return NextResponse.json({ error: 'message_required' }, { status: 400 })
  }

  const latest = repos.finalVersions.getLatestBySession(id)
  if (!latest?.text.trim()) {
    return NextResponse.json({ error: 'final_version_required' }, { status: 409 })
  }

  let snapshot: ConfigSnapshot
  try {
    snapshot = JSON.parse(session.config_snapshot) as ConfigSnapshot
  } catch {
    return NextResponse.json({ error: 'invalid_snapshot' }, { status: 500 })
  }
  const config = resolveChatConfig(snapshot)
  if (!config) {
    return NextResponse.json({ error: 'no_chat_config' }, { status: 400 })
  }

  const promptLanguage = inferRevisionPromptLanguage({
    snapshot,
    direction: session.direction,
    targetLang: session.target_lang,
  })
  const projectContext = sessionProjectContextBlock(db, id, promptLanguage)
  const taskBrief = session.task_brief ?? ''

  try {
    const result = await generateRevisionSuggestion({
      endpoint: {
        baseUrl: config.baseUrl,
        chatCompletionsPath: config.chatCompletionsPath,
        apiKey: config.apiKey,
      },
      model: config.model,
      promptLanguage,
      sourceText: session.source_text,
      taskBrief: projectContext
        ? `${taskBrief || (promptLanguage === 'zh' ? '无' : 'None')}\n\n${projectContext}`
        : taskBrief,
      currentTranslation: latest.text,
      userRequest: body.message.trim(),
      ledger: {
        db,
        sessionId: id,
        endpointId: config.endpointId,
      },
    })
    return NextResponse.json(result)
  } catch (error) {
    const diagnostic = publicDiagnosticError('suggestion_failed')
    logSafeDiagnostic({
      scope: 'chat.revision_suggestion',
      diagnosticId: diagnostic.diagnosticId,
      cause: error,
    })
    return NextResponse.json(
      {
        ...diagnostic,
        message: '生成修订建议失败，请稍后重试。',
      },
      { status: 502 },
    )
  }
}
