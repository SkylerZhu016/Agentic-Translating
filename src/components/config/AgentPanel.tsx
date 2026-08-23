'use client'

// ---------------------------------------------------------------------------
// 翻译 Agent 编辑器（R1）—— 卡片列表 + 草稿卡 + E6 重复提示 + 排序
// 已存卡：key=agent.id，挂载时以服务端值播种本地编辑态
// 草稿卡：add-agent-button 追加，校验通过才 POST（model 空 → 错误可见且不发请求）
// ---------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react'
import { Badge, Button, Card, Input, Modal, Spinner, Textarea } from '@/src/components/ui'
import { TID } from '@/src/lib/testids'
import { configApi, isApiError, type Agent, type Endpoint } from './api'
import { Field, Select, Toggle, type NotifyFn } from './shared'
import { localizeDiagnosticError, useI18n } from '@/src/i18n'

interface CardInitial {
  name: string
  endpointId: number | null
  model: string
  overrideOn: boolean
  overrideText: string
}

interface Draft {
  key: string
  initial: CardInitial
}

export interface AgentPanelProps {
  agents: Agent[]
  endpoints: Endpoint[]
  notify: NotifyFn
  onChanged: () => Promise<void>
}

export function AgentPanel({ agents, endpoints, notify, onChanged }: AgentPanelProps) {
  const { t } = useI18n()
  const [drafts, setDrafts] = useState<Draft[]>([])
  const draftSeq = useRef(0)
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [moving, setMoving] = useState(false)

  // E6：≥2 个已存 Agent 同 model + 同 prompt（覆盖值，空=全局默认）→ 非阻塞提示
  const hasDuplicates = useMemo(() => {
    const seen = new Map<string, number>()
    for (const a of agents) {
      const sig = `${a.model.trim()}|${(a.prompt_override ?? '').trim()}`
      seen.set(sig, (seen.get(sig) ?? 0) + 1)
    }
    for (const n of seen.values()) if (n >= 2) return true
    return false
  }, [agents])

  function addDraft() {
    draftSeq.current += 1
    const seq = agents.length + drafts.length + 1
    setDrafts((list) => [
      ...list,
      {
        key: `draft-${draftSeq.current}`,
        initial: {
          name: `Agent ${seq}`,
          endpointId: endpoints[0]?.id ?? null,
          model: '',
          overrideOn: false,
          overrideText: '',
        },
      },
    ])
  }

  async function moveAgent(index: number, dir: -1 | 1) {
    const other = index + dir
    if (other < 0 || other >= agents.length) return
    const a = agents[index]
    const b = agents[other]
    setMoving(true)
    try {
      await Promise.all([
        configApi.updateAgent(a.id, { sort_order: b.sort_order }),
        configApi.updateAgent(b.id, { sort_order: a.sort_order }),
      ])
      await onChanged()
    } catch (e) {
      notify(t('legacy.agent.sortFailed'), {
        message: isApiError(e)
          ? localizeDiagnosticError(t, e.payload, t('config.error.tryLater'))
          : t('config.error.networkRetry'),
      })
    } finally {
      setMoving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await configApi.deleteAgent(deleteTarget.id)
      notify(t('legacy.agent.deleted', { name: deleteTarget.name }), { tone: 'inverted' })
      setDeleteTarget(null)
      await onChanged()
    } catch (e) {
      notify(t('legacy.agent.deleteFailed'), {
        message: isApiError(e)
          ? localizeDiagnosticError(t, e.payload, t('config.error.tryLater'))
          : t('config.error.networkRetry'),
      })
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Card
      overline={t('legacy.agent.overline')}
      title={t('legacy.agent.title')}
      actions={
        <Button
          variant="outline"
          size="sm"
          testId={TID.agent.addAgentButton}
          onClick={addDraft}
        >
          {t('legacy.agent.add')}
        </Button>
      }
    >
      {hasDuplicates && (
        <div className="mb-3 flex items-start gap-2 rounded-sm border border-dashed border-line-2 bg-paper-sink/60 px-3 py-2">
          <Badge variant="outline" className="mt-0.5 shrink-0">
            {t('legacy.agent.notice')}
          </Badge>
          <p className="text-xs leading-5 text-ink-2">
            {t('legacy.agent.duplicate')}
          </p>
        </div>
      )}

      {agents.length === 0 && drafts.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-8 text-center text-sm leading-6 text-ink-3">
          {t('legacy.agent.empty')}
          <br />
          {t('legacy.agent.emptyAction')}
          {endpoints.length === 0 && (
            <span className="mt-1 block text-xs text-ink-4">{t('legacy.agent.addEndpointFirst')}</span>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map((a, i) => (
            <AgentCardView
              key={a.id}
              agentId={a.id}
              sortOrder={a.sort_order}
              initial={{
                name: a.name,
                endpointId: a.endpoint_id,
                model: a.model,
                overrideOn: (a.prompt_override ?? '').trim().length > 0,
                overrideText: a.prompt_override ?? '',
              }}
              endpoints={endpoints}
              notify={notify}
              canMoveUp={i > 0 && !moving}
              canMoveDown={i < agents.length - 1 && !moving}
              onMoveUp={() => void moveAgent(i, -1)}
              onMoveDown={() => void moveAgent(i, 1)}
              onRequestDelete={() => setDeleteTarget(a)}
              onSaved={async () => {
                await onChanged()
              }}
            />
          ))}
          {drafts.map((d) => (
            <AgentCardView
              key={d.key}
              sortOrder={agents.length}
              initial={d.initial}
              endpoints={endpoints}
              notify={notify}
              canMoveUp={false}
              canMoveDown={false}
              onMoveUp={() => {}}
              onMoveDown={() => {}}
              onRequestDelete={() =>
                setDrafts((list) => list.filter((x) => x.key !== d.key))
              }
              onSaved={async () => {
                setDrafts((list) => list.filter((x) => x.key !== d.key))
                await onChanged()
              }}
            />
          ))}
        </div>
      )}

      {/* 删除确认 */}
      <Modal
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title={t('legacy.agent.deleteTitle')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Spinner size="sm" />}
              {t('legacy.agent.deleteConfirm')}
            </Button>
          </>
        }
      >
        {deleteTarget != null && (
          <p className="text-sm leading-6 text-ink-2">
            {t('legacy.agent.deleteDescription', { name: deleteTarget.name })}
          </p>
        )}
      </Modal>
    </Card>
  )
}

