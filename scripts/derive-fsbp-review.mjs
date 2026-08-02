import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [markdownInput, candidatesInput, outputInput] = process.argv.slice(2)
if (!markdownInput || !candidatesInput || !outputInput) {
  throw new Error(
    'Usage: node scripts/derive-fsbp-review.mjs <review.md> <candidates.jsonl> <output.jsonl>',
  )
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(
          `${path.basename(filePath)}:${index + 1}: ${error.message}`,
        )
      }
    })
}

function parseFields(annotation, sampleId) {
  const fieldPattern =
    /^- (状态|已确认问题|对预审风险点的修正|其他问题|严重度|备注)：(.*)$/gm
  const matches = [...annotation.matchAll(fieldPattern)]
  if (matches.length === 0) {
    throw new Error(`No human review fields found for ${sampleId}`)
  }

  const fields = {}
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length
    const end = matches[index + 1]?.index ?? annotation.length
    const continuation = annotation.slice(start, end).trim()
    fields[match[1]] = [match[2].trim(), continuation]
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return fields
}

const reviewPath = path.resolve(markdownInput)
const candidatesPath = path.resolve(candidatesInput)
const outputPath = path.resolve(outputInput)
const markdown = await readFile(reviewPath, 'utf8')
const candidates = await readJsonl(candidatesPath)
const candidateById = new Map(candidates.map((sample) => [sample.id, sample]))
const sections = markdown
  .split(/(?=^## \d+\. )/m)
  .slice(1)

const records = sections.map((section) => {
  const heading = section.match(/^## \d+\. ([^\r\n]+)/)
  if (!heading) throw new Error('Could not parse a numbered review heading.')
  const sampleId = heading[1].trim()
  if (!candidateById.has(sampleId)) {
    throw new Error(`Review references unknown candidate: ${sampleId}`)
  }

  const annotationMatch = section.match(
    /^### 人工标注\s*([\s\S]*?)(?=^---\s*$|\s*$)/m,
  )
  if (!annotationMatch) {
    throw new Error(`Missing human annotation block for ${sampleId}`)
  }
  const fields = parseFields(annotationMatch[1].trim(), sampleId)
  if (fields.状态 !== '已审') {
    throw new Error(`Review is not complete for ${sampleId}: ${fields.状态}`)
  }

  const overallAssessment = [
    fields.已确认问题,
    fields.对预审风险点的修正,
    fields.其他问题,
    fields.备注,
  ]
    .filter((value) => value && value !== '无')
    .join('\n\n')

  return {
    sampleId,
    reviewStatus: 'reviewed',
    reviewerType: 'internal-human',
    reviewerCount: 1,
    evaluationUse: 'locked-test-only',
    preflightAssessment: fields.对预审风险点的修正 ?? '',
    confirmedIssueNotes: fields.已确认问题 ?? '',
    additionalIssueNotes: fields.其他问题 ?? '',
    severityLabel: fields.严重度 ?? '',
    notes: fields.备注 ?? '',
    overallAssessment,
    rawHumanAnnotation: annotationMatch[1].trim(),
  }
})

if (records.length !== candidates.length) {
  throw new Error(
    `Review count mismatch: ${records.length} reviews for ${candidates.length} candidates`,
  )
}
if (new Set(records.map((record) => record.sampleId)).size !== records.length) {
  throw new Error('Duplicate sample ID in human review Markdown.')
}

await writeFile(
  outputPath,
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  'utf8',
)
process.stdout.write(`Derived ${records.length} human review records.\n`)
