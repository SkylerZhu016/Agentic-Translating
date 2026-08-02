import { resolveModelsUrl } from './endpoint-url'

export interface DiscoveredModel {
  id: string
  ownedBy: string | null
}

interface ModelListItem {
  id?: unknown
  owned_by?: unknown
}

export class ModelDiscoveryError extends Error {
  status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ModelDiscoveryError'
    this.status = status
  }
}

export async function discoverEndpointModels(
  endpoint: {
    baseUrl: string
    chatCompletionsPath?: string | null
    apiKey: string
  },
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {},
): Promise<DiscoveredModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  )

  try {
    const response = await fetchImpl(resolveModelsUrl(endpoint), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(endpoint.apiKey
          ? { Authorization: `Bearer ${endpoint.apiKey}` }
          : {}),
      },
      cache: 'no-store',
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new ModelDiscoveryError(
        `模型列表请求失败（HTTP ${response.status}）`,
        response.status,
      )
    }

    const payload = await response.json().catch(() => null) as {
      data?: unknown
    } | null
    if (!payload || !Array.isArray(payload.data)) {
      throw new ModelDiscoveryError('端点返回了无法识别的模型列表')
    }

    const unique = new Map<string, DiscoveredModel>()
    for (const item of payload.data.slice(0, 2_000) as ModelListItem[]) {
      if (typeof item?.id !== 'string' || !item.id.trim()) continue
      const id = item.id.trim()
      unique.set(id, {
        id,
        ownedBy:
          typeof item.owned_by === 'string' && item.owned_by.trim()
            ? item.owned_by.trim()
            : null,
      })
    }

    return [...unique.values()].sort((a, b) =>
      a.id.localeCompare(b.id, undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    )
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelDiscoveryError('读取模型列表超时')
    }
    throw new ModelDiscoveryError('无法连接模型列表接口')
  } finally {
    clearTimeout(timeout)
  }
}
