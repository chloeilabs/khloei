import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputMessageContentList,
} from 'openai/resources/responses/responses'

import {
  parseChatHistory,
  type ChatHistoryMessage,
} from '../../lib/chat-history'
import {
  DEFAULT_CHAT_MODEL_ID,
  isChatModelId,
} from '../../lib/chat-models'
import { DEEP_RESEARCH_MODEL } from '../../lib/chat-config'
import { DEEP_RESEARCH_MAX_OUTPUT_TOKENS } from '@/shared/deep-research'
import {
  isComputerWorkerConfigured,
  isComputerWorkerRequired,
} from '../../lib/computer/worker-auth'
import { createComputerStreamResponse } from '../../lib/model-computer-stream'
import { createComputerTaskResponse } from '../../lib/model-computer-task'
import {
  chatModelProvider,
  createModelClient,
  ModelProviderConfigurationError,
  modelResponseHeaders,
  openRouterWebSearchTool,
  type ModelProvider,
  type OpenRouterWebSearchTool,
} from '../../lib/model-provider'
import {
  createModelChatStreamResponse,
  openRouterErrorDetails,
} from '../../lib/model-chat-stream'
import { requireSameOriginRequest } from '../../lib/request-origin'
import {
  extractOfficeText,
  isOfficeDocument,
} from '../../lib/office-documents'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_MESSAGE_LENGTH = 50_000
const COMPUTER_USE_COMMAND = /(?:^|\s)\/computer[\s-]*use(?:\s|$)/i
const DEEP_RESEARCH_COMMAND = /(?:^|\s)\/deep[\s-]*research(?:\s|$)/i
const IMAGE_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

/**
 * Types the provider parses for us, verified against OpenRouter rather than
 * assumed: a PDF sent as `input_file` comes back read, while the same shape
 * with any other type is refused by the model with "Input should be a valid
 * string".
 */
const PROVIDER_PARSED_TYPES = new Set(['application/pdf'])

/**
 * Everything textual is inlined instead of attached.
 *
 * A source file or a Markdown note is just characters, so handing the model the
 * characters works on every model and needs no provider support at all. It also
 * reads better than a base64 blob the provider has to decode first.
 */
function isTextualAttachment(mimeType: string) {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/xml'
  )
}

/** Inlined text is capped so one large file cannot crowd out the conversation. */
const MAX_INLINE_TEXT_CHARS = 256_000

/** Reject bytes that are not really text, rather than sending mojibake. */
function decodeTextAttachment(bytes: Buffer): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (text.includes('\u0000') || text.includes('\uFFFD')) return null
  return text
}
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

type OpenRouterResponseCreateParamsStreaming = Omit<
  ResponseCreateParamsStreaming,
  'tools'
> & {
  tools: OpenRouterWebSearchTool[]
}

const CHAT_INSTRUCTIONS = [
  'You are Khloei, a thoughtful and precise AI assistant.',
  'Write responses in clear GitHub-flavored Markdown.',
  'Use fenced code blocks with a language identifier whenever you provide code.',
  'Web search is available. Use it when the request needs current or externally verifiable information.',
  'Do not search for casual conversation, transformations, or requests fully answerable from the supplied conversation.',
  'When web search is used, make sourced claims precise and preserve the generated citations.',
].join('\n')

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

function messageWithoutSkillCommands(message: string) {
  return message
    .replace(/(?:^|\s)\/computer[\s-]*use(?=\s|$)/gi, ' ')
    .replace(/(?:^|\s)\/deep[\s-]*research(?=\s|$)/gi, ' ')
    .trim()
}

function historyInput(history: readonly ChatHistoryMessage[]): ResponseInput {
  return history.map((item) => ({
    content: [{ text: item.content, type: 'input_text' }],
    role: item.role,
    type: 'message',
  }))
}

function providerError(error: unknown) {
  if (error instanceof ModelProviderConfigurationError) {
    return jsonError(error.message, error.status)
  }
  return null
}

