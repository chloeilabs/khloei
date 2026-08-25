import { describe, expect, test } from 'bun:test'

import {
  computerViewerConnectSource,
  contentSecurityPolicyFor,
} from '../../../next.config'

describe('computer viewer content security policy', () => {
  test('allows only the exact local websocket origin in development', () => {
    expect(
      computerViewerConnectSource({ NODE_ENV: 'development' }),
    ).toBe('ws://127.0.0.1:4100')
    expect(contentSecurityPolicyFor({ NODE_ENV: 'development' })).toContain(
      "connect-src 'self' https: wss: ws://127.0.0.1:4100",
    )
  })

  test('maps configured public HTTP origins to their websocket schemes', () => {
    expect(
      computerViewerConnectSource({
        KHLOEI_COMPUTER_PUBLIC_URL: 'http://localhost:5100/computer',
        NODE_ENV: 'development',
      }),
    ).toBe('ws://localhost:5100')
    expect(
      computerViewerConnectSource({
        KHLOEI_COMPUTER_PUBLIC_URL: 'https://computer.khloei.example/path',
        NODE_ENV: 'production',
      }),
    ).toBe('wss://computer.khloei.example')
  })

  test('does not add an insecure websocket wildcard or invalid source', () => {
    const production = contentSecurityPolicyFor({ NODE_ENV: 'production' })
    expect(production).toContain("connect-src 'self' https: wss:")
    expect(production).not.toContain(' ws:')
    expect(
      computerViewerConnectSource({
        KHLOEI_COMPUTER_PUBLIC_URL: 'file:///tmp/computer',
        NODE_ENV: 'production',
      }),
    ).toBeNull()
  })
})
