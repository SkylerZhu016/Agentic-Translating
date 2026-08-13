'use client'

// ---------------------------------------------------------------------------
// Workbench — 工作台客户端容器
//
// 左栏 TranslatePanel（原文 + 流式卡片网格）；
// 右栏统筹 stepper（任务 23）——翻译全部完成后首节点亮起，提示可进入统筹；
// 底部编辑+聊天视图（任务 24 EditorSection：final-text 选中 popover/对话/版本历史）。
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { Card } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'
import {
  CoordinatorPanel,
  SessionWorkspaceProvider,
} from '@/src/components/coordinator'
import { EditorSection } from '@/src/components/editor/EditorSection'
import { TranslatePanel } from './translate-panel'

export function Workbench() {
  // 全部 Agent 完成 → 统筹 stepper 亮起（可进入）
  const [translateReady, setTranslateReady] = useState(false)

  return (
    <SessionWorkspaceProvider>
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        overline="Workbench"
        title="工作台"
        description="面向高难文本的多方案翻译决策台：独立候选、分歧审议、证据化取舍与可回溯修改。"
      />

      {/* 三栏响应式骨架：移动端单列，lg 起 7/5 双列两行 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* 左：原文 + 翻译 */}
        <TranslatePanel className="lg:col-span-7" onAllCompleteChange={setTranslateReady} />

        {/* 右：统筹 stepper + 阶段输出面板（任务 23 完整实现；翻译就绪时亮起） */}
        <Card
          overline="Coordination"
          title="统筹阶段"
          className={[
            'lg:col-span-5 transition-shadow duration-300',
            translateReady ? 'ring-1 ring-pine/30' : '',
          ].join(' ')}
          actions={
            translateReady ? (
              <span className="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium leading-4 tracking-wide text-pine">
                <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-pine" aria-hidden />
                就绪
              </span>
            ) : undefined
          }
        >
          <CoordinatorPanel />
        </Card>

        {/* 下：编辑+聊天视图（任务 24：final-text 选中 popover + 对话修订 + 版本历史） */}
        <EditorSection />
      </div>
    </div>
    </SessionWorkspaceProvider>
  )
}
