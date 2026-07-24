import type { Metadata } from 'next'
import { TopNav } from '@/src/components/shell/TopNav'
import { DirectionProvider } from '@/src/components/direction/DirectionProvider'
import { Suspense } from 'react'
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
        <Suspense
          fallback={
            <main className="mx-auto max-w-7xl px-4 py-8 text-sm text-ink-3">
              正在恢复工作台……
            </main>
          }
        >
          <DirectionProvider>
            <TopNav />
            <main>{children}</main>
          </DirectionProvider>
        </Suspense>
      </body>
    </html>
  )
}
