import { afterEach, describe, expect, test } from 'bun:test'

import { KhloeiAppClient } from '../src/app-client'

const originalFetch = globalThis.fetch
const originalEnvironment = {
  appUrl: process.env.KHLOEI_APP_URL,
  bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  token: process.env.KHLOEI_AGENT_WORKER_TOKEN,
}

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env.KHLOEI_APP_URL = originalEnvironment.appUrl
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = originalEnvironment.bypass
  process.env.KHLOEI_AGENT_WORKER_TOKEN = originalEnvironment.token
})

describe('Khloei app callbacks', () => {
  test('send both Vercel protection and application authentication', async () => {
    process.env.KHLOEI_APP_URL = 'https://khloei.example'
    process.env.KHLOEI_AGENT_WORKER_TOKEN = 'worker-token'
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'protection-token'
    let observedHeaders = new Headers()

    globalThis.fetch = (async (_input, init) => {
      observedHeaders = new Headers(init?.headers)
      return Response.json({ events: [], gatewayState: { version: 1 } })
    }) as typeof fetch

    await new KhloeiAppClient().operation(
      'tool',
      'task_abcdefghijklmnop',
      { callId: 'call_1', input: {}, name: 'computer_read' },
      null,
    )

    expect(observedHeaders.get('authorization')).toBe('Bearer worker-token')
    expect(observedHeaders.get('x-vercel-protection-bypass')).toBe(
      'protection-token',
    )
  })
})
