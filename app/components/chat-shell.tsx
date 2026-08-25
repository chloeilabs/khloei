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
import {
  clearActiveBackgroundChat,
  readActiveBackgroundChat,
  snapshotBackgroundMessages,
  writeActiveBackgroundChat,
  type ActiveBackgroundChat,
} from '../lib/chat-background'
import { normalizeComputerFrame } from '../lib/chat'
import type {
  ChatActivity,
  ChatMessage as ChatMessageValue,
  ChatStreamEvent,
} from '../lib/chat'
import {
  DEFAULT_CHAT_MODEL_ID,
  type ChatModelId,
} from '../lib/chat-models'
import {
  compactChatHistory,
  type ChatHistoryMessage,
} from '../lib/chat-history'
import { prepareChatRegenerate } from '../lib/chat-regenerate'
import { ChatMessages } from './chat-messages'
import { ChatScrollToBottom } from './chat-scroll-to-bottom'
import { ChatTurnScrollSync } from './chat-turn-scroll-sync'
import { PromptInput, type PromptSubmission } from './prompt-input'

const BACKGROUND_CHECKPOINT_DELAY_MS = 250
const BACKGROUND_RECONNECT_MAX_DELAY_MS = 10_000

type BackgroundConnection =
  | Omit<
      Extract<ActiveBackgroundChat, { backgroundKind: 'openai' }>,
      'messages' | 'version'
    >
  | Omit<
      Extract<ActiveBackgroundChat, { backgroundKind: 'computer' }>,
      'messages' | 'version'
    >

class ChatRequestError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ChatRequestError'
    this.status = status
  }
}

class ChatCancelledError extends Error {
  constructor() {
    super('The response was cancelled.')
    this.name = 'ChatCancelledError'
  }
}

class BackgroundReconnectError extends Error {
  constructor() {
    super('The background response stream needs to reconnect.')
    this.name = 'BackgroundReconnectError'
  }
}

