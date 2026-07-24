import type { Metadata } from 'next'
import { HistoryView } from '@/src/components/history/HistoryView'

export const metadata: Metadata = { title: '历史' }

export default function HistoryPage() {
  return <HistoryView />
}
