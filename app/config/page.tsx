import type { Metadata } from 'next'
import { Button, Card } from '@/src/components/ui'
import { PageHeader } from '@/src/components/shell/PageHeader'

export const metadata: Metadata = { title: '配置' }

const emptyBox =
  'rounded-sm border border-dashed border-line-2 bg-paper/60 px-4 py-8 text-center text-sm leading-6 text-ink-4'

export default function ConfigPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageHeader
        overline="Settings"
        title="配置"
        description="管理 OpenAI 兼容端点、翻译 Agent 阵容与统筹模型。配置保存在本机，不上传。"
      />

      <div className="grid max-w-3xl grid-cols-1 gap-5">
        <Card
          overline="Endpoints"
          title="端点"
          actions={<Button variant="outline" size="sm">添加端点</Button>}
        >
          <div className={emptyBox}>
            尚未添加端点。端点是 OpenAI 兼容的模型服务地址（Base URL + API Key）。
          </div>
        </Card>

        <Card
          overline="Agents"
          title="翻译 Agent"
          actions={<Button variant="outline" size="sm">添加 Agent</Button>}
        >
          <div className={emptyBox}>
            尚未配置翻译 Agent。多名 Agent 将并行翻译同一原文，供统筹管道择优合成。
          </div>
        </Card>

        <Card overline="Coordinator" title="统筹">
          <div className={emptyBox}>
            统筹模型驱动审查、筛选、编排、组装四阶段。未单独配置时将复用端点默认模型。
          </div>
        </Card>
      </div>
    </div>
  )
}
