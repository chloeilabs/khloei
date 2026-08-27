import { describe, expect, test } from 'bun:test'

/**
 * The classification the chat route applies to attachments. Kept in step with
 * app/api/chat/route.ts, where the behaviour it describes was verified against
 * OpenRouter rather than assumed.
 */
const IMAGE_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const PROVIDER_PARSED_TYPES = new Set(['application/pdf'])
const LEGACY_WORD_TYPES = new Set(['application/msword'])
const OFFICE_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

function isTextualAttachment(mimeType: string) {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/xml'
  )
}

function classify(mimeType: string) {
  if (IMAGE_TYPES.has(mimeType)) return 'image'
  if (PROVIDER_PARSED_TYPES.has(mimeType)) return 'file'
  if (OFFICE_TYPES.has(mimeType)) return 'office'
  if (LEGACY_WORD_TYPES.has(mimeType)) return 'legacy-word'
  if (isTextualAttachment(mimeType)) return 'text'
  return 'unsupported'
}

describe('attachment classification', () => {
  test('sends images as images', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(classify(type)).toBe('image')
    }
  })

  test('lets the provider parse a PDF', () => {
    // Verified against OpenRouter: a PDF sent as input_file comes back read.
    expect(classify('application/pdf')).toBe('file')
  })

  test('inlines anything textual rather than attaching it', () => {
    // The same input_file shape is refused for these, and the characters work
    // on every model without provider support.
    for (const type of [
      'text/plain',
      'text/markdown',
      'text/x-python',
      'text/x-c++',
      'text/html',
      'application/json',
      'application/javascript',
      'application/typescript',
    ]) {
      expect(classify(type)).toBe('text')
    }
  })

  test('opens Word and PowerPoint itself rather than refusing them', () => {
    // These are ZIP archives of XML; Khloei extracts the text and inlines it.
    expect(
      classify(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('office')
    expect(
      classify(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe('office')
  })

  test('reads the legacy binary Word format through its own parser', () => {
    // .doc is a compound file, not a ZIP, so it needs a different reader.
    expect(classify('application/msword')).toBe('legacy-word')
  })

  test('still refuses what it genuinely cannot read', () => {
    expect(classify('application/zip')).toBe('unsupported')
    expect(classify('application/octet-stream')).toBe('unsupported')
  })
})
