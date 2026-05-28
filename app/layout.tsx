import type { Metadata } from 'next'
import { TopNav } from '@/src/components/shell/TopNav'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Agentic Translating · 智能体翻译工作台',
    template: '%s · Agentic Translating',
  },
  description: '多智能体翻译工作台：多 Agent 并行翻译，四阶段统筹编排，产出可对话修订的最终译文。',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-dvh">
        <TopNav />
        <main>{children}</main>
      </body>
    </html>
  )
}
