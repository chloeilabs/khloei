'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { StickToBottom } from 'use-stick-to-bottom'

import { useChatFollowUpQuestions } from '../hooks/use-chat-follow-up-questions'
import { useChatThreadScroll } from '../hooks/use-chat-thread-scroll'
import {
  failActiveChatActivities,
  upsertChatActivity,
} from '../lib/chat-activities'
import type {
  ChatActivity,
  ChatMessage as ChatMessageValue,
  ChatStreamEvent,
} from '../lib/chat'
import { prepareChatRegenerate } from '../lib/chat-regenerate'
import { ChatMessages } from './chat-messages'
import { ChatScrollToBottom } from './chat-scroll-to-bottom'
import { ChatTurnScrollSync } from './chat-turn-scroll-sync'
import { PromptInput, type PromptSubmission } from './prompt-input'

function streamEvent(value: unknown): ChatStreamEvent | null {
  if (!value || typeof value !== 'object' || !('type' in value)) return null
  const event = value as Record<string, unknown>

  if (event.type === 'activity' && event.activity) {
    const activity = event.activity as Record<string, unknown>
    const validKind =
      activity.kind === 'reasoning' || activity.kind === 'web_search'
    const validStatus =
      activity.status === 'in_progress' ||
      activity.status === 'searching' ||
      activity.status === 'completed' ||
      activity.status === 'failed'
    if (typeof activity.id === 'string' && validKind && validStatus) {
      return {
        activity: event.activity as ChatActivity,
        type: 'activity',
      }
    }
  }
  if (event.type === 'text-delta' && typeof event.delta === 'string') {
    return { delta: event.delta, type: 'text-delta' }
  }
  if (
    event.type === 'message' &&
    typeof event.content === 'string' &&
    typeof event.responseId === 'string' &&
    Array.isArray(event.sources)
  ) {
    return event as ChatStreamEvent
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    return { message: event.message, type: 'error' }
  }
  if (event.type === 'done') return { type: 'done' }
  return null
}

async function responseError(response: Response) {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') return body.error
  } catch {
    // The fallback below covers non-JSON server responses.
  }
  return 'Khloei could not start that response.'
}

function normalizePrompt(value: string) {
  return value.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
}

function imageUrlsInMessages(messages: readonly ChatMessageValue[]) {
  return messages.flatMap((message) =>
    (message.attachments ?? []).flatMap((attachment) =>
      attachment.kind === 'image' && attachment.url ? [attachment.url] : [],
    ),
  )
}