function streamEvent(value: unknown): ChatStreamEvent | null {
  if (!value || typeof value !== 'object' || !('type' in value)) return null
  const event = value as Record<string, unknown>

  if (event.type === 'activity' && event.activity) {
    const activity = event.activity as Record<string, unknown>
    const validKind =
      activity.kind === 'computer' ||
      activity.kind === 'reasoning' ||
      activity.kind === 'web_search'
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
  if (event.type === 'computer-frame' && event.frame) {
    const frame = normalizeComputerFrame(event.frame)
    if (frame) return { frame, type: 'computer-frame' }
  }
  if (
    event.type === 'background' &&
    typeof event.resumeToken === 'string' &&
    Number.isSafeInteger(event.sequenceNumber) &&
    Number(event.sequenceNumber) >= 0
  ) {
    if (
      event.backgroundKind === 'computer' &&
      typeof event.taskId === 'string'
    ) {
      return {
        backgroundKind: 'computer',
        resumeToken: event.resumeToken,
        sequenceNumber: Number(event.sequenceNumber),
        taskId: event.taskId,
        type: 'background',
      }
    }
    if (
      (event.backgroundKind === undefined ||
        event.backgroundKind === 'openai') &&
      typeof event.responseId === 'string'
    ) {
      return {
        backgroundKind: 'openai',
        responseId: event.responseId,
        resumeToken: event.resumeToken,
        sequenceNumber: Number(event.sequenceNumber),
        type: 'background',
      }
    }
  }
  if (
    event.type === 'cursor' &&
    Number.isSafeInteger(event.sequenceNumber) &&
    Number(event.sequenceNumber) >= 0
  ) {
    return {
      sequenceNumber: Number(event.sequenceNumber),
      type: 'cursor',
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
  if (event.type === 'cancelled') return { type: 'cancelled' }
  if (event.type === 'reconnect') return { type: 'reconnect' }
  if (event.type === 'done') return { type: 'done' }
  return null
}

async function responseError(response: Response) {
  let message = 'Khloei could not start that response.'
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') message = body.error
  } catch {
    // The fallback below covers non-JSON server responses.
  }
  return new ChatRequestError(message, response.status)
}

function isRetriableBackgroundError(error: unknown) {
  if (error instanceof BackgroundReconnectError) return true
  if (error instanceof ChatRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return error instanceof TypeError
}

function reconnectDelay(attempt: number) {
  return Math.min(
    500 * 2 ** Math.min(attempt, 5),
    BACKGROUND_RECONNECT_MAX_DELAY_MS,
  )
}

function waitForReconnect(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }

    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delay)
    const abort = () => {
      window.clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
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

const STREAM_RENDER_INTERVAL_MS = 32

export function ChatShell() {
  const [messages, setMessages] = useState<ChatMessageValue[]>([])
  const [modelId, setModelId] = useState<ChatModelId>(DEFAULT_CHAT_MODEL_ID)
  const [streaming, setStreaming] = useState(false)
  const activeBackgroundRef = useRef<BackgroundConnection | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const backgroundCheckpointMessagesRef = useRef<
    ChatMessageValue[] | null
  >(null)
  const backgroundCheckpointTimerRef = useRef<number | null>(null)
  const streamRenderTimerRef = useRef<number | null>(null)
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

  const commitMessages = useCallback(
    (update: (current: ChatMessageValue[]) => ChatMessageValue[]) => {
      if (streamRenderTimerRef.current !== null) {
        window.clearTimeout(streamRenderTimerRef.current)
        streamRenderTimerRef.current = null
      }
      const next = update(messagesRef.current)
      messagesRef.current = next
      setMessages(next)
      return next
    },
    [],
  )

  const commitStreamingMessages = useCallback(
    (update: (current: ChatMessageValue[]) => ChatMessageValue[]) => {
      const next = update(messagesRef.current)
      messagesRef.current = next
      if (streamRenderTimerRef.current === null) {
        streamRenderTimerRef.current = window.setTimeout(() => {
          streamRenderTimerRef.current = null
          setMessages(messagesRef.current)
        }, STREAM_RENDER_INTERVAL_MS)
      }
      return next
    },
    [],
  )

  const selectModel = useCallback((nextModelId: ChatModelId) => {
    setModelId(nextModelId)
  }, [])

  const flushBackgroundCheckpoint = useCallback(() => {
    if (backgroundCheckpointTimerRef.current !== null) {
      window.clearTimeout(backgroundCheckpointTimerRef.current)
      backgroundCheckpointTimerRef.current = null
    }

    const active = activeBackgroundRef.current
    const checkpointMessages = backgroundCheckpointMessagesRef.current
    if (!active || !checkpointMessages) return

    writeActiveBackgroundChat({
      ...active,
      messages: snapshotBackgroundMessages(
        checkpointMessages,
        active.assistantId,
      ),
      version: 2,
    })
  }, [])

  const scheduleBackgroundCheckpoint = useCallback(() => {
    if (backgroundCheckpointTimerRef.current !== null) return
    backgroundCheckpointTimerRef.current = window.setTimeout(
      flushBackgroundCheckpoint,
      BACKGROUND_CHECKPOINT_DELAY_MS,
    )
  }, [flushBackgroundCheckpoint])

  const clearBackgroundState = useCallback(() => {
    if (backgroundCheckpointTimerRef.current !== null) {
      window.clearTimeout(backgroundCheckpointTimerRef.current)
      backgroundCheckpointTimerRef.current = null
    }
    activeBackgroundRef.current = null
    backgroundCheckpointMessagesRef.current = null
    clearActiveBackgroundChat()
  }, [])

  const cancelBackgroundResponse = useCallback(
    (active: BackgroundConnection) => {
      const identity =
        active.backgroundKind === 'computer'
          ? { taskId: active.taskId }
          : { responseId: active.responseId }
      void fetch(
        active.backgroundKind === 'computer'
          ? '/api/chat/computer'
          : '/api/chat/background',
        {
          body: JSON.stringify({
            ...identity,
            resumeToken: active.resumeToken,
            startingAfter: active.sequenceNumber,
          }),
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          method: 'DELETE',
        },
      ).catch(() => {
        // The local response stops immediately even if the cancellation request
        // loses its network connection.
      })
    },
    [],
  )

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(
    () => () => {
      flushBackgroundCheckpoint()
      if (streamRenderTimerRef.current !== null) {
        window.clearTimeout(streamRenderTimerRef.current)
        streamRenderTimerRef.current = null
      }
      const controller = abortRef.current
      abortRef.current = null
      controller?.abort()
      for (const url of messageImageUrlsRef.current) URL.revokeObjectURL(url)
      messageImageUrlsRef.current.clear()
    },
    [flushBackgroundCheckpoint],
  )

  const stopResponse = useCallback(() => {
    const active = activeBackgroundRef.current
    if (active) cancelBackgroundResponse(active)
    clearBackgroundState()
    abortRef.current?.abort()
  }, [cancelBackgroundResponse, clearBackgroundState])

  const startNewChat = useCallback(() => {
    const active = activeBackgroundRef.current
    if (active) cancelBackgroundResponse(active)
    clearBackgroundState()
    const controller = abortRef.current
    abortRef.current = null
    controller?.abort()
    previousResponseIdRef.current = null
    submissionsRef.current.clear()
    for (const url of messageImageUrlsRef.current) URL.revokeObjectURL(url)
    messageImageUrlsRef.current.clear()
    commitMessages(() => [])
    setStreaming(false)
  }, [cancelBackgroundResponse, clearBackgroundState, commitMessages])

  const requestAssistant = useCallback(
    ({
      assistantId,
      background,
      history,
      modelId: requestedModelId,
      previousResponseId,
      submission,
    }: {
      assistantId: string
      background?: ActiveBackgroundChat
      history?: readonly ChatHistoryMessage[]
      modelId?: ChatModelId
      previousResponseId?: string
      submission?: PromptSubmission
    }) => {
      const controller = new AbortController()

      if (background) {
        activeBackgroundRef.current =
          background.backgroundKind === 'computer'
            ? {
                assistantId: background.assistantId,
                backgroundKind: 'computer',
                createdAt: background.createdAt,
                resumeToken: background.resumeToken,
                sequenceNumber: background.sequenceNumber,
                taskId: background.taskId,
              }
            : {
                assistantId: background.assistantId,
                backgroundKind: 'openai',
                createdAt: background.createdAt,
                responseId: background.responseId,
                resumeToken: background.resumeToken,
                sequenceNumber: background.sequenceNumber,
              }
        backgroundCheckpointMessagesRef.current = messagesRef.current
      }

      abortRef.current = controller
      setStreaming(true)

      void (async () => {
        let reconnectAttempt = 0
        try {
          while (!controller.signal.aborted) {
            let completed = false
            let response: Response
            try {
              const active = activeBackgroundRef.current
              if (active?.assistantId === assistantId) {
                const identity =
                  active.backgroundKind === 'computer'
                    ? { taskId: active.taskId }
                    : { responseId: active.responseId }
                response = await fetch(
                  active.backgroundKind === 'computer'
                    ? '/api/chat/computer'
                    : '/api/chat/background',
                  {
                    body: JSON.stringify({
                      ...identity,
                      resumeToken: active.resumeToken,
                      startingAfter: active.sequenceNumber,
                    }),
                    headers: { 'Content-Type': 'application/json' },
                    method: 'POST',
                    signal: controller.signal,
                  },
                )
              } else {
                if (!submission) {
                  throw new Error('The background response could not be restored.')
                }
                const formData = new FormData()
                formData.append('message', submission.text)
                if (requestedModelId) {
                  formData.append('model', requestedModelId)
                }
                if (history?.length) {
                  formData.append('history', JSON.stringify(history))
                }
                if (previousResponseId) {
                  formData.append('previousResponseId', previousResponseId)
                }
                for (const attachment of submission.attachments) {
                  formData.append(
                    'attachments',
                    attachment.file,
                    attachment.file.name,
                  )
                }
                response = await fetch('/api/chat', {
                  body: formData,
                  method: 'POST',
                  signal: controller.signal,
                })
              }

              if (!response.ok) throw await responseError(response)
              if (!response.body) throw new BackgroundReconnectError()

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
                  commitMessages((current) =>
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
                } else if (event.type === 'computer-frame') {
                  commitMessages((current) =>
                    current.map((message) =>
                      message.id === assistantId
                        ? { ...message, computerFrame: event.frame }
                        : message,
                    ),
                  )
                } else if (event.type === 'background') {
                  const active: BackgroundConnection =
                    event.backgroundKind === 'computer'
                      ? {
                          assistantId,
                          backgroundKind: 'computer',
                          createdAt: Date.now(),
                          resumeToken: event.resumeToken,
                          sequenceNumber: event.sequenceNumber,
                          taskId: event.taskId,
                        }
                      : {
                          assistantId,
                          backgroundKind: 'openai',
                          createdAt: Date.now(),
                          responseId: event.responseId,
                          resumeToken: event.resumeToken,
                          sequenceNumber: event.sequenceNumber,
                        }
                  activeBackgroundRef.current = active
                  backgroundCheckpointMessagesRef.current = messagesRef.current
                  flushBackgroundCheckpoint()
                } else if (event.type === 'cursor') {
                  const active = activeBackgroundRef.current
                  if (
                    active?.assistantId === assistantId &&
                    event.sequenceNumber >= active.sequenceNumber
                  ) {
                    activeBackgroundRef.current = {
                      ...active,
                      sequenceNumber: event.sequenceNumber,
                    }
                    backgroundCheckpointMessagesRef.current = messagesRef.current
                    scheduleBackgroundCheckpoint()
                  }
                } else if (event.type === 'text-delta') {
                  commitStreamingMessages((current) =>
                    current.map((message) =>
                      message.id === assistantId
                        ? { ...message, content: message.content + event.delta }
                        : message,
                    ),
                  )
                } else if (event.type === 'message') {
                  previousResponseIdRef.current = event.responseId
                  commitMessages((current) =>
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
                } else if (event.type === 'cancelled') {
                  throw new ChatCancelledError()
                } else if (event.type === 'reconnect') {
                  throw new BackgroundReconnectError()
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

              if (!completed) throw new BackgroundReconnectError()
            } catch (error) {
              if (controller.signal.aborted) throw error

              const active = activeBackgroundRef.current
              if (
                active?.assistantId !== assistantId ||
                !isRetriableBackgroundError(error)
              ) {
                throw error
              }

              flushBackgroundCheckpoint()
              const checkpoint = backgroundCheckpointMessagesRef.current
              if (checkpoint) commitMessages(() => checkpoint)
              await waitForReconnect(
                reconnectDelay(reconnectAttempt),
                controller.signal,
              )
              reconnectAttempt += 1
              continue
            }

            if (completed) {
              clearBackgroundState()
              commitMessages((current) =>
                current.map((message) =>
                  message.id === assistantId
                    ? { ...message, status: 'complete' }
                    : message,
                ),
              )
              return
            }
          }
        } catch (error) {
          if (abortRef.current !== controller) return
          clearBackgroundState()
          if (controller.signal.aborted) {
            commitMessages((current) =>
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
            if (error instanceof ChatCancelledError) {
              commitMessages((current) =>
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
              commitMessages((current) =>
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
          }
        } finally {
          if (abortRef.current === controller) {
            abortRef.current = null
            setStreaming(false)
          }
        }
      })()
    },
    [
      clearBackgroundState,
      commitMessages,
      commitStreamingMessages,
      flushBackgroundCheckpoint,
      scheduleBackgroundCheckpoint,
    ],
  )

  useEffect(() => {
    if (abortRef.current) return
    const background = readActiveBackgroundChat()
    if (!background) return

    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || abortRef.current) return
      const restoredMessages = background.messages.map((message) =>
        message.id === background.assistantId
          ? { ...message, status: 'streaming' as const }
          : message,
      )
      commitMessages(() => restoredMessages)

      const previousAssistant = [...restoredMessages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' &&
            message.id !== background.assistantId &&
            message.responseId,
        )
      previousResponseIdRef.current = previousAssistant?.responseId ?? null
      requestAssistant({ assistantId: background.assistantId, background })
    })

    return () => {
      cancelled = true
    }
  }, [commitMessages, requestAssistant])

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
      const history = compactChatHistory(
        messagesRef.current.map((item) => ({
          content: item.content,
          role: item.role,
        })),
      )

      submissionsRef.current.set(userId, normalizedSubmission)
      commitMessages((current) => [
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
        history,
        modelId,
        previousResponseId,
        submission: normalizedSubmission,
      })
    },
    [commitMessages, modelId, requestAssistant],
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
      const history = compactChatHistory(
        prepared.nextMessages.slice(0, -1).map((item) => ({
          content: item.content,
          role: item.role,
        })),
      )
      commitMessages(() => [
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
        history,
        modelId,
        previousResponseId: prepared.previousResponseId,
        submission,
      })
    },
    [commitMessages, modelId, requestAssistant],
  )

  const submitFollowUp = useCallback(
    (question: string) => {
      submit({ attachments: [], text: question })
    },
    [submit],
  )

  useChatFollowUpQuestions({ messages, modelId, setMessages, streaming })

  const promptInput = (
    <PromptInput
      docked={hasMessages}
      modelId={modelId}
      onNewChat={startNewChat}
      onModelChange={selectModel}
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
