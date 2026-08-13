import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  buildProjectResourceContent,
  buildProjectScope,
  ProjectMemoryPanel,
  projectApiErrorMessage,
  projectContentLines,
  snapshotHashSummary,
} from './ProjectMemoryPanel'

describe('ProjectMemoryPanel contract helpers', () => {
  it('renders as an isolated ink-paper card with the session boundary visible', () => {
    vi.stubGlobal('React', React)
    const html = renderToStaticMarkup(React.createElement(ProjectMemoryPanel))
    vi.unstubAllGlobals()

    expect(html).toContain('data-testid="project-memory-panel"')
    expect(html).toContain('项目级翻译档案')
    expect(html).toContain('新建议尚未进入会话')
  })

  it('builds the exact project-wide resource content and scope shapes', () => {
    expect(
      buildProjectResourceContent({
        kind: 'term',
        sourceText: '  red herring  ',
        targetText: '  转移注意力的话题  ',
        instruction: '   ',
        note: '  侦探小说语境  ',
      }),
    ).toEqual({
      sourceText: 'red herring',
      targetText: '转移注意力的话题',
      instruction: null,
      note: '侦探小说语境',
    })

    expect(buildProjectScope('en_to_zh')).toEqual({
      direction: 'en_to_zh',
      level: 'project',
      selector: null,
      pinned: false,
    })
  })

  it('renders only populated contract content fields in its summary', () => {
    expect(
      projectContentLines({
        sourceText: null,
        targetText: null,
        instruction: '保持句式简洁',
        note: '',
      }),
    ).toEqual([{ label: '规则', value: '保持句式简洁' }])
  })

  it('summarizes snapshot hashes without changing short values', () => {
    expect(snapshotHashSummary('1234567890abcdef')).toBe('1234567890ab…')
    expect(snapshotHashSummary('1234')).toBe('1234')
  })

  it('uses bounded user-facing API errors instead of returning raw payload text', () => {
    expect(projectApiErrorMessage('stale_resource_revision', 409)).toContain('已有更新')
    expect(projectApiErrorMessage('unexpected_backend_detail', 500)).toBe(
      '项目档案请求未完成（500）。',
    )
  })
})
