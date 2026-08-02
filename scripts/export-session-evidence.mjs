import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const args = process.argv.slice(2)
const valueAfter = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : null
}

const sessionId = valueAfter('--session')
const outputDir = path.resolve(
  valueAfter('--out') ?? '迭代文档/第二轮迭代材料',
)
const dbPath = path.resolve(valueAfter('--db') ?? 'data/app.db')

if (!sessionId) {
  throw new Error('Usage: node scripts/export-session-evidence.mjs --session <uuid> [--out <dir>]')
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, child] of Object.entries(value)) {
      if (
        /^(api_?key|secret|authorization|encrypted_?key)$/i.test(key)
      ) {
        continue
      }
      result[key] = redact(child)
    }
    return result
  }
  return value
}

function tableExists(db, name) {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name),
  )
}

function allForSession(db, table, orderBy = 'created_at, rowid') {
  if (!tableExists(db, table)) return []
  return db.prepare(
    `SELECT * FROM ${table} WHERE session_id=? ORDER BY ${orderBy}`,
  ).all(sessionId)
}

const db = new Database(dbPath, { readonly: true })
const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId)
if (!session) {
  db.close()
  throw new Error(`Session not found: ${sessionId}`)
}

const invocations = allForSession(db, 'agent_invocations').map((row) => ({
  ...row,
  agent_snapshot: parseJson(row.agent_snapshot, row.agent_snapshot),
  usage_json: parseJson(row.usage_json, row.usage_json),
  binding_snapshot_json: parseJson(
    row.binding_snapshot_json,
    row.binding_snapshot_json,
  ),
}))
const stages = allForSession(db, 'stage_outputs', 'id')
const versions = allForSession(db, 'final_versions', 'version_no, id')
const patches = allForSession(db, 'text_patches')
const messages = allForSession(db, 'chat_messages', 'id')
const runs = allForSession(db, 'orchestration_runs')
const events = allForSession(db, 'run_events', 'id').map((row) => ({
  ...row,
  payload_json: parseJson(row.payload_json, row.payload_json),
}))
const runControl = tableExists(db, 'session_run_controls')
  ? db.prepare(
      'SELECT * FROM session_run_controls WHERE session_id=?',
    ).get(sessionId) ?? null
  : null

db.close()

const configSnapshot = parseJson(session.config_snapshot, {})
const evidence = redact({
  exportedAt: new Date().toISOString(),
  database: path.basename(dbPath),
  session: {
    ...session,
    config_snapshot: undefined,
    source_sha256: crypto
      .createHash('sha256')
      .update(session.source_text)
      .digest('hex'),
  },
  configSnapshot,
  runs,
  invocations,
  stages,
  versions,
  patches,
  messages,
  events,
  runControl,
})

const basename = `session-${sessionId}`
fs.mkdirSync(outputDir, { recursive: true })
const jsonPath = path.join(outputDir, `${basename}.json`)
const markdownPath = path.join(outputDir, `${basename}.md`)
fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

const lines = [
  '# 第二轮迭代真实会话证据',
  '',
  `- 会话 ID：${sessionId}`,
  `- 状态：${session.state}`,
  `- 方向：${session.direction ?? 'unknown'}`,
  `- 审议方式：${session.review_mode ?? 'unknown'}`,
  `- 最终版本 ID：${session.final_version_id ?? '无'}`,
  `- 原文 SHA-256：${evidence.session.source_sha256}`,
  `- 导出时间：${evidence.exportedAt}`,
  '',
  '## 任务要求',
  '',
  session.task_brief || '无',
  '',
  '## 原文',
  '',
  session.source_text,
  '',
  '## 运行记录',
  '',
]

for (const run of runs) {
  lines.push(
    `### ${run.id}`,
    '',
    `- 类型：${run.kind}`,
    `- 状态：${run.status}`,
    `- 阶段：${run.phase}`,
    `- 开始：${run.started_at ?? '无'}`,
    `- 完成：${run.completed_at ?? '无'}`,
    `- 错误：${run.error ?? '无'}`,
    '',
  )
}

lines.push('## Agent 调用', '')
for (const invocation of invocations) {
  const snapshot =
    invocation.agent_snapshot &&
    typeof invocation.agent_snapshot === 'object'
      ? invocation.agent_snapshot
      : {}
  lines.push(
    `### ${snapshot.catalogName ?? invocation.agent_variant_id}`,
    '',
    `- 调用 ID：${invocation.id}`,
    `- 模型：${invocation.model}`,
    `- 状态：${invocation.status}`,
    `- 耗时：${invocation.latency_ms ?? '无'} ms`,
    `- 选择理由：${invocation.selection_reason || '无'}`,
    `- 错误：${invocation.error ?? '无'}`,
    '',
    '#### 正文',
    '',
    invocation.body_output ?? '',
    '',
    '#### 注释',
    '',
    invocation.annotation_output ?? '无',
    '',
  )
}

lines.push('## 四阶段', '')
for (const stage of stages) {
  lines.push(
    `### ${stage.stage}`,
    '',
    `- 状态：${stage.status}`,
    `- 错误：${stage.error ?? '无'}`,
    '',
    stage.raw_output ?? '',
    '',
  )
}

lines.push('## 版本历史', '')
for (const version of versions) {
  lines.push(
    `### v${version.version_no} · ${version.source}`,
    '',
    version.text,
    '',
  )
}

fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8')
console.log(JSON.stringify({
  sessionId,
  jsonPath,
  markdownPath,
  invocations: invocations.length,
  stages: stages.length,
  versions: versions.length,
  runs: runs.length,
}, null, 2))
