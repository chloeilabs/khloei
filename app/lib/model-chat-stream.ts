import 'server-only'

import type {
  Response as OpenAIResponse,
  ResponseOutputText,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'

import { applyUrlCitations, type UrlCitation } from './citations'
import type {
  ChatActivity,
  ChatActivityStatus,
  ChatSource,
  ChatStreamEvent,
  ChatWebSearchAction,
} from './chat'

type OpenAIUrlCitation = Extract<
  ResponseOutputText['annotations'][number],
  { type: 'url_citation' }
>

export type ReasoningParts = Map<string, Map<number, string>>

type OpenAIChatStreamOptions = {
  errorDetails?: (error: unknown) => { message: string; status: number }
  headers?: HeadersInit
  resumable?: boolean
  seedResponse?: OpenAIResponse
  signal: AbortSignal
  stream: AsyncIterable<ResponseStreamEvent>
}

export const STREAM_HEADERS = {
  'Cache-Control': 'no-cache, no-store, no-transform',
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function activityStatus(
  value: unknown,
  fallback: ChatActivityStatus,
): ChatActivityStatus {
  if (
    value === 'in_progress' ||
    value === 'searching' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value
  }
  return value === 'incomplete' ? 'completed' : fallback
}

function webSearchAction(value: unknown): ChatWebSearchAction | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined

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

function reasoningSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const parts = value
    .filter(isRecord)
    .map((part) => (typeof part.text === 'string' ? part.text.trim() : ''))
    .filter(Boolean)
  return parts.length ? parts.join('\n\n') : undefined
}

function outputItemActivity(
  value: unknown,
  phase: 'added' | 'done',
): ChatActivity | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || typeof value.type !== 'string') {
    return undefined
  }

  const fallback = phase === 'added' ? 'in_progress' : 'completed'
  if (value.type === 'reasoning') {
    const summary =
      reasoningSummary(value.summary) ?? reasoningSummary(value.content)
    return {
      id: value.id,
      kind: 'reasoning',
      status: activityStatus(value.status, fallback),
      ...(summary ? { summary } : {}),
    }
  }
  if (
    value.type === 'web_search_call' ||
    value.type === 'openrouter:web_search'
  ) {
    const action = webSearchAction(value.action)
    return {
      id: value.id,
      kind: 'web_search',
      status: activityStatus(value.status, fallback),
      ...(action ? { action } : {}),
    }
  }
  return undefined
}

function lifecycleActivity(value: unknown): ChatActivity | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.item_id !== 'string' || typeof value.type !== 'string') {
    return undefined
  }

  switch (value.type) {
    case 'response.web_search_call.in_progress':
      return {
        id: value.item_id,
        kind: 'web_search',
        status: 'in_progress',
      }
    case 'response.web_search_call.searching':
      return {
        id: value.item_id,
        kind: 'web_search',
        status: 'searching',
      }
    case 'response.web_search_call.completed':
      return {
        id: value.item_id,
        kind: 'web_search',
        status: 'completed',
      }
    default:
      return undefined
  }
}

export function seedReasoningParts(response?: OpenAIResponse): ReasoningParts {
  const seeded: ReasoningParts = new Map()
  if (!response) return seeded

  for (const item of response.output) {
    if (item.type !== 'reasoning' || !Array.isArray(item.summary)) continue
    const parts = new Map<number, string>()
    item.summary.forEach((part, index) => {
      if (typeof part.text === 'string') parts.set(index, part.text)
    })
    if (parts.size > 0) seeded.set(item.id, parts)
  }
  return seeded
}

