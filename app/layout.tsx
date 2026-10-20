import type { Metadata } from 'next'
import { TopNav } from '@/src/components/shell/TopNav'
import { DirectionProvider } from '@/src/components/direction/DirectionProvider'
import { AppLoadingFallback } from '@/src/i18n/AppLoadingFallback'
import { LocaleProvider } from '@/src/i18n/LocaleProvider'
import { AppearanceSync } from '@/src/components/appearance/AppearanceSync'
import { APPEARANCE_BOOTSTRAP_SOURCE } from '@/src/lib/appearance/bootstrap'
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
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          id="appearance-before-paint"
          dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP_SOURCE }}
        />
      </head>
      <body className="min-h-dvh">
        <AppearanceSync />
        <LocaleProvider>
          <Suspense fallback={<AppLoadingFallback />}>
            <DirectionProvider>
              <TopNav />
              <main id="main-content" tabIndex={-1}>{children}</main>
            </DirectionProvider>
          </Suspense>
        </LocaleProvider>
      </body>
    </html>
  )
}
