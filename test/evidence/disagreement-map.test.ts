import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DisagreementCandidate } from '../../src/lib/contracts/disagreement-map'
import {
  buildDisagreementMap,
  computeCandidateSetHash,
  segmentDisagreementSource,
} from '../../src/lib/evidence/disagreement-map'

function candidate(
  invocationId: string,
  body: string,
  annotation?: string,
): DisagreementCandidate {
  return {
    invocationId,
    agentName: `Agent ${invocationId}`,
    model: `model-${invocationId}`,
    body,
    annotation,
  }
}

describe('disagreement map segmentation', () => {
  it('segments English and Chinese sentences across CRLF paragraphs', () => {
    const result = segmentDisagreementSource(
      'First sentence. Emoji stays 🙂!\r\n\r\n中文第一句。中文第二句？',
    )

    expect(result.mode).toBe('sentence')
    expect(result.segments.map((segment) => segment.text)).toEqual([
      'First sentence.',
      'Emoji stays 🙂!',
      '中文第一句。',
      '中文第二句？',
    ])
    expect(result.segments.map((segment) => segment.paragraphIndex)).toEqual([
      0, 0, 1, 1,
    ])
    expect(
      result.segments.map((segment) =>
        'First sentence. Emoji stays 🙂!\r\n\r\n中文第一句。中文第二句？'.slice(
          segment.startOffset,
          segment.endOffset,
        ),
      ),
    ).toEqual(result.segments.map((segment) => segment.text))
  })

  it('preserves poetry lines, stanzas, emoji, and CRLF/LF stability', () => {
    const crlf =
      'The moon is high 🌕\r\nThe river is bright\r\n\r\nA bell crosses water\r\nNight holds its breath'
    const lf = crlf.replace(/\r\n/g, '\n')
    const first = segmentDisagreementSource(crlf)
    const second = segmentDisagreementSource(lf)

    expect(first.mode).toBe('poetry_line')
    expect(first.segments.map((segment) => segment.text)).toEqual([
      'The moon is high 🌕',
      'The river is bright',
      'A bell crosses water',
      'Night holds its breath',
    ])
    expect(first.segments.map((segment) => segment.stanzaIndex)).toEqual([
      0, 0, 1, 1,
    ])
    expect(first.segments.map((segment) => segment.text)).toEqual(
      second.segments.map((segment) => segment.text),
    )
  })

  it('keeps two-line couplets and three-line haiku in poetry-line mode', () => {
    const couplet = segmentDisagreementSource(
      'The moon climbs the pine\nThe tide answers the shore',
    )
    const haiku = segmentDisagreementSource(
      'Old pond\nA frog jumps into water\nSound of water',
    )

    expect(couplet.mode).toBe('poetry_line')
    expect(couplet.segments).toHaveLength(2)
    expect(haiku.mode).toBe('poetry_line')
    expect(haiku.segments).toHaveLength(3)
    expect(haiku.segments.map((segment) => segment.lineIndex)).toEqual([0, 1, 2])
  })

  it('recognizes continuously typeset classical Chinese lines', () => {
    const result = segmentDisagreementSource(
      '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。',
    )

    expect(result.mode).toBe('poetry_line')
    expect(result.segments.map((segment) => segment.text)).toEqual([
      '白日依山尽，',
      '黄河入海流。',
      '欲穷千里目，',
      '更上一层楼。',
    ])
  })
})

describe('disagreement candidate-set hash', () => {
  it('is SHA-256, ordered, newline-stable, and independent of annotations', () => {
    const candidates = [
      candidate('a', 'Line one.\r\nLine two.', 'number 99'),
      candidate('b', 'Other body.', 'private note'),
    ]
    const changedAnnotations = [
      candidate('a', 'Line one.\nLine two.', 'totally different'),
      candidate('b', 'Other body.'),
    ]
    const canonical = JSON.stringify({
      version: 1,
      candidates: candidates.map(({ invocationId, agentName, model, body }) => ({
        invocationId,
        agentName,
        model,
        body: body.replace(/\r\n?/g, '\n'),
      })),
    })

    expect(computeCandidateSetHash(candidates)).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    )
    expect(computeCandidateSetHash(candidates)).toMatch(/^[a-f0-9]{64}$/)
    expect(computeCandidateSetHash(changedAnnotations)).toBe(
      computeCandidateSetHash(candidates),
    )
    expect(computeCandidateSetHash([...candidates].reverse())).not.toBe(
      computeCandidateSetHash(candidates),
    )
  })
})

