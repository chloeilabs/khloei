import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

const TASK_ID_PATTERN = /^task_[A-Za-z0-9_-]{16,100}$/
const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const TOKEN_CONTEXT = 'khloei-computer-task-v1'

export function computerWorkerToken() {
  const dedicated = process.env.KHLOEI_AGENT_WORKER_TOKEN?.trim()
  if (dedicated) return dedicated

  const localDevelopment =
    !process.env.VERCEL &&
    !process.env.RAILWAY_ENVIRONMENT_ID &&
    process.env.NODE_ENV !== 'production'
  return localDevelopment ? process.env.COMPUTER_TOKEN?.trim() : undefined
}

export function isComputerWorkerRequired() {
  return (
    process.env.KHLOEI_REQUIRE_AGENT_WORKER === 'true' ||
    process.env.VERCEL === '1' ||
    process.env.NODE_ENV === 'production'
  )
}

export function computerWorkerUrl() {
  const value = process.env.KHLOEI_AGENT_WORKER_URL?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function isComputerWorkerConfigured() {
  return Boolean(computerWorkerUrl() && computerWorkerToken())
}

export function isComputerTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value)
}

function signingSecret() {
  const secret = computerWorkerToken()
  if (!secret) {
    throw new Error('KHLOEI_AGENT_WORKER_TOKEN is not configured on the server.')
  }
  return secret
}

export function createComputerTaskResumeToken(taskId: string) {
  if (!isComputerTaskId(taskId)) throw new Error('Invalid computer task id.')
  return createHmac('sha256', signingSecret())
    .update(`${TOKEN_CONTEXT}:${taskId}`)
    .digest('base64url')
}

export function isValidComputerTaskResumeToken(
  taskId: string,
  token: unknown,
) {
  if (
    !isComputerTaskId(taskId) ||
    typeof token !== 'string' ||
    !RESUME_TOKEN_PATTERN.test(token)
  ) {
    return false
  }
  const expected = Buffer.from(createComputerTaskResumeToken(taskId))
  const provided = Buffer.from(token)
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  )
}

export function isAuthorizedComputerWorkerRequest(request: Request) {
  const token = computerWorkerToken()
  const authorization = request.headers.get('authorization')
  if (!token || !authorization?.startsWith('Bearer ')) return false

  const expected = Buffer.from(token)
  const provided = Buffer.from(authorization.slice('Bearer '.length))
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  )
}
