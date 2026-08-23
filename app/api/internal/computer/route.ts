import type { ComputerGatewayState } from '@/app/lib/computer/gateway'
import {
  performWorkerComputerOperation,
  type WorkerComputerInvocation,
  type WorkerComputerOperation,
} from '@/app/lib/computer/worker-action'
import { isAuthorizedComputerWorkerRequest } from '@/app/lib/computer/worker-auth'
import { isComputerTaskId } from '@/app/lib/computer/worker-auth'
import { KHLOEI_COMPUTER_TOOLS } from '@/app/lib/computer/tools'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const runtime = 'nodejs'

const MAX_BODY_BYTES = 5 * 1024 * 1024
const COMPUTER_SESSION_PATTERN = /^computer_[a-f0-9]{32}$/
const TOOL_NAMES = new Set(KHLOEI_COMPUTER_TOOLS.map((tool) => tool.name))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonError(message: string, status: number) {
  return Response.json(
    { error: message },
    { headers: { 'Cache-Control': 'no-store' }, status },
  )
}

function invocation(value: unknown): WorkerComputerInvocation | null {
  if (!isRecord(value)) return null
  if (
    typeof value.callId !== 'string' ||
    !value.callId ||
    value.callId.length > 200 ||
    typeof value.name !== 'string' ||
    !TOOL_NAMES.has(value.name) ||
    !isRecord(value.input)
  ) {
    return null
  }
  return { callId: value.callId, input: value.input, name: value.name }
}

function gatewayState(value: unknown): ComputerGatewayState | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    typeof value.currentPageUrl !== 'string' ||
    value.currentPageUrl.length > 20_000
  ) {
    throw new Error('Invalid computer gateway state.')
  }
  if (value.snapshot !== undefined) {
    if (!isRecord(value.snapshot)) {
      throw new Error('Invalid computer snapshot state.')
    }
    const snapshot = value.snapshot
    if (
      typeof snapshot.computerSessionId !== 'string' ||
      !COMPUTER_SESSION_PATTERN.test(snapshot.computerSessionId) ||
      !Number.isSafeInteger(snapshot.snapshotId) ||
      Number(snapshot.snapshotId) < 1 ||
      typeof snapshot.url !== 'string' ||
      snapshot.url.length > 20_000 ||
      typeof snapshot.title !== 'string' ||
      snapshot.title.length > 10_000 ||
      typeof snapshot.truncated !== 'boolean' ||
      !Array.isArray(snapshot.elements) ||
      snapshot.elements.length > 5_000
    ) {
      throw new Error('Invalid computer snapshot state.')
    }
  }
  return value as ComputerGatewayState
}

function operation(value: unknown): WorkerComputerOperation | null {
  if (!isRecord(value) || !isComputerTaskId(value.taskId)) return null
  if (
    value.operation !== 'tool' &&
    value.operation !== 'begin_assistance' &&
    value.operation !== 'assistance_status' &&
    value.operation !== 'cancel_assistance'
  ) {
    return null
  }
  const parsedInvocation = invocation(value.invocation)
  if (!parsedInvocation) return null

  return {
    gatewayState: gatewayState(value.gatewayState),
    invocation: parsedInvocation,
    operation: value.operation,
    taskId: value.taskId,
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedComputerWorkerRequest(request)) {
    return jsonError('The computer worker is not authorized.', 401)
  }
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonError('The computer worker request is too large.', 413)
  }

  try {
    const body = operation(await request.json().catch(() => null))
    if (!body) return jsonError('Invalid computer worker request.', 400)
    return Response.json(await performWorkerComputerOperation(body), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return jsonError(
      error instanceof Error
        ? error.message
        : 'The computer worker action failed.',
      502,
    )
  }
}
