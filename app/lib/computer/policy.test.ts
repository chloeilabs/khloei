import { describe, expect, test } from 'bun:test'

import { evaluateActionPolicy, type PolicyContext } from './policy'

const context: PolicyContext = {
  actor: { id: 'local-user' },
  bot: { id: 'khloei' },
  element: { name: 'Confirm purchase', ref: 'e1', role: 'button' },
  intent: 'activate',
  page: { host: 'shop.example.com', url: 'https://shop.example.com' },
  tool: { name: 'computer_click' },
}

describe('computer policy', () => {
  test('applies deny rules before broad allows', () => {
    const decision = evaluateActionPolicy(
      { allow: ['*'], deny: ['element:purchase'], mode: 'enforce' },
      context,
    )
    expect(decision.forward).toBe(false)
    expect(decision.source).toBe('deny')
  })

  test('fails closed when an enforce policy has no matching allow', () => {
    const decision = evaluateActionPolicy(
      { allow: ['host:docs.example.com'], deny: [], mode: 'enforce' },
      context,
    )
    expect(decision.forward).toBe(false)
    expect(decision.source).toBe('default')
  })
})
