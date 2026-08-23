import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSanitizedArtifact,
  publishReportPairAtomically,
  validateCompleteReport,
  validateJsonSchemaValue,
} from '../../scripts/materialize-round-0820-tool-evidence.mjs'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'round-0820-tool-evidence-'))
  tempDirs.push(dir)
  return dir
}

function completeBoundaryFixture(): any {
  return {
    schemaVersion: 'round-0820.tool-evidence-case-study.v1',
    reportStatus: 'complete',
    caseStudy: {
      identity: {
        configuredModelSet: ['GPT 5.6 Sol: CPA'],
        requestedModelSet: ['GPT 5.6 Sol: CPA'],
      },
      summary: {
        invocationCount: 9,
        toolTraceCount: 9,
        toolStatusCounts: { complete: 7, failed: 2 },
        failedWriteDraftBeforeSuccess: 2,
        readOnlyReviewChildCount: 2,
        bodyOnlyInspectEvidenceCount: 2,
        replaceTextVersionEdgeCount: 2,
        llmCallCount: 18,
        linkageClosure: {
          selectedRunCount: 2,
          toolToRunAndInvocationCount: 9,
          reviewParentChildCount: 2,
          invocationToLedgerCount: 9,
          runScopedLedgerCount: 15,
          sessionScopedLedgerCount: 3,
          orphanToolCount: 0,
          orphanInvocationCount: 0,
          orphanLedgerCount: 0,
        },
      },
    },
    gateMaterialization: {
      recordCount: 20,
      toolUseActuallyLocked: 0,
      supportsToolSuperiorityConclusion: false,
    },
    coverageOnly: [
      { toolName: 'search_project_memory', realObserved: false },
      { toolName: 'record_issue', realObserved: false },
      { toolName: 'propose_patch', realObserved: false },
    ],
  }
}

