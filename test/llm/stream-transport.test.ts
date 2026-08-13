import { afterEach, describe, expect, it } from 'vitest'
import http from 'http'
import {
  chatCompletion,
  isAsyncIterable,
  type LLMStreamEvent,
} from '../../src/lib/llm/client'

const servers: http.Server[] = []

async function collectDone(result: unknown) {
  expect(isAsyncIterable(result)).toBe(true)
  let done: Extract<LLMStreamEvent, { type: 'done' }> | undefined
  for await (const event of result as AsyncIterable<LLMStreamEvent>) {
    if (event.type === 'done') done = event
  }
  return done
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
})

describe('LLM stream transport metadata', () => {
  it('distinguishes provider JSON fallback from a real SSE stream', async () => {
    let requestNo = 0
    const server = http.createServer((_request, response) => {
      requestNo += 1
      if (requestNo === 1) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [
              { message: { content: 'OK' }, finish_reason: 'stop' },
            ],
          }),
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { content: 'OK' },
              finish_reason: 'stop',
            },
          ],
        })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address() as { port: number }
    const endpoint = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'secret',
    }
    const request = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'OK' }],
      stream: true as const,
    }

    const fallback = await chatCompletion(endpoint, request)
    expect((await collectDone(fallback))?.transport).toBe('json_fallback')

    const streamed = await chatCompletion(endpoint, request)
    expect((await collectDone(streamed))?.transport).toBe('sse')
  })
})
