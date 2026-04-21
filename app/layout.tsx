import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Agentic Translating',
  description: '多智能体翻译工作台',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
