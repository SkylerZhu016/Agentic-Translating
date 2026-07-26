export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createPromptBundleFamiliesRepo } from '@/src/lib/db/release-config-repositories'

const payloadSchema = z.object({
  direction: z.enum(['en_to_zh', 'zh_to_en', 'custom']),
  version: z.number().int().positive(),
  promptLanguage: z.enum(['zh', 'en']),
  mainAgentSystemPrompt: z.string().min(1),
  workerBasePrompt: z.string().min(1),
  reviewPrompt: z.string().min(1),
  filterPrompt: z.string().min(1),
  orchestratePrompt: z.string().min(1),
  assemblePrompt: z.string().min(1),
  editingPrompt: z.string().min(1),
  toolDescriptions: z.record(z.string(), z.string()),
})

function repo() {
  const db = getDb()
  migrate(db)
  return createPromptBundleFamiliesRepo(db)
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const parsed = payloadSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 })
  const updated = repo().createRevision((await params).id, parsed.data)
  return updated
    ? Response.json(updated)
    : Response.json({ error: 'bundle_not_found_or_read_only' }, { status: 404 })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const result = repo().softDelete((await params).id)
  return result.changes
    ? Response.json({ success: true })
    : Response.json({ error: 'bundle_not_found_or_read_only' }, { status: 404 })
}
