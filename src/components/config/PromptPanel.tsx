'use client'

// ---------------------------------------------------------------------------
// 提示词编辑面板 —— 5 kind 选项卡 + 模板筹码 + 变量侧注 + 恢复内置默认
// 内置模板保存时服务端自动另存为自定义副本（201 + 新 id），面板提示该行为
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner, Textarea } from '@/src/components/ui'
import { configApi, isApiError, type PromptKind, type PromptTemplate } from './api'
import { Field, type NotifyFn } from './shared'
import {
  localizeDiagnosticError,
  useI18n,
  type MessageKeyWithoutValues,
} from '@/src/i18n'

const KINDS: { kind: PromptKind; labelKey: MessageKeyWithoutValues }[] = [
  { kind: 'translator', labelKey: 'legacy.prompt.kind.translator' },
  { kind: 'review', labelKey: 'legacy.prompt.kind.review' },
  { kind: 'filter', labelKey: 'legacy.prompt.kind.filter' },
  { kind: 'orchestrate', labelKey: 'legacy.prompt.kind.orchestrate' },
  { kind: 'assemble', labelKey: 'legacy.prompt.kind.assemble' },
]

const VAR_DOCS: Record<PromptKind, { name: string; descKey: MessageKeyWithoutValues }[]> = {
  translator: [
    { name: '{{source_lang}}', descKey: 'legacy.prompt.var.sourceLang' },
    { name: '{{target_lang}}', descKey: 'legacy.prompt.var.targetLang' },
    { name: '{{source_text}}', descKey: 'legacy.prompt.var.sourceText' },
    { name: '{{extra_instructions}}', descKey: 'legacy.prompt.var.extraInstructions' },
  ],
  review: [
    { name: '{{source_text}}', descKey: 'legacy.prompt.var.sourceTextShort' },
    { name: '{{target_lang}}', descKey: 'legacy.prompt.var.targetLangShort' },
    { name: '{{translations}}', descKey: 'legacy.prompt.var.translations' },
  ],
  filter: [
    { name: '{{source_text}}', descKey: 'legacy.prompt.var.sourceTextShort' },
    { name: '{{review_output}}', descKey: 'legacy.prompt.var.reviewOutput' },
  ],
  orchestrate: [
    { name: '{{source_text}}', descKey: 'legacy.prompt.var.sourceTextShort' },
    { name: '{{selected_translations}}', descKey: 'legacy.prompt.var.selectedTranslations' },
    { name: '{{review_output}}', descKey: 'legacy.prompt.var.reviewOutput' },
    { name: '{{filter_output}}', descKey: 'legacy.prompt.var.filterOutput' },
  ],
  assemble: [
    { name: '{{source_text}}', descKey: 'legacy.prompt.var.sourceTextShort' },
    { name: '{{orchestrate_output}}', descKey: 'legacy.prompt.var.orchestrateOutput' },
    { name: '{{selected_translations}}', descKey: 'legacy.prompt.var.selectedTranslations' },
  ],
}

export interface PromptPanelProps {
  prompts: PromptTemplate[]
  notify: NotifyFn
  onChanged: () => Promise<void>
}

export function PromptPanel({ prompts, notify, onChanged }: PromptPanelProps) {
  const { t } = useI18n()
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
      setError(t('legacy.prompt.error.required'))
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
      notify(copied ? t('legacy.prompt.savedCopy') : t('legacy.prompt.saved'), {
        message: copied ? t('legacy.prompt.savedCopyDetail') : undefined,
        tone: 'inverted',
      })
      await onChanged()
      setSelectedId(res.id)
      setName(res.name)
      setContent(res.content)
      setDirty(false)
    } catch (e) {
      notify(t('config.error.save'), {
        message: isApiError(e)
          ? localizeDiagnosticError(t, e.payload, t('config.error.tryLater'))
          : t('config.error.networkRetry'),
      })
    } finally {
      setSaving(false)
    }
  }

  async function confirmReset() {
    setResetting(true)
    try {
      await configApi.resetPrompts()
      notify(t('legacy.prompt.resetDone'), {
        message: t('legacy.prompt.resetDoneDetail'),
        tone: 'inverted',
      })
      setResetOpen(false)
      await onChanged()
    } catch (e) {
      notify(t('legacy.prompt.resetFailed'), {
        message: isApiError(e)
          ? localizeDiagnosticError(t, e.payload, t('config.error.tryLater'))
          : t('config.error.networkRetry'),
      })
      setResetOpen(false)
    } finally {
      setResetting(false)
    }
  }

  return (
    <Card
      overline={t('legacy.prompt.overline')}
      title={t('legacy.prompt.title')}
      actions={
        <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
          {t('legacy.prompt.reset')}
        </Button>
      }
    >
      {/* kind 选项卡 */}
      <div role="tablist" aria-label={t('legacy.prompt.categoryAria')} className="flex flex-wrap gap-1.5">
        {KINDS.map(({ kind, labelKey }) => (
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
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* 模板筹码（内置 + 自定义副本） */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {kindList.map((template) => (
          <Button
            key={template.id}
            variant={template.id === selectedId ? 'primary' : 'outline'}
            size="sm"
            onClick={() => selectTemplate(template)}
          >
            {template.name}
            <Badge variant={template.id === selectedId ? 'solid' : 'subtle'} className="ml-1">
              {template.is_builtin === 1
                ? t('legacy.prompt.builtin')
                : t('legacy.prompt.custom')}
            </Badge>
          </Button>
        ))}
      </div>

      {selected != null ? (
        <div className="mt-4">
          {selected.is_builtin === 1 && (
            <p className="mb-3 rounded-sm border border-dashed border-line-2 bg-paper-sink/60 px-3 py-2 text-xs leading-5 text-ink-2">
              {t('legacy.prompt.builtinHint')}
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_11rem]">
            <div className="space-y-3">
              <Field label={t('legacy.prompt.templateName')}>
                <Input
                  aria-label={t('legacy.prompt.templateName')}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setDirty(true)
                  }}
                />
              </Field>
              <Field label={t('legacy.prompt.templateContent')} error={error}>
                <Textarea
                  aria-label={t('legacy.prompt.templateContent')}
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
                  {t('common.save')}
                </Button>
              </div>
            </div>

            {/* 变量说明侧注 */}
            <aside className="rounded-sm border border-line bg-paper px-3 py-3">
              <p className="overline-label">{t('legacy.prompt.variables')}</p>
              <dl className="mt-2 space-y-2.5">
                {VAR_DOCS[activeKind].map((v) => (
                  <div key={v.name}>
                    <dt className="font-mono text-xs text-ink">{v.name}</dt>
                    <dd className="mt-0.5 text-xs leading-5 text-ink-3">{t(v.descKey)}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-3">{t('legacy.prompt.empty')}</p>
      )}

      {/* 恢复内置默认确认 */}
      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t('legacy.prompt.reset')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void confirmReset()} disabled={resetting}>
              {resetting && <Spinner size="sm" />}
              {t('legacy.prompt.resetConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink-2">
          {t('legacy.prompt.resetDescription')}
        </p>
      </Modal>
    </Card>
  )
}
