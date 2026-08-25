import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { INLINE_SCREENSHOT_LIMIT } from '../src/screenshot-refs'
import { createScreenshotStore } from '../src/screenshot-store'
import { AmbiguousActionError, TaskStore } from '../src/store'
import type { ComputerTaskRequest, WorkerActionResponse } from '../src/types'

const temporaryDirectories: string[] = []

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'khloei-ledger-shots-'))
  temporaryDirectories.push(directory)
  return {
    database: join(directory, 'tasks.sqlite'),
    screenshots: join(directory, 'screenshots'),
  }
}

const BIG = 'A'.repeat(INLINE_SCREENSHOT_LIMIT + 64)

function request(): ComputerTaskRequest {
  return {
    input: [
      {
        content: [{ text: 'Look at the desktop.', type: 'input_text' }],
        role: 'user',
        type: 'message',
      },
    ],
    model: 'gpt-5.6-terra',
    provider: 'openai',
  }
}

function desktopResponse(base64 = BIG): WorkerActionResponse {
  return {
    events: [
      {
        frame: {
          capturedAt: '2026-08-25T00:00:00.000Z',
          dataUrl: `data:image/jpeg;base64,${base64}`,
          height: 1080,
          url: 'desktop://khloei',
          width: 1920,
        },
        type: 'computer-frame',
      },
    ],
    gatewayState: { currentPageUrl: '' },
    outcome: {
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
    },
  }
}

/** Everything the ledger itself is holding, as raw stored text. */
function ledgerText(store: TaskStore) {
  const actions = store.database
    .query<{ result_json: string | null }, []>(
      'SELECT result_json FROM task_actions',
    )
    .all()
    .map((row) => row.result_json ?? '')
  const events = store.database
    .query<{ payload_json: string }, []>('SELECT payload_json FROM task_events')
    .all()
    .map((row) => row.payload_json)
  return [...actions, ...events].join('\n')
}

