import type { Metadata } from 'next'
import { Workbench } from '@/src/components/translate/workbench'

export const metadata: Metadata = { title: '工作台' }

export default function WorkbenchPage() {
  return <Workbench />
}
