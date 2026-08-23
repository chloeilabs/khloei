import { describe, expect, test } from 'bun:test'

import { checkNavigationTarget } from './target'

describe('computer navigation targets', () => {
  test.each([
    'http://127.0.0.1:3000',
    'http://127.1:3000',
    'http://10.0.0.1',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal',
    'http://[::ffff:169.254.169.254]',
    'http://[64:ff9b::a9fe:a9fe]',
  ])('blocks internal or metadata target %s', (url) => {
    expect(checkNavigationTarget(url).allowed).toBe(false)
  })

  test('allows ordinary public web targets', () => {
    expect(checkNavigationTarget('https://example.com/path')).toEqual({
      allowed: true,
      url: 'https://example.com/path',
    })
  })
})