function openStore(paths: ReturnType<typeof workspace>, maxAgeMs?: number) {
  return new TaskStore(
    paths.database,
    createScreenshotStore({
      directory: paths.screenshots,
      ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    }),
  )
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('ledger screenshot retention', () => {
  test('keeps screenshot bytes out of SQLite but returns them on replay', () => {
    const paths = workspace()
    const store = openStore(paths)
    const task = store.createTask(request())

    expect(store.beginAction(task.id, 'call-1', 'computer_desktop_click', {})).toEqual({
      kind: 'execute',
    })
    store.commitActionResult(task.id, 'call-1', desktopResponse())

    // Neither the action ledger nor the transcript carries the image bytes.
    const stored = ledgerText(store)
    expect(stored).not.toContain(BIG)
    expect(stored).toContain('screenshotRef')
    expect(stored.length).toBeLessThan(2_000)

    // The model still receives the exact screenshot when the action replays.
    const replay = store.beginAction(
      task.id,
      'call-1',
      'computer_desktop_click',
      {},
    )
    expect(replay.kind).toBe('replay')
    const result = replay.kind === 'replay' ? replay.result : null
    const outcome = (result as { outcome: Record<string, unknown> }).outcome
    const screenshot = (outcome.result as Record<string, unknown>)
      .screenshot as Record<string, unknown>
    expect(screenshot.base64).toBe(BIG)
    expect(screenshot.mimeType).toBe('image/jpeg')
    expect(screenshot.width).toBe(1920)

    // The transcript frame is restored as a complete data URL for the browser.
    const events = store.eventsAfter(task.id, 0)
    const frame = (events[0]!.payload as { frame: Record<string, unknown> }).frame
    expect(frame.dataUrl).toBe(`data:image/jpeg;base64,${BIG}`)

    store.close()
  })

  test('replays across a worker restart from the durable volume', () => {
    const paths = workspace()
    const first = openStore(paths)
    const task = first.createTask(request())
    first.beginAction(task.id, 'call-1', 'computer_desktop_screenshot', {})
    first.commitActionResult(task.id, 'call-1', desktopResponse())
    first.close()

    const second = openStore(paths)
    const replay = second.beginAction(
      task.id,
      'call-1',
      'computer_desktop_screenshot',
      {},
    )

    expect(replay.kind).toBe('replay')
    const outcome = (replay as { result: { outcome: Record<string, unknown> } })
      .result.outcome
    const screenshot = (outcome.result as Record<string, unknown>)
      .screenshot as Record<string, unknown>
    expect(screenshot.base64).toBe(BIG)
    second.close()
  })

  test('stores one blob when several actions observe the same frame', () => {
    const paths = workspace()
    const store = openStore(paths)
    const task = store.createTask(request())

    for (const callId of ['call-1', 'call-2', 'call-3']) {
      store.beginAction(task.id, callId, 'computer_desktop_move', {
        callId,
      })
      store.commitActionResult(task.id, callId, desktopResponse())
    }

    expect(store.screenshots!.stats().files).toBe(1)
    store.close()
  })

  test('a swept screenshot replays as unavailable, not as a broken image', () => {
    const paths = workspace()
    // Retention shorter than the gap below, so the blob is genuinely eligible.
    const store = openStore(paths, 1)
    const task = store.createTask(request())
    store.beginAction(task.id, 'call-1', 'computer_desktop_click', {})
    store.commitActionResult(task.id, 'call-1', desktopResponse())

    const swept = store.screenshots!.sweep(Date.now() + 60_000)
    expect(swept.removedFiles).toBe(1)

    const replay = store.beginAction(
      task.id,
      'call-1',
      'computer_desktop_click',
      {},
    )
    expect(replay.kind).toBe('replay')
    const outcome = (replay as { result: { outcome: Record<string, unknown> } })
      .result.outcome
    const screenshot = (outcome.result as Record<string, unknown>)
      .screenshot as Record<string, unknown>

    expect(screenshot.screenshotUnavailable).toBe(true)
    expect(screenshot.base64).toBeUndefined()
    // The action itself still replayed: the picture expired, the record did not.
    expect(outcome.ok).toBe(true)
    expect((outcome.result as Record<string, unknown>).action).toBe('click')
    expect(screenshot.capturedAt).toBe('2026-08-25T00:00:00.000Z')

    // The transcript frame degrades the same way rather than showing a broken image.
    const frame = (
      store.eventsAfter(task.id, 0)[0]!.payload as {
        frame: Record<string, unknown>
      }
    ).frame
    expect(frame.dataUrl).toBeUndefined()
    expect(frame.screenshotUnavailable).toBe(true)
    expect(frame.width).toBe(1920)

    store.close()
  })

  test('externalizing a screenshot does not weaken exactly-once', () => {
    const paths = workspace()
    const store = openStore(paths)
    const task = store.createTask(request())

    store.beginAction(task.id, 'call-1', 'computer_desktop_click', {})
    // A second begin while the first is still in flight must still refuse.
    expect(() =>
      store.beginAction(task.id, 'call-1', 'computer_desktop_click', {}),
    ).toThrow(AmbiguousActionError)

    store.commitActionResult(task.id, 'call-1', desktopResponse())
    // And a committed action can never be carried out a second time.
    expect(() =>
      store.commitActionResult(task.id, 'call-1', desktopResponse()),
    ).toThrow()
    expect(
      store.beginAction(task.id, 'call-1', 'computer_desktop_click', {}).kind,
    ).toBe('replay')

    store.close()
  })

  test('a ledger without a screenshot store behaves exactly as before', () => {
    const paths = workspace()
    const store = new TaskStore(paths.database)
    const task = store.createTask(request())
    store.beginAction(task.id, 'call-1', 'computer_desktop_click', {})
    store.commitActionResult(task.id, 'call-1', desktopResponse())

    const replay = store.beginAction(
      task.id,
      'call-1',
      'computer_desktop_click',
      {},
    )
    const outcome = (replay as { result: { outcome: Record<string, unknown> } })
      .result.outcome
    const screenshot = (outcome.result as Record<string, unknown>)
      .screenshot as Record<string, unknown>

    expect(screenshot.base64).toBe(BIG)
    expect(ledgerText(store)).toContain(BIG)
    store.close()
  })
})
