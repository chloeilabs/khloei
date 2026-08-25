export type ChatSource = {
  title: string
  url: string
}

export type ChatAttachment = {
  kind: 'file' | 'image'
  name: string
  url?: string
}

export type ChatFollowUpQuestion = {
  id: string
  text: string
}

export type ChatWebSearchAction =
  | {
      queries?: string[]
      query?: string
      type: 'search'
    }
  | {
      type: 'open_page'
      url?: string | null
    }
  | {
      pattern: string
      type: 'find_in_page'
      url: string
    }

export type ChatComputerAction = {
  action: string
  auditEventId?: string
  decision?: {
    allowed: boolean
    reason: string
    rule: string | null
  }
  detail?: string
  stage: 'deciding' | 'approved' | 'refused' | 'completed' | 'failed'
  target?: string
}

export type ChatComputerFrame = {
  capturedAt: string
  /**
   * Absent once screenshot retention has swept the bytes this frame referenced.
   * The frame is kept so the transcript still records that Khloei looked, and
   * `screenshotUnavailable` says why there is nothing to show.
   */
  dataUrl?: string
  height: number
  screenshotUnavailable?: boolean
  url?: string
  width: number
}

/**
 * Screenshot types a computer surface can actually send.
 *
 * The browser surface returns PNG and the Linux desktop returns JPEG. Accepting
 * only one of them silently drops every frame from the other, which is why this
 * lives in one place rather than being spelled out at each boundary.
 */
const COMPUTER_FRAME_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a computer frame arriving from the network or from restored state.
 *
 * A frame whose screenshot has passed its retention window arrives with no
 * `dataUrl` and `screenshotUnavailable` set. That is a real frame worth keeping:
 * the transcript still records that Khloei looked, and the card shows why there
 * is nothing to display.
 */
export function normalizeComputerFrame(
  value: unknown,
): ChatComputerFrame | undefined {
  if (
    !isRecordValue(value) ||
    typeof value.capturedAt !== 'string' ||
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

  const unavailable = value.screenshotUnavailable === true
  const hasDataUrl =
    typeof value.dataUrl === 'string' &&
    COMPUTER_FRAME_DATA_URL.test(value.dataUrl)
  if (!hasDataUrl && !unavailable) return undefined

  return {
    capturedAt: value.capturedAt,
    height: value.height,
    width: value.width,
    ...(hasDataUrl ? { dataUrl: value.dataUrl as string } : {}),
    ...(unavailable ? { screenshotUnavailable: true } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
  }
}

export type ChatActivityStatus =
  | 'in_progress'
  | 'searching'
  | 'completed'
  | 'failed'

export type ChatActivity = {
  action?: ChatWebSearchAction
  computer?: ChatComputerAction
  id: string
  kind: 'computer' | 'reasoning' | 'web_search'
  status: ChatActivityStatus
  summary?: string
}

export type ChatMessage = {
  activities?: ChatActivity[]
  attachments?: ChatAttachment[]
  content: string
  computerFrame?: ChatComputerFrame
  followUpQuestions?: ChatFollowUpQuestion[]
  followUpQuestionsPending?: boolean
  id: string
  responseId?: string
  role: 'assistant' | 'user'
  sources?: ChatSource[]
  status?: 'complete' | 'error' | 'stopped' | 'streaming'
}

export type ChatStreamEvent =
  | { activity: ChatActivity; type: 'activity' }
  | { frame: ChatComputerFrame; type: 'computer-frame' }
  | {
      backgroundKind?: 'openai'
      responseId: string
      resumeToken: string
      sequenceNumber: number
      type: 'background'
    }
  | {
      backgroundKind: 'computer'
      resumeToken: string
      sequenceNumber: number
      taskId: string
      type: 'background'
    }
  | { sequenceNumber: number; type: 'cursor' }
  | { delta: string; type: 'text-delta' }
  | {
      content: string
      responseId: string
      sources: ChatSource[]
      type: 'message'
    }
  | { type: 'cancelled' }
  | { message: string; type: 'error' }
  | { type: 'reconnect' }
  | { type: 'done' }
