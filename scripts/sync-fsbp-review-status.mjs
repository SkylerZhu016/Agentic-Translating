import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [translationsInput, derivedInput] = process.argv.slice(2)
if (!translationsInput || !derivedInput) {
  throw new Error(
    'Usage: node scripts/sync-fsbp-review-status.mjs <translations.jsonl> <derived-review.jsonl>',
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

const translationsPath = path.resolve(translationsInput)
const derivedPath = path.resolve(derivedInput)
const translations = await readJsonl(translationsPath)
const derived = await readJsonl(derivedPath)
const reviews = new Map(derived.map((record) => [record.sampleId, record]))

const output = translations.map((translation) => {
  const review = reviews.get(translation.sampleId)
  if (!review) {
    throw new Error(`Missing derived review for ${translation.sampleId}`)
  }
  return {
    ...translation,
    humanReview: {
      status: review.reviewStatus,
      issues: [],
      notes: review.overallAssessment,
      derivedReviewFile: path.basename(derivedPath),
    },
  }
})

if (output.length !== derived.length) {
  throw new Error(
    `Review count mismatch: ${output.length} translations, ${derived.length} reviews`,
  )
}

await writeFile(
  translationsPath,
  `${output.map((record) => JSON.stringify(record)).join('\n')}\n`,
  'utf8',
)
process.stdout.write(`Synchronized ${output.length} review statuses.\n`)
