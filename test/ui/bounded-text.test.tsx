import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  BoundedText,
  CollapsibleText,
  getTextWindow,
  TEXT_WINDOW_CHARACTERS,
} from '@/src/components/ui/BoundedText'
import { AgentStreamCard } from '@/src/components/translate/agent-stream-card'
import { ChatPanel } from '@/src/components/editor/ChatPanel'
import { StageOutputPanel } from '@/src/components/coordinator/StageOutputPanel'
import { LocaleProvider } from '@/src/i18n'
import type { StageOutputRow } from '@/src/lib/contracts/types'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}))

function render(element: ReactElement) {
  return renderToStaticMarkup(
    createElement(LocaleProvider, { initialLocale: 'en', children: element }),
  )
}

function mountedText(markup: string) {
  return [...markup.matchAll(/<div data-text-content="[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((match) => match[1].replace(/<[^>]*>/g, ''))
}

describe('bounded text windows', () => {
  it.each([40_000, 100_000])('mounts at most 8000 text characters from a %i-character response', (length) => {
    const text = '甲'.repeat(length)
    const markup = render(createElement(BoundedText, { text }))
    const content = mountedText(markup)

    expect(content).toHaveLength(1)
    expect(content[0]).toHaveLength(TEXT_WINDOW_CHARACTERS)
    expect(markup).not.toContain(text)
    expect(markup).toContain(`data-visible-end="${TEXT_WINDOW_CHARACTERS}"`)
    expect(markup).toContain('data-text-controls')
  })

  it('shows the streaming tail without mounting earlier text', () => {
    const text = `EARLIER_SENTINEL${'甲'.repeat(40_000)}LATEST_SENTINEL`
    const markup = render(createElement(BoundedText, { text, streaming: true }))

    expect(mountedText(markup)[0]).toHaveLength(TEXT_WINDOW_CHARACTERS)
    expect(markup).toContain('LATEST_SENTINEL')
    expect(markup).not.toContain('EARLIER_SENTINEL')
    expect(markup).toContain(`data-visible-end="${text.length}"`)
  })

  it('keeps an anchored reading window stable while new output arrives', () => {
    const previous = '前'.repeat(40_000)
    const original = getTextWindow(previous, 16_000)
    const afterAppend = getTextWindow(`${previous}${'后'.repeat(60_000)}`, 16_000)

    expect(afterAppend).toEqual(original)
    expect(getTextWindow(`${previous}新输出`, null).text.endsWith('新输出')).toBe(true)
  })

  it('supports paging through the entire text without losing surrogate pairs', () => {
    const text = `首${'😀中'.repeat(30_000)}尾`
    let rebuilt = ''
    let anchor = 0
    while (anchor < text.length) {
      const window = getTextWindow(text, anchor, 7999)
      expect(window.text.length).toBeLessThanOrEqual(TEXT_WINDOW_CHARACTERS)
      expect(window.end).toBeGreaterThan(anchor)
      rebuilt += window.text
      anchor = window.end
    }
    expect(rebuilt).toBe(text)
  })

  it('does not allow a caller to remove the mounted-text ceiling', () => {
    expect(getTextWindow('甲'.repeat(100_000), 0, 100_000).text.length)
      .toBe(TEXT_WINDOW_CHARACTERS)
  })

  it('does not mount collapsed text or an invisible copy of the full response', () => {
    const markup = render(createElement(CollapsibleText, {
      title: 'Notes',
      text: `HIDDEN_SENTINEL${'甲'.repeat(100_000)}`,
      streaming: true,
    }))

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('HIDDEN_SENTINEL')
    expect(markup).not.toContain('data-text-viewport')
  })
})

describe('long output surfaces', () => {
  it('shows restored reasoning counts without offering an empty preview', () => {
    const markup = render(createElement(AgentStreamCard, {
      card: {
        agentKey: 'restored',
        name: 'Translator',
        model: 'fixture',
        status: 'complete',
        text: 'Saved translation',
        error: null,
        reasoningCharacters: 40_000,
      },
      retrying: false,
      retryDisabled: false,
      onRetry: vi.fn(),
    }))

    expect(markup).toContain('40000')
    expect(markup).not.toContain('data-collapsible-text')
    expect(mountedText(markup)).toEqual(['Saved translation'])
  })

  it('keeps card reasoning and annotation separate from the mounted translation', () => {
    const markup = render(createElement(AgentStreamCard, {
      card: {
        agentKey: 'translator',
        name: 'Translator',
        model: 'fixture',
        status: 'streaming',
        text: '正文'.repeat(50_000),
        error: null,
        reasoningPreview: 'REASONING_SENTINEL'.repeat(200),
        reasoningCharacters: 100_000,
        reasoningTruncated: true,
        annotation: 'ANNOTATION_SENTINEL'.repeat(5000),
      },
      retrying: false,
      retryDisabled: false,
      onRetry: vi.fn(),
    }))

    expect(mountedText(markup)).toHaveLength(1)
    expect(mountedText(markup)[0]).toHaveLength(TEXT_WINDOW_CHARACTERS)
    expect(markup).not.toContain('REASONING_SENTINEL')
    expect(markup).not.toContain('ANNOTATION_SENTINEL')
    expect(markup).toContain('100000')
  })

  it('bounds individual user and assistant messages in the chat list', () => {
    const markup = render(createElement(ChatPanel, {
      messages: [
        { id: 'u', role: 'user', content: '问'.repeat(40_000) },
        {
          id: 'a',
          role: 'assistant',
          content: '答'.repeat(100_000),
          streaming: true,
          reasoningPreview: 'THOUGHT_SENTINEL'.repeat(200),
          reasoningCharacters: 100_000,
        },
      ],
      streaming: true,
      canChat: true,
      disabledHint: '',
      onSend: vi.fn(),
    }))

    const content = mountedText(markup)
    expect(content).toHaveLength(2)
    expect(content.every((part) => part.length <= TEXT_WINDOW_CHARACTERS)).toBe(true)
    expect(markup).not.toContain('THOUGHT_SENTINEL')
  })

  it('decodes a saved JSON body and keeps its annotation and raw response unmounted', () => {
    const row: StageOutputRow = {
      id: 1,
      session_id: 'fixture',
      stage: 'assemble',
      status: 'complete',
      prompt_used: '[protocol:json-v1]',
      raw_output: JSON.stringify({
        body: `READABLE_BODY\n${'译'.repeat(100_000)}`,
        annotation: `NOTES_SENTINEL${'注'.repeat(40_000)}`,
      }),
      error: null,
      created_at: '',
    }
    const markup = render(createElement(StageOutputPanel, {
      stage: 'assemble',
      row,
      running: false,
      streamText: '',
      canRun: false,
      onRun: vi.fn(),
    }))

    expect(mountedText(markup)).toHaveLength(1)
    expect(mountedText(markup)[0]).toHaveLength(TEXT_WINDOW_CHARACTERS)
    expect(markup).toContain('READABLE_BODY\n')
    expect(markup).not.toContain('NOTES_SENTINEL')
    expect(markup).not.toContain('&quot;body&quot;')
    expect(markup).not.toContain('READABLE_BODY\\n')
  })
})
