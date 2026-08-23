import type {
  ChatActivity,
  ChatAttachment,
  ChatComputerAction,
  ChatComputerFrame,
  ChatMessage,
  ChatSource,
  ChatWebSearchAction,
} from './chat'

const STORAGE_KEY = 'khloei.active-background-chat.v2'
const LEGACY_STORAGE_KEY = 'khloei.active-background-chat.v1'
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1_000
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{8,200}$/
const TASK_ID_PATTERN = /^task_[A-Za-z0-9_-]{8,200}$/
const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

type ActiveBackgroundBase = {
  assistantId: string
  createdAt: number
  messages: ChatMessage[]
  resumeToken: string
  sequenceNumber: number
  version: 2
}

export type ActiveBackgroundChat = ActiveBackgroundBase &
  (
    | { backgroundKind: 'openai'; responseId: string }
    | { backgroundKind: 'computer'; taskId: string }
  )

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function restoredAttachment(value: unknown): ChatAttachment | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null
  if (value.kind !== 'file' && value.kind !== 'image') return null
  return { kind: value.kind, name: value.name.slice(0, 180) }
}

function restoredSource(value: unknown): ChatSource | null {
  if (
    !isRecord(value) ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string'
  ) {
    return null
  }
  return { title: value.title, url: value.url }
}

function restoredAction(value: unknown): ChatWebSearchAction | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'search') {
    const query = typeof value.query === 'string' ? value.query : undefined
    const queries = Array.isArray(value.queries)
      ? value.queries.filter(
          (item): item is string => typeof item === 'string',
        )
      : undefined
    return {
      type: 'search',
      ...(query ? { query } : {}),
      ...(queries?.length ? { queries } : {}),
    }
  }
  if (value.type === 'open_page') {
    return {
      type: 'open_page',
      ...(typeof value.url === 'string' ? { url: value.url } : {}),
    }
  }
  if (
    value.type === 'find_in_page' &&
    typeof value.pattern === 'string' &&
    typeof value.url === 'string'
  ) {
    return {
      pattern: value.pattern,
      type: 'find_in_page',
      url: value.url,
    }
  }
  return undefined
}

function restoredComputerAction(value: unknown): ChatComputerAction | undefined {
  if (!isRecord(value) || typeof value.action !== 'string') return undefined
  if (
    value.stage !== 'deciding' &&
    value.stage !== 'approved' &&
    value.stage !== 'refused' &&
    value.stage !== 'completed' &&
    value.stage !== 'failed'
  ) {
    return undefined
  }

  const decision =
    isRecord(value.decision) &&
    typeof value.decision.allowed === 'boolean' &&
    typeof value.decision.reason === 'string' &&
    (value.decision.rule === null || typeof value.decision.rule === 'string')
      ? {
          allowed: value.decision.allowed,
          reason: value.decision.reason,
          rule: value.decision.rule,
        }
      : undefined

  return {
    action: value.action,
    stage: value.stage,
    ...(typeof value.auditEventId === 'string'
      ? { auditEventId: value.auditEventId }
      : {}),
    ...(decision ? { decision } : {}),
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.target === 'string' ? { target: value.target } : {}),
  }
}

function restoredActivity(value: unknown): ChatActivity | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  if (
    value.kind !== 'computer' &&
    value.kind !== 'reasoning' &&
    value.kind !== 'web_search'
  ) {
    return null
  }
  if (
    value.status !== 'in_progress' &&
    value.status !== 'searching' &&
    value.status !== 'completed' &&
    value.status !== 'failed'
  ) {
    return null
  }

  const action = restoredAction(value.action)
  const computer = restoredComputerAction(value.computer)
  return {
    id: value.id,
    kind: value.kind,
    status: value.status,
    ...(action ? { action } : {}),
    ...(computer ? { computer } : {}),
    ...(typeof value.summary === 'string'
      ? { summary: value.summary }
      : {}),
  }
}

function restoredComputerFrame(value: unknown): ChatComputerFrame | undefined {
  if (
    !isRecord(value) ||
    typeof value.capturedAt !== 'string' ||
    typeof value.dataUrl !== 'string' ||
    !value.dataUrl.startsWith('data:image/png;base64,') ||
    typeof value.height !== 'number' ||
    !Number.isFinite(value.height) ||
    value.height <= 0 ||
    typeof value.width !== 'number' ||
    !Number.isFinite(value.width) ||
    value.width <= 0 ||
    (value.url !== undefined && typeof value.url !== 'string')
  ) {
    return undefined
  }

  return {
    capturedAt: value.capturedAt,
    dataUrl: value.dataUrl,
    height: value.height,
    width: value.width,
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
  }
}

