/**
 * Durable, content-addressed storage for the screenshots Khloei's desktop returns.
 *
 * A visual desktop action answers with a full-resolution JPEG. Keeping those bytes
 * inside the SQLite action ledger made a single screenshot-heavy task carry tens of
 * megabytes of base64 in `task_actions.result_json` and `task_events.payload_json`,
 * for rows the durable worker keeps for its whole retention window.
 *
 * The bytes now live beside the database on the same durable volume, named by the
 * SHA-256 of their content. The ledger keeps only a reference, so exactly-once
 * replay is unchanged: the ledger row is still the single record of whether an
 * action ran, and the reference is only how its picture is found again.
 *
 * Content addressing also means a repeated identical frame -- common on a desktop
 * that has not visibly changed -- is stored once no matter how many actions cite it.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Types the desktop and browser surfaces can actually return. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * A stored screenshot, as it appears in the ledger.
 *
 * The shape is deliberately self-describing and strictly validated on the way
 * back in, so a reference can never be read as a filesystem path.
 */
const REFERENCE = /^sha256-([a-f0-9]{64})\.(jpg|png|webp)$/

export const DEFAULT_SCREENSHOT_MAX_BYTES = 512 * 1024 * 1024
export const DEFAULT_SCREENSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

/**
 * The largest share of a volume screenshots may ever occupy.
 *
 * Screenshots sit on the same volume as the task database, and that database is
 * what makes an action exactly-once. A budget larger than the volume -- easy to
 * configure by accident, since a sensible-looking default can exceed a small
 * mounted disk -- would let cached pictures fill the disk and stall the ledger.
 * Losing old screenshots is recoverable; losing the ledger is not.
 */
const MAX_VOLUME_FRACTION = 0.5

/**
 * Clamp a configured budget to what the volume can actually spare.
 *
 * Returns the budget unchanged when the filesystem cannot be measured: an
 * unreadable `statfs` is not a reason to refuse to store anything.
 */
export function budgetForVolume(
  configuredBytes: number,
  directory: string,
  fraction: number = MAX_VOLUME_FRACTION,
): { bytes: number; clampedFrom: number | null; volumeBytes: number | null } {
  let volumeBytes: number | null = null
  try {
    const stats = statfsSync(directory)
    const total = Number(stats.blocks) * Number(stats.bsize)
    if (Number.isFinite(total) && total > 0) volumeBytes = total
  } catch {
    // An unreadable filesystem is not a reason to refuse to store anything.
  }
  if (volumeBytes === null) {
    return { bytes: configuredBytes, clampedFrom: null, volumeBytes: null }
  }

  const ceiling = Math.floor(volumeBytes * fraction)
  if (configuredBytes <= ceiling) {
    return { bytes: configuredBytes, clampedFrom: null, volumeBytes }
  }
  return { bytes: ceiling, clampedFrom: configuredBytes, volumeBytes }
}

export type ScreenshotStoreOptions = {
  directory: string
  maxAgeMs?: number
  maxTotalBytes?: number
  now?: () => number
}

export type StoredScreenshot = {
  bytes: number
  mimeType: string
  reference: string
}

export type ScreenshotStoreStats = {
  directory: string
  files: number
  maxAgeMs: number
  maxTotalBytes: number
  totalBytes: number
}

export type ScreenshotSweepResult = {
  removedBytes: number
  removedFiles: number
  totalBytes: number
}

export function screenshotExtension(mimeType: string): string | null {
  return EXTENSIONS[mimeType.trim().toLowerCase()] ?? null
}

/** Parse a reference without ever letting it name a path of its own choosing. */
export function parseScreenshotReference(
  value: unknown,
): { digest: string; extension: string; mimeType: string } | null {
  if (typeof value !== 'string') return null
  const match = REFERENCE.exec(value)
  if (!match) return null
  return {
    digest: match[1]!,
    extension: match[2]!,
    mimeType: MIME_TYPES[match[2]!]!,
  }
}

type FileEntry = { bytes: number; modifiedAt: number; path: string }

export type ScreenshotStore = {
  get(reference: string): { base64: string; mimeType: string } | null
  put(base64: string, mimeType: string): StoredScreenshot | null
  stats(): ScreenshotStoreStats
  sweep(now?: number): ScreenshotSweepResult
}

/**
 * Create the blob store rooted at `directory`.
 *
 * Writes are synchronous on purpose. They happen on the same durable volume as
 * the ledger and must be visible before the action row that references them is
 * committed, so there is nothing useful to overlap them with.
 */
