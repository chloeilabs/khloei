import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{8,200}$/
const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const TOKEN_CONTEXT = 'khloei-openai-background-v1'

function signingSecret() {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured on the server.')
  return apiKey
}

export function isOpenAIResponseId(value: unknown): value is string {
  return typeof value === 'string' && RESPONSE_ID_PATTERN.test(value)
}

export function createBackgroundResumeToken(responseId: string) {
  return createHmac('sha256', signingSecret())
    .update(`${TOKEN_CONTEXT}:${responseId}`)
    .digest('base64url')
}

export function isValidBackgroundResumeToken(
  responseId: string,
  token: unknown,
) {
  if (typeof token !== 'string' || !RESUME_TOKEN_PATTERN.test(token)) {
    return false
  }

  const expected = Buffer.from(createBackgroundResumeToken(responseId))
  const provided = Buffer.from(token)
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  )
}
