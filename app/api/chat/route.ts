import OpenAI from 'openai'
import type {
  Response as OpenAIResponse,
  ResponseInputMessageContentList,
  ResponseOutputText,
} from 'openai/resources/responses/responses'

import { applyUrlCitations, type UrlCitation } from '../../lib/citations'
import { CHAT_MODEL, DEEP_RESEARCH_MODEL } from '../../lib/chat-config'
import type {
  ChatActivity,
  ChatActivityStatus,
  ChatSource,
  ChatStreamEvent,
  ChatWebSearchAction,
} from '../../lib/chat'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

const DEEP_RESEARCH_MAX_OUTPUT_TOKENS = 64_000
const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_MESSAGE_LENGTH = 50_000
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{8,200}$/
const IMAGE_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const EXTENSION_MIME_TYPES: Record<string, string> = {
  c: 'text/x-c',
  cpp: 'text/x-c++',
  cs: 'text/x-csharp',
  css: 'text/css',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif',
  go: 'text/x-golang',
  html: 'text/html',
  java: 'text/x-java',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'application/javascript',
  json: 'application/json',
  markdown: 'text/markdown',
  md: 'text/markdown',
  pdf: 'application/pdf',
  php: 'text/x-php',
  png: 'image/png',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  sh: 'text/x-shellscript',
  tex: 'text/x-tex',
  ts: 'application/typescript',
  txt: 'text/plain',
  webp: 'image/webp',
}

type OpenAIUrlCitation = Extract<
  ResponseOutputText['annotations'][number],
  { type: 'url_citation' }
>

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
    const summary = reasoningSummary(value.summary)
    return {
      id: value.id,
      kind: 'reasoning',
      status: activityStatus(value.status, fallback),
      ...(summary ? { summary } : {}),
    }
  }
  if (value.type === 'web_search_call') {
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

function streamActivity(
  value: unknown,
  reasoningParts: Map<string, Map<number, string>>,
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
    value.type === 'response.reasoning_summary_text.done'
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

    normalized.push({
      endIndex: citation.end_index,
      startIndex: citation.start_index,
      title: citation.title,
      url,
    })

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
          collectCitations(
            content.text,
            citations,
            sources,
            sourceUrls,
          ),
        )
      } else if (content.type === 'refusal') {
        parts.push(content.refusal)
      }
    }
  }

  return { content: parts.join('\n\n').trim(), sources }
}

function filename(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'file'
}

function attachmentMimeType(attachment: File) {
  if (attachment.type) return attachment.type
  const extension = attachment.name.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_MIME_TYPES[extension] ?? 'application/octet-stream'
}

