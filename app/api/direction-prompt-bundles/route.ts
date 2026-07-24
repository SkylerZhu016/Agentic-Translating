export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/src/lib/db'
import { migrate } from '@/src/lib/db/migrate'
import { seed } from '@/src/lib/db/seed'
import { createVNextRepositories } from '@/src/lib/db/vnext-repositories'

const customBundleSchema = z.object({
  promptLanguage: z.enum(['zh', 'en']),
  mainAgentSystemPrompt: z.string().min(1),
  workerBasePrompt: z.string().min(1),
  reviewPrompt: z.string().min(1),
  filterPrompt: z.string().min(1),
  orchestratePrompt: z.string().min(1),
  assemblePrompt: z.string().min(1),
  editingPrompt: z.string().min(1),
  toolDescriptions: z.object({
    call_agents: z.string().min(1),
    write_draft: z.string().min(1),
    replace_text: z.string().min(1),
    submit_final: z.string().min(1),
  }),
})

function repository() {
  const db = getDb()
  migrate(db)
  seed(db)
  return createVNextRepositories(db).directionPrompts
}

export async function GET(request: NextRequest) {
  const direction = request.nextUrl.searchParams.get('direction') ?? 'custom'
  if (!['en_to_zh', 'zh_to_en', 'custom'].includes(direction)) {
    return NextResponse.json({ error: 'invalid_direction' }, { status: 400 })
  }
  const bundle = repository().getLatest(
    direction as 'en_to_zh' | 'zh_to_en' | 'custom',
  )
  return bundle
    ? NextResponse.json(bundle)
    : NextResponse.json({ error: 'not_found' }, { status: 404 })
}

export async function POST(request: NextRequest) {
  const parsed = customBundleSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  return NextResponse.json(repository().createCustom(parsed.data), {
    status: 201,
  })
}
