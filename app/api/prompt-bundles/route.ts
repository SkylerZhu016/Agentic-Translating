export const runtime = 'nodejs'

import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { createPromptBundleFamiliesRepo } from '@/src/lib/db/release-config-repositories'

const directionSchema = z.enum(['en_to_zh', 'zh_to_en', 'custom'])
const bundleSchema = z.object({
  direction: directionSchema,
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
const createSchema = z.object({
  name: z.string().min(1),
  direction: directionSchema,
  payload: bundleSchema,
})

function repo() {
  const db = getDb()
  migrate(db)
  return createPromptBundleFamiliesRepo(db)
}

export async function GET(request: Request) {
  const value = new URL(request.url).searchParams.get('direction')
  const direction = value ? directionSchema.safeParse(value) : null
  if (direction && !direction.success) {
    return Response.json({ error: 'invalid_direction' }, { status: 400 })
  }
  return Response.json(repo().list(direction?.data))
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 })
  if (parsed.data.payload.direction !== parsed.data.direction) {
    return Response.json({ error: 'direction_mismatch' }, { status: 400 })
  }
  return Response.json(repo().create(parsed.data), { status: 201 })
}
