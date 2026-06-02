// ---------------------------------------------------------------------------
// Chat SSE Route Handler Factory — re-export from canonical co-located handler
//
// This file exists for testability — tests import createChatHandlers without
// triggering production-side getDb() call. The canonical implementation lives
// at app/api/sessions/[id]/chat/handlers.ts.
// ---------------------------------------------------------------------------

export { createHandlers as createChatHandlers } from '@/app/api/sessions/[id]/chat/handlers'
