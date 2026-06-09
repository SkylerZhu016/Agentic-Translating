import type { Metadata } from 'next'
import { ConfigPanels } from '@/src/components/config/ConfigPanels'

export const metadata: Metadata = { title: '配置' }

export default function ConfigPage() {
  return <ConfigPanels />
}
