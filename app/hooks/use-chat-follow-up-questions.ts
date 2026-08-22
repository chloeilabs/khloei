'use client'

import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react'

import type { ChatFollowUpQuestion, ChatMessage } from '../lib/chat'
import {
  getFollowUpQuestionRequestTargets,
  parseFollowUpQuestionsResponse,
} from '../lib/chat-follow-ups'

export function useChatFollowUpQuestions({
  messages,
  setMessages,
  streaming,
}: {
  messages: ChatMessage[]
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  streaming: boolean
}) {
  const messagesRef = useRef(messages)
  const requestedIdsRef = useRef(new Set<string>())
  const controllersRef = useRef(new Map<string, AbortController>())

  useInsertionEffect(() => {
    messagesRef.current = messages
  })

  useEffect(
    () => () => {
      for (const controller of controllersRef.current.values()) {
        controller.abort()
      }
      controllersRef.current.clear()
    },
    [],
  )

  const requestFollowUpQuestions = useCallback(
    (assistantMessageId: string) => {
      if (requestedIdsRef.current.has(assistantMessageId)) return
      requestedIdsRef.current.add(assistantMessageId)

      const sourceIndex = messagesRef.current.findIndex(
        (message) =>
          message.id === assistantMessageId && message.role === 'assistant',
      )
      if (sourceIndex === -1) {
        requestedIdsRef.current.delete(assistantMessageId)
        return
      }

      const context = messagesRef.current
        .slice(0, sourceIndex + 1)
        .filter((message) => message.content.trim().length > 0)
        .map((message) => ({
          content: message.content.trim(),
          role: message.role,
        }))
      const controller = new AbortController()
      controllersRef.current.set(assistantMessageId, controller)

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId &&
          (message.followUpQuestions?.length ?? 0) === 0
            ? { ...message, followUpQuestionsPending: true }
            : message,
        ),
      )

      void (async () => {
        let followUpQuestions: ChatFollowUpQuestion[] = []
        try {
          const response = await fetch('/api/chat/follow-ups', {
            body: JSON.stringify({ messages: context }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
            signal: controller.signal,
          })

          if (response.ok) {
            followUpQuestions = parseFollowUpQuestionsResponse(
              await response.json(),
            )
          }
        } catch {
          // Follow-up suggestions are optional and should not disrupt the chat.
        } finally {
          controllersRef.current.delete(assistantMessageId)
        }

        if (controller.signal.aborted) return
        if (
          !messagesRef.current.some(
            (message) => message.id === assistantMessageId,
          )
        ) {
          return
        }

        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  followUpQuestions:
                    followUpQuestions.length > 0
                      ? followUpQuestions
                      : undefined,
                  followUpQuestionsPending: false,
                }
              : message,
          ),
        )
      })()
    },
    [setMessages],
  )

  useEffect(() => {
    const messageIds = new Set(messages.map((message) => message.id))

    for (const messageId of requestedIdsRef.current) {
      if (messageIds.has(messageId)) continue
      requestedIdsRef.current.delete(messageId)
      controllersRef.current.get(messageId)?.abort()
      controllersRef.current.delete(messageId)
    }

    if (messages.length === 0) requestedIdsRef.current.clear()
    if (streaming) return

    const targets = getFollowUpQuestionRequestTargets(
      messages,
      requestedIdsRef.current,
    )
    for (const target of targets) {
      requestFollowUpQuestions(target.assistantMessageId)
    }
  }, [messages, requestFollowUpQuestions, streaming])
}
