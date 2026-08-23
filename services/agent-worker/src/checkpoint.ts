export const CHECKPOINT_KIND = 'khloei.agents-run-state'
export const CHECKPOINT_FORMAT_VERSION = 1
export const COMPUTER_AGENT_GRAPH_VERSION = 1
export const AGENTS_SDK_CHECKPOINT_VERSION = '0.17.0'

type CheckpointEnvelope = {
  agentsSdkVersion: string
  agentGraphVersion: number
  formatVersion: number
  kind: typeof CHECKPOINT_KIND
  serializedState: string
}

export type DecodedCheckpoint = {
  legacy: boolean
  serializedState: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class IncompatibleCheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IncompatibleCheckpointError'
  }
}

export function encodeRunStateCheckpoint(serializedState: string) {
  const envelope: CheckpointEnvelope = {
    agentsSdkVersion: AGENTS_SDK_CHECKPOINT_VERSION,
    agentGraphVersion: COMPUTER_AGENT_GRAPH_VERSION,
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    kind: CHECKPOINT_KIND,
    serializedState,
  }
  return JSON.stringify(envelope)
}

/**
 * Raw RunState strings written before checkpoint envelopes were introduced are
 * accepted once and rewritten on worker startup. Versioned envelopes always
 * fail closed when their SDK, graph, or format is not supported.
 */
export function decodeRunStateCheckpoint(value: string): DecodedCheckpoint {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new IncompatibleCheckpointError(
      'The saved agent checkpoint is not valid JSON and cannot be resumed safely.',
    )
  }

  if (!isRecord(parsed) || parsed.kind !== CHECKPOINT_KIND) {
    return { legacy: true, serializedState: value }
  }
  if (parsed.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
    throw new IncompatibleCheckpointError(
      `Checkpoint format ${String(parsed.formatVersion)} is not supported by this worker.`,
    )
  }
  if (parsed.agentGraphVersion !== COMPUTER_AGENT_GRAPH_VERSION) {
    throw new IncompatibleCheckpointError(
      `Computer agent graph ${String(parsed.agentGraphVersion)} cannot be resumed by graph ${COMPUTER_AGENT_GRAPH_VERSION}.`,
    )
  }
  if (parsed.agentsSdkVersion !== AGENTS_SDK_CHECKPOINT_VERSION) {
    throw new IncompatibleCheckpointError(
      `Agents SDK checkpoint ${String(parsed.agentsSdkVersion)} cannot be resumed by SDK ${AGENTS_SDK_CHECKPOINT_VERSION}.`,
    )
  }
  if (typeof parsed.serializedState !== 'string' || !parsed.serializedState) {
    throw new IncompatibleCheckpointError(
      'The saved agent checkpoint does not contain a serialized RunState.',
    )
  }
  return { legacy: false, serializedState: parsed.serializedState }
}
