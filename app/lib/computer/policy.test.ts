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

  test('can refuse the shell as an intent', () => {
    const decision = evaluateActionPolicy(
      { allow: ['*'], deny: ['intent:run_command'], mode: 'enforce' },
      {
        ...context,
        command: 'npm test',
        element: undefined,
        intent: 'run_command',
        page: { host: '', url: '' },
        tool: { name: 'computer_run_command' },
      },
    )
    expect(decision.forward).toBe(false)
    expect(decision.matched).toBe('intent:run_command')
  })

  test('can refuse pixel desktop activation independently', () => {
    const decision = evaluateActionPolicy(
      {
        allow: ['*'],
        deny: ['tool:computer_desktop_click'],
        mode: 'enforce',
      },
      {
        ...context,
        element: undefined,
        page: { host: '', url: 'desktop://khloei' },
        tool: { name: 'computer_desktop_click' },
      },
    )
    expect(decision.forward).toBe(false)
    expect(decision.matched).toBe('tool:computer_desktop_click')
  })

  test('can match a command prefix without blocking unrelated commands', () => {
    const commandContext: PolicyContext = {
      ...context,
      command: 'rm -rf ./generated',
      element: undefined,
      intent: 'run_command',
      page: { host: '', url: '' },
      tool: { name: 'computer_run_command' },
    }
    const policy = {
      allow: ['*'],
      deny: ['command:rm -rf*'],
      mode: 'enforce' as const,
    }
    expect(evaluateActionPolicy(policy, commandContext).forward).toBe(false)
    expect(
      evaluateActionPolicy(policy, {
        ...commandContext,
        command: 'npm test',
      }).forward,
    ).toBe(true)
  })
})