export function streamActivity(
  value: unknown,
  reasoningParts: ReasoningParts,
): ChatActivity | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined

  if (
    value.type === 'response.output_item.added' ||
    value.type === 'response.output_item.done'
  ) {
    return outputItemActivity(
      value.item,
      value.type === 'response.output_item.added' ? 'added' : 'done',
    )
  }

  if (
    value.type === 'response.reasoning_summary_text.delta' ||
    value.type === 'response.reasoning_summary_text.done' ||
    value.type === 'response.reasoning_text.delta' ||
    value.type === 'response.reasoning_text.done'
  ) {
    if (typeof value.item_id !== 'string') return undefined
    const summaryIndex =
      typeof value.summary_index === 'number' ? value.summary_index : 0
    const itemParts = new Map(reasoningParts.get(value.item_id) ?? [])
    const previous = itemParts.get(summaryIndex) ?? ''
    const text =
      typeof value.text === 'string'
        ? value.text
        : typeof value.delta === 'string'
          ? previous + value.delta
          : previous
    itemParts.set(summaryIndex, text)
    reasoningParts.set(value.item_id, itemParts)
    const summary = [...itemParts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, part]) => part.trim())
      .filter(Boolean)
      .join('\n\n')

    return {
      id: value.item_id,
      kind: 'reasoning',
      status: 'in_progress',
      ...(summary ? { summary } : {}),
    }
  }

  return lifecycleActivity(value)
}

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function collectCitations(
  text: string,
  citations: OpenAIUrlCitation[],
  sources: ChatSource[],
  sourceUrls: Set<string>,
) {
  const normalized: UrlCitation[] = []

  for (const citation of citations) {
    const url = safeHttpUrl(citation.url)
    if (!url) continue

    const anchored =
      citation.start_index >= 0 &&
      citation.end_index > citation.start_index &&
      citation.end_index <= text.length
    if (anchored) {
      normalized.push({
        endIndex: citation.end_index,
        startIndex: citation.start_index,
        title: citation.title,
        url,
      })
    }

    if (sourceUrls.has(url)) continue
    sourceUrls.add(url)
    sources.push({ title: citation.title || new URL(url).hostname, url })
  }

  return applyUrlCitations(text, normalized)
}

function finalizeResponse(response: OpenAIResponse) {
  const sources: ChatSource[] = []
  const sourceUrls = new Set<string>()
  const parts: string[] = []

  for (const item of response.output) {
    if (item.type !== 'message') continue

    for (const content of item.content) {
      if (content.type === 'output_text') {
        const citations = content.annotations.filter(
          (annotation): annotation is OpenAIUrlCitation =>
            annotation.type === 'url_citation',
        )
        parts.push(
          collectCitations(content.text, citations, sources, sourceUrls),
        )
      } else if (content.type === 'refusal') {
        parts.push(content.refusal)
      }
    }
  }

  return { content: parts.join('\n\n').trim(), sources }
}

function incompleteResponseMessage(response: OpenAIResponse) {
  const reason = response.incomplete_details?.reason

  if (reason === 'max_output_tokens') {
    return 'The response stopped because it reached `max_output_tokens`—the combined reasoning and answer token limit. Any partial answer appears above. Try regenerating it or narrowing the request.'
  }
  if (reason === 'content_filter') {
    return 'The response stopped because the API returned `content_filter`.'
  }
  return 'The response stopped with an incomplete status before it could finish.'
}

export function modelAPIErrorDetails(
  error: unknown,
  provider: 'OpenAI' | 'OpenRouter',
) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status)
      : 500

  if (code === 'billing_not_active') {
    return {
      message: `${provider} billing is not active for this API key.`,
      status: 402,
    }
  }

  if (status === 401 || status === 403) {
    return {
      message: `The ${provider} API key is invalid or does not have access to this model.`,
      status,
    }
  }
  if (status === 402 && provider === 'OpenRouter') {
    return {
      message: 'The OpenRouter account does not have enough credits for this request.',
      status,
    }
  }
  if (status === 404) {
    return {
      message:
        provider === 'OpenRouter'
          ? 'The requested OpenRouter model is not available.'
          : 'This background response is no longer available.',
      status,
    }
  }
  if (status === 429) {
    return {
      message: `${provider} is rate-limiting this project. Please try again shortly.`,
      status,
    }
  }
  if (status === 400) {
    return {
      message: `${provider} could not process this message or attachment.`,
      status,
    }
  }
  if (status >= 500 && status < 600) {
    return {
      message: `${provider} is temporarily unavailable. Please try again.`,
      status: 502,
    }
  }
  return { message: 'Khloei could not complete that response.', status: 500 }
}

