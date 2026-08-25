import { describe, expect, test } from 'bun:test'

import {
  COMPUTER_CONTRACT_FEATURES,
  COMPUTER_CONTRACT_VERSION,
  evaluateComputerContract,
  MINIMUM_COMPUTER_CONTRACT_VERSION,
} from '../../../shared/computer-contract'

/** What a computer image of a given contract version answers on /health. */
function health(version: number, features: string[] = []) {
  return {
    capabilities: { shell: true },
    contract: { features, version },
    status: 'ok',
    surface: 'desktop',
  }
}

describe('computer deployment parity', () => {
  test('reports an aligned deployment as compatible', () => {
    const skew = evaluateComputerContract(
      health(COMPUTER_CONTRACT_VERSION, [...COMPUTER_CONTRACT_FEATURES]),
    )

    expect(skew.severity).toBe('aligned')
    expect(skew.compatible).toBe(true)
    expect(skew.missingFeatures).toEqual([])
    expect(skew.reportedVersion).toBe(COMPUTER_CONTRACT_VERSION)
    expect(skew.expectedVersion).toBe(COMPUTER_CONTRACT_VERSION)
  })

  test('names what is missing when the computer image is behind', () => {
    const skew = evaluateComputerContract(health(1), 2)

    expect(skew.severity).toBe('computer-behind')
    expect(skew.reportedVersion).toBe(1)
    // The operator is told which capabilities will refuse, not just that two
    // numbers differ.
    expect(skew.missingFeatures).toContain('desktop-visual')
    expect(skew.missingFeatures).toContain('desktop-shell')
    expect(skew.missingFeatures).toContain('screenshot-mime')
    expect(skew.missingFeatures).not.toContain('browser-refs')
    expect(skew.detail).toContain('Rebuild the computer image')
    // Contract 1 is still drivable, so this is visible without being fatal.
    expect(skew.compatible).toBe(true)
  })

  test('treats a missing contract as unknown rather than assuming it is fine', () => {
    // Exactly what an image built before full-desktop vision answers: a healthy
    // looking body with no contract field at all.
    const skew = evaluateComputerContract({
      browser: false,
      computerSessionId: 'computer_deadbeefdeadbeefdeadbeefdeadbeef',
      status: 'ok',
    })

    expect(skew.severity).toBe('unknown')
    expect(skew.compatible).toBe(false)
    expect(skew.reportedVersion).toBeNull()
    expect(skew.detail).toContain('did not report a contract version')
  })

  test('still drives a computer at the current minimum contract', () => {
    // Contract 1 is behind, but every capability it lacks refuses rather than
    // acting wrongly, so it stays usable and merely visible.
    const skew = evaluateComputerContract(
      health(MINIMUM_COMPUTER_CONTRACT_VERSION),
      MINIMUM_COMPUTER_CONTRACT_VERSION + 5,
    )

    expect(skew.severity).toBe('computer-behind')
    expect(skew.compatible).toBe(true)
  })

  test('refuses a computer below the minimum this build supports', () => {
    // What happens once a future release drops an old contract entirely.
    const skew = evaluateComputerContract(health(1), 3, 2)

    expect(skew.severity).toBe('unsupported')
    expect(skew.compatible).toBe(false)
    expect(skew.detail).toContain('below the minimum 2')
  })

  test('flags a computer newer than the app without breaking it', () => {
    const skew = evaluateComputerContract(
      health(COMPUTER_CONTRACT_VERSION + 1),
      COMPUTER_CONTRACT_VERSION,
    )

    expect(skew.severity).toBe('computer-ahead')
    expect(skew.compatible).toBe(true)
    expect(skew.detail).toContain('redeploy the app')
  })

  test('rejects contract shapes that are not real versions', () => {
    for (const body of [
      null,
      'ok',
      [],
      { contract: { version: 0 } },
      { contract: { version: -3 } },
      { contract: { version: 1.5 } },
      { contract: { version: '2' } },
      { contract: null },
    ]) {
      const skew = evaluateComputerContract(body)
      expect(skew.severity).toBe('unknown')
      expect(skew.reportedVersion).toBeNull()
    }
  })

  test('accepts a bare contract body as well as a nested one', () => {
    const nested = evaluateComputerContract({
      contract: { features: [], version: COMPUTER_CONTRACT_VERSION },
    })
    const bare = evaluateComputerContract({
      features: [],
      version: COMPUTER_CONTRACT_VERSION,
    })

    expect(nested.severity).toBe('aligned')
    expect(bare.severity).toBe('aligned')
  })
})
