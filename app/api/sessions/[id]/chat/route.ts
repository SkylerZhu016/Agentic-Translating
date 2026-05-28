// ---------------------------------------------------------------------------
// Chat SSE Route — POST /api/sessions/:id/chat
// Wave 3 Task 19 — 聊天 SSE 路由（工具循环 + 版本落库）
//
// POST {message, selection?:{text,start,end}} →
//   - Guard: state∈{assembled,refining}→409
//   - Context: buildChatContext(最新版本全文+最近20轮)
//   - Model: snapshot coordinator.chat_model(缺省=coordinator.model)
//   - SSE: C1 chat events (message_start/delta/tool_call/tool_result/message_complete/done)
//   - Persist: user msg first; assistant after(content+tool_calls); edited→final_versions(source='edit')+version_id
// ---------------------------------------------------------------------------

export const runtime = 'nodejs'

import { NextRequest } from 'next/server'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createChatHandlers } from '@/src/lib/handlers/chat-handler'

// ── Lazy singleton — 构建期不触库；首次请求时迁移 + 初始化 ─────────
let _handlers: ReturnType<typeof createChatHandlers> | null = null
function prod(): ReturnType<typeof createChatHandlers> {
  if (!_handlers) {
    const db = getDb()
    migrate(db)
    _handlers = createChatHandlers(db)
  }
  return _handlers
}

export const POST = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => prod().POST(req, ctx)
