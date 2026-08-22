import type { ChatFollowUpQuestion, ChatMessage } from './chat'

export const FOLLOW_UP_QUESTION_LIMIT = 3
export const FOLLOW_UP_QUESTION_MAX_CHARS = 160
export const FOLLOW_UP_CONTEXT_MAX_CHARS = 16_000
export const FOLLOW_UP_CONTEXT_MAX_MESSAGES = 10
export const FOLLOW_UP_REQUEST_MAX_MESSAGES = 20
export const FOLLOW_UP_REQUEST_MAX_MESSAGE_CHARS = 10_000
export const FOLLOW_UP_REQUEST_MAX_TOTAL_CHARS = 40_000

export type ChatFollowUpContextMessage = {
  content: string
  role: 'assistant' | 'user'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function normalizeQuestionText(text: string): string | null {
  const normalized = text
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/u, '')
    .replace(/\s+/g, ' ')

  if (!normalized || normalized.length > FOLLOW_UP_QUESTION_MAX_CHARS) {
    return null
  }

  return normalized
}

function readGeneratedQuestionTexts(value: unknown): string[] | null {
  if (!isRecord(value)) return null

  const questions = value.questions ?? value.follow_up_questions
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) {
    return null
  }
  if (!questions.every((question) => typeof question === 'string')) return null

  return questions
}

export function normalizeGeneratedFollowUpQuestionTexts(
  value: unknown,
): string[] {
  const questions = readGeneratedQuestionTexts(value)
  if (!questions) return []

  const seen = new Set<string>()
  const normalizedQuestions: string[] = []

  for (const question of questions) {
    const normalized = normalizeQuestionText(question)
    if (!normalized) continue

    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    normalizedQuestions.push(normalized)
  }

  return normalizedQuestions.slice(0, FOLLOW_UP_QUESTION_LIMIT)
}

export function createFollowUpQuestions(
  texts: readonly string[],
  createId: () => string = () => crypto.randomUUID(),
): ChatFollowUpQuestion[] {
  return texts.slice(0, FOLLOW_UP_QUESTION_LIMIT).flatMap((text) => {
    const normalized = normalizeQuestionText(text)
    return normalized ? [{ id: createId(), text: normalized }] : []
  })
}

export function parseFollowUpQuestionsResponse(
  payload: unknown,
): ChatFollowUpQuestion[] {
  if (!isRecord(payload) || !Array.isArray(payload.followUpQuestions)) return []

  const questions: ChatFollowUpQuestion[] = []
  for (const item of payload.followUpQuestions) {
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string' || !item.id.trim()) continue

    const normalized =
      typeof item.text === 'string' ? normalizeQuestionText(item.text) : null
    if (!normalized) continue

    questions.push({ id: item.id.trim(), text: normalized })
    if (questions.length === FOLLOW_UP_QUESTION_LIMIT) break
  }

  return questions
}

function validateFollowUpMessages(
  messages: readonly ChatFollowUpContextMessage[],
): boolean {
  const totalChars = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  )
  const lastMessage = messages[messages.length - 1]

  return (
    messages.length >= 2 &&
    messages.length <= FOLLOW_UP_REQUEST_MAX_MESSAGES &&
    totalChars <= FOLLOW_UP_REQUEST_MAX_TOTAL_CHARS &&
    lastMessage?.role === 'assistant' &&
    lastMessage.content.trim().length > 0
  )
}

export function parseFollowUpRequest(
  body: unknown,
): ChatFollowUpContextMessage[] | string {
  if (!isRecord(body)) {
    return 'Send the conversation to generate follow-up questions.'
  }

  const rawMessages = body.messages
  if (
    !Array.isArray(rawMessages) ||
    rawMessages.length < 2 ||
    rawMessages.length > FOLLOW_UP_REQUEST_MAX_MESSAGES
  ) {
    return 'Follow-up questions need the recent conversation.'
  }

  const messages: ChatFollowUpContextMessage[] = []
  for (const item of rawMessages) {
    if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant')) {
      return 'Follow-up questions need the recent conversation.'
    }
    if (typeof item.content !== 'string') {
      return 'Follow-up questions need the recent conversation.'
    }

    const content = item.content.trim()
    if (!content || content.length > FOLLOW_UP_REQUEST_MAX_MESSAGE_CHARS) {
      return 'Follow-up questions need the recent conversation.'
    }

    messages.push({ content, role: item.role })
  }

  if (!validateFollowUpMessages(messages)) {
    return 'Follow-up questions need the latest assistant response.'
  }

  return messages
}

export function getFollowUpQuestionRequestTargets(
  messages: readonly ChatMessage[],
  requestedMessageIds: ReadonlySet<string>,
): { assistantMessageId: string; messages: ChatFollowUpContextMessage[] }[] {
  const targets: {
    assistantMessageId: string
    messages: ChatFollowUpContextMessage[]
  }[] = []

  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || message.status !== 'complete') return
    if (requestedMessageIds.has(message.id)) return
    if ((message.followUpQuestions?.length ?? 0) > 0) return

    const context = messages
      .slice(0, index + 1)
      .filter((item) => item.content.trim().length > 0)
      .map((item) => ({
        content: item.content.trim(),
        role: item.role,
      }))

    if (!validateFollowUpMessages(context)) return
    targets.push({ assistantMessageId: message.id, messages: context })
  })

  return targets
}

export function truncateFollowUpContext(
  messages: readonly ChatFollowUpContextMessage[],
) {
  const lines = messages.slice(-FOLLOW_UP_CONTEXT_MAX_MESSAGES).map((message) => {
    const label = message.role === 'user' ? 'User' : 'Assistant'
    return `${label}: ${message.content.trim()}`
  })
  const joined = lines.join('\n\n')

  if (joined.length <= FOLLOW_UP_CONTEXT_MAX_CHARS) return joined
  return joined.slice(joined.length - FOLLOW_UP_CONTEXT_MAX_CHARS).trimStart()
}

export function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return undefined

    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}
