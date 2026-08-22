'use client'

import { memo, useMemo } from 'react'

import type { ChatMessage as ChatMessageValue } from '../lib/chat'
import { groupChatTurns } from '../lib/chat-thread-anchor'
import { ChatMessage } from './chat-message'

type ChatMessagesProps = {
  messages: ChatMessageValue[]
  onFollowUpQuestionClick?: (question: string) => void
  onRegenerate?: (assistantMessageId: string) => void
}

export const ChatMessages = memo(function ChatMessages({
  messages,
  onFollowUpQuestionClick,
  onRegenerate,
}: ChatMessagesProps) {
  const turns = useMemo(() => groupChatTurns(messages), [messages])

  return (
    <div className="chat-message-list">
      {turns.map((turn, turnIndex) => {
        const isLastTurn = turnIndex === turns.length - 1
        const firstMessage = turn[0]
        const userMessage = firstMessage?.role === 'user' ? firstMessage : null
        const userMessageId = userMessage?.id ?? ''

        return (
          <div
            className="chat-message-turn"
            data-last-turn={isLastTurn || undefined}
            data-message-group="turn"
            data-user-message-id={userMessageId || undefined}
            key={userMessageId || firstMessage?.id || String(turnIndex)}
          >
            {turn.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                onFollowUpQuestionClick={onFollowUpQuestionClick}
                onRegenerate={onRegenerate}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
})
