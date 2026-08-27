import { timingSafeEqual } from 'node:crypto'
import { dirname, resolve } from 'node:path'

import {
  COMPUTER_CONTRACT_FEATURES,
  COMPUTER_CONTRACT_VERSION,
} from '../../../shared/computer-contract'
import {
  createScreenshotStore,
  DEFAULT_SCREENSHOT_MAX_AGE_MS,
  DEFAULT_SCREENSHOT_MAX_BYTES,
} from './screenshot-store'
import { AgentWorkerService } from './service'
import { TaskStore } from './store'
import type { ComputerTaskRequest } from './types'

const PORT = Number.parseInt(process.env.PORT ?? '4200', 10)
const DB_PATH = process.env.AGENT_WORKER_DB_PATH?.trim() || '/data/tasks.sqlite'
const DEDICATED_WORKER_TOKEN =
  process.env.KHLOEI_AGENT_WORKER_TOKEN?.trim()
const LOCAL_DEVELOPMENT =
  !process.env.RAILWAY_ENVIRONMENT_ID &&
  process.env.NODE_ENV !== 'production'
const WORKER_TOKEN =
  DEDICATED_WORKER_TOKEN ||
  (LOCAL_DEVELOPMENT ? process.env.COMPUTER_TOKEN?.trim() : undefined)
const MAX_CREATE_BODY_BYTES = 40 * 1024 * 1024
const TASK_PATH = /^\/v1\/tasks\/(task_[A-Za-z0-9_-]{16,100})$/
const EVENTS_PATH =
  /^\/v1\/tasks\/(task_[A-Za-z0-9_-]{16,100})\/events$/

if (!WORKER_TOKEN) {
  console.error(
    'KHLOEI_AGENT_WORKER_TOKEN is not set. The durable worker will not start without server-to-server authentication.',
  )
  process.exit(1)
}

function authorized(request: Request) {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return false
  const expected = Buffer.from(WORKER_TOKEN!)
  const provided = Buffer.from(header.slice('Bearer '.length))
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  )
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    status,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function taskRequest(value: unknown): ComputerTaskRequest | null {
  if (!isRecord(value)) return null
  if (
    value.provider !== 'openrouter' ||
    typeof value.model !== 'string' ||
    !value.model ||
    value.model.length > 200 ||
    !Array.isArray(value.input) ||
    value.input.length === 0 ||
    value.input.length > 100 ||
    (value.kind !== undefined &&
      value.kind !== 'computer' &&
      value.kind !== 'deep-research')
  ) {
    return null
  }
  return {
    input: value.input as ComputerTaskRequest['input'],
    ...(value.kind === 'deep-research' ? { kind: 'deep-research' as const } : {}),
    model: value.model,
    provider: value.provider,
  }
}

function positiveNumber(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Screenshots live beside the database on the same durable volume, so a
 * deployment that already persists the ledger persists their bytes too.
 */
const SCREENSHOT_DIR =
  process.env.AGENT_WORKER_SCREENSHOT_DIR?.trim() ||
  (DB_PATH === ':memory:'
    ? resolve('.khloei/agent-worker/screenshots')
    : resolve(dirname(DB_PATH), 'screenshots'))

const screenshots = createScreenshotStore({
  directory: SCREENSHOT_DIR,
  maxAgeMs:
    positiveNumber(
      'AGENT_WORKER_SCREENSHOT_MAX_AGE_DAYS',
      DEFAULT_SCREENSHOT_MAX_AGE_MS / (24 * 60 * 60 * 1_000),
    ) *
    24 *
    60 *
    60 *
    1_000,
  maxTotalBytes: positiveNumber(
    'AGENT_WORKER_SCREENSHOT_MAX_BYTES',
    DEFAULT_SCREENSHOT_MAX_BYTES,
  ),
})

const store = new TaskStore(DB_PATH, screenshots)
const service = new AgentWorkerService(store)
service.start()

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health' && request.method === 'GET') {
      const budget = store.screenshots?.stats()
      return json({
        contract: {
          features: [...COMPUTER_CONTRACT_FEATURES],
          version: COMPUTER_CONTRACT_VERSION,
        },
        durable: true,
        // Storage pressure is reported rather than only logged: a worker that is
        // sweeping screenshots faster than tasks finish is a capacity problem an
        // operator has to be able to see without shelling into the volume.
        screenshots: budget
          ? {
              directory: budget.directory,
              files: budget.files,
              maxAgeMs: budget.maxAgeMs,
              maxTotalBytes: budget.maxTotalBytes,
              totalBytes: budget.totalBytes,
              usedFraction:
                budget.maxTotalBytes > 0
                  ? Number((budget.totalBytes / budget.maxTotalBytes).toFixed(4))
                  : 0,
            }
          : null,
        status: 'ok',
      })
    }
    if (!authorized(request)) return json({ error: 'Unauthorized.' }, 401)

    if (url.pathname === '/v1/tasks' && request.method === 'POST') {
      const contentLength = Number(request.headers.get('content-length') ?? '0')
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_CREATE_BODY_BYTES
      ) {
        return json({ error: 'The task request is too large.' }, 413)
      }
      const body = taskRequest(await request.json().catch(() => null))
      if (!body) return json({ error: 'Invalid computer task request.' }, 400)
      const task = service.createTask(body)
      return json({ status: task.status, taskId: task.id }, 202)
    }

    const eventMatch = url.pathname.match(EVENTS_PATH)
    if (eventMatch && request.method === 'GET') {
      const afterValue = url.searchParams.get('after') ?? '0'
      const after = Number(afterValue)
      if (!Number.isSafeInteger(after) || after < 0) {
        return json({ error: 'The event cursor is invalid.' }, 400)
      }
      const task = await service.events(eventMatch[1]!, after, request.signal)
      if (!task) return json({ error: 'Computer task not found.' }, 404)
      return json(task)
    }

    const taskMatch = url.pathname.match(TASK_PATH)
    if (taskMatch && request.method === 'DELETE') {
      const task = await service.cancel(taskMatch[1]!)
      if (!task) return json({ error: 'Computer task not found.' }, 404)
      return json({ status: task.status })
    }

    return json({ error: 'Not found.' }, 404)
  },
})

console.info(
  JSON.stringify({
    contractVersion: COMPUTER_CONTRACT_VERSION,
    database: DB_PATH,
    port: server.port,
    screenshots: SCREENSHOT_DIR,
    type: 'khloei-agent-worker-started',
  }),
)

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await server.stop(true)
  await service.close()
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
