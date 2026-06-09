'use client'

// ---------------------------------------------------------------------------
// 统筹配置面板 —— 端点/模型 + 聊天模型（可选）+ R2 flash 警告闭环
// 闭环：保存 → 响应含 warning → flash-warning Modal（精确文案）
//       → 勾 dont-show-again-checkbox → 确定 → 带 suppress_warnings 重存
//       → 服务端持久化抑制，此后保存不再返回 warning（AC22）
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { Button, Card, Input, Modal, Spinner } from '@/src/components/ui'
import { TID } from '@/src/lib/testids'
import {
  configApi,
  isApiError,
  type CoordinatorConfig,
  type CoordinatorPutPayload,
  type Endpoint,
} from './api'
import { Field, Select, type NotifyFn } from './shared'

export interface CoordinatorPanelProps {
  coordinator: CoordinatorConfig | null
  endpoints: Endpoint[]
  notify: NotifyFn
}

export function CoordinatorPanel({ coordinator, endpoints, notify }: CoordinatorPanelProps) {
  const [endpointId, setEndpointId] = useState<number | null>(coordinator?.endpoint_id ?? null)
  const [model, setModel] = useState(coordinator?.model ?? '')
  const [chatEndpointId, setChatEndpointId] = useState<number | null>(
    coordinator?.chat_endpoint_id ?? null,
  )
  const [chatModel, setChatModel] = useState(coordinator?.chat_model ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // R2 flash 警告
  const [flashOpen, setFlashOpen] = useState(false)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const [suppressing, setSuppressing] = useState(false)

  function buildPayload(): CoordinatorPutPayload | null {
    if (model.trim().length === 0) {
      setError('请输入统筹模型名')
      return null
    }
    setError(null)
    const payload: CoordinatorPutPayload = {
      endpoint_id: endpointId,
      model: model.trim(),
      chat_endpoint_id: chatEndpointId,
    }
    const chat = chatModel.trim()
    if (chat.length > 0) payload.chat_model = chat // 留空则省略，服务端回落默认
    return payload
  }

  async function save() {
    const payload = buildPayload()
    if (payload == null) return // 校验失败，不发请求
    setSaving(true)
    try {
      const res = await configApi.putCoordinator(payload)
      if (res.warning != null) {
        setDontShowAgain(false)
        setFlashOpen(true)
      } else {
        notify('统筹配置已保存', { tone: 'inverted' })
      }
    } catch (e) {
      notify('保存失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setSaving(false)
    }
  }

  async function confirmFlash() {
    if (!dontShowAgain) {
      setFlashOpen(false)
      notify('统筹配置已保存', { tone: 'inverted' })
      return
    }
    const payload = buildPayload()
    setSuppressing(true)
    try {
      await configApi.putCoordinator({
        ...(payload ?? {
          endpoint_id: endpointId,
          model: model.trim(),
          chat_endpoint_id: chatEndpointId,
        }),
        suppress_warnings: ['flash_coordinator'],
      })
      setFlashOpen(false)
      notify('统筹配置已保存，flash 警告将不再提示', { tone: 'inverted' })
    } catch (e) {
      notify('抑制警告失败', { message: isApiError(e) ? e.message : '网络错误，请重试' })
    } finally {
      setSuppressing(false)
    }
  }

  return (
    <Card overline="Coordinator" title="统筹">
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="统筹端点">
            <Select
              aria-label="统筹端点"
              value={endpointId == null ? '' : String(endpointId)}
              onChange={(e) =>
                setEndpointId(e.target.value === '' ? null : Number(e.target.value))
              }
            >
              <option value="">未指定</option>
              {endpoints.map((ep) => (
                <option key={ep.id} value={String(ep.id)}>
                  {ep.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="统筹模型" error={error}>
            <Input
              testId={TID.coordinator.modelInput}
              value={model}
              onChange={(e) => {
                setModel(e.target.value)
                if (error != null) setError(null)
              }}
              placeholder="如 gpt-4o"
              className="font-mono"
            />
          </Field>
          <Field label="聊天端点（可选）">
            <Select
              aria-label="聊天端点"
              value={chatEndpointId == null ? '' : String(chatEndpointId)}
              onChange={(e) =>
                setChatEndpointId(e.target.value === '' ? null : Number(e.target.value))
              }
            >
              <option value="">未指定</option>
              {endpoints.map((ep) => (
                <option key={ep.id} value={String(ep.id)}>
                  {ep.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="聊天模型（可选）" hint="用于对话式修改；留空则由服务端回落默认。">
            <Input
              aria-label="聊天模型"
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              placeholder="留空则使用默认"
              className="font-mono"
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs leading-5 text-ink-4">
            统筹模型驱动审查、筛选、编排、组装四阶段。
          </p>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving && <Spinner size="sm" />}
            保存
          </Button>
        </div>
      </div>

      {/* R2 flash 警告弹窗 */}
      <Modal
        open={flashOpen}
        onClose={() => setFlashOpen(false)}
        title="统筹模型建议"
        testId={TID.coordinator.flashWarning}
        footer={
          <Button size="sm" onClick={() => void confirmFlash()} disabled={suppressing}>
            {suppressing && <Spinner size="sm" />}
            确定
          </Button>
        }
      >
        <p className="text-sm font-medium leading-6 text-ink">
          不推荐使用flash模型进行统筹
        </p>
        <p className="mt-1.5 text-xs leading-5 text-ink-3">
          flash 级模型偏快但推理较弱，四阶段统筹（审查/筛选/编排/组装）更依赖稳定的长文推理能力，建议改用旗舰级模型。
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            data-testid={TID.coordinator.dontShowAgainCheckbox}
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          <span className="text-sm text-ink-2">不再提示</span>
        </label>
      </Modal>
    </Card>
  )
}
