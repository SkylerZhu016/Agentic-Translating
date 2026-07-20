// ---------------------------------------------------------------------------
// 配置面板 API 层 —— 任务 15 配置路由的浏览器端封装
// 统一错误形状：ApiError{ status, payload }，message 取自服务端 error 字段
// ---------------------------------------------------------------------------

import type { ConfigPresetRow, FullPreset } from '@/src/lib/contracts/types'

export interface Endpoint {
  id: number
  name: string
  base_url: string
  api_key: string
  created_at: string
}

export interface Agent {
  id: number
  name: string
  endpoint_id: number
  model: string
  prompt_override: string | null
  sort_order: number
  created_at: string
}

export interface CoordinatorConfig {
  id: number
  endpoint_id: number | null
  model: string
  chat_endpoint_id: number | null
  chat_model: string
  updated_at: string
  /** PUT 响应可能附带 flash 警告（R2） */
  warning?: string
  warning_id?: string
}

/** POST /api/presets/{id}/load 响应形状 */
export interface LoadPresetResult {
  applied: boolean
  warnings?: { kind: string; agentIndex?: number; endpointId: number }[]
}

export type PromptKind = 'translator' | 'review' | 'filter' | 'orchestrate' | 'assemble'

export interface PromptTemplate {
  id: number
  kind: PromptKind
  name: string
  content: string
  is_builtin: number
  updated_at: string
}

export class ApiError extends Error {
  status: number
  payload: unknown

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

/** DELETE /api/endpoints/[id] 409 时的负载形状（E30） */
export interface EndpointDeleteConflict {
  error: string
  usedBySessions: string[]
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `请求失败（HTTP ${res.status}）`
    throw new ApiError(message, res.status, body)
  }
  return body as T
}

export interface CoordinatorPutPayload {
  endpoint_id: number | null
  model: string
  chat_endpoint_id: number | null
  /** 留空时省略，由服务端回落默认 */
  chat_model?: string
  /** R2：勾选"不再提示"后携带 */
  suppress_warnings?: string[]
}

export const configApi = {
  // ── 端点 ────────────────────────────────────────────────
  listEndpoints: () => request<Endpoint[]>('/api/endpoints'),
  createEndpoint: (data: { name: string; base_url: string; api_key: string }) =>
    request<Endpoint>('/api/endpoints', { method: 'POST', body: JSON.stringify(data) }),
  updateEndpoint: (
    id: number,
    data: { name?: string; base_url?: string; api_key?: string },
  ) =>
    request<Endpoint>(`/api/endpoints/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  /** force=true 时绕过会话引用软锁（会话持有快照，删除不影响历史） */
  deleteEndpoint: (id: number, opts?: { force?: boolean }) =>
    request<{ success: true }>(`/api/endpoints/${id}${opts?.force ? '?force=1' : ''}`, {
      method: 'DELETE',
    }),

  // ── 翻译 Agent ──────────────────────────────────────────
  listAgents: () => request<Agent[]>('/api/agents'),
  createAgent: (data: {
    name: string
    endpoint_id: number
    model: string
    prompt_override: string | null
    sort_order: number
  }) => request<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (
    id: number,
    data: Partial<{
      name: string
      endpoint_id: number
      model: string
      prompt_override: string | null
      sort_order: number
    }>,
  ) => request<Agent>(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: number) =>
    request<{ success: true }>(`/api/agents/${id}`, { method: 'DELETE' }),

  // ── 统筹（单例；未配置时 GET 404 → null） ─────────────────
  getCoordinator: async (): Promise<CoordinatorConfig | null> => {
    try {
      return await request<CoordinatorConfig>('/api/coordinator')
    } catch (e) {
      if (isApiError(e) && e.status === 404) return null
      throw e
    }
  },
  putCoordinator: (data: CoordinatorPutPayload) =>
    request<CoordinatorConfig>('/api/coordinator', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // ── 提示词模板 ──────────────────────────────────────────
  listPrompts: () => request<PromptTemplate[]>('/api/prompts'),
  /** 对内置模板 PUT 时服务端另存为自定义副本（201 + 新 id） */
  updatePrompt: (id: number, data: { name?: string; content?: string }) =>
    request<PromptTemplate>(`/api/prompts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  resetPrompts: () =>
    request<{ success: true; prompts: PromptTemplate[] }>('/api/prompts/reset', {
      method: 'POST',
    }),

  // ── 预设 ──────────────────────────────────────────────
  listPresets: () => request<ConfigPresetRow[]>('/api/presets'),
  getPreset: (id: number) => request<FullPreset>(`/api/presets/${id}`),
  createPreset: (opts: {
    name: string
    description?: string
    fromCurrentConfig?: boolean
    fromPresetId?: number
  }) => request<{ id: number }>('/api/presets', { method: 'POST', body: JSON.stringify(opts) }),
  updatePreset: (
    id: number,
    body: {
      name?: string
      description?: string
      agents?: any[]
      coordinator?: any
      prompts?: any[]
    },
  ) => request<void>(`/api/presets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deletePreset: (id: number) => request<void>(`/api/presets/${id}`, { method: 'DELETE' }),
  loadPreset: (id: number, force?: boolean) =>
    request<LoadPresetResult>(`/api/presets/${id}/load`, {
      method: 'POST',
      body: JSON.stringify({ force: force === true }),
    }),
}
