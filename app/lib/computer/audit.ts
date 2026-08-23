import 'server-only'

import { createComputerTransport } from './client'

export type ComputerAuditDecision = {
  allowed: boolean
  carriedOut: boolean
  mode: 'dry-run' | 'enforce'
  reason: string
  rule: string | null
  source: 'allow' | 'deny' | 'default'
}

export type ComputerAuditEvent = {
  action: string
  actor: string
  bot: string
  decision?: ComputerAuditDecision
  eventType:
    | 'computer.action_decided'
    | 'computer.action_completed'
    | 'computer.action_failed'
    | 'computer.help_requested'
    | 'computer.control_taken'
    | 'computer.control_released'
    | 'computer.help_completed'
    | 'computer.assistance_cancelled'
    | 'computer.secret_requested'
    | 'computer.secret_completed'
    | 'computer.secret_supplied'
  hash: string
  id: string
  outcome?: Record<string, unknown>
  previousHash: string | null
  recordedAt: string
  sessionId: string
  target: Record<string, unknown>
}

type ComputerAuditInput = Omit<
  ComputerAuditEvent,
  'hash' | 'id' | 'previousHash' | 'recordedAt'
>

const sensitiveKeys = new Set([
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'authorization',
  'client_secret',
  'clientsecret',
  'content',
  'contents',
  'credential',
  'credentials',
  'id_token',
  'idtoken',
  'password',
  'prompt',
  'refresh_token',
  'refreshtoken',
  'secret',
  'secrets',
  'text',
  'token',
  'tokens',
  'tool_arguments',
  'tool_result',
])

let appendQueue: Promise<void> = Promise.resolve()

function normalizedKey(key: string) {
  return key.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKeys.has(key.toLowerCase()) ||
      sensitiveKeys.has(normalizedKey(key))
        ? '[REDACTED]'
        : redact(nested),
    ]),
  )
}

function auditConfiguration() {
  const baseUrl =
    process.env.KHLOEI_COMPUTER_URL?.trim() ||
    process.env.AGENT_COMPUTER_URL?.trim() ||
    'http://127.0.0.1:4100'
  const token = process.env.COMPUTER_TOKEN?.trim()
  if (!token) {
    throw new Error('COMPUTER_TOKEN is not configured on the server.')
  }
  return { baseUrl, token }
}

function isAuditEvent(
  value: unknown,
  input: ComputerAuditInput,
): value is ComputerAuditEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<ComputerAuditEvent>
  return (
    event.action === input.action &&
    event.bot === input.bot &&
    event.eventType === input.eventType &&
    typeof event.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(event.hash) &&
    typeof event.id === 'string' &&
    event.id.length > 0 &&
    (event.previousHash === null ||
      (typeof event.previousHash === 'string' &&
        /^[a-f0-9]{64}$/.test(event.previousHash))) &&
    typeof event.recordedAt === 'string' &&
    !Number.isNaN(Date.parse(event.recordedAt))
  )
}

/**
 * Append one tamper-evident audit event to the computer's durable volume.
 *
 * Calls are serialized within this server process, while the single-replica
 * computer service serializes calls across all Vercel instances. If this
 * request or its fsynced append fails, the gateway does not act.
 */
export function recordComputerAuditEvent(
  input: ComputerAuditInput,
): Promise<ComputerAuditEvent> {
  const run = appendQueue.then(async () => {
    const configuration = auditConfiguration()
    const transport = createComputerTransport({
      token: configuration.token,
      timeoutMs: 15_000,
    })
    const sanitized = redact(input) as ComputerAuditInput
    const event = await transport.post<ComputerAuditEvent>(
      configuration.baseUrl,
      input.bot,
      '/audit/events',
      sanitized,
    )
    if (!isAuditEvent(event, sanitized)) {
      throw new Error('The computer returned an invalid audit receipt.')
    }
    return event
  })

  appendQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