export function openRouterErrorDetails(error: unknown) {
  return modelAPIErrorDetails(error, 'OpenRouter')
}

function completedActivities(response: OpenAIResponse): ChatStreamEvent[] {
  return response.output.flatMap((item) => {
    const activity = outputItemActivity(item, 'done')
    return activity ? [{ activity, type: 'activity' as const }] : []
  })
}

export function terminalChatEvents(response: OpenAIResponse): ChatStreamEvent[] {
  if (response.status === 'cancelled') return [{ type: 'cancelled' }]
  if (response.status === 'failed') {
    return [
      {
        message: response.error?.message || 'The background response failed.',
        type: 'error',
      },
    ]
  }
  if (response.status !== 'completed' && response.status !== 'incomplete') {
    return [{ type: 'reconnect' }]
  }

  const final = finalizeResponse(response)
  const events: ChatStreamEvent[] = [
    ...completedActivities(response),
    {
      content: final.content,
      responseId: response.id,
      sources: final.sources,
      type: 'message',
    },
  ]

  if (response.status === 'completed') {
    events.push({ type: 'done' })
  } else {
    events.push({ message: incompleteResponseMessage(response), type: 'error' })
  }
  return events
}

function sequenceNumber(event: ResponseStreamEvent) {
  return typeof event.sequence_number === 'number'
    ? event.sequence_number
    : undefined
}

function terminalStreamEvents(event: ResponseStreamEvent) {
  if (
    event.type === 'response.completed' ||
    event.type === 'response.incomplete' ||
    event.type === 'response.failed'
  ) {
    return terminalChatEvents(event.response)
  }
  if (event.type === 'error') {
    return [{ message: event.message, type: 'error' as const }]
  }
  return null
}

export function createTerminalChatResponse(response: OpenAIResponse) {
  const body = `${terminalChatEvents(response)
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`
  return new Response(body, { headers: STREAM_HEADERS })
}

export function createModelChatStreamResponse({
  errorDetails = openRouterErrorDetails,
  headers,
  resumable = false,
  seedResponse,
  signal,
  stream,
}: OpenAIChatStreamOptions) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const reasoningParts = seedReasoningParts(seedResponse)
      const send = (event: ChatStreamEvent) => {
        if (closed || signal.aborted) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          closed = true
        }
      }
      const close = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // The browser may have already cancelled its side of the stream.
        }
      }

      try {
        for await (const event of stream) {
          const terminal = terminalStreamEvents(event)
          if (terminal) {
            const cursor = sequenceNumber(event)
            for (const chatEvent of terminal.slice(0, -1)) send(chatEvent)
            if (cursor !== undefined) {
              send({ sequenceNumber: cursor, type: 'cursor' })
            }
            send(terminal.at(-1)!)
            close()
            return
          }

          const activity = streamActivity(event, reasoningParts)
          if (activity) send({ activity, type: 'activity' })

          if (event.type === 'response.output_text.delta') {
            send({ delta: event.delta, type: 'text-delta' })
          } else if (event.type === 'response.refusal.delta') {
            send({ delta: event.delta, type: 'text-delta' })
          }

          const cursor = sequenceNumber(event)
          if (resumable && cursor !== undefined) {
            send({ sequenceNumber: cursor, type: 'cursor' })
          }
        }

        send(
          resumable
            ? { type: 'reconnect' }
            : {
                message: 'The response stream ended unexpectedly.',
                type: 'error',
              },
        )
        close()
      } catch (error) {
        if (!signal.aborted) {
          send(
            resumable
              ? { type: 'reconnect' }
              : { message: errorDetails(error).message, type: 'error' },
          )
        }
        close()
      }
    },
  })

  return new Response(body, {
    headers: { ...STREAM_HEADERS, ...headers },
  })
}
