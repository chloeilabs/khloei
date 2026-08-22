export type ChatRegenerateMessage = {
  id: string
  responseId?: string
  role: 'assistant' | 'user'
}

export function prepareChatRegenerate<T extends ChatRegenerateMessage>(
  messages: readonly T[],
  userMessageId: string,
): {
  nextMessages: T[]
  previousResponseId?: string
  userMessage: T
} | null {
  const userIndex = messages.findIndex(
    (message) => message.id === userMessageId && message.role === 'user',
  )
  if (userIndex === -1) return null

  const userMessage = messages[userIndex]
  if (!userMessage) return null

  const nextMessages = messages.slice(0, userIndex + 1)
  const previousAssistant = [...messages.slice(0, userIndex)]
    .reverse()
    .find((message) => message.role === 'assistant' && message.responseId)

  return {
    nextMessages,
    ...(previousAssistant?.responseId
      ? { previousResponseId: previousAssistant.responseId }
      : {}),
    userMessage,
  }
}
