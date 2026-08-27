import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  extractLegacyWordText,
  isLegacyWordDocument,
} from '../legacy-word'

/**
 * A genuine compound-file Word document, written by a different implementation
 * than the one reading it. A fixture this parser generated itself would only
 * prove it agrees with its own misunderstandings.
 */
const fixture = readFileSync(
  join(import.meta.dir, 'fixtures', 'legacy-word.doc'),
)

describe('legacy Word documents', () => {
  test('reads the text of a real .doc', () => {
    expect(extractLegacyWordText(fixture)).toBe(
      'Khloei doc probe. The secret marker is SILVERFOX-8823.\nSecond paragraph here.',
    )
  })

  test('leaves no control characters in the result', () => {
    // Word separates paragraphs with 0x0D and marks cells with 0x07; those are
    // structure, not text, and must not reach the model as raw bytes.
    const text = extractLegacyWordText(fixture) ?? ''
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)).toBe(false)
  })

  test('refuses input that is not a compound file', () => {
    expect(extractLegacyWordText(Buffer.from('not a doc'))).toBeNull()
    expect(extractLegacyWordText(Buffer.alloc(0))).toBeNull()
    expect(extractLegacyWordText(Buffer.alloc(600))).toBeNull()
  })

  test('refuses a compound file that is not a Word document', () => {
    // Right container, wrong contents: the identifier at the start of the
    // WordDocument stream is what settles it.
    const notWord = Buffer.from(fixture)
    notWord.writeUInt8(0x00, 512)
    notWord.writeUInt8(0x00, 513)
    expect(extractLegacyWordText(notWord)).toBeNull()
  })

  test('recognizes only the legacy Word type', () => {
    expect(isLegacyWordDocument('application/msword')).toBe(true)
    expect(isLegacyWordDocument('application/pdf')).toBe(false)
    expect(
      isLegacyWordDocument(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(false)
  })
})
