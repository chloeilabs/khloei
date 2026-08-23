import {
  cancelComputerTask,
  readComputerTask,
} from '@/app/lib/computer/worker-client'
import {
  isComputerTaskId,
  isValidComputerTaskResumeToken,
} from '@/app/lib/computer/worker-auth'
import type { ChatStreamEvent } from '@/app/lib/chat'
import { STREAM_HEADERS } from '@/app/lib/model-chat-stream'
import { requireSameOriginRequest } from '@/app/lib/request-origin'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const runtime = 'nodejs'

type ComputerBackgroundRequest = {
  resumeToken: string
  startingAfter: number
  taskId: string
}

function jsonError(message: string, status: number) {
  return Response.json(
    { error: message },
    { headers: { 'Cache-Control': 'no-store' }, status },
  )
}

async function backgroundRequest(request: Request) {
  const value = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (
    !value ||
    !isComputerTaskId(value.taskId) ||
    typeof value.resumeToken !== 'string' ||
    !Number.isSafeInteger(value.startingAfter) ||
    Number(value.startingAfter) < 0
  ) {
    return null
  }
  return {
    resumeToken: value.resumeToken,
    startingAfter: Number(value.startingAfter),
    taskId: value.taskId,
  } satisfies ComputerBackgroundRequest
}

function authorized(body: ComputerBackgroundRequest) {
  return isValidComputerTaskResumeToken(body.taskId, body.resumeToken)
}

export async function POST(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  const body = await backgroundRequest(request)
  if (!body) return jsonError('Invalid computer task request.', 400)
  if (!authorized(body)) {
    return jsonError('This computer task cannot be resumed.', 403)
  }

  try {
    const task = await readComputerTask(
      body.taskId,
      body.startingAfter,
      request.signal,
    )
    const events: ChatStreamEvent[] = task.events.map((event) => event.payload)
    if (task.sequenceNumber > body.startingAfter) {
      events.push({
        sequenceNumber: task.sequenceNumber,
        type: 'cursor',
      })
    }
    if (task.hasMore) {
      events.push({ type: 'reconnect' })
    } else if (
      task.status === 'queued' ||
      task.status === 'running' ||
      task.status === 'waiting_for_human'
    ) {
      events.push({ type: 'reconnect' })
    } else if (
      !events.some(
        (event) =>
          event.type === 'done' ||
          event.type === 'cancelled' ||
          event.type === 'error',
      )
    ) {
      if (task.status === 'completed') {
        events.push({ type: 'done' })
      } else if (task.status === 'cancelled') {
        events.push({ type: 'cancelled' })
      } else {
        events.push({
          message: task.error || 'Khloei could not complete the computer task.',
          type: 'error',
        })
      }
    }
    return new Response(
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      { headers: STREAM_HEADERS },
    )
  } catch (error) {
    return jsonError(
      error instanceof Error
        ? error.message
        : 'Khloei could not resume the computer task.',
      503,
    )
  }
}

export async function DELETE(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  const body = await backgroundRequest(request)
  if (!body) return jsonError('Invalid computer task request.', 400)
  if (!authorized(body)) {
    return jsonError('This computer task cannot be cancelled.', 403)
  }

  try {
    return Response.json(await cancelComputerTask(body.taskId, request.signal), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return jsonError(
      error instanceof Error
        ? error.message
        : 'Khloei could not cancel the computer task.',
      503,
    )
  }
}
