import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { AgentLibraryPanel } from '@/src/components/config/AgentLibraryPanel'
import { WorkflowPresetPanel } from '@/src/components/config/WorkflowPresetPanel'
import { LocaleProvider } from '@/src/i18n'
import type { Endpoint } from '@/src/components/config/api'

const roleKeys = ['defaultWorker', 'mainAgent', 'reviewAgent', 'filterAgent', 'orchestrateAgent', 'assembleAgent', 'editingAgent']
const endpoints = [1, 2].map((id) => ({
  id,
  name: `Mock endpoint ${id}`,
  base_url: `https://mock-${id}.invalid`,
  context_window: id * 128000,
})) as Endpoint[]
const variants = ['one', 'two'].map((id) => ({
  id,
  archetypeId: id,
  catalogName: `Mock translator ${id}`,
  catalogDescription: 'Offline fixture',
  rolePrompt: 'Offline fixture',
  direction: 'en_to_zh',
  enabled: true,
  endpointOverrideId: null,
  modelOverride: null,
}))

const state = {
  profile: Object.fromEntries(roleKeys.map((key, index) => [key, {
    endpointId: 1,
    model: 'deepseek-chat',
    contextWindow: 128000,
    maxOutputTokens: 8192 + index,
  }])),
  requests: [] as Array<{ path: string; method: string; body: any }>,
  presets: [] as any[],
  revisions: [] as any[],
  notifications: [] as string[],
  remount: () => {},
}

Object.assign(window, { __outputBudgetHarness: state })

window.fetch = async (input, init) => {
  const path = String(input)
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : null
  state.requests.push({ path, method, body })
  const response = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  }))

  if (path === '/api/settings') return response([{ key: 'ui_locale', value: 'zh-CN' }])
  if (path === '/api/endpoints') return response(endpoints)
  if (/^\/api\/endpoints\/[12]\/models$/.test(path)) {
    return response({ models: ['deepseek-chat', 'deepseek-reasoner', 'other-model'].map((id) => ({ id, ownedBy: null })) })
  }
  if (path.startsWith('/api/agent-catalog?')) return response({ archetypes: [], variants })
  if (path === '/api/model-profiles/en_to_zh') {
    if (method === 'PUT') state.profile = body
    return response(state.profile)
  }
  if (path.startsWith('/api/direction-prompt-bundles?')) return response({ version: 1 })
  if (path === '/api/workflow-presets' && method === 'POST') {
    const preset = { id: 'mock-preset', name: body.name, description: body.description, currentRevisionNo: 2, deletedAt: null }
    state.presets = [preset]
    state.revisions = [1, 2].map((revisionNo) => ({
      id: `r${revisionNo}`, revisionNo, createdAt: '2026-10-21T00:00:00Z', contract: body.contract,
    }))
    return response(preset)
  }
  if (path.startsWith('/api/workflow-presets?')) return response(state.presets)
  if (path === '/api/workflow-presets/mock-preset') {
    return response({ preset: state.presets[0], revisions: state.revisions })
  }
  if (path === '/api/workflow-presets/mock-preset/restore' && method === 'POST') {
    const contract = state.revisions.find((revision) => revision.revisionNo === body.revisionNo)?.contract
    state.presets[0].currentRevisionNo = 3
    state.revisions.push({ id: 'r3', revisionNo: 3, createdAt: '2026-10-21T01:00:00Z', contract })
    return response(state.presets[0])
  }
  throw new Error(`Unmocked request: ${method} ${path}`)
}

function App() {
  const [panel, setPanel] = useState<'profile' | 'preset'>('profile')
  const [generation, setGeneration] = useState(0)
  state.remount = () => setGeneration((value) => value + 1)
  return (
    <LocaleProvider initialLocale="zh-CN">
      <main className="mx-auto max-w-7xl space-y-4 p-5">
        <nav className="flex gap-4">
          <button onClick={() => setPanel('profile')}>角色配置</button>
          <button onClick={() => setPanel('preset')}>预设配置</button>
        </nav>
        {panel === 'profile'
          ? <AgentLibraryPanel key={generation} notify={(title) => state.notifications.push(title)} />
          : <WorkflowPresetPanel key={generation} endpoints={endpoints} notify={(title) => state.notifications.push(title)} />}
      </main>
    </LocaleProvider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
