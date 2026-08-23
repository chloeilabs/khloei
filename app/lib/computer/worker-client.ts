import 'server-only'

import type { AgentInputItem } from '@openai/agents'

import type { ChatModelId } from '../chat-models'
import type { ChatStreamEvent } from '../chat'
import type { ModelProvider } from '../model-provider'
import {
  computerWorkerToken,
  computerWorkerUrl,
  isComputerTaskId,
} from './worker-auth'

export type ComputerTaskStatus =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'queued'
  | 'running'
  | 'waiting_for_human'

export type ComputerTaskEvent = {
  payload: ChatStreamEvent
  sequenceNumber: number
}

export type ComputerTaskSnapshot = {
  error: string | null
  events: ComputerTaskEvent[]
  hasMore: boolean
  sequenceNumber: number
  status: ComputerTaskStatus
}

type CreateComputerTaskInput = {
  input: AgentInputItem[]
  model: ChatModelId
  previousResponseId?: string
  provider: ModelProvider
}

function configuration() {
  const baseUrl = computerWorkerUrl()
  const token = computerWorkerToken()
  if (!baseUrl || !token) {
    throw new Error('Khloei\'s durable computer worker is not configured.')
  }
  return { baseUrl, token }
}

async function workerFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const { baseUrl, token } = configuration()
  return fetch(`${baseUrl}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: unknown })
    | null
  if (!response.ok) {
    const message =
      body && typeof body.error === 'string'
        ? body.error
        : 'Khloei\'s durable computer worker is unavailable.'
    throw new Error(message)
  }
  if (!body) throw new Error('The computer worker returned an empty response.')
  return body
}

export async function createComputerTask(
  input: CreateComputerTaskInput,
  signal: AbortSignal,
) {
  const response = await workerFetch('/v1/tasks', {
    body: JSON.stringify(input),
    method: 'POST',
    signal,
  })
  const body = await jsonResponse<{ taskId: string }>(response)
  if (!isComputerTaskId(body.taskId)) {
    throw new Error('The computer worker returned an invalid task id.')
  }
  return body.taskId
}

export async function readComputerTask(
  taskId: string,
  startingAfter: number,
  signal: AbortSignal,
): Promise<ComputerTaskSnapshot> {
  if (!isComputerTaskId(taskId)) throw new Error('Invalid computer task id.')
  const params = new URLSearchParams({ after: String(startingAfter) })
  const response = await workerFetch(
    `/v1/tasks/${encodeURIComponent(taskId)}/events?${params}`,
    { method: 'GET', signal },
  )
  return jsonResponse<ComputerTaskSnapshot>(response)
}

export async function cancelComputerTask(
  taskId: string,
  signal?: AbortSignal,
) {
  if (!isComputerTaskId(taskId)) throw new Error('Invalid computer task id.')
  const response = await workerFetch(
    `/v1/tasks/${encodeURIComponent(taskId)}`,
    { method: 'DELETE', signal },
  )
  return jsonResponse<{ status: ComputerTaskStatus }>(response)
}
