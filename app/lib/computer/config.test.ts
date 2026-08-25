import { describe, expect, test } from 'bun:test'

import { privateHostsAllowed } from './config'

describe('computer configuration', () => {
  test('keeps private network navigation off by default', () => {
    expect(privateHostsAllowed({ NODE_ENV: 'production' })).toBe(false)
  })

  test('allows an explicit local development opt-in', () => {
    expect(
      privateHostsAllowed({
        KHLOEI_COMPUTER_ALLOW_PRIVATE_HOSTS: 'true',
        NODE_ENV: 'development',
      }),
    ).toBe(true)
  })

  test('refuses the private-host escape hatch in production', () => {
    expect(() =>
      privateHostsAllowed({
        KHLOEI_COMPUTER_ALLOW_PRIVATE_HOSTS: 'true',
        NODE_ENV: 'production ',
      }),
    ).toThrow('local development only')
  })
})
