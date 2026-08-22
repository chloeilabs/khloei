import OpenAI from 'openai'
import type { ResponseInputMessageContentList } from 'openai/resources/responses/responses'

import {
  createBackgroundResumeToken,
  isOpenAIResponseId,
} from '../../lib/openai-background'
import { CHAT_MODEL, DEEP_RESEARCH_MODEL } from '../../lib/chat-config'
import {
  createOpenAIChatStreamResponse,
  openAIErrorDetails,
} from '../../lib/openai-chat-stream'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

const DEEP_RESEARCH_MAX_OUTPUT_TOKENS = 64_000
const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_MESSAGE_LENGTH = 50_000
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

function filename(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'file'
}

function attachmentMimeType(attachment: File) {
  if (attachment.type) return attachment.type
  const extension = attachment.name.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_MIME_TYPES[extension] ?? 'application/octet-stream'
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status })
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
    isOpenAIResponseId(previousValue)
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
        background: deepResearch,
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
    const details = openAIErrorDetails(error)
    return jsonError(details.message, details.status)
  }

  return createOpenAIChatStreamResponse({
    ...(deepResearch
      ? { backgroundToken: createBackgroundResumeToken, resumable: true }
      : {}),
    signal: request.signal,
    stream: openAIStream,
  })
}
