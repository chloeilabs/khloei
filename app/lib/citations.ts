export type UrlCitation = {
  endIndex: number
  startIndex: number
  title: string
  url: string
}

function escapeMarkdownLinkLabel(value: string): string {
  return value
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeMarkdownLinkTitle(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\s+/g, ' ')
    .trim()
}

export function citationDomainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'source'
  }
}

function looksLikeCitationWrapperLabel(value: string): boolean {
  const text = value.trim()
  if (!text || text.length > 512) return false
  if (/^https?:\/\/\S+$/i.test(text)) return true
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(text)) return true
  return /^\[[^\]]+\]\((?:<)?https?:\/\/\S+(?:>)?(?:\s+"[^"]*")?\)$/i.test(
    text,
  )
}

function expandCitationWrapperParens(
  text: string,
  startIndex: number,
  endIndex: number,
): { startIndex: number; endIndex: number } {
  let start = startIndex
  let end = endIndex

  if (!looksLikeCitationWrapperLabel(text.slice(start, end))) {
    return { startIndex: start, endIndex: end }
  }

  while (
    start > 0 &&
    end < text.length &&
    text[start - 1] === '(' &&
    text[end] === ')'
  ) {
    start -= 1
    end += 1
  }

  return { startIndex: start, endIndex: end }
}

function markdownLinkDestination(url: string): string {
  return `<${url.replace(/>/g, '%3E')}>`
}

export function applyUrlCitations(
  text: string,
  citations: readonly UrlCitation[],
): string {
  const ordered = [...citations].sort(
    (left, right) => right.startIndex - left.startIndex,
  )
  let result = text
  let guardEnd = Number.POSITIVE_INFINITY

  for (const citation of ordered) {
    if (
      citation.startIndex > result.length ||
      citation.endIndex > result.length ||
      citation.endIndex > guardEnd
    ) {
      continue
    }

    const { startIndex, endIndex } = expandCitationWrapperParens(
      result,
      citation.startIndex,
      citation.endIndex,
    )
    const pageTitle = escapeMarkdownLinkTitle(citation.title)
    const label = escapeMarkdownLinkLabel(citationDomainLabel(citation.url))
    if (!label) continue

    const destination = markdownLinkDestination(citation.url)
    const markdown = pageTitle
      ? `[${label}](${destination} "${pageTitle}")`
      : `[${label}](${destination})`

    result = result.slice(0, startIndex) + markdown + result.slice(endIndex)
    guardEnd = startIndex
  }

  return result
}
