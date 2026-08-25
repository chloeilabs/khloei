import { describe, expect, test } from 'bun:test'

import {
  dehydrateScreenshots,
  INLINE_SCREENSHOT_LIMIT,
  rehydrateScreenshots,
} from '../src/screenshot-refs'
import type { ScreenshotStore } from '../src/screenshot-store'

const BIG = 'A'.repeat(INLINE_SCREENSHOT_LIMIT + 8)

/** A store that keeps blobs in memory, so the walk can be tested on its own. */
function memoryStore() {
  const blobs = new Map<string, { base64: string; mimeType: string }>()
  let sequence = 0
  const store: Pick<ScreenshotStore, 'get' | 'put'> = {
    put(base64, mimeType) {
      const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png'
      sequence += 1
      const reference = `sha256-${String(sequence).padStart(64, '0')}.${extension}`
      blobs.set(reference, { base64, mimeType })
      return { bytes: base64.length, mimeType, reference }
    },
    get(reference) {
      return blobs.get(reference) ?? null
    },
  }
  return { blobs, store }
}

function desktopOutcome(base64 = BIG) {
  return {
    ok: true,
    result: {
      action: 'click',
      elapsedMs: 42,
      screenshot: {
        base64,
        capturedAt: '2026-08-25T00:00:00.000Z',
        height: 1080,
        mimeType: 'image/jpeg',
        url: 'desktop://khloei',
        width: 1920,
      },
    },
  }
}

describe('screenshot externalization', () => {
  test('moves desktop screenshot bytes out of the outcome and back again', () => {
    const { store } = memoryStore()
    const dehydrated = dehydrateScreenshots(desktopOutcome(), store)

    expect(dehydrated.externalized).toBe(1)
    expect(JSON.stringify(dehydrated.value)).not.toContain(BIG)
    const screenshot = (dehydrated.value.result as Record<string, unknown>)
      .screenshot as Record<string, unknown>
    expect(screenshot.base64).toBeUndefined()
    expect(typeof screenshot.screenshotRef).toBe('string')
    // Metadata the model reads stays in the ledger row.
    expect(screenshot.width).toBe(1920)
    expect(screenshot.mimeType).toBe('image/jpeg')

    const restored = rehydrateScreenshots(dehydrated.value, store)
    expect(restored.restored).toBe(1)
    expect(restored.missing).toBe(0)
    expect(restored.value).toEqual(desktopOutcome())
  })

  test('moves a transcript frame data url out and restores the complete url', () => {
    const { store } = memoryStore()
    const event = {
      frame: {
        capturedAt: '2026-08-25T00:00:00.000Z',
        dataUrl: `data:image/jpeg;base64,${BIG}`,
        height: 1080,
        url: 'desktop://khloei',
        width: 1920,
      },
      type: 'computer-frame',
    }

    const dehydrated = dehydrateScreenshots(event, store)
    expect(dehydrated.externalized).toBe(1)
    expect(JSON.stringify(dehydrated.value)).not.toContain(BIG)

    const restored = rehydrateScreenshots(dehydrated.value, store)
    expect(restored.value).toEqual(event)
  })

  test('leaves small images inline rather than paying for a blob', () => {
    const { store, blobs } = memoryStore()
    const small = desktopOutcome('c21hbGw=')

    const dehydrated = dehydrateScreenshots(small, store)

    expect(dehydrated.externalized).toBe(0)
    expect(dehydrated.value).toEqual(small)
    expect(blobs.size).toBe(0)
  })

  test('keeps bytes inline when the store cannot accept them', () => {
    // A commit must never fail because a volume is full: the action already ran.
    const refusing: Pick<ScreenshotStore, 'get' | 'put'> = {
      put: () => null,
      get: () => null,
    }
    const outcome = desktopOutcome()

    const dehydrated = dehydrateScreenshots(outcome, refusing)

    expect(dehydrated.externalized).toBe(0)
    expect(dehydrated.value).toEqual(outcome)
  })

  test('marks a swept screenshot unavailable instead of returning a broken image', () => {
    const { store, blobs } = memoryStore()
    const dehydrated = dehydrateScreenshots(desktopOutcome(), store)
    blobs.clear()

    const restored = rehydrateScreenshots(dehydrated.value, store)

    expect(restored.missing).toBe(1)
    expect(restored.restored).toBe(0)
    const screenshot = (restored.value.result as Record<string, unknown>)
      .screenshot as Record<string, unknown>
    expect(screenshot.screenshotUnavailable).toBe(true)
    expect(screenshot.base64).toBeUndefined()
    expect(screenshot.screenshotRef).toBeUndefined()
    // The metadata the model needs to decide what to do next survives.
    expect(screenshot.width).toBe(1920)
    expect(screenshot.capturedAt).toBe('2026-08-25T00:00:00.000Z')
  })

  test('ignores a reference that does not name a real blob shape', () => {
    const { store } = memoryStore()
    const hostile = {
      result: { screenshotRef: '../../etc/passwd', screenshotField: 'base64' },
    }

    const restored = rehydrateScreenshots(hostile, store)

    expect(restored.missing).toBe(0)
    expect(restored.value).toEqual(hostile)
  })

  test('passes through payloads that carry no image at all', () => {
    const { store } = memoryStore()
    const outcome = { ok: true, result: { entries: ['a', 'b'], title: 'Khloei' } }

    expect(dehydrateScreenshots(outcome, store).value).toEqual(outcome)
    expect(rehydrateScreenshots(outcome, store).value).toEqual(outcome)
  })
})
