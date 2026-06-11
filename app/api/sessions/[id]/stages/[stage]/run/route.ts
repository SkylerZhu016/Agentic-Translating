// ---------------------------------------------------------------------------
// POST /api/sessions/[id]/stages/[stage]/run — 单阶段 SSE 路由 (Wave 3 Task 18)
// ---------------------------------------------------------------------------
// 守卫 → 快照 → runStage → C1 SSE 事件 → 落库 + stale 联动 + 版本生成
//
// Route module 仅导出 HTTP verb + runtime config；逻辑位于 ./handlers.ts
// ---------------------------------------------------------------------------

export const runtime = 'nodejs'

import { getDb } from '@/src/lib/db'
import { createHandlers } from './handlers'

// ── Lazy singleton — 构建期不触库；首次请求时初始化 ─────────────────
let _handlers: ReturnType<typeof createHandlers> | null = null
function prod(): ReturnType<typeof createHandlers> {
  if (!_handlers) _handlers = createHandlers(getDb())
  return _handlers
}

export const POST = (
  req: Request,
  ctx: { params: Promise<{ id: string; stage: string }> },
): Promise<Response> => prod().POST(req, ctx)
