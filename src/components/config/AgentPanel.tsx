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
      notify('排序失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setMoving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await configApi.deleteAgent(deleteTarget.id)
      notify(`Agent「${deleteTarget.name}」已删除`, { tone: 'inverted' })
      setDeleteTarget(null)
      await onChanged()
    } catch (e) {
      notify('删除失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Card
      overline="Agents"
      title="翻译 Agent"
      actions={
        <Button
          variant="outline"
          size="sm"
          testId={TID.agent.addAgentButton}
          onClick={addDraft}
        >
          添加 Agent
        </Button>
      }
    >
      {hasDuplicates && (
        <div className="mb-3 flex items-start gap-2 rounded-sm border border-dashed border-line-2 bg-paper-sink/60 px-3 py-2">
          <Badge variant="outline" className="mt-0.5 shrink-0">
            提示
          </Badge>
          <p className="text-xs leading-5 text-ink-2">
            存在配置相同的 Agent：模型与提示词完全一致。仍可保存，但并行翻译将产出趋同的译稿。
          </p>
        </div>
      )}

      {agents.length === 0 && drafts.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-8 text-center text-sm leading-6 text-ink-3">
          尚未配置翻译 Agent。多名 Agent 将并行翻译同一原文，供统筹管道择优合成。
          <br />
          点击右上角「添加 Agent」开始配置。
          {endpoints.length === 0 && (
            <span className="mt-1 block text-xs text-ink-4">（请先在上方添加端点）</span>
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
        title="删除 Agent"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button size="sm" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Spinner size="sm" />}
              确认删除
            </Button>
          </>
        }
      >
        {deleteTarget != null && (
          <p className="text-sm leading-6 text-ink-2">
            确定删除 Agent「{deleteTarget.name}」吗？历史会话不受影响（会话保存的是配置快照）。
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
      setError('模型名不能为空')
      return
    }
    if (endpointId == null) {
      setError(endpoints.length === 0 ? '请先在上方添加端点' : '请选择端点')
      return
    }
    if (name.trim().length === 0) {
      setError('请输入名称')
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
        notify(`Agent「${payload.name}」已创建`, { tone: 'inverted' })
      } else {
        await configApi.updateAgent(agentId, payload)
        setSavedTick(true)
        setTimeout(() => setSavedTick(false), 2000)
      }
      await onSaved()
    } catch (e) {
      notify('保存失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
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
          aria-label="Agent 名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 max-w-44"
        />
        {isDraft && <Badge variant="outline">未保存</Badge>}
        <div className="flex-1" />
        {!isDraft && (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label="上移"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              className="px-2"
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="下移"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              className="px-2"
            >
              ↓
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={onRequestDelete}>
          删除
        </Button>
      </div>

      {/* 端点 + 模型 */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="端点">
          <Select
            aria-label="选择端点"
            value={endpointId == null ? '' : String(endpointId)}
            onChange={(e) =>
              setEndpointId(e.target.value === '' ? null : Number(e.target.value))
            }
          >
            {endpoints.length === 0 && <option value="">（尚无端点）</option>}
            {endpointId == null && endpoints.length > 0 && <option value="">请选择…</option>}
            {endpoints.map((ep) => (
              <option key={ep.id} value={String(ep.id)}>
                {ep.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="模型" error={error}>
          <Input
            testId={TID.agent.modelInput}
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              if (error != null) setError(null)
            }}
            placeholder="如 gpt-4o"
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
            ariaLabel="覆盖全局默认提示词"
          />
          <span className="text-xs text-ink-2">覆盖全局默认提示词</span>
        </div>
        {overrideOn ? (
          <Textarea
            aria-label="提示词覆盖内容"
            rows={5}
            value={overrideText}
            onChange={(e) => setOverrideText(e.target.value)}
            placeholder="输入该 Agent 专属提示词，支持 {{source_text}} 等变量"
            className="mt-2 font-mono text-xs leading-relaxed"
          />
        ) : (
          <p className="mt-2 rounded-sm border border-dashed border-line bg-paper-sink/50 px-3 py-2 text-xs text-ink-4">
            使用全局默认提示词
          </p>
        )}
      </div>

      {/* 底部操作 */}
      <div className="mt-3 flex items-center justify-end gap-2">
        {savedTick && <span className="text-xs text-ink-3">已保存</span>}
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving && <Spinner size="sm" />}
          {isDraft ? '创建' : '保存'}
        </Button>
      </div>
    </div>
  )
}
