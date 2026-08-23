import { randomUUID } from 'node:crypto'

import { KhloeiAppClient } from './app-client'
import {
  decodeRunStateCheckpoint,
  encodeRunStateCheckpoint,
} from './checkpoint'
import { TaskEventNotifier } from './notifier'
import { ComputerTaskRuntime } from './runtime'
import { TaskStore } from './store'
import type { ComputerTaskRequest, TaskStatus } from './types'

const APPROVAL_CHECK_MS = 2_000
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_MAINTENANCE_MS = 5_000
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_RETENTION_SWEEP_MS = 60 * 60 * 1_000

export type AgentWorkerServiceOptions = {
  heartbeatMs?: number
  leaseMs?: number
  maintenanceMs?: number
  retentionDays?: number
  retentionSweepMs?: number
}

function environmentNumber(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= minimum ? value : fallback
}

function unref(timer: ReturnType<typeof setInterval>) {
  timer.unref?.()
  return timer
}

export class AgentWorkerService {
  readonly notifier = new TaskEventNotifier()
  readonly runtime: ComputerTaskRuntime
  private readonly app = new KhloeiAppClient()
  private readonly workerId = `worker_${randomUUID()}`
  private readonly heartbeatMs: number
  private readonly leaseMs: number
  private readonly maintenanceMs: number
  private readonly retentionMs: number | null
  private readonly retentionSweepMs: number
  private active: {
    controller: AbortController
    heartbeat: ReturnType<typeof setInterval>
    taskId: string
  } | null = null
  private approvalTimer: ReturnType<typeof setInterval> | null = null
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null
  private approvalCheckPromise: Promise<void> | null = null
  private lastRetentionSweep = 0
  private pumping = false
  private wakePending = false
  private closed = false
  private closePromise: Promise<void> | null = null
  private finishClose: (() => void) | null = null

  constructor(
    readonly store: TaskStore,
    options: AgentWorkerServiceOptions = {},
  ) {
    this.leaseMs =
      options.leaseMs ??
      environmentNumber('AGENT_WORKER_LEASE_MS', DEFAULT_LEASE_MS, 5_000)
    const heartbeatMs =
      options.heartbeatMs ??
      environmentNumber(
        'AGENT_WORKER_HEARTBEAT_MS',
        Math.max(1_000, Math.min(10_000, Math.floor(this.leaseMs / 3))),
        250,
      )
    this.heartbeatMs = Math.max(
      10,
      Math.min(heartbeatMs, Math.max(10, this.leaseMs - 1_000)),
    )
    this.maintenanceMs =
      options.maintenanceMs ??
      environmentNumber(
        'AGENT_WORKER_MAINTENANCE_MS',
        DEFAULT_MAINTENANCE_MS,
        1_000,
      )
    const retentionDays =
      options.retentionDays ??
      environmentNumber(
        'AGENT_WORKER_RETENTION_DAYS',
        DEFAULT_RETENTION_DAYS,
        0,
      )
    this.retentionMs =
      retentionDays === 0 ? null : retentionDays * 24 * 60 * 60 * 1_000
    this.retentionSweepMs =
      options.retentionSweepMs ?? DEFAULT_RETENTION_SWEEP_MS
    this.runtime = new ComputerTaskRuntime(store, this.notifier, this.app)
  }

  start() {
    this.maintain(true)
    this.approvalTimer = unref(setInterval(() => {
      void this.checkApprovals()
    }, APPROVAL_CHECK_MS))
    this.maintenanceTimer = unref(setInterval(() => {
      this.maintain()
    }, this.maintenanceMs))
    this.wake()
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    if (this.approvalTimer) clearInterval(this.approvalTimer)
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.approvalTimer = null
    this.maintenanceTimer = null
    this.active?.controller.abort(
      new Error('The worker is shutting down and will resume this task.'),
    )
    this.closePromise = (async () => {
      if (this.pumping) {
        await new Promise<void>((resolve) => {
          this.finishClose = resolve
        })
      }
      await this.approvalCheckPromise?.catch(() => undefined)
      this.store.close()
    })()
    return this.closePromise
  }

  createTask(request: ComputerTaskRequest) {
    const task = this.store.createTask(request)
    this.wake()
    return task
  }

  async events(taskId: string, after: number, signal?: AbortSignal) {
    let events = this.store.eventsAfter(taskId, after)
    const task = this.store.getTask(taskId)
    if (!task) return null
    if (
      events.length === 0 &&
      (task.status === 'queued' ||
        task.status === 'running' ||
        task.status === 'waiting_for_human')
    ) {
      await this.notifier.wait(taskId, 20_000, signal)
      events = this.store.eventsAfter(taskId, after)
    }
    const current = this.store.getTask(taskId)
    if (!current) return null
    const latestSequence = this.store.latestSequence(taskId)
    const sequenceNumber = events.at(-1)?.sequenceNumber ?? latestSequence
    return {
      error: current.error,
      events,
      hasMore: sequenceNumber < latestSequence,
      sequenceNumber,
      status: current.status,
    }
  }

