'use client'

import { useEffect, useState } from 'react'
import { Badge, Button, Card } from '@/src/components/ui'
import type { NotifyFn } from './shared'

export function DirectionSettingsCard({ notify }: { notify: NotifyFn }) {
  const [suppressed, setSuppressed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [desktop, setDesktop] = useState(false)

  useEffect(() => {
    setDesktop(Boolean(window.agenticDesktop))
    void fetch('/api/settings')
      .then((response) => response.ok ? response.json() : [])
      .then((settings: Array<{ key: string; value: string }>) => {
        setSuppressed(
          settings.find(
            (entry) => entry.key === 'suppress_direction_switch_warning',
          )?.value === '1',
        )
      })
  }, [])

  async function restoreWarning() {
    setSaving(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'suppress_direction_switch_warning',
          value: '0',
        }),
      })
      if (!response.ok) throw new Error('设置保存失败')
      setSuppressed(false)
      notify('方向切换提示已恢复', { tone: 'inverted' })
    } catch (error) {
      notify('保存失败', {
        message: error instanceof Error ? error.message : '请稍后重试',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      overline="Workspace"
      title="方向切换"
      actions={
        <Badge variant={suppressed ? 'subtle' : 'outline'}>
          {suppressed ? '提示已关闭' : '提示已启用'}
        </Badge>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm leading-6 text-ink-3">
          切换英译中与中译英会离开当前会话，但不会取消服务端正在执行的任务。
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={!suppressed || saving}
          onClick={() => void restoreWarning()}
        >
          恢复方向切换提示
        </Button>
        {desktop && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.agenticDesktop?.openDataDirectory()}
            >
              打开数据目录
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.agenticDesktop?.openDiagnosticLogs()}
            >
              打开诊断日志
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}
