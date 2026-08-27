/**
 * Read the text out of Word and PowerPoint attachments.
 *
 * Both formats are ZIP archives of XML, so a model that refuses them is not
 * refusing the content, only the container. Khloei opens the container itself
 * and hands the model the characters, which is the same thing it already does
 * for source files and needs no support from the provider.
 *
 * The archive is read with `node:zlib` rather than a dependency. Only a few
 * named entries are ever needed, their sizes come from the central directory
 * where they are authoritative, and everything else in the file is ignored.
 */
import { inflateRawSync } from 'node:zlib'

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50

const STORED = 0
const DEFLATED = 8

/** A malicious archive must not be able to expand into unbounded memory. */
const MAX_UNCOMPRESSED_ENTRY_BYTES = 32 * 1024 * 1024
/** Extracted text is capped for the same reason inlined files are. */
export const MAX_OFFICE_TEXT_CHARS = 256_000

export const WORD_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
export const SLIDES_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

export function isOfficeDocument(mimeType: string) {
  return WORD_MIME_TYPES.has(mimeType) || SLIDES_MIME_TYPES.has(mimeType)
}

type ZipEntry = {
  compressedSize: number
  localHeaderOffset: number
  method: number
  uncompressedSize: number
}

/**
 * Index an archive from its central directory.
 *
 * The central directory is used rather than each local header because a local
 * header is allowed to carry zeroed sizes and defer them to a trailing data
 * descriptor, which the central directory never does.
 */
function readCentralDirectory(bytes: Buffer): Map<string, ZipEntry> | null {
  // The end record sits last but may be followed by a comment, so scan back.
  const earliest = Math.max(0, bytes.length - 22 - 0xffff)
  let end = -1
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset
      break
    }
  }
  if (end < 0) return null

  const count = bytes.readUInt16LE(end + 10)
  let cursor = bytes.readUInt32LE(end + 16)
  // Zip64 signals itself with saturated fields. Office attachments never reach
  // that size, so refuse rather than misread a format this does not implement.
  if (count === 0xffff || cursor === 0xffffffff) return null

  const entries = new Map<string, ZipEntry>()
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length) return null
    if (bytes.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) return null
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8')
    entries.set(name, {
      compressedSize,
      localHeaderOffset,
      method,
      uncompressedSize,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntry(bytes: Buffer, entry: ZipEntry): string | null {
  if (entry.uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES) return null
  const header = entry.localHeaderOffset
  if (header + 30 > bytes.length) return null
  if (bytes.readUInt32LE(header) !== LOCAL_FILE_HEADER) return null
  const nameLength = bytes.readUInt16LE(header + 26)
  const extraLength = bytes.readUInt16LE(header + 28)
  const start = header + 30 + nameLength + extraLength
  const body = bytes.subarray(start, start + entry.compressedSize)

  try {
    if (entry.method === STORED) return body.toString('utf8')
    if (entry.method === DEFLATED) {
      return inflateRawSync(body, {
        maxOutputLength: MAX_UNCOMPRESSED_ENTRY_BYTES,
      }).toString('utf8')
    }
  } catch {
    return null
  }
  return null
}

function decodeEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, so an escaped entity is not decoded twice.
    .replace(/&amp;/g, '&')
}

/**
 * Pull readable text out of one Office XML part.
 *
 * `textTag` is where characters live; `breakTag` is what separates them into
 * lines. Everything else in the markup is layout the model does not need.
 */
function textFromXml(xml: string, textTag: string, breakTag: string) {
  const withBreaks = xml
    .replace(new RegExp(`<${breakTag}[ >]`, 'g'), '\n$&')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<w:tab\s*\/>/g, '\t')
  const runs = withBreaks.matchAll(
    new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>`, 'g'),
  )

  let out = ''
  let line = ''
  let cursor = 0
  for (const run of runs) {
    const index = run.index ?? 0
    if (withBreaks.slice(cursor, index).includes('\n') && line) {
      out += `${line}\n`
      line = ''
    }
    line += decodeEntities(run[1] ?? '')
    cursor = index + run[0].length
  }
  if (line) out += line
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

function slideOrder(name: string) {
  const match = /slide(\d+)\.xml$/.exec(name)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * The readable text of a Word or PowerPoint attachment, or null when the file
 * cannot be opened as one.
 */
export function extractOfficeText(
  bytes: Buffer,
  mimeType: string,
): string | null {
  const entries = readCentralDirectory(bytes)
  if (!entries) return null

  if (WORD_MIME_TYPES.has(mimeType)) {
    const entry = entries.get('word/document.xml')
    if (!entry) return null
    const xml = readEntry(bytes, entry)
    if (xml === null) return null
    return textFromXml(xml, 'w:t', 'w:p').slice(0, MAX_OFFICE_TEXT_CHARS)
  }

  if (SLIDES_MIME_TYPES.has(mimeType)) {
    const slides = [...entries.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => slideOrder(left) - slideOrder(right))
    if (slides.length === 0) return null

    const parts: string[] = []
    for (const [index, name] of slides.entries()) {
      const xml = readEntry(bytes, entries.get(name)!)
      if (xml === null) continue
      const text = textFromXml(xml, 'a:t', 'a:p')
      // Slide numbers are part of the content: "the third slide says" is a
      // question people ask, and it cannot be answered from a flat wall of text.
      if (text) parts.push(`Slide ${index + 1}:\n${text}`)
    }
    if (parts.length === 0) return null
    return parts.join('\n\n').slice(0, MAX_OFFICE_TEXT_CHARS)
  }

  return null
}