  async cancel(taskId: string) {
    const requested = this.store.requestCancellation(taskId)
    if (!requested) return null
    if (
      requested.status === 'cancelled' ||
      requested.status === 'completed' ||
      requested.status === 'failed'
    ) {
      return requested
    }

    if (this.active?.taskId === taskId) {
      this.active.controller.abort()
      return this.store.getTask(taskId)
    }

    if (requested.status === 'waiting_for_human' && requested.approval) {
      try {
        const result = await this.app.operation(
          'cancel_assistance',
          requested.id,
          requested.approval.invocation,
          requested.gatewayState,
          AbortSignal.timeout(10_000),
        )
        this.store.saveGatewayState(requested.id, result.gatewayState)
        for (const event of result.events) {
          this.store.appendEvent(requested.id, event)
        }
      } catch {
        // Cancellation is fail-closed for the agent even if the UI request cannot be cleared.
      }
    }

    this.store.appendEvent(taskId, { type: 'cancelled' })
    this.store.markTerminal(taskId, 'cancelled')
    this.notifier.notify(taskId)
    return this.store.getTask(taskId)
  }

  private wake() {
    if (this.closed) return
    this.wakePending = true
    if (this.pumping) return
    this.pumping = true
    queueMicrotask(() => void this.pump())
  }

  private async pump() {
    try {
      do {
        this.wakePending = false
        while (!this.closed && !this.active) {
          const task = this.store.claimNextTask(this.workerId, this.leaseMs)
          if (!task) break
          const controller = new AbortController()
          const heartbeat = unref(setInterval(() => {
            const renewed = this.store.renewLease(
              task.id,
              this.workerId,
              this.leaseMs,
            )
            if (!renewed && !controller.signal.aborted) {
              controller.abort(
                new Error('The worker lost ownership of this task lease.'),
              )
            }
          }, this.heartbeatMs))
          this.active = { controller, heartbeat, taskId: task.id }
          try {
            await this.runtime.run(task, controller.signal)
          } finally {
            clearInterval(heartbeat)
          }
          const current = this.store.getTask(task.id)
          if (
            current?.status === 'running' &&
            current.leaseOwner === this.workerId
          ) {
            this.store.expireLease(task.id, this.workerId)
            this.notifyRecovery(this.store.recoverExpiredTasks())
          }
          this.active = null
        }
      } while (!this.closed && this.wakePending)
    } finally {
      this.pumping = false
      if (this.closed) {
        this.finishClose?.()
        this.finishClose = null
      }
      if (!this.closed && this.wakePending) this.wake()
    }
  }

  private async checkApprovals() {
    if (this.closed || this.approvalCheckPromise) return
    this.approvalCheckPromise = this.pollApprovals()
    try {
      await this.approvalCheckPromise
    } finally {
      this.approvalCheckPromise = null
    }
  }

  private async pollApprovals() {
    for (const task of this.store.waitingTasks()) {
      if (task.cancelRequested || this.closed) continue
      const ready = await this.runtime.checkHumanApproval(task)
      if (ready) this.wake()
    }
  }

  private maintain(forceRetention = false) {
    if (this.closed) return
    this.notifyRecovery(this.store.recoverExpiredTasks())
    this.reconcileCheckpoints()

    const now = Date.now()
    if (
      this.retentionMs !== null &&
      (forceRetention || now - this.lastRetentionSweep >= this.retentionSweepMs)
    ) {
      this.lastRetentionSweep = now
      let removed = 0
      for (let batch = 0; batch < 4; batch += 1) {
        const count = this.store.purgeTerminalTasks(now - this.retentionMs)
        removed += count
        if (count < 250) break
      }
      if (removed > 0) this.store.optimize()
    }
  }

  private notifyRecovery(result: {
    cancelledTaskIds: string[]
    recoveredTaskIds: string[]
  }) {
    for (const taskId of [
      ...result.cancelledTaskIds,
      ...result.recoveredTaskIds,
    ]) {
      this.notifier.notify(taskId)
    }
    if (result.recoveredTaskIds.length > 0) this.wake()
  }

  private reconcileCheckpoints() {
    for (const task of this.store.checkpointTasks()) {
      if (task.status === 'running' || !task.runState) continue
      try {
        const checkpoint = decodeRunStateCheckpoint(task.runState)
        if (checkpoint.legacy) {
          this.store.saveRunState(
            task.id,
            encodeRunStateCheckpoint(checkpoint.serializedState),
          )
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? `${error.message} Start a new computer request.`
            : 'The saved agent checkpoint cannot be resumed safely. Start a new computer request.'
        this.store.appendEvent(task.id, { message, type: 'error' })
        this.store.markTerminal(task.id, 'failed', message)
        this.notifier.notify(task.id)
      }
    }
  }
}

export function isTerminalStatus(status: TaskStatus) {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}
