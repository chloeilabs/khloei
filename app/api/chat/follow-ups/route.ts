import { generateFollowUpQuestions } from '../../../lib/chat-follow-ups-generate'
import { parseFollowUpRequest } from '../../../lib/chat-follow-ups'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
export const runtime = 'nodejs'

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status })
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return jsonError('OPENAI_API_KEY is not configured on the server.', 503)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Request body must be valid JSON.', 400)
  }

  const messages = parseFollowUpRequest(body)
  if (typeof messages === 'string') return jsonError(messages, 400)

  const followUpQuestions = await generateFollowUpQuestions({
    apiKey,
    messages,
    signal: request.signal,
  })

  return Response.json({ followUpQuestions })
}
