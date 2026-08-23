import { generateFollowUpQuestions } from '../../../lib/chat-follow-ups-generate'
import { parseFollowUpRequest } from '../../../lib/chat-follow-ups'
import {
  DEFAULT_CHAT_MODEL_ID,
  isChatModelId,
} from '../../../lib/chat-models'
import {
  chatModelProvider,
  createModelClient,
  ModelProviderConfigurationError,
  modelResponseHeaders,
} from '../../../lib/model-provider'
import { requireSameOriginRequest } from '../../../lib/request-origin'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
export const runtime = 'nodejs'

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status })
}

export async function POST(request: Request) {
  const refused = requireSameOriginRequest(request)
  if (refused) return refused

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Request body must be valid JSON.', 400)
  }

  const messages = parseFollowUpRequest(body)
  if (typeof messages === 'string') return jsonError(messages, 400)

  const modelValue =
    typeof body === 'object' && body !== null && 'model' in body
      ? body.model
      : undefined
  if (modelValue !== undefined && !isChatModelId(modelValue)) {
    return jsonError('Select a supported chat model.', 400)
  }
  const selectedModelId = modelValue ?? DEFAULT_CHAT_MODEL_ID

  let provider
  let client
  try {
    provider = chatModelProvider(selectedModelId)
    client = createModelClient(provider)
  } catch (error) {
    if (error instanceof ModelProviderConfigurationError) {
      return jsonError(error.message, error.status)
    }
    return jsonError('Khloei could not configure the model provider.', 500)
  }

  const followUpQuestions = await generateFollowUpQuestions({
    client,
    messages,
    model: selectedModelId,
    provider,
    signal: request.signal,
  })

  return Response.json(
    { followUpQuestions },
    { headers: modelResponseHeaders(provider, selectedModelId) },
  )
}
