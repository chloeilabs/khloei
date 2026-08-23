import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

import type {
  ComputerTaskRequest,
  PendingApproval,
  TaskEvent,
  TaskRecord,
  TaskStatus,
  WorkerActionResponse,
} from './types'

type TaskRow = {
  approval_json: string | null
  cancel_requested: number
  created_at: number
  error: string | null
  gateway_state_json: string | null
  id: string
  lease_expires_at: number | null
  lease_owner: string | null
  recovery_note: string | null
  request_json: string
  run_state: string | null
  status: TaskStatus
  updated_at: number
}

type EventRow = {
  created_at: number
  payload_json: string
  sequence: number
}

type ActionRow = {
  input_hash: string
  result_json: string | null
  status: 'completed' | 'started' | 'unknown'
  tool_name: string
}

export type BeginActionResult =
  | { kind: 'execute' }
  | { kind: 'replay'; result: unknown }

type CommittedActionResult = {
  gatewayState: Record<string, unknown>
  outcome: unknown
}

export type RecoveryResult = {
  cancelledTaskIds: string[]
  recoveredTaskIds: string[]
}

const DATABASE_SCHEMA_VERSION = 1

const RECOVERED_ACTION_RESULT = {
  error:
    'The worker restarted while this action was in flight, so Khloei did not replay it. Inspect the current browser or file state and take a fresh snapshot before deciding what to do next.',
  ok: false,
  recovery: true,
}

function json<T>(value: string | null): T | null {
  if (value === null) return null
  return JSON.parse(value) as T
}

function rowTask(row: TaskRow): TaskRecord {
  return {
    approval: json<PendingApproval>(row.approval_json),
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    error: row.error,
    gatewayState: json<Record<string, unknown>>(row.gateway_state_json),
    id: row.id,
    leaseExpiresAt: row.lease_expires_at,
    leaseOwner: row.lease_owner,
    recoveryNote: row.recovery_note,
    request: JSON.parse(row.request_json) as ComputerTaskRequest,
    runState: row.run_state,
    status: row.status,
    updatedAt: row.updated_at,
  }
}

function inputHash(toolName: string, input: unknown) {
  return createHash('sha256')
    .update(`${toolName}\n${JSON.stringify(input)}`)
    .digest('hex')
}

export function isCommittedActionResult(
  value: unknown,
): value is CommittedActionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'outcome' in value &&
    typeof (value as Record<string, unknown>).gatewayState === 'object' &&
    (value as Record<string, unknown>).gatewayState !== null &&
    !Array.isArray((value as Record<string, unknown>).gatewayState)
  )
}

export class AmbiguousActionError extends Error {
  constructor() {
    super(
      'This action is already in flight. Khloei stopped rather than risk carrying it out twice.',
    )
    this.name = 'AmbiguousActionError'
  }
}

