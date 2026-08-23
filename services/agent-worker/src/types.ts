import type { AgentInputItem } from '@openai/agents'

export type ModelProvider = 'openai' | 'openrouter'

export type ComputerTaskRequest = {
  input: AgentInputItem[]
  model: string
  previousResponseId?: string
  provider: ModelProvider
}

export type TaskStatus =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'queued'
  | 'running'
  | 'waiting_for_human'

export type ComputerToolInvocation = {
  callId: string
  input: unknown
  name: string
}

export type PendingApproval = {
  invocation: ComputerToolInvocation
  requestedAt: number
  ready: boolean
}

export type TaskRecord = {
  approval: PendingApproval | null
  cancelRequested: boolean
  createdAt: number
  error: string | null
  gatewayState: Record<string, unknown> | null
  id: string
  leaseExpiresAt: number | null
  leaseOwner: string | null
  recoveryNote: string | null
  request: ComputerTaskRequest
  runState: string | null
  status: TaskStatus
  updatedAt: number
}

export type TaskEvent<T = unknown> = {
  createdAt: number
  payload: T
  sequenceNumber: number
}

export type WorkerActionResponse = {
  events: unknown[]
  gatewayState: Record<string, unknown>
  outcome?: unknown
  ready?: boolean
}