describe('disagreement map derivation', () => {
  it('aligns candidate fragments in order and ignores whitespace-only variants', () => {
    const result = buildDisagreementMap({
      sourceText: 'First source sentence. Second source sentence. Third source sentence.',
      candidates: [
        candidate('a', 'Alpha one. Shared middle. Final choice A.'),
        candidate('b', 'Alpha one.\nShared   middle. Final choice B.'),
      ],
      finalText: 'Alpha one. Shared middle. Final choice B.',
    })

    expect(result.status).toBe('ready')
    expect(result.finalAlignmentStatus).toBe('aligned')
    expect(result.hotspots).toHaveLength(1)
    expect(result.hotspots[0].sourceRange.text).toBe('Third source sentence.')
    expect(
      result.hotspots[0].candidates.map((item) => item.bodySegment),
    ).toEqual([
      'Final choice A.',
      'Final choice B.',
    ])
    expect(result.hotspots[0].finalSegment).toBe('Final choice B.')
    expect(result.hotspots[0].adoptedCandidateIds).toEqual(['b'])
  })

  it('leaves adoption empty when the final segment is not a normalized exact match', () => {
    const result = buildDisagreementMap({
      sourceText: 'One source sentence.',
      candidates: [candidate('a', 'Choice A.'), candidate('b', 'Choice B.')],
      finalText: 'A combined third choice.',
    })

    expect(result.status).toBe('ready')
    expect(result.hotspots[0].finalSegment).toBe('A combined third choice.')
    expect(result.hotspots[0].adoptedCandidateIds).toEqual([])
  })

  it('does not compare or emit annotations', () => {
    const first = buildDisagreementMap({
      sourceText: 'One source sentence.',
      candidates: [
        candidate('a', 'Same translation.', 'Never 100%! Alice API-v2'),
        candidate('b', 'Same translation.', 'Always 200%? Bob API-v3'),
      ],
    })
    const second = buildDisagreementMap({
      sourceText: 'One source sentence.',
      candidates: [candidate('a', 'Same translation.'), candidate('b', 'Same translation.')],
    })

    expect(first.status).toBe('ready')
    expect(first.hotspots).toEqual([])
    expect(first.candidateSetHash).toBe(second.candidateSetHash)
    expect(JSON.stringify(first)).not.toContain('Never 100%')
  })

  it('emits only deterministic inventory hints without declaring correctness', () => {
    const result = buildDisagreementMap({
      sourceText: 'The source has one sentence.',
      candidates: [
        candidate('a', 'The request from Alice did not approve `API-v2` at 12%.'),
        candidate('b', 'The request from Bob approved `API-v3` at 15%!'),
      ],
    })

    expect(result.status).toBe('ready')
    expect(result.hotspots).toHaveLength(1)
    expect(result.hotspots[0].differenceKinds).toEqual(
      expect.arrayContaining([
        'wording',
        'punctuation',
        'number',
        'negation',
        'proper_noun',
        'terminology',
      ]),
    )
    expect(result.hotspots[0].hints.map((hint) => hint.kind)).toEqual(
      expect.arrayContaining([
        'punctuation',
        'number',
        'negation',
        'proper_noun',
        'terminology',
      ]),
    )
    expect(result.hotspots[0].hints.every((hint) => hint.confidence === 'deterministic')).toBe(true)
    expect(JSON.stringify(result.hotspots[0].hints)).not.toMatch(/correct|incorrect|error/i)
  })

  it('does not classify ordinary sentence-initial wording as a proper noun', () => {
    const result = buildDisagreementMap({
      sourceText: 'The source has one sentence.',
      candidates: [
        candidate('a', 'Quickly, he left.'),
        candidate('b', 'Slowly, he left.'),
      ],
    })

    expect(result.status).toBe('ready')
    expect(result.hotspots[0].differenceKinds).not.toContain('proper_noun')
    expect(result.hotspots[0].hints.map((hint) => hint.kind)).not.toContain(
      'proper_noun',
    )
  })

  it('aligns a modest sentence-boundary mismatch without changing candidate order', () => {
    const result = buildDisagreementMap({
      sourceText: 'Source one. Source two. Source three.',
      candidates: [
        candidate('a', 'Target one. Target two. Target three.'),
        candidate('b', 'Target one and target two. Different target three.'),
      ],
    })

    expect(result.status).toBe('ready')
    expect(result.hotspots.length).toBeGreaterThan(0)
    expect(
      result.hotspots.every(
        (hotspot) =>
          hotspot.candidates[0].invocationId === 'a' &&
          hotspot.candidates[1].invocationId === 'b',
      ),
    ).toBe(true)
    expect(
      result.hotspots.some((hotspot) =>
        hotspot.differenceKinds.includes('structure'),
      ),
    ).toBe(true)
  })

  it('keeps a merged source range text exactly consistent with its offsets', () => {
    const sourceText = 'One.\nTwo. Three.'
    const result = buildDisagreementMap({
      sourceText,
      candidates: [
        candidate('a', 'Uno. Dos y tres.'),
        candidate('b', 'One. A different two and three.'),
      ],
    })

    expect(result.status).toBe('ready')
    for (const hotspot of result.hotspots) {
      expect(hotspot.sourceRange.text).toBe(
        sourceText.slice(
          hotspot.sourceRange.startOffset,
          hotspot.sourceRange.endOffset,
        ),
      )
    }
  })

  it('shows punctuation-only differences but suppresses pure whitespace differences', () => {
    const punctuation = buildDisagreementMap({
      sourceText: 'One source sentence.',
      candidates: [candidate('a', 'Same words.'), candidate('b', 'Same words!')],
    })
    const whitespace = buildDisagreementMap({
      sourceText: 'One source sentence.',
      candidates: [candidate('a', 'Same words.'), candidate('b', '  Same   words.  ')],
    })

    expect(punctuation.status).toBe('ready')
    expect(punctuation.hotspots[0].differenceKinds).toContain('punctuation')
    expect(whitespace.status).toBe('ready')
    expect(whitespace.hotspots).toEqual([])
  })

  it('degrades severe alignment failure to full-text blocks without throwing', () => {
    const result = buildDisagreementMap({
      sourceText: 'One. Two. Three. Four.',
      candidates: [
        candidate('a', 'A. B. C. D.'),
        candidate('b', 'One undivided translation without sentence punctuation'),
      ],
      finalText: 'Existing final text',
    })

    expect(result.status).toBe('full_text_fallback')
    expect(result.fallback).toMatchObject({
      reason: 'alignment_failed',
      message: '本次只能按全文比较',
      finalText: 'Existing final text',
    })
    expect(result.fallback?.candidates.map((item) => item.body)).toEqual([
      'A. B. C. D.',
      'One undivided translation without sentence punctuation',
    ])
    expect(result.hotspots).toEqual([])
  })

  it('degrades malformed, duplicate, blank, and oversized inputs safely', () => {
    const duplicate = buildDisagreementMap({
      sourceText: 'Source.',
      candidates: [candidate('same', 'A.'), candidate('same', 'B.')],
    })
    const blank = buildDisagreementMap({
      sourceText: 'Source.',
      candidates: [candidate('a', 'A.'), candidate('b', '   ')],
    })
    const oversized = buildDisagreementMap({
      sourceText: 'x'.repeat(200_001),
      candidates: [candidate('a', 'A.'), candidate('b', 'B.')],
    })

    expect(duplicate.fallback?.reason).toBe('invalid_input')
    expect(blank.fallback?.reason).toBe('empty_candidate')
    expect(oversized.fallback?.reason).toBe('too_large')
    expect(duplicate.candidateSetHash).toMatch(/^[a-f0-9]{64}$/)
  })
})
