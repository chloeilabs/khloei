import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COMPUTER_AGENT_GRAPH_VERSION,
  decodeRunStateCheckpoint,
  encodeRunStateCheckpoint,
} from '../src/checkpoint'
import { AgentWorkerService } from '../src/service'
import { TaskStore } from '../src/store'
import type { ComputerTaskRequest } from '../src/types'

const temporaryDirectories: string[] = []

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'khloei-agent-service-'))
  temporaryDirectories.push(directory)
  return join(directory, 'tasks.sqlite')
}

function request(): ComputerTaskRequest {
  return {
    input: [
      {
        content: [{ text: 'Inspect the current page.', type: 'input_text' }],
        role: 'user',
        type: 'message',
      },
    ],
    model: 'z-ai/glm-5.3-flash',
    provider: 'openrouter',
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for the worker fixture.')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('AgentWorkerService leases', () => {
  test('heartbeats extend a lease while a task is running', async () => {
    const store = new TaskStore(databasePath())
    const service = new AgentWorkerService(store, {
      heartbeatMs: 20,
      leaseMs: 2_000,
      maintenanceMs: 30,
      retentionDays: 0,
    })
    const task = service.createTask(request())
    let initialExpiry = 0
    let renewedExpiry = 0
    service.runtime.run = async (claimed) => {
      initialExpiry = claimed.leaseExpiresAt ?? 0
      await waitFor(
        () =>
          (store.getTask(claimed.id)?.leaseExpiresAt ?? 0) > initialExpiry,
        5_000,
      )
      renewedExpiry = store.getTask(claimed.id)?.leaseExpiresAt ?? 0
      store.markTerminal(claimed.id, 'completed')
    }

    service.start()
    await waitFor(() => store.getTask(task.id)?.status === 'completed')
    expect(renewedExpiry).toBeGreaterThan(initialExpiry)
    await service.close()
  })

  test('graceful shutdown releases an active task for a later worker', async () => {
    const path = databasePath()
    const store = new TaskStore(path)
    const service = new AgentWorkerService(store, {
      heartbeatMs: 20,
      leaseMs: 2_000,
      maintenanceMs: 30,
      retentionDays: 0,
    })
    const task = service.createTask(request())
    let started = false
    service.runtime.run = async (_claimed, signal) => {
      started = true
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    service.start()
    await waitFor(() => started, 5_000)
    await service.close()

    const nextStore = new TaskStore(path)
    expect(nextStore.getTask(task.id)?.status).toBe('queued')
    expect(nextStore.claimNextTask('next-worker')?.id).toBe(task.id)
    nextStore.close()
  })
})

describe('AgentWorkerService checkpoint reconciliation', () => {
  test('migrates a legacy waiting checkpoint before it can resume', async () => {
    const store = new TaskStore(databasePath())
    const task = store.createTask(request())
    const legacyState = JSON.stringify({ currentTurn: 1 })
    store.setWaiting(task.id, legacyState, {
      invocation: {
        callId: 'call_help',
        input: { reason: 'fixture' },
        name: 'computer_request_help',
      },
      ready: false,
      requestedAt: 1,
    })
    const service = new AgentWorkerService(store, { retentionDays: 0 })

    service.start()
    const migrated = store.getTask(task.id)?.runState
    expect(migrated).not.toBe(legacyState)
    expect(decodeRunStateCheckpoint(migrated!)).toEqual({
      legacy: false,
      serializedState: legacyState,
    })
    await service.close()
  })

  test('fails an incompatible waiting checkpoint closed', async () => {
    const store = new TaskStore(databasePath())
    const task = store.createTask(request())
    const envelope = JSON.parse(
      encodeRunStateCheckpoint(JSON.stringify({ currentTurn: 1 })),
    ) as Record<string, unknown>
    envelope.agentGraphVersion = COMPUTER_AGENT_GRAPH_VERSION + 1
    store.setWaiting(task.id, JSON.stringify(envelope), {
      invocation: {
        callId: 'call_help',
        input: { reason: 'fixture' },
        name: 'computer_request_help',
      },
      ready: false,
      requestedAt: 1,
    })
    const service = new AgentWorkerService(store, { retentionDays: 0 })

    service.start()
    expect(store.getTask(task.id)?.status).toBe('failed')
    expect(store.eventsAfter(task.id, 0).at(-1)?.payload).toEqual({
      message: expect.stringContaining('cannot be resumed'),
      type: 'error',
    })
    await service.close()
  })
})
