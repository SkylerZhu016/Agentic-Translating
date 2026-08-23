import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  countExactOccurrences,
  projectEvidenceForInheritance,
  TranslationToolPolicyError,
  validateTranslationToolInvocation,
} from '../../src/lib/orchestration/translation-tools'
import {
  bodyOnlyEvidenceItemSchema,
  evidenceMaterialSchema,
} from '../../src/lib/contracts/translation-tools'

const baseContext = {
  sessionId: 'session-1',
  runId: 'run-1',
  invocationId: 'invocation-1',
  parentToolCallId: null,
  stage: 'review' as const,
  actor: 'main_agent' as const,
  depth: 0,
  allowedInheritanceMode: 'body_only' as const,
  knownEvidenceIds: ['evidence-1', 'evidence-2'],
  baseVersion: {
    id: 7,
    text: 'A unique phrase appears here. Another sentence follows.',
  },
}

function policyError(run: () => unknown): TranslationToolPolicyError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(TranslationToolPolicyError)
    return error as TranslationToolPolicyError
  }
  throw new Error('Expected TranslationToolPolicyError')
}

describe('translation tool contracts and policy', () => {
  it('imports the refined evidence schemas and preserves annotation pairing', () => {
    expect(bodyOnlyEvidenceItemSchema.parse({
      evidenceId: 'evidence-1',
      sourceType: 'agent_invocation',
      sourceId: 'invocation-1',
      body: 'body',
    })).toEqual(expect.objectContaining({ body: 'body' }))
    expect(evidenceMaterialSchema.safeParse({
      evidenceId: 'evidence-1',
      sourceType: 'agent_invocation',
      sourceId: 'invocation-1',
      raw: 'body\n---\nnote',
      body: 'body',
      annotation: 'note',
      annotationMetadata: null,
    }).success).toBe(false)
  })

  it('projects body-only evidence through a strict allowlist', () => {
    const projected = projectEvidenceForInheritance(
      [
        {
          evidenceId: 'evidence-1',
          sourceType: 'agent_invocation',
          sourceId: 'invocation-1',
          raw: '译文正文\n---\n可能误导下游的注释',
          body: '译文正文',
          annotation: '可能误导下游的注释',
          annotationMetadata: {
            source: 'invocation-1',
            version: 'fsbp-v1',
            hash: createHash('sha256')
              .update('可能误导下游的注释')
              .digest('hex'),
          },
        },
      ],
      'body_only',
    )

    expect(projected).toEqual({
      inheritanceMode: 'body_only',
      items: [
        {
          evidenceId: 'evidence-1',
          sourceType: 'agent_invocation',
          sourceId: 'invocation-1',
          body: '译文正文',
        },
      ],
    })
    expect(JSON.stringify(projected)).not.toContain('可能误导下游的注释')
    expect(JSON.stringify(projected)).not.toContain('raw')
    expect(JSON.stringify(projected)).not.toContain('annotation')
  })

  it('rejects annotation evidence whose recorded hash no longer matches', () => {
    expect(policyError(() =>
      projectEvidenceForInheritance(
        [{
          evidenceId: 'evidence-1',
          sourceType: 'agent_invocation',
          sourceId: 'invocation-1',
          raw: 'body\n---\nchanged note',
          body: 'body',
          annotation: 'changed note',
          annotationMetadata: {
            source: 'invocation-1',
            version: 'fsbp-v1',
            hash: createHash('sha256').update('old note').digest('hex'),
          },
        }],
        'body_only',
      ),
    )).toMatchObject({ code: 'annotation_hash_mismatch' })
  })

  it('rejects attempts to escalate a frozen body-only evidence mode', () => {
    expect(policyError(() =>
      validateTranslationToolInvocation({
        call: {
          name: 'inspect_evidence',
          args: {
            evidenceIds: ['evidence-1'],
            inheritanceMode: 'body_and_annotation',
          },
        },
        context: baseContext,
      }),
    )).toMatchObject({ code: 'inheritance_mode_forbidden' })
  })

  it('keeps review subagents read-only', () => {
    expect(policyError(() =>
      validateTranslationToolInvocation({
        call: {
          name: 'record_issue',
          args: {
            title: 'Meaning drift',
            details: 'The translated predicate changes the source claim.',
            location: { quote: 'unique phrase' },
            category: 'fidelity',
            severity: 'high',
            evidenceIds: ['evidence-1'],
          },
        },
        context: {
          ...baseContext,
          actor: 'review_subagent',
          depth: 1,
        },
      }),
    )).toMatchObject({ code: 'read_only_agent' })
  })

  it('limits request_review to depth one and two reservations per stage', () => {
    const call = {
      name: 'request_review',
      args: {
        segment: 'A unique phrase',
        question: 'Does this preserve agency?',
        evidenceIds: ['evidence-1'],
      },
    }
    expect(
      validateTranslationToolInvocation({
        call,
        context: baseContext,
        reviewRequestsInStage: 1,
      }).call.name,
    ).toBe('request_review')
    expect(policyError(() =>
      validateTranslationToolInvocation({
        call,
        context: baseContext,
        reviewRequestsInStage: 2,
      }),
    )).toMatchObject({ code: 'review_limit_exceeded' })
    expect(policyError(() =>
      validateTranslationToolInvocation({
        call,
        context: { ...baseContext, depth: 1 },
        reviewRequestsInStage: 0,
      }),
    )).toMatchObject({ code: 'review_depth_exceeded' })
  })

  it('requires propose_patch to target the current base version exactly once', () => {
    const validCall = {
      name: 'propose_patch',
      args: {
        baseVersionId: 7,
        oldText: 'A unique phrase',
        replacement: 'One unique phrase',
        reason: 'Preserve the source number.',
        evidenceIds: ['evidence-1'],
      },
    }
    expect(
      validateTranslationToolInvocation({
        call: validCall,
        context: baseContext,
      }).call.name,
    ).toBe('propose_patch')

    expect(policyError(() =>
      validateTranslationToolInvocation({
        call: {
          ...validCall,
          args: { ...validCall.args, baseVersionId: 6 },
        },
        context: baseContext,
      }),
    )).toMatchObject({ code: 'base_version_mismatch' })

    expect(policyError(() =>
      validateTranslationToolInvocation({
        call: {
          ...validCall,
          args: { ...validCall.args, oldText: 'sentence' },
        },
        context: {
          ...baseContext,
          baseVersion: { id: 7, text: 'sentence one; sentence two' },
        },
      }),
    )).toMatchObject({ code: 'patch_target_ambiguous' })
  })

  it('counts overlapping exact matches as ambiguous', () => {
    expect(countExactOccurrences('aaaa', 'aaa')).toBe(2)
  })
})