export class TaskStore {
  readonly database: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new Database(path, { create: true, strict: true })
    this.database.run('PRAGMA journal_mode = WAL')
    this.database.run('PRAGMA synchronous = FULL')
    this.database.run('PRAGMA foreign_keys = ON')
    this.database.run('PRAGMA busy_timeout = 5000')
    this.migrate()
    this.assertIntegrity()
  }

  private assertIntegrity() {
    const checks = this.database
      .query<{ quick_check: string }, []>('PRAGMA quick_check')
      .all()
    const failures = checks.filter((check) => check.quick_check !== 'ok')
    if (failures.length > 0) {
      throw new Error('The durable worker database failed its integrity check.')
    }
  }

  private migrate() {
    const version = this.database
      .query<{ user_version: number }, []>('PRAGMA user_version')
      .get()?.user_version
    if ((version ?? 0) > DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Agent worker database schema ${version} is newer than supported schema ${DATABASE_SCHEMA_VERSION}.`,
      )
    }
    this.database.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        run_state TEXT,
        gateway_state_json TEXT,
        approval_json TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        recovery_note TEXT,
        error TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.database.run(`
      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    this.database.run(`
      CREATE INDEX IF NOT EXISTS task_events_task_sequence
      ON task_events(task_id, sequence)
    `)
    this.database.run(`
      CREATE TABLE IF NOT EXISTS task_actions (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (task_id, call_id)
      )
    `)
    this.database.run(`
      CREATE INDEX IF NOT EXISTS tasks_status_created
      ON tasks(status, created_at)
    `)
    this.database.run(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`)
  }

  close() {
    this.database.close()
  }

  createTask(request: ComputerTaskRequest) {
    const id = `task_${randomUUID().replaceAll('-', '')}`
    const now = Date.now()
    this.database
      .query(
        `INSERT INTO tasks
          (id, status, request_json, created_at, updated_at)
         VALUES (?, 'queued', ?, ?, ?)`,
      )
      .run(id, JSON.stringify(request), now, now)
    return this.getTask(id)!
  }

  getTask(id: string) {
    const row = this.database
      .query<TaskRow, [string]>('SELECT * FROM tasks WHERE id = ?')
      .get(id)
    return row ? rowTask(row) : null
  }

  appendEvent(taskId: string, payload: unknown) {
    const now = Date.now()
    const result = this.database
      .query(
        `INSERT INTO task_events (task_id, payload_json, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(taskId, JSON.stringify(payload), now)
    return Number(result.lastInsertRowid)
  }

  eventsAfter(taskId: string, sequenceNumber: number, limit = 500) {
    return this.database
      .query<EventRow, [string, number, number]>(
        `SELECT sequence, payload_json, created_at
         FROM task_events
         WHERE task_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(taskId, sequenceNumber, limit)
      .map(
        (row): TaskEvent => ({
          createdAt: row.created_at,
          payload: JSON.parse(row.payload_json) as unknown,
          sequenceNumber: row.sequence,
        }),
      )
  }

  latestSequence(taskId: string) {
    const row = this.database
      .query<{ sequence: number | null }, [string]>(
        'SELECT MAX(sequence) AS sequence FROM task_events WHERE task_id = ?',
      )
      .get(taskId)
    return row?.sequence ?? 0
  }

  claimNextTask(workerId: string, leaseMs = 30_000, now = Date.now()) {
    const transaction = this.database.transaction(() => {
      const next = this.database
        .query<{ id: string }, []>(
          `SELECT id FROM tasks
           WHERE status = 'queued' AND cancel_requested = 0
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get()
      if (!next) return null
      const changed = this.database
        .query(
          `UPDATE tasks
           SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued' AND cancel_requested = 0`,
        )
        .run(workerId, now + leaseMs, now, next.id)
      return changed.changes === 1 ? this.getTask(next.id) : null
    })
    return transaction.immediate()
  }

  renewLease(
    taskId: string,
    workerId: string,
    leaseMs = 30_000,
    now = Date.now(),
  ) {
    const changed = this.database
      .query(
        `UPDATE tasks
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(now + leaseMs, now, taskId, workerId, now)
    return changed.changes === 1
  }

  expireLease(taskId: string, workerId: string, now = Date.now()) {
    const changed = this.database
      .query(
        `UPDATE tasks SET lease_expires_at = 0, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(now, taskId, workerId)
    return changed.changes === 1
  }

  saveRunState(taskId: string, runState: string) {
    this.database
      .query('UPDATE tasks SET run_state = ?, updated_at = ? WHERE id = ?')
      .run(runState, Date.now(), taskId)
  }

  saveGatewayState(taskId: string, state: Record<string, unknown>) {
    this.database
      .query(
        'UPDATE tasks SET gateway_state_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(JSON.stringify(state), Date.now(), taskId)
  }

  setWaiting(taskId: string, runState: string, approval: PendingApproval) {
    this.database
      .query(
        `UPDATE tasks
         SET status = 'waiting_for_human', run_state = ?, approval_json = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(runState, JSON.stringify(approval), Date.now(), taskId)
  }

  markApprovalReady(taskId: string) {
    const task = this.getTask(taskId)
    if (!task?.approval || task.status !== 'waiting_for_human') return false
    const approval = { ...task.approval, ready: true }
    const result = this.database
      .query(
        `UPDATE tasks
         SET status = 'queued', approval_json = ?, updated_at = ?
         WHERE id = ? AND status = 'waiting_for_human'`,
      )
      .run(JSON.stringify(approval), Date.now(), taskId)
    return result.changes === 1
  }

  clearApproval(taskId: string) {
    this.database
      .query('UPDATE tasks SET approval_json = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), taskId)
  }

  waitingTasks() {
    return this.database
      .query<TaskRow, []>(
        `SELECT * FROM tasks
         WHERE status = 'waiting_for_human' AND cancel_requested = 0
         ORDER BY updated_at ASC`,
      )
      .all()
      .map(rowTask)
  }

  checkpointTasks() {
    return this.database
      .query<TaskRow, []>(
        `SELECT * FROM tasks
         WHERE run_state IS NOT NULL
           AND status IN ('queued', 'running', 'waiting_for_human')
         ORDER BY updated_at ASC`,
      )
      .all()
      .map(rowTask)
  }

  requestCancellation(taskId: string) {
    const task = this.getTask(taskId)
    if (!task) return null
    if (
      task.status === 'cancelled' ||
      task.status === 'completed' ||
      task.status === 'failed'
    ) {
      return task
    }
    this.database
      .query(
        'UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE id = ?',
      )
      .run(Date.now(), taskId)
    return this.getTask(taskId)
  }

  isCancellationRequested(taskId: string) {
    return Boolean(this.getTask(taskId)?.cancelRequested)
  }

  markTerminal(
    taskId: string,
    status: Extract<TaskStatus, 'cancelled' | 'completed' | 'failed'>,
    error?: string,
  ) {
    this.database
      .query(
        `UPDATE tasks
         SET status = ?, error = ?, approval_json = NULL,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, error ?? null, Date.now(), taskId)
  }

  beginAction(
    taskId: string,
    callId: string,
    toolName: string,
    input: unknown,
  ): BeginActionResult {
    const hash = inputHash(toolName, input)
    const transaction = this.database.transaction(() => {
      const existing = this.database
        .query<ActionRow, [string, string]>(
          `SELECT tool_name, input_hash, status, result_json
           FROM task_actions WHERE task_id = ? AND call_id = ?`,
        )
        .get(taskId, callId)
      if (existing) {
        if (existing.tool_name !== toolName || existing.input_hash !== hash) {
          throw new Error('A tool call id was reused with different input.')
        }
        if (existing.status === 'started') throw new AmbiguousActionError()
        return {
          kind: 'replay' as const,
          result: JSON.parse(existing.result_json ?? 'null') as unknown,
        }
      }
      this.database
        .query(
          `INSERT INTO task_actions
            (task_id, call_id, tool_name, input_hash, status, started_at)
           VALUES (?, ?, ?, ?, 'started', ?)`,
        )
        .run(taskId, callId, toolName, hash, Date.now())
      return { kind: 'execute' as const }
    })
    return transaction.immediate()
  }

  commitActionResult(
    taskId: string,
    callId: string,
    response: WorkerActionResponse,
    runState?: string,
  ) {
    const transaction = this.database.transaction(() => {
      const now = Date.now()
      const committed: CommittedActionResult = {
        gatewayState: response.gatewayState,
        outcome: response.outcome,
      }
      const action = this.database
        .query(
          `UPDATE task_actions
           SET status = 'completed', result_json = ?, completed_at = ?
           WHERE task_id = ? AND call_id = ? AND status = 'started'`,
        )
        .run(JSON.stringify(committed), now, taskId, callId)
      if (action.changes !== 1) {
        throw new Error('The computer action could not be committed exactly once.')
      }

      const task = this.database
        .query(
          `UPDATE tasks
           SET gateway_state_json = ?,
               run_state = COALESCE(?, run_state),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(response.gatewayState),
          runState ?? null,
          now,
          taskId,
        )
      if (task.changes !== 1) {
        throw new Error('The computer task state could not be committed.')
      }

      const append = this.database.query(
        `INSERT INTO task_events (task_id, payload_json, created_at)
         VALUES (?, ?, ?)`,
      )
      for (const event of response.events) {
        append.run(taskId, JSON.stringify(event), now)
      }
      return response.events.length
    })
    return transaction.immediate()
  }

  recoverExpiredTasks(now = Date.now()): RecoveryResult {
    const transaction = this.database.transaction(() => {
      const expired = this.database
        .query<{ cancel_requested: number; id: string }, [number]>(
          `SELECT id, cancel_requested FROM tasks
           WHERE status = 'running'
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .all(now)
      const note =
        'The durable worker lost its lease while an action was in flight. The action may have completed, so do not repeat it. Inspect the current state and take a fresh snapshot before continuing.'
      const recoveredTaskIds: string[] = []
      const cancelledTaskIds: string[] = []

      for (const task of expired) {
        const ambiguous = this.database
          .query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM task_actions
             WHERE task_id = ? AND status = 'started'`,
          )
          .get(task.id)?.count
        if ((ambiguous ?? 0) > 0) {
          this.database
            .query(
              `UPDATE task_actions
               SET status = 'unknown', result_json = ?, completed_at = ?
               WHERE task_id = ? AND status = 'started'`,
            )
            .run(JSON.stringify(RECOVERED_ACTION_RESULT), now, task.id)
        }
        if (task.cancel_requested === 1) {
          this.database
            .query(
              `UPDATE tasks
               SET status = 'cancelled', approval_json = NULL,
                   lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(now, task.id)
          cancelledTaskIds.push(task.id)
        } else {
          this.database
            .query(
              `UPDATE tasks
               SET status = 'queued', recovery_note = COALESCE(?, recovery_note),
                   lease_owner = NULL,
                   lease_expires_at = NULL, updated_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run((ambiguous ?? 0) > 0 ? note : null, now, task.id)
          recoveredTaskIds.push(task.id)
        }
      }

      const abandonedCancellations = this.database
        .query<{ id: string }, []>(
          `SELECT id FROM tasks
           WHERE status IN ('queued', 'waiting_for_human')
             AND cancel_requested = 1`,
        )
        .all()
      this.database
        .query(
          `UPDATE tasks
           SET status = 'cancelled', approval_json = NULL, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE status IN ('queued', 'waiting_for_human')
             AND cancel_requested = 1`,
        )
        .run(now)
      cancelledTaskIds.push(...abandonedCancellations.map((task) => task.id))

      for (const taskId of cancelledTaskIds) {
        this.database
          .query(
            `INSERT INTO task_events (task_id, payload_json, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(taskId, JSON.stringify({ type: 'cancelled' }), now)
      }
      return { cancelledTaskIds, recoveredTaskIds }
    })
    return transaction.immediate()
  }

  purgeTerminalTasks(olderThan: number, limit = 250) {
    const transaction = this.database.transaction(() => {
      const tasks = this.database
        .query<{ id: string }, [number, number]>(
          `SELECT id FROM tasks
           WHERE status IN ('cancelled', 'completed', 'failed')
             AND updated_at < ?
           ORDER BY updated_at ASC
           LIMIT ?`,
        )
        .all(olderThan, limit)
      const remove = this.database.query('DELETE FROM tasks WHERE id = ?')
      for (const task of tasks) remove.run(task.id)
      return tasks.length
    })
    return transaction.immediate()
  }

  optimize() {
    this.database.run('PRAGMA optimize')
  }

  takeRecoveryNote(taskId: string) {
    const task = this.getTask(taskId)
    if (!task?.recoveryNote) return null
    this.database
      .query('UPDATE tasks SET recovery_note = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), taskId)
    return task.recoveryNote
  }
}
