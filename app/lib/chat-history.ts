export type ChatHistoryMessage = {
  content: string
  role: 'assistant' | 'user'
}

const MAX_HISTORY_MESSAGES = 20
const MAX_HISTORY_MESSAGE_CHARS = 10_000
const MAX_HISTORY_TOTAL_CHARS = 40_000
const OMISSION_MARKER = '\n\n[…content omitted…]\n\n'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function compactContent(value: string) {
  const content = value.trim()
  if (content.length <= MAX_HISTORY_MESSAGE_CHARS) return content

  const available = MAX_HISTORY_MESSAGE_CHARS - OMISSION_MARKER.length
  const head = Math.floor(available / 2)
  return [
    content.slice(0, head).trimEnd(),
    OMISSION_MARKER,
    content.slice(-(available - head)).trimStart(),
  ].join('')
}

export function compactChatHistory(
  messages: readonly ChatHistoryMessage[],
): ChatHistoryMessage[] {
  const bounded = messages
    .filter((message) => message.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({
      content: compactContent(message.content),
      role: message.role,
    }))
  const result: ChatHistoryMessage[] = []
  let total = 0

  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const message = bounded[index]
    if (!message) continue
    if (total + message.content.length > MAX_HISTORY_TOTAL_CHARS) break
    result.push(message)
    total += message.content.length
  }

  return result.reverse()
}

export function parseChatHistory(
  value: FormDataEntryValue | null,
): ChatHistoryMessage[] | string {
  if (value === null) return []
  if (typeof value !== 'string') return 'Chat history must be JSON.'

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return 'Chat history must be valid JSON.'
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_HISTORY_MESSAGES) {
    return 'Chat history contains too many messages.'
  }

  const messages: ChatHistoryMessage[] = []
  let total = 0
  for (const item of parsed) {
    if (
      !isRecord(item) ||
      (item.role !== 'user' && item.role !== 'assistant') ||
      typeof item.content !== 'string'
    ) {
      return 'Chat history contains an invalid message.'
    }
    const content = item.content.trim()
    if (!content || content.length > MAX_HISTORY_MESSAGE_CHARS) {
      return 'Chat history contains an invalid message.'
    }
    total += content.length
    if (total > MAX_HISTORY_TOTAL_CHARS) {
      return 'Chat history is too large.'
    }
    messages.push({ content, role: item.role })
  }
  return messages
}
