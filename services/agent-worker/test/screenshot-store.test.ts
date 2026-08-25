import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  budgetForVolume,
  createScreenshotStore,
  parseScreenshotReference,
} from '../src/screenshot-store'

const temporaryDirectories: string[] = []

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'khloei-screenshots-'))
  temporaryDirectories.push(path)
  return path
}

/** Deterministic bytes big enough to look like a real frame. */
function frame(seed: string, size = 8_192) {
  const bytes = Buffer.alloc(size)
  const source = Buffer.from(seed)
  for (let index = 0; index < size; index += 1) {
    bytes[index] = source[index % source.length]!
  }
  return bytes.toString('base64')
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true })
  }
})

describe('screenshot blob store', () => {
  test('names a blob by the hash of its content and reads it back exactly', () => {
    const store = createScreenshotStore({ directory: directory() })
    const base64 = frame('desktop')
    const stored = store.put(base64, 'image/jpeg')

    expect(stored).not.toBeNull()
    const digest = createHash('sha256')
      .update(Buffer.from(base64, 'base64'))
      .digest('hex')
    expect(stored!.reference).toBe(`sha256-${digest}.jpg`)
    expect(stored!.mimeType).toBe('image/jpeg')
    expect(store.get(stored!.reference)).toEqual({
      base64,
      mimeType: 'image/jpeg',
    })
  })

  test('stores one copy of a repeated identical frame', () => {
    const path = directory()
    const store = createScreenshotStore({ directory: path })
    const base64 = frame('unchanged-desktop')

    const first = store.put(base64, 'image/jpeg')
    const second = store.put(base64, 'image/jpeg')

    expect(first!.reference).toBe(second!.reference)
    expect(store.stats().files).toBe(1)
    expect(store.stats().totalBytes).toBe(first!.bytes)
    expect(readdirSync(path)).toHaveLength(1)
  })

  test('refuses a type that is not an image it can name', () => {
    const store = createScreenshotStore({ directory: directory() })
    expect(store.put(frame('x'), 'text/html')).toBeNull()
    expect(store.put(frame('x'), 'application/octet-stream')).toBeNull()
    expect(store.stats().files).toBe(0)
  })

  test('never lets a reference name a path of its own choosing', () => {
    const root = directory()
    const store = createScreenshotStore({ directory: root })
    writeFileSync(join(root, 'secret.txt'), 'do not read me')

    for (const attempt of [
      '../secret.txt',
      '../../etc/passwd',
      'sha256-../../secret.txt.jpg',
      'sha256-not-hex.jpg',
      `sha256-${'a'.repeat(64)}.exe`,
      '/etc/passwd',
    ]) {
      expect(parseScreenshotReference(attempt)).toBeNull()
      expect(store.get(attempt)).toBeNull()
    }
  })

  test('sweeps blobs past their retention age', () => {
    let now = 1_000_000
    const store = createScreenshotStore({
      directory: directory(),
      maxAgeMs: 1_000,
      now: () => now,
    })
    const old = store.put(frame('old'), 'image/jpeg')!
    now += 5_000
    const fresh = store.put(frame('fresh'), 'image/jpeg')!

    const swept = store.sweep(now)

    expect(swept.removedFiles).toBe(1)
    expect(swept.removedBytes).toBe(old.bytes)
    expect(store.get(old.reference)).toBeNull()
    expect(store.get(fresh.reference)).not.toBeNull()
  })

  test('evicts oldest first when the volume budget is exceeded', () => {
    let now = 1_000_000
    const store = createScreenshotStore({
      directory: directory(),
      maxAgeMs: 0,
      maxTotalBytes: 20_000,
      now: () => now,
    })
    const first = store.put(frame('first'), 'image/jpeg')!
    now += 1_000
    const second = store.put(frame('second'), 'image/jpeg')!
    now += 1_000
    const third = store.put(frame('third'), 'image/jpeg')!

    expect(store.stats().totalBytes).toBeGreaterThan(20_000)
    const swept = store.sweep(now)

    expect(swept.totalBytes).toBeLessThanOrEqual(20_000)
    expect(store.get(first.reference)).toBeNull()
    expect(store.get(second.reference)).not.toBeNull()
    expect(store.get(third.reference)).not.toBeNull()
  })

  test('re-storing a frame keeps it out of the next age sweep', () => {
    let now = 1_000_000
    const store = createScreenshotStore({
      directory: directory(),
      maxAgeMs: 1_000,
      now: () => now,
    })
    const base64 = frame('still-on-screen')
    const stored = store.put(base64, 'image/jpeg')!

    now += 5_000
    // The model observes the same unchanged desktop again.
    store.put(base64, 'image/jpeg')
    store.sweep(now)

    expect(store.get(stored.reference)).not.toBeNull()
  })

  test('never lets screenshots claim a volume out from under the database', () => {
    // The production worker mounts a 500 MB volume while the shipped default
    // budget is 512 MiB, so an unclamped store could fill the disk the task
    // ledger depends on.
    const path = directory()
    const volume = budgetForVolume(Number.MAX_SAFE_INTEGER, path)

    expect(volume.volumeBytes).toBeGreaterThan(0)
    expect(volume.clampedFrom).toBe(Number.MAX_SAFE_INTEGER)
    expect(volume.bytes).toBeLessThanOrEqual(volume.volumeBytes! / 2)

    // A store built with that budget holds the clamped value, not the request.
    const store = createScreenshotStore({
      directory: path,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    })
    expect(store.stats().maxTotalBytes).toBe(volume.bytes)
  })

  test('leaves a budget the volume can afford untouched', () => {
    const path = directory()
    const modest = budgetForVolume(1_024, path)

    expect(modest.bytes).toBe(1_024)
    expect(modest.clampedFrom).toBeNull()
    expect(createScreenshotStore({ directory: path, maxTotalBytes: 1_024 }).stats()
      .maxTotalBytes).toBe(1_024)
  })

  test('keeps the configured budget when the volume cannot be measured', () => {
    const missing = budgetForVolume(4_096, '/khloei-no-such-volume-8f3a2b')

    expect(missing.bytes).toBe(4_096)
    expect(missing.clampedFrom).toBeNull()
    expect(missing.volumeBytes).toBeNull()
  })

  test('reports the budget it is holding against', () => {
    const store = createScreenshotStore({
      directory: directory(),
      maxAgeMs: 60_000,
      maxTotalBytes: 99_999,
    })
    store.put(frame('one'), 'image/png')

    const stats = store.stats()
    expect(stats.files).toBe(1)
    expect(stats.maxTotalBytes).toBe(99_999)
    expect(stats.maxAgeMs).toBe(60_000)
    expect(stats.totalBytes).toBeGreaterThan(0)
  })
})
