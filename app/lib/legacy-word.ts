/**
 * Read the text out of legacy binary Word (.doc) attachments.
 *
 * Unlike .docx, this is not a ZIP of XML. It is a Compound File Binary
 * container -- a small FAT filesystem in a file -- holding a `WordDocument`
 * stream whose characters are described by a piece table in a companion table
 * stream. Text is not contiguous and is not one encoding: each piece says
 * separately whether it is CP1252 or UTF-16, which is why simply scraping
 * printable bytes produces plausible-looking but wrong output.
 *
 * Everything here refuses rather than guesses. A file that is encrypted, that
 * predates the piece table, or that uses a container feature this does not
 * implement returns null, because silently returning the wrong text is worse
 * than saying the file could not be read.
 */

const CFBF_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const END_OF_CHAIN = 0xfffffffe
const FREE_SECTOR = 0xffffffff
/** Word 97. Earlier revisions place the piece table differently. */
const MIN_SUPPORTED_NFIB = 193
const WORD_IDENTIFIER = 0xa5ec
const MAX_STREAM_BYTES = 32 * 1024 * 1024

export const LEGACY_WORD_MIME_TYPES = new Set(['application/msword'])

export function isLegacyWordDocument(mimeType: string) {
  return LEGACY_WORD_MIME_TYPES.has(mimeType)
}

type Container = {
  read(name: string): Buffer | null
}

/** Open the compound file and index its streams by name. */
function openContainer(bytes: Buffer): Container | null {
  if (bytes.length < 512) return null
  for (const [index, byte] of CFBF_SIGNATURE.entries()) {
    if (bytes[index] !== byte) return null
  }

  const sectorSize = 1 << bytes.readUInt16LE(30)
  const miniSectorSize = 1 << bytes.readUInt16LE(32)
  const directoryStart = bytes.readUInt32LE(48)
  const miniCutoff = bytes.readUInt32LE(56)
  const miniFatStart = bytes.readUInt32LE(60)
  const difatStart = bytes.readUInt32LE(68)
  const difatCount = bytes.readUInt32LE(72)
  if (sectorSize < 128 || sectorSize > 65536) return null

  const sector = (index: number) => {
    const offset = 512 + index * sectorSize
    if (offset < 0 || offset + sectorSize > bytes.length) return null
    return bytes.subarray(offset, offset + sectorSize)
  }

  // The first 109 FAT sector numbers live in the header; larger files continue
  // the list in a chain of DIFAT sectors.
  const fatSectors: number[] = []
  for (let index = 0; index < 109; index += 1) {
    const value = bytes.readUInt32LE(76 + index * 4)
    if (value === FREE_SECTOR) break
    fatSectors.push(value)
  }
  let difatSector = difatStart
  for (let seen = 0; seen < difatCount && difatSector < END_OF_CHAIN; seen += 1) {
    const data = sector(difatSector)
    if (!data) return null
    const perSector = sectorSize / 4 - 1
    for (let index = 0; index < perSector; index += 1) {
      const value = data.readUInt32LE(index * 4)
      if (value !== FREE_SECTOR) fatSectors.push(value)
    }
    difatSector = data.readUInt32LE(sectorSize - 4)
  }

  const fat: number[] = []
  for (const index of fatSectors) {
    const data = sector(index)
    if (!data) return null
    for (let entry = 0; entry < sectorSize / 4; entry += 1) {
      fat.push(data.readUInt32LE(entry * 4))
    }
  }

  /** Walk a sector chain, refusing a cycle rather than looping forever. */
  const follow = (start: number, table: number[]) => {
    const chain: number[] = []
    const seen = new Set<number>()
    let current = start
    while (current < END_OF_CHAIN) {
      if (seen.has(current) || current >= table.length) return null
      seen.add(current)
      chain.push(current)
      if (chain.length * sectorSize > MAX_STREAM_BYTES) return null
      current = table[current]!
    }
    return chain
  }

  const readChain = (start: number, size: number) => {
    const chain = follow(start, fat)
    if (!chain) return null
    const parts = chain.map(sector)
    if (parts.some((part) => part === null)) return null
    return Buffer.concat(parts as Buffer[]).subarray(0, size)
  }

  const directoryChain = readChain(directoryStart, MAX_STREAM_BYTES)
  if (!directoryChain) return null

  type Entry = { size: number; start: number }
  const entries = new Map<string, Entry>()
  let rootEntry: Entry | null = null
  for (let offset = 0; offset + 128 <= directoryChain.length; offset += 128) {
    const nameLength = directoryChain.readUInt16LE(offset + 64)
    if (nameLength < 2 || nameLength > 64) continue
    const name = directoryChain
      .subarray(offset + 0, offset + nameLength - 2)
      .toString('utf16le')
    const type = directoryChain[offset + 66]
    const entry = {
      size: directoryChain.readUInt32LE(offset + 120),
      start: directoryChain.readUInt32LE(offset + 116),
    }
    if (type === 5) rootEntry = entry
    else if (type === 2) entries.set(name, entry)
  }

  // Streams below the cutoff are packed into the root entry's own stream and
  // indexed by a second, smaller allocation table.
  let miniStream: Buffer | null = null
  let miniFat: number[] | null = null
  const loadMini = () => {
    if (miniStream || !rootEntry) return
    miniStream = readChain(rootEntry.start, rootEntry.size)
    const chain = follow(miniFatStart, fat)
    if (!chain) return
    miniFat = []
    for (const index of chain) {
      const data = sector(index)
      if (!data) return
      for (let entry = 0; entry < sectorSize / 4; entry += 1) {
        miniFat.push(data.readUInt32LE(entry * 4))
      }
    }
  }

  return {
    read(name) {
      const entry = entries.get(name)
      if (!entry || entry.size > MAX_STREAM_BYTES) return null
      if (entry.size >= miniCutoff) return readChain(entry.start, entry.size)

      loadMini()
      if (!miniStream || !miniFat) return null
      const chain = follow(entry.start, miniFat)
      if (!chain) return null
      const parts = chain.map((index) =>
        miniStream!.subarray(index * miniSectorSize, (index + 1) * miniSectorSize),
      )
      return Buffer.concat(parts).subarray(0, entry.size)
    },
  }
}

