import { createRequire } from 'node:module'

// Both dictionaries are large. Keep route loading and ordinary workspace
// navigation free of their parsing/allocation cost. This module is server-only.
// Webpack statically recognizes this standard ESM form and emits lazy module
// references. A computed cwd/path argument is not supported by its
// createRequire parser and can be compiled to an undefined loader.
const requireDictionary = createRequire(import.meta.url)
let englishDictionary: typeof import('cmu-pronouncing-dictionary').dictionary | undefined
let chineseDictionary: typeof import('pinyin-pro') | undefined

export function englishRhyme(word: string): string | null {
  if (!word) return null
  englishDictionary ??= (
    requireDictionary('cmu-pronouncing-dictionary') as typeof import('cmu-pronouncing-dictionary')
  ).dictionary
  const pronunciation = englishDictionary[word.toLowerCase()]
  if (!pronunciation) return null
  const phones = pronunciation
    .replace(/\s+#.*$/, '')
    .split(/\s+/)
    .filter(Boolean)
  let vowelIndex = -1
  for (let index = phones.length - 1; index >= 0; index--) {
    if (/[012]$/.test(phones[index])) {
      vowelIndex = index
      if (/[12]$/.test(phones[index])) break
    }
  }
  if (vowelIndex < 0) return null
  return phones
    .slice(vowelIndex)
    .map((phone) => phone.replace(/[012]/g, ''))
    .join('-')
}

export function chineseRhyme(character: string): string | null {
  if (!character) return null
  chineseDictionary ??= requireDictionary('pinyin-pro') as typeof import('pinyin-pro')
  const reading = chineseDictionary.pinyin(character, { toneType: 'none' })
  if (!reading || reading === character) return null
  return chineseDictionary.getInitialAndFinal(reading).final || null
}
