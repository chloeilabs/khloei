import type {
  ChatActivity,
  ChatAttachment,
  ChatMessage,
  ChatSource,
  ChatWebSearchAction,
} from './chat'

const STORAGE_KEY = 'khloei.active-background-chat.v1'
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1_000
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{8,200}$/
const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type ActiveBackgroundChat = {
  assistantId: string
  createdAt: number
  messages: ChatMessage[]
  responseId: string
  resumeToken: string
  sequenceNumber: number
  version: 1
}

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

function restoredActivity(value: unknown): ChatActivity | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  if (value.kind !== 'reasoning' && value.kind !== 'web_search') return null
  if (
    value.status !== 'in_progress' &&
    value.status !== 'searching' &&
    value.status !== 'completed' &&
    value.status !== 'failed'
  ) {
    return null
  }

  const action = restoredAction(value.action)
  return {
    id: value.id,
    kind: value.kind,
    status: value.status,
    ...(action ? { action } : {}),
    ...(typeof value.summary === 'string'
      ? { summary: value.summary }
      : {}),
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
): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    activities: message.activities?.map((activity) => ({ ...activity })),
    attachments: message.attachments?.map(({ kind, name }) => ({ kind, name })),
    followUpQuestions: undefined,
    followUpQuestionsPending: undefined,
    sources: message.sources?.map((source) => ({ ...source })),
  }))
}

export function readActiveBackgroundChat(): ActiveBackgroundChat | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.version !== 1) throw new Error('invalid')
    if (
      typeof value.assistantId !== 'string' ||
      typeof value.createdAt !== 'number' ||
      !Number.isSafeInteger(value.sequenceNumber) ||
      Number(value.sequenceNumber) < 0 ||
      typeof value.responseId !== 'string' ||
      !RESPONSE_ID_PATTERN.test(value.responseId) ||
      typeof value.resumeToken !== 'string' ||
      !RESUME_TOKEN_PATTERN.test(value.resumeToken) ||
      !Array.isArray(value.messages) ||
      value.messages.length === 0 ||
      value.messages.length > 100 ||
      Date.now() - value.createdAt > MAX_RECOVERY_AGE_MS ||
      value.createdAt > Date.now() + 60_000
    ) {
      throw new Error('invalid')
    }

    const messages = value.messages.map(restoredMessage)
    if (messages.some((message) => message === null)) throw new Error('invalid')
    const restored = messages as ChatMessage[]
    if (
      !restored.some(
        (message) =>
          message.id === value.assistantId && message.role === 'assistant',
      )
    ) {
      throw new Error('invalid')
    }

    return {
      assistantId: value.assistantId,
      createdAt: value.createdAt,
      messages: restored,
      responseId: value.responseId,
      resumeToken: value.resumeToken,
      sequenceNumber: Number(value.sequenceNumber),
      version: 1,
    }
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export function writeActiveBackgroundChat(value: ActiveBackgroundChat) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // The response still runs at OpenAI if browser storage is unavailable.
  }
}

export function clearActiveBackgroundChat() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage failures while clearing recovery metadata.
  }
}
