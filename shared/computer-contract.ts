/**
 * The agreement between Khloei's app and the computer image it drives.
 *
 * The app, the durable worker and the computer service deploy separately: the
 * app ships on every push, while the computer is a pinned container image an
 * operator rebuilds. Nothing previously made that gap observable, so an app
 * built against a newer computer would call an endpoint the running image did
 * not have and read a field it did not set, and the only symptom was degraded
 * behaviour somewhere far from the cause.
 *
 * This module is the single place that names the current contract. Each side
 * reports the version it was built with, and the difference is surfaced in
 * health and status rather than absorbed silently.
 *
 * Bump `COMPUTER_CONTRACT_VERSION` when the computer service gains or changes a
 * capability the app depends on, and add the capability to
 * `COMPUTER_CONTRACT_FEATURES` so a skew report can say what is actually
 * missing rather than only that two numbers differ.
 */

/**
 * Version history:
 *   1 - browser surface: navigate, snapshot, refs, files, screenshots as PNG
 *   2 - full Linux desktop: /desktop/action, JPEG screenshots with mimeType,
 *       the governed command runner, and the surface message on the viewer socket
 */
export const COMPUTER_CONTRACT_VERSION = 2

/**
 * The lowest computer contract this app build can still drive.
 *
 * Version 1 remains usable because every desktop capability degrades to a clear
 * refusal rather than a wrong action: the gateway rejects a screenshot that is
 * not the desktop, and `/desktop/action` answers 404 on an older image.
 */
export const MINIMUM_COMPUTER_CONTRACT_VERSION = 1

export const COMPUTER_CONTRACT_FEATURES = [
  'browser-refs',
  'workspace-files',
  'desktop-visual',
  'desktop-shell',
  'screenshot-mime',
] as const

export type ComputerContractFeature = (typeof COMPUTER_CONTRACT_FEATURES)[number]

/** Which features arrived in which contract version. */
const FEATURE_VERSIONS: Record<ComputerContractFeature, number> = {
  'browser-refs': 1,
  'workspace-files': 1,
  'desktop-visual': 2,
  'desktop-shell': 2,
  'screenshot-mime': 2,
}

export type ComputerContractReport = {
  features: string[]
  version: number
}

export type ComputerSkewSeverity =
  | 'aligned'
  | 'computer-ahead'
  | 'computer-behind'
  | 'unknown'
  | 'unsupported'

export type ComputerSkew = {
  /** Whether this app build can drive the reported computer at all. */
  compatible: boolean
  detail: string
  expectedVersion: number
  /** Features this app build expects that the reported computer does not have. */
  missingFeatures: ComputerContractFeature[]
  reportedVersion: number | null
  severity: ComputerSkewSeverity
}

function reportedContract(value: unknown): ComputerContractReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const contract = (value as Record<string, unknown>).contract
  const source =
    typeof contract === 'object' && contract !== null && !Array.isArray(contract)
      ? (contract as Record<string, unknown>)
      : (value as Record<string, unknown>)
  const version = source.version
  if (!Number.isSafeInteger(version) || (version as number) < 1) return null
  const features = Array.isArray(source.features)
    ? source.features.filter((name): name is string => typeof name === 'string')
    : []
  return { features, version: version as number }
}

/**
 * Compare a computer's reported contract against the one this build expects.
 *
 * An absent or unparseable report is deliberately not treated as "probably
 * fine". A computer image old enough to omit the field is exactly the image
 * most likely to be missing something, so it is reported as `unknown` and left
 * for an operator to look at.
 */
export function evaluateComputerContract(
  health: unknown,
  expectedVersion: number = COMPUTER_CONTRACT_VERSION,
  minimumVersion: number = MINIMUM_COMPUTER_CONTRACT_VERSION,
): ComputerSkew {
  const report = reportedContract(health)

  if (!report) {
    return {
      compatible: false,
      detail:
        'The computer did not report a contract version. It is running an image older than full-desktop vision, or it is not a Khloei computer. Rebuild and redeploy the computer image.',
      expectedVersion,
      missingFeatures: [...COMPUTER_CONTRACT_FEATURES].filter(
        (feature) => FEATURE_VERSIONS[feature] > minimumVersion,
      ),
      reportedVersion: null,
      severity: 'unknown',
    }
  }

  const missingFeatures = [...COMPUTER_CONTRACT_FEATURES].filter(
    (feature) =>
      FEATURE_VERSIONS[feature] <= expectedVersion &&
      FEATURE_VERSIONS[feature] > report.version,
  )

  if (report.version === expectedVersion) {
    return {
      compatible: true,
      detail: `The computer implements contract ${report.version}, which is what this build expects.`,
      expectedVersion,
      missingFeatures: [],
      reportedVersion: report.version,
      severity: 'aligned',
    }
  }

  if (report.version > expectedVersion) {
    return {
      compatible: true,
      detail: `The computer implements contract ${report.version} while this build expects ${expectedVersion}. The computer image is newer than the app; redeploy the app to use what it added.`,
      expectedVersion,
      missingFeatures: [],
      reportedVersion: report.version,
      severity: 'computer-ahead',
    }
  }

  const supported = report.version >= minimumVersion
  return {
    compatible: supported,
    detail: supported
      ? `The computer implements contract ${report.version} while this build expects ${expectedVersion}. Rebuild the computer image; until then ${
          missingFeatures.length > 0
            ? missingFeatures.join(', ')
            : 'the newer capabilities'
        } will refuse rather than work.`
      : `The computer implements contract ${report.version}, below the minimum ${minimumVersion} this build supports. Rebuild the computer image before using Computer Use.`,
    expectedVersion,
    missingFeatures,
    reportedVersion: report.version,
    severity: supported ? 'computer-behind' : 'unsupported',
  }
}
