import { describe, expect, test } from 'bun:test'

import { normalizeComputerFrame } from '../chat'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

function frame(overrides: Record<string, unknown> = {}) {
  return {
    capturedAt: '2026-08-25T00:00:00.000Z',
    dataUrl: JPEG,
    height: 1080,
    url: 'desktop://khloei',
    width: 1920,
    ...overrides,
  }
}

describe('computer frame validation', () => {
  test('accepts the desktop surface, which sends JPEG', () => {
    // A PNG-only guard silently dropped every desktop frame, so the computer
    // card never appeared for the Linux desktop.
    const value = normalizeComputerFrame(frame())

    expect(value).toBeDefined()
    expect(value!.dataUrl).toBe(JPEG)
    expect(value!.width).toBe(1920)
    expect(value!.url).toBe('desktop://khloei')
  })

  test('still accepts the browser surface, which sends PNG', () => {
    const value = normalizeComputerFrame(
      frame({ dataUrl: PNG, url: 'https://example.com/' }),
    )

    expect(value!.dataUrl).toBe(PNG)
    expect(value!.url).toBe('https://example.com/')
  })

  test('keeps a frame whose screenshot has passed its retention window', () => {
    const value = normalizeComputerFrame(
      frame({ dataUrl: undefined, screenshotUnavailable: true }),
    )

    expect(value).toBeDefined()
    expect(value!.dataUrl).toBeUndefined()
    expect(value!.screenshotUnavailable).toBe(true)
    // Geometry survives so the card keeps its shape instead of collapsing.
    expect(value!.height).toBe(1080)
    expect(value!.width).toBe(1920)
  })

  test('rejects a frame with neither an image nor a reason for its absence', () => {
    expect(normalizeComputerFrame(frame({ dataUrl: undefined }))).toBeUndefined()
  })

  test('rejects a data url that is not an image this surface can send', () => {
    for (const dataUrl of [
      'data:text/html;base64,PHNjcmlwdD4=',
      'javascript:alert(1)',
      'https://example.com/frame.png',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/jpeg;base64,not base64 at all',
      '',
    ]) {
      expect(normalizeComputerFrame(frame({ dataUrl }))).toBeUndefined()
    }
  })

  test('rejects frames without usable geometry', () => {
    for (const overrides of [
      { height: 0 },
      { width: -1 },
      { height: Number.NaN },
      { width: '1920' },
      { capturedAt: 42 },
      { url: 7 },
    ]) {
      expect(normalizeComputerFrame(frame(overrides))).toBeUndefined()
    }
    for (const value of [null, undefined, 'frame', [], 42]) {
      expect(normalizeComputerFrame(value)).toBeUndefined()
    }
  })

  test('drops fields it was not given rather than inventing them', () => {
    const value = normalizeComputerFrame({
      capturedAt: '2026-08-25T00:00:00.000Z',
      dataUrl: JPEG,
      height: 720,
      width: 1280,
    })

    expect(value).toEqual({
      capturedAt: '2026-08-25T00:00:00.000Z',
      dataUrl: JPEG,
      height: 720,
      width: 1280,
    })
  })
})
