import { timingSafeEqual } from 'node:crypto'

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
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{8,200}$/
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
    (value.provider !== 'openai' && value.provider !== 'openrouter') ||
    typeof value.model !== 'string' ||
    !value.model ||
    value.model.length > 200 ||
    !Array.isArray(value.input) ||
    value.input.length === 0 ||
    value.input.length > 100 ||
    (value.previousResponseId !== undefined &&
      (typeof value.previousResponseId !== 'string' ||
        !RESPONSE_ID_PATTERN.test(value.previousResponseId)))
  ) {
    return null
  }
  return {
    input: value.input as ComputerTaskRequest['input'],
    model: value.model,
    provider: value.provider,
    ...(typeof value.previousResponseId === 'string'
      ? { previousResponseId: value.previousResponseId }
      : {}),
  }
}

const store = new TaskStore(DB_PATH)
const service = new AgentWorkerService(store)
service.start()

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ durable: true, status: 'ok' })
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
    database: DB_PATH,
    port: server.port,
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