// ── 单张 Agent 卡片 ─────────────────────────────────────────────

interface AgentCardViewProps {
  initial: CardInitial
  endpoints: Endpoint[]
  notify: NotifyFn
  /** 存在则为已存卡（PUT），否则为草稿卡（POST） */
  agentId?: number
  sortOrder: number
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onRequestDelete: () => void
  onSaved: () => Promise<void>
}

function AgentCardView({
  initial,
  endpoints,
  notify,
  agentId,
  sortOrder,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRequestDelete,
  onSaved,
}: AgentCardViewProps) {
  const { t } = useI18n()
  const isDraft = agentId == null
  const [name, setName] = useState(initial.name)
  const [endpointId, setEndpointId] = useState<number | null>(initial.endpointId)
  const [model, setModel] = useState(initial.model)
  const [overrideOn, setOverrideOn] = useState(initial.overrideOn)
  const [overrideText, setOverrideText] = useState(initial.overrideText)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)

  async function save() {
    // 客户端校验先行：错误可见且不发请求（QA negative）
    if (model.trim().length === 0) {
      setError(t('legacy.agent.error.model'))
      return
    }
    if (endpointId == null) {
      setError(
        endpoints.length === 0
          ? t('legacy.agent.error.addEndpoint')
          : t('legacy.agent.error.selectEndpoint'),
      )
      return
    }
    if (name.trim().length === 0) {
      setError(t('legacy.agent.error.name'))
      return
    }
    setError(null)

    const payload = {
      name: name.trim(),
      endpoint_id: endpointId,
      model: model.trim(),
      prompt_override: overrideOn ? overrideText : null,
      sort_order: sortOrder,
    }
    setSaving(true)
    try {
      if (isDraft) {
        await configApi.createAgent(payload)
        notify(t('legacy.agent.created', { name: payload.name }), { tone: 'inverted' })
      } else {
        await configApi.updateAgent(agentId, payload)
        setSavedTick(true)
        setTimeout(() => setSavedTick(false), 2000)
      }
      await onSaved()
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

  return (
    <div
      data-testid={TID.agent.card}
      className="rounded-md border border-line bg-paper px-4 py-3.5"
    >
      {/* 头部：名称 + 排序 + 删除 */}
      <div className="flex items-center gap-2">
        <Input
          aria-label={t('legacy.agent.nameAria')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 max-w-44"
        />
        {isDraft && <Badge variant="outline">{t('legacy.agent.unsaved')}</Badge>}
        <div className="flex-1" />
        {!isDraft && (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('legacy.agent.moveUp')}
              onClick={onMoveUp}
              disabled={!canMoveUp}
              className="px-2"
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('legacy.agent.moveDown')}
              onClick={onMoveDown}
              disabled={!canMoveDown}
              className="px-2"
            >
              ↓
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={onRequestDelete}>
          {t('common.delete')}
        </Button>
      </div>

      {/* 端点 + 模型 */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('legacy.agent.endpoint')}>
          <Select
            aria-label={t('legacy.agent.endpointAria')}
            value={endpointId == null ? '' : String(endpointId)}
            onChange={(e) =>
              setEndpointId(e.target.value === '' ? null : Number(e.target.value))
            }
          >
            {endpoints.length === 0 && <option value="">{t('legacy.agent.noEndpoint')}</option>}
            {endpointId == null && endpoints.length > 0 && <option value="">{t('legacy.agent.selectEndpoint')}</option>}
            {endpoints.map((ep) => (
              <option key={ep.id} value={String(ep.id)}>
                {ep.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('legacy.agent.model')} error={error}>
          <Input
            testId={TID.agent.modelInput}
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              if (error != null) setError(null)
            }}
            placeholder={t('legacy.agent.modelPlaceholder')}
            className="font-mono"
          />
        </Field>
      </div>

      {/* 提示词覆盖 */}
      <div className="mt-3">
        <div className="flex items-center gap-2">
          <Toggle
            testId={TID.agent.promptOverrideToggle}
            checked={overrideOn}
            onChange={setOverrideOn}
            ariaLabel={t('legacy.agent.override')}
          />
          <span className="text-xs text-ink-2">{t('legacy.agent.override')}</span>
        </div>
        {overrideOn ? (
          <Textarea
            aria-label={t('legacy.agent.overrideAria')}
            rows={5}
            value={overrideText}
            onChange={(e) => setOverrideText(e.target.value)}
            placeholder={t('legacy.agent.promptPlaceholder', {
              placeholder: '{{source_text}}',
            })}
            className="mt-2 font-mono text-xs leading-relaxed"
          />
        ) : (
          <p className="mt-2 rounded-sm border border-dashed border-line bg-paper-sink/50 px-3 py-2 text-xs text-ink-4">
            {t('legacy.agent.globalPrompt')}
          </p>
        )}
      </div>

      {/* 底部操作 */}
      <div className="mt-3 flex items-center justify-end gap-2">
        {savedTick && <span className="text-xs text-ink-3">{t('common.saved')}</span>}
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving && <Spinner size="sm" />}
          {isDraft ? t('common.create') : t('common.save')}
        </Button>
      </div>
    </div>
  )
}