describe('round-0820 tool evidence materializer guards', () => {
  it('fails closed when the real-case boundary or cross-table closure weakens', () => {
    const report = completeBoundaryFixture()
    expect(() => validateCompleteReport(report)).not.toThrow()
    report.caseStudy.summary.linkageClosure.orphanLedgerCount = 1
    expect(() => validateCompleteReport(report)).toThrow('linkage closure is incomplete')
  })

  it('normalizes camel, snake, and kebab keys before rejecting sensitive additions', () => {
    const clean = completeBoundaryFixture()
    expect(() => assertSanitizedArtifact(clean, '脱敏案例', ['受保护的数据库正文']))
      .not.toThrow()
    for (const [key, value] of [
      ['apiKey', 'opaque'],
      ['api_key', 'opaque'],
      ['api-key', 'opaque'],
      ['raw_output', 'private body'],
      ['endpoint-url', 'private endpoint'],
      ['project_memory_body', 'private memory'],
    ]) {
      expect(() => assertSanitizedArtifact(
        { ...clean, nested: { [key]: value } },
        '脱敏案例',
      ), key).toThrow('forbidden report key')
    }
    expect(() => assertSanitizedArtifact(
      clean,
      's k is not accepted: sk-thisLooksLikeACredentialValue',
    )).toThrow('suspect credential or endpoint pattern')
    expect(() => assertSanitizedArtifact(
      clean,
      'h t t p s : / / example.invalid/private',
    )).toThrow('suspect credential or endpoint pattern')
    expect(() => assertSanitizedArtifact(
      clean,
      '123e4567-e89b-12d3-a456-426614174000',
    )).toThrow('unhashed UUID')
    expect(() => assertSanitizedArtifact(
      clean,
      '受保护的数据库正文',
      ['受保护的数据库正文'],
    )).toThrow('protected database text')
  })

  it('enforces nested additionalProperties=false in the runtime schema validator', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['nested'],
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          required: ['safeCount'],
          properties: { safeCount: { type: 'integer', minimum: 0 } },
        },
      },
    }
    expect(() => validateJsonSchemaValue({ nested: { safeCount: 1 } }, schema))
      .not.toThrow()
    expect(() => validateJsonSchemaValue(
      { nested: { safeCount: 1, raw_output: 'private' } },
      schema,
    )).toThrow('unexpected keys: raw_output')
  })

  it('restores the old JSON/Markdown/manifest trio after a mid-publish failure', () => {
    const dir = tempDir()
    const jsonOutput = path.join(dir, 'case.json')
    const markdownOutput = path.join(dir, 'case.md')
    const pairManifestOutput = path.join(dir, 'case.pair.json')
    writeFileSync(jsonOutput, 'OLD_JSON\n')
    writeFileSync(markdownOutput, 'OLD_MARKDOWN\n')
    writeFileSync(pairManifestOutput, 'OLD_MANIFEST\n')
    const common = {
      jsonOutput,
      markdownOutput,
      pairManifestOutput,
      jsonText: 'NEW_JSON\n',
      markdownText: 'NEW_MARKDOWN\n',
      pairManifestText: 'NEW_MANIFEST\n',
      generationId: 'a'.repeat(32),
    }
    expect(() => publishReportPairAtomically({
      ...common,
      failureInjectionStep: 'after-json-publish',
    })).toThrow('Injected publish failure')
    expect(readFileSync(jsonOutput, 'utf8')).toBe('OLD_JSON\n')
    expect(readFileSync(markdownOutput, 'utf8')).toBe('OLD_MARKDOWN\n')
    expect(readFileSync(pairManifestOutput, 'utf8')).toBe('OLD_MANIFEST\n')
    expect(readdirSync(dir).sort()).toEqual(['case.json', 'case.md', 'case.pair.json'])

    publishReportPairAtomically(common)
    expect(readFileSync(jsonOutput, 'utf8')).toBe('NEW_JSON\n')
    expect(readFileSync(markdownOutput, 'utf8')).toBe('NEW_MARKDOWN\n')
    expect(readFileSync(pairManifestOutput, 'utf8')).toBe('NEW_MANIFEST\n')
  })

  it('removes a newly created pair when publication fails without an old pair', () => {
    const dir = tempDir()
    const jsonOutput = path.join(dir, 'case.json')
    const markdownOutput = path.join(dir, 'case.md')
    const pairManifestOutput = path.join(dir, 'case.pair.json')
    expect(() => publishReportPairAtomically({
      jsonOutput,
      markdownOutput,
      pairManifestOutput,
      jsonText: 'NEW_JSON\n',
      markdownText: 'NEW_MARKDOWN\n',
      pairManifestText: 'NEW_MANIFEST\n',
      generationId: 'b'.repeat(32),
      failureInjectionStep: 'after-markdown-publish',
    })).toThrow('Injected publish failure')
    expect(existsSync(jsonOutput)).toBe(false)
    expect(existsSync(markdownOutput)).toBe(false)
    expect(existsSync(pairManifestOutput)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('keeps a committed new pair successful when backup cleanup fails', () => {
    const dir = tempDir()
    const jsonOutput = path.join(dir, 'case.json')
    const markdownOutput = path.join(dir, 'case.md')
    const pairManifestOutput = path.join(dir, 'case.pair.json')
    writeFileSync(jsonOutput, 'OLD_JSON\n')
    writeFileSync(markdownOutput, 'OLD_MARKDOWN\n')
    writeFileSync(pairManifestOutput, 'OLD_MANIFEST\n')
    const generationId = 'c'.repeat(32)
    const publication = publishReportPairAtomically({
      jsonOutput,
      markdownOutput,
      pairManifestOutput,
      jsonText: 'NEW_JSON\n',
      markdownText: 'NEW_MARKDOWN\n',
      pairManifestText: 'NEW_MANIFEST\n',
      generationId,
      failureInjectionStep: 'backup-cleanup-failure',
    })
    expect(publication.committed).toBe(true)
    expect(publication.cleanupWarnings).toHaveLength(1)
    expect(readFileSync(jsonOutput, 'utf8')).toBe('NEW_JSON\n')
    expect(readFileSync(markdownOutput, 'utf8')).toBe('NEW_MARKDOWN\n')
    expect(readFileSync(pairManifestOutput, 'utf8')).toBe('NEW_MANIFEST\n')
    expect(readFileSync(`${jsonOutput}.${generationId}.backup`, 'utf8')).toBe('OLD_JSON\n')
  })

  it('preserves an unrestored backup and reports its absolute recovery path', () => {
    const dir = tempDir()
    const jsonOutput = path.join(dir, 'case.json')
    const markdownOutput = path.join(dir, 'case.md')
    const pairManifestOutput = path.join(dir, 'case.pair.json')
    writeFileSync(jsonOutput, 'OLD_JSON\n')
    writeFileSync(markdownOutput, 'OLD_MARKDOWN\n')
    writeFileSync(pairManifestOutput, 'OLD_MANIFEST\n')
    const generationId = 'd'.repeat(32)
    const jsonBackup = `${jsonOutput}.${generationId}.backup`
    expect(() => publishReportPairAtomically({
      jsonOutput,
      markdownOutput,
      pairManifestOutput,
      jsonText: 'NEW_JSON\n',
      markdownText: 'NEW_MARKDOWN\n',
      pairManifestText: 'NEW_MANIFEST\n',
      generationId,
      failureInjectionStep: ['after-json-publish', 'rollback-restore-failure'],
    })).toThrow(path.resolve(jsonBackup))
    expect(existsSync(jsonOutput)).toBe(false)
    expect(readFileSync(jsonBackup, 'utf8')).toBe('OLD_JSON\n')
    expect(readFileSync(markdownOutput, 'utf8')).toBe('OLD_MARKDOWN\n')
    expect(readFileSync(pairManifestOutput, 'utf8')).toBe('OLD_MANIFEST\n')
  })
})