/**
 * Turn Word's control characters into ordinary text.
 *
 * A field such as a page number is stored as its instruction followed by its
 * result; only the result is what a reader sees, so the instruction is dropped.
 */
function cleanWordText(text: string) {
  let out = ''
  let inFieldInstruction = false
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x13) {
      inFieldInstruction = true
      continue
    }
    if (code === 0x14) {
      inFieldInstruction = false
      continue
    }
    if (code === 0x15) continue
    if (inFieldInstruction) continue

    if (code === 0x0d || code === 0x0b || code === 0x0c) out += '\n'
    else if (code === 0x07) out += '\t'
    else if (code === 0x09) out += '\t'
    else if (code >= 0x20 || code === 0x0a) out += character
  }
  return out.replace(/\t+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** The readable text of a legacy Word file, or null when it cannot be read. */
export function extractLegacyWordText(bytes: Buffer): string | null {
  const container = openContainer(bytes)
  if (!container) return null

  const document = container.read('WordDocument')
  if (!document || document.length < 0x1a6 + 4) return null
  if (document.readUInt16LE(0) !== WORD_IDENTIFIER) return null

  const flags = document.readUInt16LE(0x0a)
  // Bit 8 marks an encrypted document; its bytes are ciphertext, not text.
  if ((flags >> 8) & 1) return null
  if (document.readUInt16LE(2) < MIN_SUPPORTED_NFIB) return null

  const tableName = (flags >> 9) & 1 ? '1Table' : '0Table'
  const table = container.read(tableName)
  if (!table) return null

  const clxOffset = document.readUInt32LE(0x01a2)
  const clxLength = document.readUInt32LE(0x01a6)
  if (clxLength === 0 || clxOffset + clxLength > table.length) return null
  const clx = table.subarray(clxOffset, clxOffset + clxLength)

  // The piece table is the last block in the CLX, preceded by any number of
  // formatting blocks whose lengths must be stepped over to reach it.
  let cursor = 0
  while (cursor < clx.length) {
    const kind = clx[cursor]
    if (kind === 1) {
      if (cursor + 3 > clx.length) return null
      cursor += 3 + clx.readUInt16LE(cursor + 1)
      continue
    }
    if (kind !== 2) return null

    const length = clx.readUInt32LE(cursor + 1)
    const plc = clx.subarray(cursor + 5, cursor + 5 + length)
    if (plc.length < 4 || (plc.length - 4) % 12 !== 0) return null
    const pieces = (plc.length - 4) / 12

    let text = ''
    for (let piece = 0; piece < pieces; piece += 1) {
      const startCp = plc.readUInt32LE(piece * 4)
      const endCp = plc.readUInt32LE((piece + 1) * 4)
      const descriptor = 4 * (pieces + 1) + piece * 8
      const encoded = plc.readUInt32LE(descriptor + 2)
      // Bit 30 marks a CP1252 piece, and folds the offset in half.
      const compressed = (encoded >> 30) & 1
      const offset = compressed ? (encoded & 0x3fffffff) / 2 : encoded & 0x3fffffff
      const characters = endCp - startCp
      if (characters <= 0) continue
      const byteLength = compressed ? characters : characters * 2
      if (offset + byteLength > document.length) continue
      const raw = document.subarray(offset, offset + byteLength)
      text += compressed
        ? raw.toString('latin1')
        : raw.toString('utf16le')
    }
    const cleaned = cleanWordText(text)
    return cleaned || null
  }
  return null
}
