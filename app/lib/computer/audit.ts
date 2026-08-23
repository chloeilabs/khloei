import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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
    | 'computer.secret_requested'
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
let cachedLastHash: string | null | undefined

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

function auditPath() {
  const configured = process.env.KHLOEI_COMPUTER_DATA_DIR?.trim()
  const dataRoot = configured
    ? resolve(/* turbopackIgnore: true */ configured)
    : resolve(
        /* turbopackIgnore: true */ process.cwd(),
        '.khloei/computer',
      )
  return resolve(dataRoot, 'audit/events.ndjson')
}

async function lastHash(path: string) {
  if (cachedLastHash !== undefined) return cachedLastHash

  try {
    const lines = (await readFile(/* turbopackIgnore: true */ path, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const latest = lines.at(-1)
    if (!latest) return (cachedLastHash = null)
    const parsed = JSON.parse(latest) as { hash?: unknown }
    cachedLastHash = typeof parsed.hash === 'string' ? parsed.hash : null
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      cachedLastHash = null
    } else {
      throw error
    }
  }
  return cachedLastHash
}

/**
 * Append one tamper-evident audit event.
 *
 * Calls are serialized so the hash chain and file order are the same order in
 * which actions pass through the gateway. If this write fails, the gateway does
 * not act.
 */
export function recordComputerAuditEvent(
  input: ComputerAuditInput,
): Promise<ComputerAuditEvent> {
  const run = appendQueue.then(async () => {
    const path = auditPath()
    await mkdir(dirname(path), { recursive: true })
    const previousHash = await lastHash(path)
    const unsigned = {
      ...input,
      id: randomUUID(),
      previousHash,
      recordedAt: new Date().toISOString(),
    }
    const sanitized = redact(unsigned) as Omit<ComputerAuditEvent, 'hash'>
    const hash = createHash('sha256')
      .update(JSON.stringify(sanitized))
      .digest('hex')
    const event: ComputerAuditEvent = { ...sanitized, hash }
    await appendFile(path, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    cachedLastHash = hash
    return event
  })

  appendQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function computerAuditFilePath() {
  return auditPath()
}
