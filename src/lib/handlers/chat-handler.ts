// ---------------------------------------------------------------------------
// Chat SSE Route Handler Factory — re-export from canonical co-located handler
//
// This file exists for testability — tests import createChatHandlers without
// triggering production-side getDb() call. The canonical implementation lives
// at app/api/sessions/[id]/chat/handlers.ts (Wave 3 Task 19).
// ---------------------------------------------------------------------------

export {
  buildRevisionReferenceMessage,
  createHandlers as createChatHandlers,
  resolveChatConfig,
  resolveChatReviewConfig,
} from '@/app/api/sessions/[id]/chat/handlers'