export async function POST(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

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

  const history = parseChatHistory(formData.get('history'))
  if (typeof history === 'string') return jsonError(history, 400)

  const modelValue = formData.get('model')
  if (modelValue !== null && !isChatModelId(modelValue)) {
    return jsonError('Select a supported chat model.', 400)
  }
  const selectedModelId = modelValue ?? DEFAULT_CHAT_MODEL_ID

  const computerUse = COMPUTER_USE_COMMAND.test(message)
  const deepResearch = DEEP_RESEARCH_COMMAND.test(message)
  if (computerUse && deepResearch) {
    return jsonError('Choose either Computer Use or Deep Research.', 400)
  }
  if (
    (computerUse || deepResearch) &&
    !messageWithoutSkillCommands(message) &&
    attachments.length === 0
  ) {
    return jsonError('Add a question or attachment for the selected skill.', 400)
  }
  let provider: ModelProvider
  try {
    provider = chatModelProvider(selectedModelId)
  } catch (error) {
    return (
      providerError(error) ??
      jsonError('Khloei could not select a model provider.', 500)
    )
  }

  const unsupported = attachments.filter((attachment) => {
    const mimeType = attachmentMimeType(attachment)
    return (
      !IMAGE_TYPES.has(mimeType) &&
      !PROVIDER_PARSED_TYPES.has(mimeType) &&
      !isTextualAttachment(mimeType) &&
      !isOfficeDocument(mimeType)
    )
  })
  if (unsupported.length > 0) {
    // Word and PowerPoint files are compressed archives, and the model refuses
    // them outright. Naming them is more useful than a blanket refusal that
    // also turns away the PDFs and source files that do work.
    return jsonError(
      `Khloei cannot read ${unsupported
        .map((attachment) => filename(attachment.name))
        .join(', ')}. Images, PDFs, .docx and .pptx files, and text or source files are supported. The legacy .doc format is not.`,
      400,
    )
  }

  const content: ResponseInputMessageContentList = [
    {
      text: message || 'Please analyze the attached content.',
      type: 'input_text',
    },
  ]

  for (const attachment of attachments) {
    const bytes = Buffer.from(await attachment.arrayBuffer())
    const mimeType = attachmentMimeType(attachment)
    const name = filename(attachment.name)

    if (IMAGE_TYPES.has(mimeType)) {
      content.push({
        detail: 'high',
        image_url: `data:${mimeType};base64,${bytes.toString('base64')}`,
        type: 'input_image',
      })
      continue
    }

    if (isOfficeDocument(mimeType)) {
      // Word and PowerPoint are ZIP archives of XML. The model refuses the
      // container, so Khloei opens it and passes on the characters.
      const text = extractOfficeText(bytes, mimeType)
      if (text === null) {
        return jsonError(
          `${name} could not be read. It may be corrupt, password-protected, or an older binary Office format.`,
          400,
        )
      }
      content.push({
        text: [`Attached document ${name}:`, '', text].join('\n'),
        type: 'input_text',
      })
      continue
    }

    if (isTextualAttachment(mimeType)) {
      const text = decodeTextAttachment(bytes)
      if (text === null) {
        return jsonError(`${name} is not readable as text.`, 400)
      }
      const truncated = text.length > MAX_INLINE_TEXT_CHARS
      content.push({
        text: [
          `Attached file ${name}${truncated ? ' (truncated)' : ''}:`,
          '',
          truncated ? text.slice(0, MAX_INLINE_TEXT_CHARS) : text,
        ].join('\n'),
        type: 'input_text',
      })
      continue
    }

    content.push({
      file_data: `data:${mimeType};base64,${bytes.toString('base64')}`,
      filename: name,
      type: 'input_file',
    })
  }

  if (computerUse) {
    if (!process.env.COMPUTER_TOKEN?.trim()) {
      return jsonError('COMPUTER_TOKEN is not configured on the server.', 503)
    }
    if (isComputerWorkerConfigured()) {
      try {
        return await createComputerTaskResponse({
          content,
          history,
          model: selectedModelId,
          provider,
          signal: request.signal,
        })
      } catch (error) {
        return jsonError(
          error instanceof Error
            ? error.message
            : 'Khloei could not start the durable computer task.',
          503,
        )
      }
    }
    if (isComputerWorkerRequired()) {
      return jsonError(
        'Khloei\'s durable computer worker is not configured. Computer Use is unavailable until the worker connection is restored.',
        503,
      )
    }
  }

  // A research run is long enough that losing it to a reload or a serverless
  // timeout wastes both the wait and the spend. The durable worker is what
  // makes it resumable now that OpenAI's background responses are gone; where
  // the worker is unavailable it still runs inline, just without that safety.
  if (deepResearch && isComputerWorkerConfigured()) {
    try {
      return await createComputerTaskResponse({
        content,
        history,
        kind: 'deep-research',
        model: DEEP_RESEARCH_MODEL,
        provider,
        signal: request.signal,
      })
    } catch (error) {
      return jsonError(
        error instanceof Error
          ? error.message
          : 'Khloei could not start the durable research task.',
        503,
      )
    }
  }

  let client
  try {
    client = createModelClient()
  } catch (error) {
    return (
      providerError(error) ??
      jsonError('Khloei could not configure the model provider.', 500)
    )
  }

  if (computerUse) {
    return createComputerStreamResponse({
      client,
      content,
      history,
      model: selectedModelId,
      signal: request.signal,
    })
  }

  const input: ResponseInput = [
    ...historyInput(history),
    { content, role: 'user', type: 'message' },
  ]
  let modelStream
  try {
    if (provider === 'openrouter') {
      const params: OpenRouterResponseCreateParamsStreaming = {
        input,
        instructions: CHAT_INSTRUCTIONS,
        max_output_tokens: 8_192,
        model: selectedModelId,
        reasoning: { effort: 'medium' },
        stream: true,
        tool_choice: 'auto',
        tools: [openRouterWebSearchTool()],
      }
      // The OpenAI SDK forwards provider extensions but does not type
      // OpenRouter's server tools yet.
      modelStream = await client.responses.create(
        params as unknown as ResponseCreateParamsStreaming,
        { signal: request.signal },
      )
    } else {
      modelStream = await client.responses.create(
        {
          input,
          instructions: [
            CHAT_INSTRUCTIONS,
            deepResearch
              ? 'The user selected Deep Research. Search broadly, compare multiple reliable sources, surface uncertainty, and produce a well-structured, evidence-rich answer.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          max_output_tokens: deepResearch
            ? DEEP_RESEARCH_MAX_OUTPUT_TOKENS
            : 8_192,
          model: deepResearch
            ? DEEP_RESEARCH_MODEL
            : selectedModelId,
          reasoning: {
            context: 'all_turns',
            effort: deepResearch ? 'max' : 'medium',
            summary: 'auto',
          },
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
    }
  } catch (error) {
    const details = openRouterErrorDetails(error)
    return jsonError(details.message, details.status)
  }

  return createModelChatStreamResponse({
    errorDetails: openRouterErrorDetails,
    headers: modelResponseHeaders(
      deepResearch ? DEEP_RESEARCH_MODEL : selectedModelId,
    ),
    signal: request.signal,
    stream: modelStream,
  })
}
