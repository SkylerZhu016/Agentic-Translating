import { createHash, randomUUID } from 'crypto'
import path from 'path'
import type Database from 'better-sqlite3'
import type {
  BuiltinDirection,
  WorkflowPresetContract,
} from '../contracts/vnext'
import { createRepositories } from '../db/repositories'
import { createSessionService } from '../services/session-service'
import { startVNextRun } from '../orchestration/vnext-runner'

export interface BatchInputFile {
  relativePath: string
  sourceText: string
  originalLineEnding: 'lf' | 'crlf'
  hadBom: boolean
}

const DEVICE_NAME = /(^|\/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|\/|$)/i
const batchTasks = new Map<string, Promise<void>>()

export function assertSafeRelativePath(relativePath: string) {
  const unix = relativePath.replace(/\\/g, '/')
  if (
    !unix ||
    unix.startsWith('/') ||
    /^[a-zA-Z]:/.test(unix) ||
    unix.split('/').includes('..') ||
    path.posix.normalize(unix) !== unix ||
    DEVICE_NAME.test(unix)
  ) {
    throw new Error(`非法相对路径：${relativePath}`)
  }
  const extension = path.posix.extname(unix).toLowerCase()
  if (extension !== '.txt' && extension !== '.md') {
    throw new Error(`仅支持 .txt 与 .md：${relativePath}`)
  }
}

