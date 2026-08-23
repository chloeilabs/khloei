import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentWorkerService } from '../src/service'
import { AmbiguousActionError, TaskStore } from '../src/store'
import type { ComputerTaskRequest } from '../src/types'

const temporaryDirectories: string[] = []

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'khloei-agent-worker-'))
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
    model: 'gpt-5.6-terra',
    provider: 'openai',
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('TaskStore durability', () => {
  test('persists event cursors and approval checkpoints across a restart', () => {
    const path = databasePath()
    const first = new TaskStore(path)
    const task = first.createTask(request())
    const sequence = first.appendEvent(task.id, {
      delta: 'Working',
      type: 'text-delta',
    })
    first.setWaiting(task.id, 'serialized-run-state', {
      invocation: {
        callId: 'call_help',
        input: { reason: 'Complete sign-in.' },
        name: 'computer_request_help',
      },
      ready: false,
      requestedAt: 123,
    })
    first.close()

    const second = new TaskStore(path)
    const restored = second.getTask(task.id)
    expect(restored?.status).toBe('waiting_for_human')
    expect(restored?.runState).toBe('serialized-run-state')
    expect(restored?.approval?.invocation.callId).toBe('call_help')
    expect(second.eventsAfter(task.id, 0)).toEqual([
      {
        createdAt: expect.any(Number),
        payload: { delta: 'Working', type: 'text-delta' },
        sequenceNumber: sequence,
      },
    ])

    expect(second.markApprovalReady(task.id)).toBe(true)
    const claimed = second.claimNextTask('test-worker')
    expect(claimed?.id).toBe(task.id)
    expect(claimed?.approval?.ready).toBe(true)
    second.close()
  })

  test('atomically commits and replays the complete tool boundary', () => {
    const path = databasePath()
    const store = new TaskStore(path)
    const task = store.createTask(request())
    expect(
      store.beginAction(task.id, 'call_1', 'computer_click', { ref: 'e1' }),
    ).toEqual({ kind: 'execute' })
    expect(
      store.commitActionResult(
        task.id,
        'call_1',
        {
          events: [{ type: 'activity', value: 'clicked' }],
          gatewayState: {
            currentPageUrl: 'https://example.com/after',
            snapshot: { computerSessionId: 'computer_1', snapshotId: 2 },
          },
          outcome: { ok: true },
        },
        'serialized-run-state',
      ),
    ).toBe(1)
    store.close()

    const restored = new TaskStore(path)
    expect(
      restored.beginAction(task.id, 'call_1', 'computer_click', { ref: 'e1' }),
    ).toEqual({
      kind: 'replay',
      result: {
        gatewayState: {
          currentPageUrl: 'https://example.com/after',
          snapshot: { computerSessionId: 'computer_1', snapshotId: 2 },
        },
        outcome: { ok: true },
      },
    })
    expect(restored.getTask(task.id)?.gatewayState).toEqual({
      currentPageUrl: 'https://example.com/after',
      snapshot: { computerSessionId: 'computer_1', snapshotId: 2 },
    })
    expect(restored.getTask(task.id)?.runState).toBe('serialized-run-state')
    expect(restored.eventsAfter(task.id, 0).map((event) => event.payload)).toEqual(
      [{ type: 'activity', value: 'clicked' }],
    )
    restored.close()
  })

  test('rolls back the tool boundary when the action cannot be completed', () => {
    const store = new TaskStore(databasePath())
    const task = store.createTask(request())
    expect(() =>
      store.commitActionResult(task.id, 'missing_call', {
        events: [{ type: 'activity' }],
        gatewayState: { currentPageUrl: 'https://example.com' },
        outcome: { ok: true },
      }),
    ).toThrow('exactly once')
    expect(store.getTask(task.id)?.gatewayState).toBeNull()
    expect(store.eventsAfter(task.id, 0)).toEqual([])
    store.close()
  })

  test('recovers only an expired lease and never replays its ambiguous action', () => {
    const path = databasePath()
    const first = new TaskStore(path)
    const task = first.createTask(request())
    const liveTask = first.createTask(request())
    expect(first.claimNextTask('first-worker', 1_000, 10_000)?.id).toBe(task.id)
    expect(first.claimNextTask('live-worker', 10_000, 10_000)?.id).toBe(
      liveTask.id,
    )
    expect(
      first.beginAction(task.id, 'call_2', 'computer_click', { ref: 'e2' }),
    ).toEqual({ kind: 'execute' })
    expect(
      first.beginAction(liveTask.id, 'call_live', 'computer_click', {
        ref: 'e3',
      }),
    ).toEqual({ kind: 'execute' })
    first.close()

    const second = new TaskStore(path)
    expect(second.recoverExpiredTasks(11_001)).toEqual({
      cancelledTaskIds: [],
      recoveredTaskIds: [task.id],
    })
    expect(second.getTask(task.id)?.status).toBe('queued')
    expect(second.getTask(task.id)?.recoveryNote).toContain('do not repeat')
    expect(second.getTask(liveTask.id)?.status).toBe('running')
    expect(
      second.beginAction(task.id, 'call_2', 'computer_click', { ref: 'e2' }),
    ).toEqual({
      kind: 'replay',
      result: {
        error: expect.stringContaining('did not replay it'),
        ok: false,
        recovery: true,
      },
    })
    expect(() =>
      second.beginAction(liveTask.id, 'call_live', 'computer_click', {
        ref: 'e3',
      }),
    ).toThrow(AmbiguousActionError)
    second.close()
  })

  test('renews a lease only while the same worker still owns it', () => {
    const store = new TaskStore(databasePath())
    const task = store.createTask(request())
    expect(store.claimNextTask('owner', 1_000, 10_000)?.leaseExpiresAt).toBe(
      11_000,
    )
    expect(store.renewLease(task.id, 'owner', 2_000, 10_500)).toBe(true)
    expect(store.getTask(task.id)?.leaseExpiresAt).toBe(12_500)
    expect(store.renewLease(task.id, 'other', 2_000, 10_600)).toBe(false)
    expect(store.renewLease(task.id, 'owner', 2_000, 12_500)).toBe(false)
    store.close()
  })

  test('finishes a requested cancellation after a worker restart', () => {
    const path = databasePath()
    const first = new TaskStore(path)
    const task = first.createTask(request())
    expect(first.requestCancellation(task.id)?.cancelRequested).toBe(true)
    first.close()

    const second = new TaskStore(path)
    second.recoverExpiredTasks()
    expect(second.getTask(task.id)?.status).toBe('cancelled')
    expect(second.eventsAfter(task.id, 0).at(-1)?.payload).toEqual({
      type: 'cancelled',
    })
    second.close()
  })

  test('purges only terminal tasks older than the retention cutoff', () => {
    const store = new TaskStore(databasePath())
    const oldTask = store.createTask(request())
    const recentTask = store.createTask(request())
    const activeTask = store.createTask(request())
    store.appendEvent(oldTask.id, { type: 'done' })
    store.beginAction(oldTask.id, 'call_old', 'computer_read', {})
    store.commitActionResult(oldTask.id, 'call_old', {
      events: [],
      gatewayState: { currentPageUrl: '' },
      outcome: { ok: true },
    })
    store.markTerminal(oldTask.id, 'completed')
    store.markTerminal(recentTask.id, 'failed', 'fixture')
    store.database
      .query('UPDATE tasks SET updated_at = ? WHERE id = ?')
      .run(1_000, oldTask.id)

    expect(store.purgeTerminalTasks(2_000)).toBe(1)
    expect(store.getTask(oldTask.id)).toBeNull()
    expect(store.getTask(recentTask.id)?.status).toBe('failed')
    expect(store.getTask(activeTask.id)?.status).toBe('queued')
    expect(store.eventsAfter(oldTask.id, 0)).toEqual([])
    store.close()
  })

  test('paginates event recovery without advancing past undelivered events', async () => {
    const store = new TaskStore(databasePath())
    const task = store.createTask(request())
    for (let index = 0; index < 510; index += 1) {
      store.appendEvent(task.id, { delta: String(index), type: 'text-delta' })
    }
    const service = new AgentWorkerService(store)

    const first = await service.events(task.id, 0)
    expect(first?.events).toHaveLength(500)
    expect(first?.sequenceNumber).toBe(
      first?.events.at(-1)?.sequenceNumber,
    )
    expect(first?.hasMore).toBe(true)

    const second = await service.events(task.id, first!.sequenceNumber)
    expect(second?.events).toHaveLength(10)
    expect(second?.hasMore).toBe(false)
    await service.close()
  })
})
