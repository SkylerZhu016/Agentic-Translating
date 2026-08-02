import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const [input] = process.argv.slice(2)
if (!input) {
  throw new Error(
    'Usage: node scripts/update-fsbp-content-hashes.mjs <jsonl-file>',
  )
}

const filePath = path.resolve(process.cwd(), input)
const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/)
let updated = 0

const output = lines.map((line, index) => {
  if (!line.trim()) return ''
  let record
  try {
    record = JSON.parse(line)
  } catch (error) {
    throw new Error(
      `${path.basename(filePath)}:${index + 1}: invalid JSON: ${error.message}`,
    )
  }
  if (typeof record.sourceText !== 'string' || !record.sourceText) {
    throw new Error(
      `${path.basename(filePath)}:${index + 1}: sourceText must be non-empty`,
    )
  }
  const contentHash = sha256(record.sourceText)
  if (record.contentHash !== contentHash) updated += 1
  return JSON.stringify({ ...record, contentHash })
})

await writeFile(filePath, `${output.filter(Boolean).join('\n')}\n`, 'utf8')
process.stdout.write(
  `Updated ${updated} content hash${updated === 1 ? '' : 'es'} in ${filePath}\n`,
)