export function ChatShell() {
  const [messages, setMessages] = useState<ChatMessageValue[]>([])
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const messageImageUrlsRef = useRef(new Set<string>())
  const messagesRef = useRef<ChatMessageValue[]>([])
  const previousResponseIdRef = useRef<string | null>(null)
  const promptInputRef = useRef<HTMLDivElement>(null)
  const submissionsRef = useRef(new Map<string, PromptSubmission>())
  const hasMessages = messages.length > 0
  const latestMessageId = messages.at(-1)?.id
  const targetThreadScrollTop = useChatThreadScroll(
    streaming,
    hasMessages,
    promptInputRef,
  )

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(
    () => () => {
      abortRef.current?.abort()
      for (const url of messageImageUrlsRef.current) URL.revokeObjectURL(url)
      messageImageUrlsRef.current.clear()
    },
    [],
  )

  const stopResponse = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const startNewChat = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    previousResponseIdRef.current = null
    submissionsRef.current.clear()
    for (const url of messageImageUrlsRef.current) URL.revokeObjectURL(url)
    messageImageUrlsRef.current.clear()
    setMessages([])
    setStreaming(false)
  }, [])

  const requestAssistant = useCallback(
    ({
      assistantId,
      previousResponseId,
      submission,
    }: {
      assistantId: string
      previousResponseId?: string
      submission: PromptSubmission
    }) => {
      const controller = new AbortController()

      abortRef.current = controller
      setStreaming(true)

      void (async () => {
        let completed = false
        try {
          const formData = new FormData()
          formData.append('message', submission.text)
          if (previousResponseId) {
            formData.append('previousResponseId', previousResponseId)
          }
          for (const attachment of submission.attachments) {
            formData.append('attachments', attachment.file, attachment.file.name)
          }

          const response = await fetch('/api/chat', {
            body: formData,
            method: 'POST',
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(await responseError(response))
          if (!response.body) {
            throw new Error('The response stream was unavailable.')
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          const applyLine = (line: string) => {
            if (abortRef.current !== controller || !line.trim()) return
            let parsed: unknown
            try {
              parsed = JSON.parse(line)
            } catch {
              return
            }
            const event = streamEvent(parsed)
            if (!event) return

            if (event.type === 'activity') {
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId
                    ? {
                        ...message,
                        activities: upsertChatActivity(
                          message.activities,
                          event.activity,
                        ),
                      }
                    : message,
                ),
              )
            } else if (event.type === 'text-delta') {
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId
                    ? { ...message, content: message.content + event.delta }
                    : message,
                ),
              )
            } else if (event.type === 'message') {
              previousResponseIdRef.current = event.responseId
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantId
                    ? {
                        ...message,
                        content: event.content || message.content,
                        responseId: event.responseId,
                        sources: event.sources,
                      }
                    : message,
                ),
              )
            } else if (event.type === 'error') {
              throw new Error(event.message)
            } else if (event.type === 'done') {
              completed = true
            }
          }

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) applyLine(line)
          }
          buffer += decoder.decode()
          if (buffer) applyLine(buffer)

          if (!completed) {
            throw new Error('The response stream ended unexpectedly.')
          }
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, status: 'complete' }
                : message,
            ),
          )
        } catch (error) {
          if (controller.signal.aborted) {
            setMessages((current) =>
              current.flatMap((message) => {
                if (message.id !== assistantId) return [message]
                return message.content || message.activities?.length
                  ? [
                      {
                        ...message,
                        activities: failActiveChatActivities(
                          message.activities,
                        ),
                        status: 'stopped' as const,
                      },
                    ]
                  : []
              }),
            )
          } else {
            const messageText =
              error instanceof Error
                ? error.message
                : 'Khloei could not complete that response.'
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      activities: failActiveChatActivities(
                        message.activities,
                      ),
                      content: message.content
                        ? `${message.content}\n\n> ${messageText}`
                        : messageText,
                      status: 'error',
                    }
                  : message,
              ),
            )
          }
        } finally {
          if (abortRef.current === controller) {
            abortRef.current = null
            setStreaming(false)
          }
        }
      })()
    },
    [],
  )

  const submit = useCallback(
    (submission: PromptSubmission) => {
      if (abortRef.current) return

      const prompt = normalizePrompt(submission.text)
      if (!prompt && submission.attachments.length === 0) return

      const normalizedSubmission: PromptSubmission = {
        attachments: [...submission.attachments],
        text: prompt,
      }
      const attachments = normalizedSubmission.attachments.map((attachment) => {
        const url =
          attachment.kind === 'image'
            ? URL.createObjectURL(attachment.file)
            : undefined
        if (url) messageImageUrlsRef.current.add(url)

        return {
          kind: attachment.kind,
          name: attachment.file.name,
          ...(url ? { url } : {}),
        }
      })
      const userId = crypto.randomUUID()
      const assistantId = crypto.randomUUID()
      const previousResponseId = previousResponseIdRef.current ?? undefined

      submissionsRef.current.set(userId, normalizedSubmission)
      setMessages((current) => [
        ...current,
        {
          attachments: attachments.length ? attachments : undefined,
          content: prompt,
          id: userId,
          role: 'user',
          status: 'complete',
        },
        {
          content: '',
          id: assistantId,
          role: 'assistant',
          status: 'streaming',
        },
      ])
      requestAssistant({
        assistantId,
        previousResponseId,
        submission: normalizedSubmission,
      })
    },
    [requestAssistant],
  )

  const regenerateAssistant = useCallback(
    (assistantMessageId: string) => {
      if (abortRef.current) return

      const current = messagesRef.current
      const assistantIndex = current.findIndex(
        (message) =>
          message.id === assistantMessageId && message.role === 'assistant',
      )
      if (assistantIndex === -1) return

      const userMessage = [...current.slice(0, assistantIndex)]
        .reverse()
        .find((message) => message.role === 'user')
      if (!userMessage) return

      const prepared = prepareChatRegenerate(current, userMessage.id)
      if (!prepared) return

      const submission = submissionsRef.current.get(userMessage.id) ?? {
        attachments: [],
        text: userMessage.content,
      }
      const assistantId = crypto.randomUUID()
      const retainedUserIds = new Set(
        prepared.nextMessages
          .filter((message) => message.role === 'user')
          .map((message) => message.id),
      )

      for (const userId of submissionsRef.current.keys()) {
        if (!retainedUserIds.has(userId)) submissionsRef.current.delete(userId)
      }

      const retainedImageUrls = new Set(
        imageUrlsInMessages(prepared.nextMessages),
      )
      for (const url of messageImageUrlsRef.current) {
        if (retainedImageUrls.has(url)) continue
        URL.revokeObjectURL(url)
        messageImageUrlsRef.current.delete(url)
      }

      previousResponseIdRef.current = prepared.previousResponseId ?? null
      setMessages([
        ...prepared.nextMessages,
        {
          content: '',
          id: assistantId,
          role: 'assistant',
          status: 'streaming',
        },
      ])
      requestAssistant({
        assistantId,
        previousResponseId: prepared.previousResponseId,
        submission,
      })
    },
    [requestAssistant],
  )

  const submitFollowUp = useCallback(
    (question: string) => {
      submit({ attachments: [], text: question })
    },
    [submit],
  )

  useChatFollowUpQuestions({ messages, setMessages, streaming })

  const promptInput = (
    <PromptInput
      docked={hasMessages}
      onNewChat={startNewChat}
      onStop={stopResponse}
      onSubmit={submit}
      shellRef={promptInputRef}
      showNewChat={hasMessages}
      submitting={streaming}
    />
  )

  return (
    <div className="khloei-chat" data-has-messages={hasMessages || undefined}>
      {hasMessages ? (
        <StickToBottom
          className="chat-thread-scroller"
          initial="instant"
          resize="instant"
          targetScrollTop={targetThreadScrollTop}
        >
          <StickToBottom.Content
            className="chat-thread-content"
            scrollClassName="chat-thread-scroll"
          >
            <section
              aria-label="Conversation"
              aria-live="polite"
              className="chat-messages"
            >
              <div className="chat-thread-inner">
                <ChatMessages
                  messages={messages}
                  onFollowUpQuestionClick={
                    streaming ? undefined : submitFollowUp
                  }
                  onRegenerate={
                    streaming ? undefined : regenerateAssistant
                  }
                />
              </div>
            </section>
            {promptInput}
          </StickToBottom.Content>
          {latestMessageId ? (
            <ChatTurnScrollSync key={latestMessageId} />
          ) : null}
          <ChatScrollToBottom />
        </StickToBottom>
      ) : (
        promptInput
      )}
    </div>
  )
}
