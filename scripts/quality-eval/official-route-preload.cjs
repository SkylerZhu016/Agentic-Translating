const LOOPBACK_KEY = 'quality-eval-loopback-only'

function createRestrictedFetch(originalFetch, gatewayUrl) {
  const gateway = new URL(gatewayUrl)
  if (gateway.protocol !== 'http:' || gateway.hostname !== '127.0.0.1'
      || gateway.username || gateway.password || gateway.pathname !== '/'
      || gateway.search || gateway.hash || !gateway.port) throw new Error('invalid_loopback_gateway')
  return async function qualityEvalFetch(input, init) {
    const value = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const target = new URL(value)
    const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined))
    const authorization = headers.get('authorization') ?? ''
    const carriesFakeKey = authorization.includes(LOOPBACK_KEY)
    const officialOrigin = target.origin === 'https://api.deepseek.com'
    if (!officialOrigin && !carriesFakeKey) return originalFetch(input, init)
    const method = (init?.method ?? (typeof input === 'object' ? input.method : undefined) ?? 'GET').toUpperCase()
    if (!officialOrigin || !['/chat/completions', '/v1/chat/completions'].includes(target.pathname)
        || target.search || target.hash || target.username || target.password
        || method !== 'POST' || authorization !== `Bearer ${LOOPBACK_KEY}`
        || !(typeof input === 'string' || input instanceof URL)
        || typeof init?.body !== 'string') throw new Error('quality_eval_official_route_blocked')
    // Body and product-supplied response_format remain untouched. The real key
    // is introduced only by the already-budgeted gateway, never this process.
    return originalFetch(`${gateway.origin}/v1/chat/completions`, { ...init, headers, redirect: 'error' })
  }
}

module.exports = { createRestrictedFetch }
if (process.env.QUALITY_EVAL_GATEWAY_URL) {
  globalThis.fetch = createRestrictedFetch(globalThis.fetch.bind(globalThis), process.env.QUALITY_EVAL_GATEWAY_URL)
}