export function createBatch(
  db: Database.Database,
  input: {
    name: string
    direction: BuiltinDirection
    presetRevisionId: string
    presetSnapshot: WorkflowPresetContract
    concurrency: number
    files: BatchInputFile[]
  },
) {
  if (input.files.length === 0 || input.files.length > 500) {
    throw new Error('批量文件数量必须在 1—500 之间')
  }
  if (input.concurrency < 1 || input.concurrency > 4) {
    throw new Error('批量并发必须在 1—4 之间')
  }
  const seen = new Set<string>()
  for (const file of input.files) {
    assertSafeRelativePath(file.relativePath)
    if (seen.has(file.relativePath)) {
      throw new Error(`重复路径：${file.relativePath}`)
    }
    seen.add(file.relativePath)
    if (Buffer.byteLength(file.sourceText, 'utf8') > 5 * 1024 * 1024) {
      throw new Error(`文件超过 5 MiB：${file.relativePath}`)
    }
  }
  const id = randomUUID()
  db.transaction(() => {
    db.prepare(`
      INSERT INTO batch_jobs
        (id, name, direction, preset_revision_id, preset_snapshot, status,
         concurrency, total_count)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      id,
      input.name,
      input.direction,
      input.presetRevisionId,
      JSON.stringify(input.presetSnapshot),
      input.concurrency,
      input.files.length,
    )
    const insert = db.prepare(`
      INSERT INTO batch_items
        (id, batch_id, relative_path, source_hash, source_text,
         original_line_ending, had_bom, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
    `)
    for (const file of input.files) {
      insert.run(
        randomUUID(),
        id,
        file.relativePath,
        createHash('sha256').update(file.sourceText).digest('hex'),
        file.sourceText,
        file.originalLineEnding,
        file.hadBom ? 1 : 0,
      )
    }
  })()
  startBatch(db, id)
  return id
}

function templateTask(
  template: string,
  relativePath: string,
) {
  return template
    .replaceAll('{{file_name}}', path.posix.basename(relativePath))
    .replaceAll('{{relative_path}}', relativePath)
}

async function runItem(
  db: Database.Database,
  job: {
    id: string
    direction: BuiltinDirection
    preset_revision_id: string
    preset_snapshot: string
  },
  item: {
    id: string
    relative_path: string
    source_text: string
    attempt: number
  },
) {
  const contract = JSON.parse(job.preset_snapshot) as WorkflowPresetContract
  db.prepare(`
    UPDATE batch_items
    SET status='running', attempt=attempt+1, error=NULL,
        updated_at=datetime('now')
    WHERE id=?
  `).run(item.id)
  try {
    const repos = createRepositories(db)
    const service = createSessionService(db, repos)
    const session = service.createSession({
      sourceText: item.source_text,
      sourceLang: contract.sourceLang,
      targetLang: contract.targetLang,
      direction: job.direction,
      taskBrief: templateTask(
        contract.taskBriefTemplate,
        item.relative_path,
      ),
      reviewMode: contract.reviewMode,
      presetRevisionId: job.preset_revision_id,
      allowedAgentVariantIds: contract.agentVariantIds,
      constraints: contract.constraints,
    })
    db.prepare(
      'UPDATE sessions SET batch_item_id=? WHERE id=?',
    ).run(item.id, session.id)
    db.prepare(
      'UPDATE batch_items SET session_id=? WHERE id=?',
    ).run(session.id, item.id)
    const { runId } = startVNextRun(db, session.id)
    for (;;) {
      const run = db.prepare(
        'SELECT status, error FROM orchestration_runs WHERE id=?',
      ).get(runId) as { status: string; error: string | null }
      if (run.status === 'complete') {
        db.prepare(`
          UPDATE batch_items
          SET status='completed', updated_at=datetime('now')
          WHERE id=?
        `).run(item.id)
        break
      }
      if (['failed', 'interrupted', 'cancelled'].includes(run.status)) {
        db.prepare(`
          UPDATE batch_items
          SET status='failed', error=?, updated_at=datetime('now')
          WHERE id=?
        `).run(run.error ?? `Run ${run.status}`, item.id)
        if (/auth|api.?key|401/i.test(run.error ?? '')) {
          db.prepare(`
            UPDATE batch_jobs
            SET status='paused', error=?, updated_at=datetime('now')
            WHERE id=?
          `).run(run.error, job.id)
        }
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  } catch (error) {
    db.prepare(`
      UPDATE batch_items
      SET status='failed', error=?, updated_at=datetime('now')
      WHERE id=?
    `).run(error instanceof Error ? error.message : String(error), item.id)
  }
}

function updateCounts(db: Database.Database, batchId: string) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running
    FROM batch_items WHERE batch_id=?
  `).get(batchId) as {
    completed: number
    failed: number
    queued: number
    running: number
  }
  db.prepare(`
    UPDATE batch_jobs
    SET completed_count=?, failed_count=?, updated_at=datetime('now')
    WHERE id=?
  `).run(counts.completed ?? 0, counts.failed ?? 0, batchId)
  return counts
}

async function executeBatch(db: Database.Database, batchId: string) {
  const active = new Set<Promise<void>>()
  try {
    db.prepare(`
      UPDATE batch_jobs SET status='running', error=NULL,
        updated_at=datetime('now')
      WHERE id=? AND status IN ('queued','paused','failed')
    `).run(batchId)
    for (;;) {
      const job = db.prepare(
        'SELECT * FROM batch_jobs WHERE id=?',
      ).get(batchId) as {
        id: string
        direction: BuiltinDirection
        preset_revision_id: string
        preset_snapshot: string
        status: string
        concurrency: number
      } | undefined
      if (!job) break
      if (job.status === 'cancelled') break
      if (job.status === 'paused') {
        if (active.size > 0) await Promise.allSettled(active)
        break
      }
      while (active.size < job.concurrency) {
        const item = db.prepare(`
          SELECT * FROM batch_items
          WHERE batch_id=? AND status='queued'
          ORDER BY created_at, id LIMIT 1
        `).get(batchId) as {
          id: string
          relative_path: string
          source_text: string
          attempt: number
        } | undefined
        if (!item) break
        const task = runItem(db, job, item).finally(() => active.delete(task))
        active.add(task)
      }
      const counts = updateCounts(db, batchId)
      if ((counts.queued ?? 0) === 0 && active.size === 0) {
        db.prepare(`
          UPDATE batch_jobs
          SET status=CASE WHEN failed_count>0 THEN 'failed' ELSE 'completed' END,
              updated_at=datetime('now')
          WHERE id=? AND status='running'
        `).run(batchId)
        break
      }
      if (active.size > 0) await Promise.race(active)
      else await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } finally {
    updateCounts(db, batchId)
    batchTasks.delete(batchId)
  }
}

export function startBatch(db: Database.Database, batchId: string) {
  if (batchTasks.has(batchId)) return
  const task = executeBatch(db, batchId)
  batchTasks.set(batchId, task)
  void task
}
