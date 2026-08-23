import OpenAI from 'openai'

import {
  isOpenAIResponseId,
  isValidBackgroundResumeToken,
} from '../../../lib/openai-background'
import {
  createModelChatStreamResponse,
  createTerminalChatResponse,
  openAIErrorDetails,
} from '../../../lib/model-chat-stream'
import { requireSameOriginRequest } from '../../../lib/request-origin'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

type BackgroundRequest = {
  responseId: string
  resumeToken: string
  startingAfter: number
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status })
}

async function backgroundRequest(request: Request) {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null

  const body = value as Record<string, unknown>
  if (
    !isOpenAIResponseId(body.responseId) ||
    typeof body.resumeToken !== 'string' ||
    !Number.isSafeInteger(body.startingAfter) ||
    Number(body.startingAfter) < 0
  ) {
    return null
  }

  return {
    responseId: body.responseId,
    resumeToken: body.resumeToken,
    startingAfter: Number(body.startingAfter),
  } satisfies BackgroundRequest
}

function authorized(body: BackgroundRequest) {
  return isValidBackgroundResumeToken(body.responseId, body.resumeToken)
}

export async function POST(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return jsonError('OPENAI_API_KEY is not configured on the server.', 503)
  }

  const body = await backgroundRequest(request)
  if (!body) return jsonError('Invalid background response request.', 400)
  if (!authorized(body)) {
    return jsonError('This background response cannot be resumed.', 403)
  }

  const client = new OpenAI({ apiKey })
  let current
  try {
    current = await client.responses.retrieve(body.responseId, undefined, {
      signal: request.signal,
    })
  } catch (error) {
    const details = openAIErrorDetails(error)
    return jsonError(details.message, details.status)
  }

  if (current.status !== 'queued' && current.status !== 'in_progress') {
    return createTerminalChatResponse(current)
  }

  try {
    const stream = await client.responses.retrieve(
      body.responseId,
      {
        include_obfuscation: false,
        starting_after: body.startingAfter,
        stream: true,
      },
      { signal: request.signal },
    )

    return createModelChatStreamResponse({
      resumable: true,
      seedResponse: current,
      signal: request.signal,
      stream,
    })
  } catch (error) {
    const details = openAIErrorDetails(error)
    return jsonError(details.message, details.status)
  }
}

export async function DELETE(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return jsonError('OPENAI_API_KEY is not configured on the server.', 503)
  }

  const body = await backgroundRequest(request)
  if (!body) return jsonError('Invalid background response request.', 400)
  if (!authorized(body)) {
    return jsonError('This background response cannot be cancelled.', 403)
  }

  try {
    const client = new OpenAI({ apiKey })
    const response = await client.responses.cancel(body.responseId, {
      signal: request.signal,
    })
    return Response.json({ status: response.status })
  } catch (error) {
    const details = openAIErrorDetails(error)
    return jsonError(details.message, details.status)
  }
}
