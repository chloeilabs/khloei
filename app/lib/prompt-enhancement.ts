const ENHANCEMENT_GUIDANCE =
  'Provide a clear, accurate, and well-structured response. State necessary assumptions, include concrete details, and call out uncertainty when relevant.'

export function enhancePromptText(prompt: string) {
  const trimmed = prompt.trim()
  if (!trimmed) return ''
  if (trimmed.endsWith(ENHANCEMENT_GUIDANCE)) return trimmed

  return `${trimmed}\n\n${ENHANCEMENT_GUIDANCE}`
}
