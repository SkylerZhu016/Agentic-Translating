'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, Spinner, Textarea } from '@/src/components/ui'
import { useDirection } from '@/src/components/direction/DirectionProvider'
import type { DirectionPromptBundle } from '@/src/lib/contracts/vnext'
import type { NotifyFn } from './shared'

interface PromptBundleView {
  id: string
  name: string
  direction: string
  isBuiltin: boolean
  currentRevisionNo: number
  currentRevision: {
    id: string
    payload: DirectionPromptBundle
  }
}

const MODULES = [
  ['mainAgentSystemPrompt', '主 Agent'],
  ['workerBasePrompt', '翻译公共基础'],
  ['reviewPrompt', '审查'],
  ['filterPrompt', '筛选'],
  ['orchestratePrompt', '编排'],
  ['assemblePrompt', '组装'],
  ['editingPrompt', '编辑'],
] as const

type ModuleKey = (typeof MODULES)[number][0]

export function PromptBundlePanel({ notify }: { notify: NotifyFn }) {
  const { direction } = useDirection()
  const [bundles, setBundles] = useState<PromptBundleView[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [moduleKey, setModuleKey] =
    useState<ModuleKey>('mainAgentSystemPrompt')
  const [draft, setDraft] = useState<DirectionPromptBundle | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch(`/api/prompt-bundles?direction=${direction}`)
    if (!response.ok) return
    const list = (await response.json()) as PromptBundleView[]
    setBundles(list)
    const preferred =
      list.find((item) => item.id === selectedId) ?? list[0] ?? null
    setSelectedId(preferred?.id ?? '')
    setDraft(preferred?.currentRevision.payload ?? null)
  }, [direction, selectedId])

  useEffect(() => {
    void load()
  }, [load])

  const selected = useMemo(
    () => bundles.find((item) => item.id === selectedId) ?? null,
    [bundles, selectedId],
  )

  function selectBundle(id: string) {
    const next = bundles.find((item) => item.id === id) ?? null
    setSelectedId(id)
    setDraft(next?.currentRevision.payload ?? null)
  }

  async function cloneOfficial() {
    if (!selected || !draft) return
    setSaving(true)
    try {
      const response = await fetch('/api/prompt-bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${selected.name} · 用户副本`,
          direction,
          payload: { ...draft, version: 1 },
        }),
      })
      if (!response.ok) throw new Error('复制失败')
      const created = (await response.json()) as PromptBundleView
      notify('已复制为用户提示词包', { tone: 'inverted' })
      await load()
      setSelectedId(created.id)
      setDraft(created.currentRevision.payload)
    } catch (error) {
      notify('复制失败', {
        message: error instanceof Error ? error.message : '请重试',
      })
    } finally {
      setSaving(false)
    }
  }

  async function saveRevision() {
    if (!selected || selected.isBuiltin || !draft) return
    setSaving(true)
    try {
      const response = await fetch(
        `/api/prompt-bundles/${encodeURIComponent(selected.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...draft,
            version: selected.currentRevisionNo + 1,
          }),
        },
      )
      if (!response.ok) throw new Error('保存 revision 失败')
      notify('提示词包已生成新 revision', { tone: 'inverted' })
      await load()
    } catch (error) {
      notify('保存失败', {
        message: error instanceof Error ? error.message : '请重试',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      overline="Prompt Center"
      title="提示词中心"
      actions={
        selected ? (
          <Badge variant={selected.isBuiltin ? 'solid' : 'outline'}>
            {selected.isBuiltin ? '官方只读' : `revision ${selected.currentRevisionNo}`}
          </Badge>
        ) : undefined
      }
    >
      {selected && draft ? (
        <div className="space-y-3">
          <select
            value={selectedId}
            onChange={(event) => selectBundle(event.target.value)}
            className="block h-9 w-full rounded-sm border border-line-2 bg-paper-raise px-2 text-sm text-ink"
          >
            {bundles.map((bundle) => (
              <option key={bundle.id} value={bundle.id}>
                {bundle.name} v{bundle.currentRevisionNo}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1.5">
            {MODULES.map(([key, label]) => (
              <Button
                key={key}
                size="sm"
                variant={moduleKey === key ? 'primary' : 'outline'}
                onClick={() => setModuleKey(key)}
              >
                {label}
              </Button>
            ))}
          </div>
          <Textarea
            rows={10}
            value={draft[moduleKey]}
            disabled={selected.isBuiltin}
            onChange={(event) =>
              setDraft((current) =>
                current
                  ? { ...current, [moduleKey]: event.target.value }
                  : current,
              )
            }
            aria-label={`${MODULES.find(([key]) => key === moduleKey)?.[1]}提示词`}
          />
          <details className="rounded-sm border border-line bg-paper/55">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-3">
              工具说明
            </summary>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 text-xs leading-5 text-ink-2">
              {JSON.stringify(draft.toolDescriptions, null, 2)}
            </pre>
          </details>
          {selected.isBuiltin ? (
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void cloneOfficial()}
            >
              {saving && <Spinner size="sm" />}复制为用户包
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={saving}
              onClick={() => void saveRevision()}
            >
              {saving && <Spinner size="sm" />}保存为新 revision
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-3">当前方向没有可用提示词包。</p>
      )}
    </Card>
  )
}
