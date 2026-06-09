'use client'

// ---------------------------------------------------------------------------
// 提示词编辑面板 —— 5 kind 选项卡 + 模板筹码 + 变量侧注 + 恢复内置默认
// 内置模板保存时服务端自动另存为自定义副本（201 + 新 id），面板提示该行为
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner, Textarea } from '@/src/components/ui'
import { configApi, isApiError, type PromptKind, type PromptTemplate } from './api'
import { Field, type NotifyFn } from './shared'

const KINDS: { kind: PromptKind; label: string }[] = [
  { kind: 'translator', label: '翻译默认' },
  { kind: 'review', label: '审查' },
  { kind: 'filter', label: '筛选' },
  { kind: 'orchestrate', label: '编排' },
  { kind: 'assemble', label: '组装' },
]

const VAR_DOCS: Record<PromptKind, { name: string; desc: string }[]> = {
  translator: [
    { name: '{{source_lang}}', desc: '原文语言（如 英文）' },
    { name: '{{target_lang}}', desc: '目标语言（如 中文五言）' },
    { name: '{{source_text}}', desc: '待翻译的原文全文' },
    { name: '{{extra_instructions}}', desc: '附加指令，可为空' },
  ],
  review: [
    { name: '{{source_text}}', desc: '原文全文' },
    { name: '{{target_lang}}', desc: '目标语言' },
    { name: '{{translations}}', desc: '各 Agent 译稿集合' },
  ],
  filter: [
    { name: '{{source_text}}', desc: '原文全文' },
    { name: '{{review_output}}', desc: '审查阶段 JSON 输出' },
  ],
  orchestrate: [
    { name: '{{source_text}}', desc: '原文全文' },
    { name: '{{selected_translations}}', desc: '入选译稿全文' },
    { name: '{{review_output}}', desc: '审查阶段 JSON 输出' },
    { name: '{{filter_output}}', desc: '筛选阶段 JSON 输出' },
  ],
  assemble: [
    { name: '{{source_text}}', desc: '原文全文' },
    { name: '{{orchestrate_output}}', desc: '编排阶段 JSON 输出' },
    { name: '{{selected_translations}}', desc: '入选译稿全文' },
  ],
}

export interface PromptPanelProps {
  prompts: PromptTemplate[]
  notify: NotifyFn
  onChanged: () => Promise<void>
}

export function PromptPanel({ prompts, notify, onChanged }: PromptPanelProps) {
  const [activeKind, setActiveKind] = useState<PromptKind>('translator')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  const kindList = useMemo(
    () =>
      prompts
        .filter((p) => p.kind === activeKind)
        .sort((a, b) => b.is_builtin - a.is_builtin || a.id - b.id),
    [prompts, activeKind],
  )

  const selected = useMemo(
    () => prompts.find((p) => p.id === selectedId) ?? null,
    [prompts, selectedId],
  )

  // 选项卡/数据变化时维持选中：当前选中失效 → 回落到内置（或首个）
  useEffect(() => {
    const current = kindList.find((p) => p.id === selectedId)
    if (current == null) {
      const def = kindList.find((p) => p.is_builtin === 1) ?? kindList[0] ?? null
      setSelectedId(def?.id ?? null)
      setName(def?.name ?? '')
      setContent(def?.content ?? '')
      setDirty(false)
      setError(null)
    } else if (!dirty) {
      setName(current.name)
      setContent(current.content)
    }
  }, [kindList, selectedId, dirty])

  function selectTemplate(t: PromptTemplate) {
    setSelectedId(t.id)
    setName(t.name)
    setContent(t.content)
    setDirty(false)
    setError(null)
  }

  async function save() {
    if (selected == null) return
    if (name.trim().length === 0 || content.trim().length === 0) {
      setError('名称与内容均不能为空')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const res = await configApi.updatePrompt(selected.id, {
        name: name.trim(),
        content,
      })
      const copied = res.id !== selected.id
      notify(copied ? '已另存为自定义副本' : '提示词已保存', {
        message: copied ? '内置模板保持不变，后续将使用自定义副本。' : undefined,
        tone: 'inverted',
      })
      await onChanged()
      setSelectedId(res.id)
      setName(res.name)
      setContent(res.content)
      setDirty(false)
    } catch (e) {
      notify('保存失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setSaving(false)
    }
  }

  async function confirmReset() {
    setResetting(true)
    try {
      await configApi.resetPrompts()
      notify('已恢复内置默认提示词', {
        message: '全部自定义副本已删除。',
        tone: 'inverted',
      })
      setResetOpen(false)
      await onChanged()
    } catch (e) {
      notify('恢复失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
      setResetOpen(false)
    } finally {
      setResetting(false)
    }
  }

  return (
    <Card
      overline="Prompts"
      title="提示词"
      actions={
        <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
          恢复内置默认
        </Button>
      }
    >
      {/* kind 选项卡 */}
      <div role="tablist" aria-label="提示词类别" className="flex flex-wrap gap-1.5">
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={activeKind === kind}
            onClick={() => setActiveKind(kind)}
            className={[
              'h-8 rounded-sm px-3 text-sm font-medium transition-colors duration-150',
              activeKind === kind
                ? 'bg-ink text-paper'
                : 'text-ink-2 hover:bg-paper-sink hover:text-ink',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 模板筹码（内置 + 自定义副本） */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {kindList.map((t) => (
          <Button
            key={t.id}
            variant={t.id === selectedId ? 'primary' : 'outline'}
            size="sm"
            onClick={() => selectTemplate(t)}
          >
            {t.name}
            <Badge variant={t.id === selectedId ? 'solid' : 'subtle'} className="ml-1">
              {t.is_builtin === 1 ? '内置' : '自定义'}
            </Badge>
          </Button>
        ))}
      </div>

      {selected != null ? (
        <div className="mt-4">
          {selected.is_builtin === 1 && (
            <p className="mb-3 rounded-sm border border-dashed border-line-2 bg-paper-sink/60 px-3 py-2 text-xs leading-5 text-ink-2">
              当前为内置模板，不可直接修改；保存时将另存为自定义副本，原内置模板保持不变。
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_11rem]">
            <div className="space-y-3">
              <Field label="模板名称">
                <Input
                  aria-label="模板名称"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setDirty(true)
                  }}
                />
              </Field>
              <Field label="模板内容" error={error}>
                <Textarea
                  aria-label="模板内容"
                  rows={14}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value)
                    setDirty(true)
                    if (error != null) setError(null)
                  }}
                  className="font-mono text-xs leading-relaxed"
                />
              </Field>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
                  {saving && <Spinner size="sm" />}
                  保存
                </Button>
              </div>
            </div>

            {/* 变量说明侧注 */}
            <aside className="rounded-sm border border-line bg-paper px-3 py-3">
              <p className="overline-label">可用变量</p>
              <dl className="mt-2 space-y-2.5">
                {VAR_DOCS[activeKind].map((v) => (
                  <div key={v.name}>
                    <dt className="font-mono text-xs text-ink">{v.name}</dt>
                    <dd className="mt-0.5 text-xs leading-5 text-ink-3">{v.desc}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-3">该类别下暂无模板，可点击「恢复内置默认」生成。</p>
      )}

      {/* 恢复内置默认确认 */}
      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="恢复内置默认"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={() => void confirmReset()} disabled={resetting}>
              {resetting && <Spinner size="sm" />}
              确认恢复
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          将删除全部 5 类提示词的自定义副本，并恢复为内置默认模板。此操作不可撤销，确定继续吗？
        </p>
      </Modal>
    </Card>
  )
}
