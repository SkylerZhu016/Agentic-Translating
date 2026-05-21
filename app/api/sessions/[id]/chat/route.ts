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

import { getDb } from '@/src/lib/db'
import { createChatHandlers } from '@/src/lib/handlers/chat-handler'

// ── Production export ─────────────────────────────────────────────
const db = getDb()
export const { POST } = createChatHandlers(db)
