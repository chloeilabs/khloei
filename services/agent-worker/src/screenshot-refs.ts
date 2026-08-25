/**
 * Swap screenshot bytes for durable references on the way into the ledger, and
 * back again on the way out.
 *
 * Two shapes carry image bytes across the worker boundary, and both are handled
 * here rather than at each call site:
 *
 *   - a tool outcome, where the model's screenshot sits at `base64` alongside a
 *     `mimeType`, either directly or under `screenshot`
 *   - a `computer-frame` transcript event, where the surface's picture sits at
 *     `dataUrl` as a complete `data:` URL
 *
 * Rather than match those two paths exactly, the walk rewrites any node that
 * carries image bytes in either field. A future surface that returns a picture
 * somewhere new is externalized without a change here, and a node that carries
 * no image bytes is returned untouched.
 */
import type { ScreenshotStore } from './screenshot-store'
import { parseScreenshotReference, screenshotExtension } from './screenshot-store'

/**
 * Bytes below this stay inline.
 *
 * A blob costs an inode, a sweep entry and two file operations, so paying that
 * for a favicon-sized image is worse than the base64 it saves. Full-resolution
 * desktop frames are three orders of magnitude above the threshold.
 */
export const INLINE_SCREENSHOT_LIMIT = 4 * 1024

/** Depth guard: the payloads walked here are shallow, and cycles cannot appear in parsed JSON. */
const MAX_DEPTH = 12

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i

type Node = Record<string, unknown>

export type DehydrateResult<T> = {
  externalized: number
  value: T
}

export type RehydrateResult<T> = {
  missing: number
  restored: number
  value: T
}

function isRecord(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mimeTypeOf(node: Node): string {
  return typeof node.mimeType === 'string' ? node.mimeType : 'image/png'
}

/**
 * Replace inline image bytes with a durable reference.
 *
 * A store that cannot accept the bytes leaves the node exactly as it was. That
 * keeps a full disk or an unwritable volume from turning a completed action into
 * a failed commit, which would break exactly-once far more seriously than
 * carrying one oversized row.
 */
export function dehydrateScreenshots<T>(
  value: T,
  store: Pick<ScreenshotStore, 'put'>,
): DehydrateResult<T> {
  let externalized = 0

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return node
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    if (!isRecord(node)) return node

    const next: Node = {}
    for (const [key, item] of Object.entries(node)) {
      next[key] = walk(item, depth + 1)
    }

    if (
      typeof next.base64 === 'string' &&
      next.base64.length >= INLINE_SCREENSHOT_LIMIT &&
      screenshotExtension(mimeTypeOf(next))
    ) {
      const stored = store.put(next.base64, mimeTypeOf(next))
      if (stored) {
        delete next.base64
        next.screenshotRef = stored.reference
        next.screenshotField = 'base64'
        next.mimeType = stored.mimeType
        next.screenshotBytes = stored.bytes
        externalized += 1
      }
      return next
    }

    if (typeof next.dataUrl === 'string' && next.dataUrl.length >= INLINE_SCREENSHOT_LIMIT) {
      const match = DATA_URL.exec(next.dataUrl)
      if (match && screenshotExtension(match[1]!)) {
        const stored = store.put(match[2]!, match[1]!)
        if (stored) {
          delete next.dataUrl
          next.screenshotRef = stored.reference
          next.screenshotField = 'dataUrl'
          next.screenshotBytes = stored.bytes
          externalized += 1
        }
      }
    }

    return next
  }

  // The walk runs before the result object is built: reading the counters in an
  // object literal alongside the call would capture them at zero.
  const rewritten = walk(value, 0) as T
  return { externalized, value: rewritten }
}

/**
 * Restore inline image bytes from durable references.
 *
 * A reference whose blob has been swept is not an error. Retention is allowed to
 * outlive a paused task, so the node comes back carrying its metadata and an
 * explicit `screenshotUnavailable` marker. The model then reads a small, honest
 * result telling it the picture is gone rather than being handed a broken image
 * or a silently truncated one, and can take a fresh screenshot.
 */
export function rehydrateScreenshots<T>(
  value: T,
  store: Pick<ScreenshotStore, 'get'>,
): RehydrateResult<T> {
  let missing = 0
  let restored = 0

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return node
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    if (!isRecord(node)) return node

    const next: Node = {}
    for (const [key, item] of Object.entries(node)) {
      next[key] = walk(item, depth + 1)
    }

    const reference = next.screenshotRef
    if (!parseScreenshotReference(reference)) return next

    const field = next.screenshotField === 'dataUrl' ? 'dataUrl' : 'base64'
    delete next.screenshotRef
    delete next.screenshotField
    delete next.screenshotBytes

    const found = store.get(reference as string)
    if (!found) {
      next.screenshotUnavailable = true
      missing += 1
      return next
    }

    // A data URL already names its own type, so only the `base64` shape carries
    // a separate `mimeType`. Adding one to a transcript frame would put a field
    // there that never existed before it was externalized.
    if (field === 'dataUrl') {
      next.dataUrl = `data:${found.mimeType};base64,${found.base64}`
    } else {
      next.base64 = found.base64
      next.mimeType = found.mimeType
    }
    restored += 1
    return next
  }

  const rewritten = walk(value, 0) as T
  return { missing, restored, value: rewritten }
}
