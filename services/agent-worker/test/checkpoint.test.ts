import { describe, expect, test } from 'bun:test'

import {
  AGENTS_SDK_CHECKPOINT_VERSION,
  CHECKPOINT_FORMAT_VERSION,
  CHECKPOINT_KIND,
  COMPUTER_AGENT_GRAPH_VERSION,
  IncompatibleCheckpointError,
  decodeRunStateCheckpoint,
  encodeRunStateCheckpoint,
} from '../src/checkpoint'

describe('Agents SDK checkpoint envelopes', () => {
  test('round trips a serialized RunState with explicit compatibility data', () => {
    const serializedState = JSON.stringify({ currentTurn: 3 })
    const encoded = encodeRunStateCheckpoint(serializedState)
    expect(JSON.parse(encoded)).toEqual({
      agentsSdkVersion: AGENTS_SDK_CHECKPOINT_VERSION,
      agentGraphVersion: COMPUTER_AGENT_GRAPH_VERSION,
      formatVersion: CHECKPOINT_FORMAT_VERSION,
      kind: CHECKPOINT_KIND,
      serializedState,
    })
    expect(decodeRunStateCheckpoint(encoded)).toEqual({
      legacy: false,
      serializedState,
    })
  })

  test('accepts one legacy raw RunState so startup can migrate it', () => {
    const serializedState = JSON.stringify({ currentTurn: 2 })
    expect(decodeRunStateCheckpoint(serializedState)).toEqual({
      legacy: true,
      serializedState,
    })
  })

  test.each([
    ['formatVersion', CHECKPOINT_FORMAT_VERSION + 1],
    ['agentGraphVersion', COMPUTER_AGENT_GRAPH_VERSION + 1],
    ['agentsSdkVersion', '999.0.0'],
  ] as const)('fails closed for incompatible %s', (field, value) => {
    const envelope = JSON.parse(
      encodeRunStateCheckpoint(JSON.stringify({ currentTurn: 1 })),
    ) as Record<string, unknown>
    envelope[field] = value
    expect(() => decodeRunStateCheckpoint(JSON.stringify(envelope))).toThrow(
      IncompatibleCheckpointError,
    )
  })

  test('rejects a corrupt checkpoint before the SDK sees it', () => {
    expect(() => decodeRunStateCheckpoint('not-json')).toThrow(
      IncompatibleCheckpointError,
    )
  })
})