export function createScreenshotStore(
  options: ScreenshotStoreOptions,
): ScreenshotStore {
  const directory = options.directory
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_SCREENSHOT_MAX_AGE_MS
  const clock = options.now ?? Date.now
  mkdirSync(directory, { recursive: true })

  const budget = budgetForVolume(
    options.maxTotalBytes ?? DEFAULT_SCREENSHOT_MAX_BYTES,
    directory,
  )
  const maxTotalBytes = budget.bytes
  if (budget.clampedFrom !== null) {
    console.warn(
      JSON.stringify({
        clampedFromBytes: budget.clampedFrom,
        maxTotalBytes,
        reason:
          'The configured screenshot budget exceeded this volume, so it was reduced to protect the task database.',
        type: 'khloei-screenshot-budget-clamped',
        volumeBytes: budget.volumeBytes,
      }),
    )
  }

  /** Fan out over the first byte of the digest so no directory grows unbounded. */
  const pathFor = (digest: string, extension: string) =>
    join(directory, digest.slice(0, 2), `sha256-${digest}.${extension}`)

  const entries = (): FileEntry[] => {
    const found: FileEntry[] = []
    let shards: string[]
    try {
      shards = readdirSync(directory)
    } catch {
      return found
    }
    for (const shard of shards) {
      const shardPath = join(directory, shard)
      let names: string[]
      try {
        names = readdirSync(shardPath)
      } catch {
        continue
      }
      for (const name of names) {
        if (!parseScreenshotReference(name)) continue
        const path = join(shardPath, name)
        try {
          const info = statSync(path)
          found.push({ bytes: info.size, modifiedAt: info.mtimeMs, path })
        } catch {
          // Swept by another pass between listing and stat.
        }
      }
    }
    return found
  }

  return {
    put(base64, mimeType) {
      const extension = screenshotExtension(mimeType)
      if (!extension) return null
      let bytes: Buffer
      try {
        bytes = Buffer.from(base64, 'base64')
      } catch {
        return null
      }
      if (bytes.length === 0) return null

      const digest = createHash('sha256').update(bytes).digest('hex')
      const reference = `sha256-${digest}.${extension}`
      const path = pathFor(digest, extension)
      const stored: StoredScreenshot = {
        bytes: bytes.length,
        mimeType: MIME_TYPES[extension]!,
        reference,
      }

      // Age is stamped from the store's own clock rather than left to the
      // filesystem, so retention stays consistent across a volume whose clock
      // drifts, and so it is testable without waiting real time.
      const stamp = () => {
        try {
          const timestamp = new Date(clock())
          utimesSync(path, timestamp, timestamp)
        } catch {
          // Losing the stamp only makes this blob eligible for sweeping sooner.
        }
      }

      if (existsSync(path)) {
        // An identical frame is already stored. Refresh its age so a screenshot
        // the model keeps re-observing is not swept out from under a live task.
        stamp()
        return stored
      }

      mkdirSync(dirname(path), { recursive: true })
      // Write to a unique temporary name and rename, so a crash mid-write can
      // never leave a truncated file sitting at a content-addressed name.
      const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        writeFileSync(temporary, bytes, { flush: true })
        renameSync(temporary, path)
        stamp()
      } catch {
        try {
          rmSync(temporary, { force: true })
        } catch {
          // Nothing further to do; the caller falls back to inlining.
        }
        return null
      }
      return stored
    },

    get(reference) {
      const parsed = parseScreenshotReference(reference)
      if (!parsed) return null
      const path = pathFor(parsed.digest, parsed.extension)
      try {
        const bytes = readFileSync(path)
        return { base64: bytes.toString('base64'), mimeType: parsed.mimeType }
      } catch {
        return null
      }
    },

    stats() {
      const found = entries()
      return {
        directory,
        files: found.length,
        maxAgeMs,
        maxTotalBytes,
        totalBytes: found.reduce((total, entry) => total + entry.bytes, 0),
      }
    },

    sweep(now = clock()) {
      const found = entries()
      let totalBytes = found.reduce((total, entry) => total + entry.bytes, 0)
      let removedBytes = 0
      let removedFiles = 0
      const remove = (entry: FileEntry) => {
        try {
          rmSync(entry.path, { force: true })
        } catch {
          return false
        }
        totalBytes -= entry.bytes
        removedBytes += entry.bytes
        removedFiles += 1
        return true
      }

      const survivors: FileEntry[] = []
      for (const entry of found) {
        if (maxAgeMs > 0 && now - entry.modifiedAt > maxAgeMs) {
          if (remove(entry)) continue
        }
        survivors.push(entry)
      }

      // Oldest first, so a budget overrun sheds the least recently useful frames.
      survivors.sort((left, right) => left.modifiedAt - right.modifiedAt)
      for (const entry of survivors) {
        if (totalBytes <= maxTotalBytes) break
        remove(entry)
      }

      return { removedBytes, removedFiles, totalBytes }
    },
  }
}
