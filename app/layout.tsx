import type { Metadata } from 'next'
import { TopNav } from '@/src/components/shell/TopNav'
import { DirectionProvider } from '@/src/components/direction/DirectionProvider'
import { AppLoadingFallback } from '@/src/i18n/AppLoadingFallback'
import { LocaleProvider } from '@/src/i18n/LocaleProvider'
import { Suspense } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Agentic Translating',
    template: '%s · Agentic Translating',
  },
  description: 'A local multi-agent translation workbench.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-dvh">
        <LocaleProvider>
          <Suspense fallback={<AppLoadingFallback />}>
            <DirectionProvider>
              <TopNav />
              <main>{children}</main>
            </DirectionProvider>
          </Suspense>
        </LocaleProvider>
      </body>
    </html>
  )
}
