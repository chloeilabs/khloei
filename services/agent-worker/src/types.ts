import type { AgentInputItem } from '@openai/agents'

/** Khloei reaches every model through OpenRouter. */
export type ModelProvider = 'openrouter'

/**
 * What the worker is running. Both kinds get the same durability; they differ
 * in what the agent is given. A computer task carries tools whose effects are
 * recorded exactly-once, while a research task takes no actions in the world.
 */
export type AgentTaskKind = 'computer' | 'deep-research'

export type ComputerTaskRequest = {
  input: AgentInputItem[]
  /** Absent means `computer`, which is what every task was before research. */
  kind?: AgentTaskKind
  model: string
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
