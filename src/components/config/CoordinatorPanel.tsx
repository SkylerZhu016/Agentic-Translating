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
import { localizeDiagnosticError, useI18n } from '@/src/i18n'

export interface CoordinatorPanelProps {
  coordinator: CoordinatorConfig | null
  endpoints: Endpoint[]
  notify: NotifyFn
}

export function CoordinatorPanel({ coordinator, endpoints, notify }: CoordinatorPanelProps) {
  const { t } = useI18n()
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
      setError(t('legacy.coordinator.error.model'))
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
        notify(t('legacy.coordinator.saved'), { tone: 'inverted' })
      }
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

  async function confirmFlash() {
    if (!dontShowAgain) {
      setFlashOpen(false)
      notify(t('legacy.coordinator.saved'), { tone: 'inverted' })
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
      notify(t('legacy.coordinator.savedSuppressed'), { tone: 'inverted' })
    } catch (e) {
      notify(t('legacy.coordinator.suppressFailed'), {
        message: isApiError(e)
          ? localizeDiagnosticError(t, e.payload, t('config.error.tryLater'))
          : t('config.error.networkRetry'),
      })
    } finally {
      setSuppressing(false)
    }
  }

  return (
    <Card overline={t('legacy.coordinator.overline')} title={t('legacy.coordinator.title')}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('legacy.coordinator.endpoint')}>
            <Select
              aria-label={t('legacy.coordinator.endpoint')}
              value={endpointId == null ? '' : String(endpointId)}
              onChange={(e) =>
                setEndpointId(e.target.value === '' ? null : Number(e.target.value))
              }
            >
              <option value="">{t('legacy.coordinator.unspecified')}</option>
              {endpoints.map((ep) => (
                <option key={ep.id} value={String(ep.id)}>
                  {ep.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('legacy.coordinator.model')} error={error}>
            <Input
              testId={TID.coordinator.modelInput}
              value={model}
              onChange={(e) => {
                setModel(e.target.value)
                if (error != null) setError(null)
              }}
              placeholder={t('legacy.agent.modelPlaceholder')}
              className="font-mono"
            />
          </Field>
          <Field label={t('legacy.coordinator.chatEndpoint')}>
            <Select
              aria-label={t('legacy.coordinator.chatEndpointAria')}
              value={chatEndpointId == null ? '' : String(chatEndpointId)}
              onChange={(e) =>
                setChatEndpointId(e.target.value === '' ? null : Number(e.target.value))
              }
            >
              <option value="">{t('legacy.coordinator.unspecified')}</option>
              {endpoints.map((ep) => (
                <option key={ep.id} value={String(ep.id)}>
                  {ep.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('legacy.coordinator.chatModel')}
            hint={t('legacy.coordinator.chatModelHint')}
          >
            <Input
              aria-label={t('legacy.coordinator.chatModelAria')}
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              placeholder={t('legacy.coordinator.chatModelPlaceholder')}
              className="font-mono"
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs leading-5 text-ink-4">
            {t('legacy.coordinator.description')}
          </p>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving && <Spinner size="sm" />}
            {t('common.save')}
          </Button>
        </div>
      </div>

      {/* R2 flash 警告弹窗 */}
      <Modal
        open={flashOpen}
        onClose={() => setFlashOpen(false)}
        title={t('legacy.coordinator.warningTitle')}
        testId={TID.coordinator.flashWarning}
        footer={
          <Button size="sm" onClick={() => void confirmFlash()} disabled={suppressing}>
            {suppressing && <Spinner size="sm" />}
            {t('legacy.coordinator.confirm')}
          </Button>
        }
      >
        <p className="text-sm font-medium leading-6 text-ink">
          {t('legacy.coordinator.warningHeading')}
        </p>
        <p className="mt-1.5 text-xs leading-5 text-ink-3">
          {t('legacy.coordinator.warningDescription')}
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            data-testid={TID.coordinator.dontShowAgainCheckbox}
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          <span className="text-sm text-ink-2">{t('legacy.coordinator.dontShowAgain')}</span>
        </label>
      </Modal>
    </Card>
  )
}
