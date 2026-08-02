import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [candidateInput, reviewInput, outputInput] = process.argv.slice(2)
if (!candidateInput || !reviewInput || !outputInput) {
  throw new Error(
    'Usage: node scripts/promote-fsbp-candidates.mjs <candidates.jsonl> <reviews.jsonl> <output.jsonl>',
  )
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  const records = text
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
  return { records, text }
}

const candidatePath = path.resolve(candidateInput)
const reviewPath = path.resolve(reviewInput)
const outputPath = path.resolve(outputInput)
const candidates = await readJsonl(candidatePath)
const reviews = await readJsonl(reviewPath)
const currentOutput = await readFile(outputPath, 'utf8')

if (currentOutput.trim()) {
  throw new Error(
    `Refusing to overwrite non-empty formal dataset: ${outputPath}`,
  )
}

const reviewById = new Map(
  reviews.records.map((record) => [record.sampleId, record]),
)
for (const candidate of candidates.records) {
  const review = reviewById.get(candidate.id)
  if (!review) {
    throw new Error(`Missing review for ${candidate.id}`)
  }
  if (review.humanReview?.status !== 'reviewed') {
    throw new Error(`Candidate is not fully reviewed: ${candidate.id}`)
  }
}
if (candidates.records.length !== reviews.records.length) {
  throw new Error(
    `Count mismatch: ${candidates.records.length} candidates, ${reviews.records.length} reviews`,
  )
}

await writeFile(
  outputPath,
  `${candidates.records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  'utf8',
)
process.stdout.write(
  `Promoted ${candidates.records.length} reviewed candidates to ${outputPath}\n`,
)
