import type Database from 'better-sqlite3'
import { NextResponse } from 'next/server'
import { createLlmCallRecordsService } from '@/src/lib/services/llm-call-records-service'

export function createHandlers(db: Database.Database) {
  const service = createLlmCallRecordsService(db)

  return {
    async GET() {
      // The service returns aggregate, allowlisted fields only. No raw call
      // row, prompt, source text, endpoint URL or credential crosses this API.
      return NextResponse.json(service.overview(), { status: 200 })
    },
  }
}
