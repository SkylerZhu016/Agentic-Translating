import type { Metadata } from 'next'
import { TID } from '@/src/lib/testids'
import { Button, Card, Textarea } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'

export const metadata: Metadata = { title: '工作台' }

// 四阶段统筹管道（与 contracts/types.ts 的 Stage 一一对应）
const STAGES = [
  { key: 'review', label: '审查', hint: '评析各 Agent 译文优劣' },
  { key: 'filter', label: '筛选', hint: '择优保留候选译文' },
  { key: 'orchestrate', label: '编排', hint: '规划整合与修订策略' },
  { key: 'assemble', label: '组装', hint: '合成最终译文' },
] as const

const emptyBox =
  'rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-6 text-center text-sm leading-6 text-ink-4'

export default function WorkbenchPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        overline="Workbench"
        title="工作台"
        description="粘贴原文，多名翻译 Agent 并行产出；统筹管道经审查、筛选、编排、组装四阶段合成最终译文。"
      />

      {/* 空态 CTA：未配置端点 / Agent 时引导（面板就绪后由 21-24 任务按状态替换） */}
      <section className="mb-6 rounded-md border border-dashed border-line-2 bg-paper-raise/70 px-6 py-10 text-center">
        <p className="overline-label">Get Started</p>
        <h2 className="mt-2 font-serif text-lg font-semibold text-ink">从一次配置开始</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-3">
          工作台需要至少一个可用端点与一名翻译 Agent，才能开始并行翻译与统筹。
        </p>
        <Button href="/config" className="mt-5">
          请先配置端点与翻译 Agent
        </Button>
      </section>

      {/* 三栏响应式骨架：移动端单列，lg 起 7/5 双列两行 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* 左：原文 + 翻译 */}
        <Card overline="Source" title="原文" className="lg:col-span-7">
          <Textarea
            testId={TID.translate.sourceInput}
            rows={9}
            placeholder="粘贴或输入待译原文……"
            aria-label="原文输入"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-ink-4">支持长文，译文将由多名 Agent 并行产出</p>
            <Button testId={TID.translate.translateButton}>开始翻译</Button>
          </div>
          <div className={`mt-4 ${emptyBox}`}>各翻译 Agent 的流式输出将在此并列显示</div>
        </Card>

        {/* 右：统筹 stepper */}
        <Card overline="Coordination" title="统筹阶段" className="lg:col-span-5">
          <ol data-testid={TID.stage.stepper} className="space-y-0">
            {STAGES.map((stage, i) => (
              <li key={stage.key} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xs border border-line-2 bg-paper-raise font-serif text-sm text-ink-2">
                    {i + 1}
                  </span>
                  {i < STAGES.length - 1 && <span className="my-1 w-px flex-1 bg-line" aria-hidden />}
                </div>
                <div className={i < STAGES.length - 1 ? 'pb-5' : ''}>
                  <p className="text-sm font-medium leading-7 text-ink">{stage.label}</p>
                  <p className="text-xs leading-5 text-ink-3">{stage.hint}</p>
                  <p className="mt-1 text-xs text-ink-4">待运行</p>
                </div>
              </li>
            ))}
          </ol>
          <div data-testid={TID.stage.outputPanel} className={`mt-4 ${emptyBox}`}>
            阶段输出将在运行后显示于此
          </div>
        </Card>

        {/* 下：最终译文（poem-text 排版） */}
        <Card overline="Final Text" title="最终译文" className="lg:col-span-7">
          <div data-testid={TID.edit.finalText} className="poem-text min-h-56">
            <span className="text-ink-4">
              译文将在组装完成后呈现于此——宋体、松行距、微字距，适合中文长读。
            </span>
          </div>
        </Card>

        {/* 下：对话修订 */}
        <Card overline="Chat" title="对话修订" className="lg:col-span-5">
          <div data-testid={TID.edit.chatPanel} className="flex min-h-56 items-center justify-center">
            <p className="max-w-60 text-center text-sm leading-6 text-ink-4">
              选中译文片段提出修改指令，或与统筹 Agent 持续对话打磨译文
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