function errorDetails(error: unknown) {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status)
      : 500

  if (status === 401 || status === 403) {
    return {
      message: 'The OpenAI API key is invalid or does not have access to this model.',
      status,
    }
  }
  if (status === 429) {
    return {
      message: 'OpenAI is rate-limiting this project. Please try again shortly.',
      status,
    }
  }
  if (status === 400) {
    return {
      message: 'OpenAI could not process this message or attachment.',
      status,
    }
  }
  if (status >= 500 && status < 600) {
    return {
      message: 'OpenAI is temporarily unavailable. Please try again.',
      status: 502,
    }
  }
  return { message: 'Khloei could not complete that response.', status: 500 }
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status })
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

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return jsonError('OPENAI_API_KEY is not configured on the server.', 503)
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return jsonError('The request body must be multipart form data.', 400)
  }

  const messageValue = formData.get('message')
  const message = typeof messageValue === 'string' ? messageValue.trim() : ''
  if (message.length > MAX_MESSAGE_LENGTH) {
    return jsonError('The message is too long.', 413)
  }

  const attachments = formData
    .getAll('attachments')
    .filter((entry): entry is File => entry instanceof File && entry.size > 0)

  if (!message && attachments.length === 0) {
    return jsonError('A message or attachment is required.', 400)
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return jsonError(`Attach no more than ${MAX_ATTACHMENTS} files.`, 413)
  }
  if (attachments.some((attachment) => attachment.size > MAX_ATTACHMENT_BYTES)) {
    return jsonError('Each attachment must be 10 MB or smaller.', 413)
  }
  if (
    attachments.reduce((total, attachment) => total + attachment.size, 0) >
    MAX_TOTAL_ATTACHMENT_BYTES
  ) {
    return jsonError('Attachments must total 25 MB or less.', 413)
  }

  const previousValue = formData.get('previousResponseId')
  const previousResponseId =
    typeof previousValue === 'string' && RESPONSE_ID_PATTERN.test(previousValue)
      ? previousValue
      : undefined

  const content: ResponseInputMessageContentList = [
    {
      text: message || 'Please analyze the attached content.',
      type: 'input_text',
    },
  ]

  for (const attachment of attachments) {
    const data = Buffer.from(await attachment.arrayBuffer()).toString('base64')
    const mimeType = attachmentMimeType(attachment)
    if (IMAGE_TYPES.has(mimeType)) {
      content.push({
        detail: 'high',
        image_url: `data:${mimeType};base64,${data}`,
        type: 'input_image',
      })
    } else {
      content.push({
        file_data: `data:${mimeType};base64,${data}`,
        filename: filename(attachment.name),
        type: 'input_file',
      })
    }
  }

  const deepResearch = /(?:^|\s)\/deep[\s-]*research(?:\s|$)/i.test(message)
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  let openAIStream
  try {
    openAIStream = await client.responses.create(
      {
        input: [{ content, role: 'user' }],
        instructions: [
          'You are Khloei, a thoughtful and precise AI assistant.',
          'Write responses in clear GitHub-flavored Markdown.',
          'Use fenced code blocks with a language identifier whenever you provide code.',
          'Web search is available. Use it whenever current or externally verifiable information would improve the answer.',
          'When web search is used, make sourced claims precise and preserve the generated citations.',
          deepResearch
            ? 'The user selected Deep Research. Search broadly, compare multiple reliable sources, surface uncertainty, and produce a well-structured, evidence-rich answer.'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        max_output_tokens: deepResearch
          ? DEEP_RESEARCH_MAX_OUTPUT_TOKENS
          : 8_192,
        model: deepResearch ? DEEP_RESEARCH_MODEL : CHAT_MODEL,
        previous_response_id: previousResponseId,
        reasoning: {
          context: 'all_turns',
          effort: deepResearch ? 'max' : 'medium',
          summary: 'auto',
        },
        store: true,
        stream: true,
        text: { verbosity: deepResearch ? 'high' : 'medium' },
        tool_choice: 'auto',
        tools: [
          {
            search_context_size: deepResearch ? 'high' : 'medium',
            type: 'web_search',
          },
        ],
      },
      { signal: request.signal },
    )
  } catch (error) {
    const details = errorDetails(error)
    return jsonError(details.message, details.status)
  }

  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const reasoningParts = new Map<string, Map<number, string>>()
      const send = (event: ChatStreamEvent) => {
        if (closed || request.signal.aborted) return
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }
      const close = () => {
        if (closed) return
        closed = true
        controller.close()
      }

      try {
        for await (const event of openAIStream) {
          const activity = streamActivity(event, reasoningParts)
          if (activity) send({ activity, type: 'activity' })

          if (event.type === 'response.output_text.delta') {
            send({ delta: event.delta, type: 'text-delta' })
          } else if (event.type === 'response.refusal.delta') {
            send({ delta: event.delta, type: 'text-delta' })
          } else if (event.type === 'response.completed') {
            for (const item of event.response.output) {
              const completedActivity = outputItemActivity(item, 'done')
              if (completedActivity) {
                send({ activity: completedActivity, type: 'activity' })
              }
            }
            const final = finalizeResponse(event.response)
            send({
              content: final.content,
              responseId: event.response.id,
              sources: final.sources,
              type: 'message',
            })
            send({ type: 'done' })
            close()
            return
          } else if (event.type === 'response.incomplete') {
            for (const item of event.response.output) {
              const completedActivity = outputItemActivity(item, 'done')
              if (completedActivity) {
                send({ activity: completedActivity, type: 'activity' })
              }
            }
            const final = finalizeResponse(event.response)
            send({
              content: final.content,
              responseId: event.response.id,
              sources: final.sources,
              type: 'message',
            })
            send({
              message: incompleteResponseMessage(event.response),
              type: 'error',
            })
            close()
            return
          } else if (event.type === 'response.failed') {
            throw new Error(event.response.error?.message || 'Response failed')
          } else if (event.type === 'error') {
            throw new Error(event.message)
          }
        }

        send({ message: 'The response stream ended unexpectedly.', type: 'error' })
        close()
      } catch (error) {
        if (!request.signal.aborted) {
          send({ message: errorDetails(error).message, type: 'error' })
        }
        close()
      }
    },
  })

  return new Response(body, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  })
}
