import { describe, expect, it, vi } from 'vitest'

const { loadDictionary } = vi.hoisted(() => ({
  loadDictionary: vi.fn((name: string) => {
    if (name === 'cmu-pronouncing-dictionary') {
      return { dictionary: { day: 'D EY1', say: 'S EY1' } }
    }
    if (name === 'pinyin-pro') {
      return {
        pinyin: () => 'shan',
        getInitialAndFinal: () => ({ initial: 'sh', final: 'an' }),
      }
    }
    throw new Error(`Unexpected dictionary: ${name}`)
  }),
}))

vi.mock('node:module', () => ({ createRequire: () => loadDictionary }))

import { analyzePoetrySource } from '../../src/lib/poetry/analysis'
import { chineseRhyme, englishRhyme } from '../../src/lib/poetry/pronunciation'

describe('on-demand pronunciation dictionaries', () => {
  it('keeps ordinary text analysis light and loads each language only when needed', () => {
    expect(loadDictionary).not.toHaveBeenCalled()
    const prose = analyzePoetrySource({
      sourceText: 'A short piece of ordinary text.',
      direction: 'en_to_zh',
    })
    expect(prose.isPoetry).toBe(false)
    analyzePoetrySource({
      sourceText: 'Day\nSay\nDay\nSay',
      constraints: { poetryMode: 'off' },
    })
    expect(loadDictionary).not.toHaveBeenCalled()

    expect(englishRhyme('day')).toBe('EY')
    expect(englishRhyme('Say')).toBe('EY')
    expect(loadDictionary.mock.calls).toEqual([['cmu-pronouncing-dictionary']])

    expect(chineseRhyme('山')).toBe('an')
    expect(chineseRhyme('山')).toBe('an')
    expect(loadDictionary.mock.calls).toEqual([
      ['cmu-pronouncing-dictionary'],
      ['pinyin-pro'],
    ])
  })
})