function restoredMessage(value: unknown): ChatMessage | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.content !== 'string' ||
    (value.role !== 'assistant' && value.role !== 'user')
  ) {
    return null
  }
  if (
    value.status !== undefined &&
    value.status !== 'complete' &&
    value.status !== 'error' &&
    value.status !== 'stopped' &&
    value.status !== 'streaming'
  ) {
    return null
  }

  const activities = Array.isArray(value.activities)
    ? value.activities
        .map(restoredActivity)
        .filter((item): item is ChatActivity => item !== null)
    : []
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .map(restoredAttachment)
        .filter((item): item is ChatAttachment => item !== null)
    : []
  const computerFrame = restoredComputerFrame(value.computerFrame)
  const sources = Array.isArray(value.sources)
    ? value.sources
        .map(restoredSource)
        .filter((item): item is ChatSource => item !== null)
    : []

  return {
    content: value.content,
    id: value.id,
    role: value.role,
    ...(activities.length ? { activities } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(computerFrame ? { computerFrame } : {}),
    ...(typeof value.responseId === 'string' &&
    RESPONSE_ID_PATTERN.test(value.responseId)
      ? { responseId: value.responseId }
      : {}),
    ...(sources.length ? { sources } : {}),
    ...(value.status ? { status: value.status } : {}),
  }
}

export function snapshotBackgroundMessages(
  messages: readonly ChatMessage[],
  activeAssistantId?: string,
): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    activities: message.activities?.map((activity) => ({
      ...activity,
      computer: activity.computer
        ? {
            ...activity.computer,
            decision: activity.computer.decision
              ? { ...activity.computer.decision }
              : undefined,
          }
        : undefined,
    })),
    attachments: message.attachments?.map(({ kind, name }) => ({ kind, name })),
    computerFrame:
      message.id === activeAssistantId && message.computerFrame
      ? { ...message.computerFrame }
      : undefined,
    followUpQuestions: undefined,
    followUpQuestionsPending: undefined,
    sources: message.sources?.map((source) => ({ ...source })),
  }))
}

function parseActiveBackgroundChat(value: unknown): ActiveBackgroundChat | null {
  if (!isRecord(value)) return null
  const isLegacy = value.version === 1
  const backgroundKind = isLegacy ? 'openai' : value.backgroundKind
  if (
    (!isLegacy && value.version !== 2) ||
    typeof value.assistantId !== 'string' ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    !Number.isSafeInteger(value.sequenceNumber) ||
    Number(value.sequenceNumber) < 0 ||
    typeof value.resumeToken !== 'string' ||
    !RESUME_TOKEN_PATTERN.test(value.resumeToken) ||
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > 100 ||
    Date.now() - value.createdAt > MAX_RECOVERY_AGE_MS ||
    value.createdAt > Date.now() + 60_000
  ) {
    return null
  }
  if (backgroundKind !== 'openai' && backgroundKind !== 'computer') {
    return null
  }
  if (
    (backgroundKind === 'openai' &&
      (typeof value.responseId !== 'string' ||
        !RESPONSE_ID_PATTERN.test(value.responseId))) ||
    (backgroundKind === 'computer' &&
      (typeof value.taskId !== 'string' || !TASK_ID_PATTERN.test(value.taskId)))
  ) {
    return null
  }

  const messages = value.messages.map(restoredMessage)
  if (messages.some((message) => message === null)) return null
  const restored = messages as ChatMessage[]
  if (
    !restored.some(
      (message) =>
        message.id === value.assistantId && message.role === 'assistant',
    )
  ) {
    return null
  }

  const base = {
    assistantId: value.assistantId,
    createdAt: value.createdAt,
    messages: restored,
    resumeToken: value.resumeToken,
    sequenceNumber: Number(value.sequenceNumber),
    version: 2 as const,
  }
  return backgroundKind === 'computer'
    ? { ...base, backgroundKind, taskId: value.taskId as string }
    : { ...base, backgroundKind, responseId: value.responseId as string }
}

export function readActiveBackgroundChat(): ActiveBackgroundChat | null {
  if (typeof window === 'undefined') return null

  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    const restored = parseActiveBackgroundChat(JSON.parse(raw) as unknown)
    if (!restored) throw new Error('invalid')
    if (restored.backgroundKind === 'openai') {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(restored))
    }
    return restored
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    return null
  }
}

export function writeActiveBackgroundChat(value: ActiveBackgroundChat) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...value,
          messages: value.messages.map((message) => ({
            ...message,
            computerFrame: undefined,
          })),
        }),
      )
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      // The task keeps running if browser storage is unavailable.
    }
  }
}

export function clearActiveBackgroundChat() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Ignore storage failures while clearing recovery metadata.
  }
}
