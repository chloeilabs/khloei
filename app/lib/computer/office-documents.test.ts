import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'

import {
  extractOfficeText,
  isOfficeDocument,
} from '../office-documents'

/** Build a real ZIP so the reader is exercised, not a mock of it. */
function zip(files: Record<string, string>, { store = false } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8')
    const body = store ? raw : deflateRawSync(raw)
    const nameBytes = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(Buffer.concat([local, nameBytes, body]))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(store ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBytes]))

    offset += 30 + nameBytes.length + body.length
  }

  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(centralPart.length, 12)
  end.writeUInt32LE(localPart.length, 16)
  return Buffer.concat([localPart, centralPart, end])
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

function wordDocument(body: string) {
  return `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`
}

describe('office document text', () => {
  test('reads paragraphs out of a Word file', () => {
    const bytes = zip({
      'word/document.xml': wordDocument(
        '<w:p><w:r><w:t>First line</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Second line</w:t></w:r></w:p>',
      ),
    })
    expect(extractOfficeText(bytes, DOCX)).toBe('First line\nSecond line')
  })

  test('joins runs that a formatting change split mid-sentence', () => {
    // Word splits a styled word into separate runs; the sentence must survive.
    const bytes = zip({
      'word/document.xml': wordDocument(
        '<w:p><w:r><w:t>The marker is </w:t></w:r>' +
          '<w:r><w:t xml:space="preserve">BLUE</w:t></w:r>' +
          '<w:r><w:t>BIRD</w:t></w:r></w:p>',
      ),
    })
    expect(extractOfficeText(bytes, DOCX)).toBe('The marker is BLUEBIRD')
  })

  test('decodes XML entities rather than showing them raw', () => {
    const bytes = zip({
      'word/document.xml': wordDocument(
        '<w:p><w:r><w:t>a &amp; b &lt;c&gt; &#65;</w:t></w:r></w:p>',
      ),
    })
    expect(extractOfficeText(bytes, DOCX)).toBe('a & b <c> A')
  })

  test('reads slides in order and labels them', () => {
    // Slide 10 must not sort before slide 2.
    const slide = (t: string) =>
      `<?xml version="1.0"?><p:sld xmlns:a="x"><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`
    const bytes = zip({
      'ppt/slides/slide1.xml': slide('Intro'),
      'ppt/slides/slide2.xml': slide('Middle'),
      'ppt/slides/slide10.xml': slide('Last'),
    })
    expect(extractOfficeText(bytes, PPTX)).toBe(
      'Slide 1:\nIntro\n\nSlide 2:\nMiddle\n\nSlide 3:\nLast',
    )
  })

  test('handles uncompressed entries as well as deflated ones', () => {
    const bytes = zip(
      { 'word/document.xml': wordDocument('<w:p><w:r><w:t>Stored</w:t></w:r></w:p>') },
      { store: true },
    )
    expect(extractOfficeText(bytes, DOCX)).toBe('Stored')
  })

  test('returns null rather than guessing at input it cannot open', () => {
    expect(extractOfficeText(Buffer.from('not a zip at all'), DOCX)).toBeNull()
    // A valid archive that simply is not a Word file.
    expect(extractOfficeText(zip({ 'other.xml': '<x/>' }), DOCX)).toBeNull()
    // A presentation with no slides.
    expect(extractOfficeText(zip({ 'ppt/presentation.xml': '<x/>' }), PPTX)).toBeNull()
  })

  test('recognizes only the formats it can actually read', () => {
    expect(isOfficeDocument(DOCX)).toBe(true)
    expect(isOfficeDocument(PPTX)).toBe(true)
    expect(isOfficeDocument('application/pdf')).toBe(false)
    expect(isOfficeDocument('text/plain')).toBe(false)
  })
})
