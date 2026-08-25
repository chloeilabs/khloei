import 'server-only'

import {
  recordComputerAuditEvent,
  type ComputerAuditEvent,
} from './audit'
import {
  createComputerTransport,
  NavigationRefusedError,
} from './client'
import { privateHostsAllowed } from './config'
import {
  COMPUTER_CONTRACT_FEATURES,
  COMPUTER_CONTRACT_VERSION,
  evaluateComputerContract,
  type ComputerSkew,
} from '@/shared/computer-contract'
import type {
  ControlState,
  SecretResult,
  TabsResult,
} from './schema'
import { checkNavigationTarget } from './target'

export type ComputerControlState = ControlState

type ViewerSession = {
  expiresAt: string
  token: string
}

function computerConfiguration() {
  const baseUrl =
    process.env.KHLOEI_COMPUTER_URL?.trim() ||
    process.env.AGENT_COMPUTER_URL?.trim() ||
    'http://127.0.0.1:4100'
  const publicUrl =
    process.env.KHLOEI_COMPUTER_PUBLIC_URL?.trim() || baseUrl
  const token = process.env.COMPUTER_TOKEN?.trim()
  if (!token) throw new Error('COMPUTER_TOKEN is not configured on the server.')

  return {
    allowPrivateHosts: privateHostsAllowed(),
    baseUrl,
    botId:
      process.env.KHLOEI_COMPUTER_BOT_ID?.trim() ||
      process.env.KHLOEI_COMPUTER_ID?.trim() ||
      'khloei',
    publicUrl,
    token,
  }
}

function streamUrl(publicUrl: string, botId: string, viewer: string) {
  const url = new URL('/stream', publicUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw new Error('KHLOEI_COMPUTER_PUBLIC_URL must use http or https.')
  url.searchParams.set('bot', botId)
  url.searchParams.set('viewer', viewer)
  return url.toString()
}

function surfaceTransport() {
  const configuration = computerConfiguration()
  const transport = createComputerTransport({
    allowPrivateHosts: configuration.allowPrivateHosts,
    token: configuration.token,
  })
  return { configuration, transport }
}

async function recordSurfaceEvent(
  configuration: ReturnType<typeof computerConfiguration>,
  input: {
    action: string
    eventType: ComputerAuditEvent['eventType']
    outcome?: Record<string, unknown>
    target?: Record<string, unknown>
  },
) {
  return recordComputerAuditEvent({
    action: input.action,
    actor: 'local-user',
    bot: configuration.botId,
    eventType: input.eventType,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    sessionId: `surface-${crypto.randomUUID()}`,
    target: input.target ?? { computer: configuration.botId },
  })
}

export type HumanTabAction =
  | { action: 'open' }
  | { action: 'activate' | 'close'; tabId: string }
  | { action: 'navigate'; url: string }

function navigationAddress(raw: string, allowPrivateHosts: boolean) {
  const value = raw.trim()
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`
  const verdict = checkNavigationTarget(candidate, { allowPrivateHosts })
  if (!verdict.allowed) throw new NavigationRefusedError(verdict.reason)
  return verdict.url
}

export async function changeComputerTab(input: HumanTabAction) {
  const { configuration, transport } = surfaceTransport()
  const path = `/human/tabs/${input.action}`
  const body =
    input.action === 'navigate'
      ? {
          url: navigationAddress(
            input.url,
            configuration.allowPrivateHosts,
          ),
        }
      : input.action === 'activate' || input.action === 'close'
        ? { tabId: input.tabId }
        : {}
  return transport.post<TabsResult>(
    configuration.baseUrl,
    configuration.botId,
    path,
    body,
  )
}

export async function createComputerViewerSession(origin: string) {
  const { configuration, transport } = surfaceTransport()
  const session = await transport.post<ViewerSession>(
    configuration.baseUrl,
    configuration.botId,
    '/viewer/session',
    { origin },
  )
  return {
    expiresAt: session.expiresAt,
    streamUrl: streamUrl(
      configuration.publicUrl,
      configuration.botId,
      session.token,
    ),
  }
}

export async function getComputerControl() {
  const { configuration, transport } = surfaceTransport()
  return transport.call<ComputerControlState>(
    configuration.baseUrl,
    configuration.botId,
    '/control',
  )
}

export async function setComputerControl(action: 'release' | 'take') {
  const { configuration, transport } = surfaceTransport()
  const state = await transport.post<ComputerControlState>(
    configuration.baseUrl,
    configuration.botId,
    `/control/${action}`,
    {},
  )
  await recordSurfaceEvent(configuration, {
    action: action === 'take' ? 'computer_take_control' : 'computer_release_control',
    eventType:
      action === 'take'
        ? 'computer.control_taken'
        : 'computer.control_released',
    outcome: {
      holder: state.holder,
      ...(state.reason ? { reason: state.reason } : {}),
    },
  })
  return state
}

export async function supplyComputerSecret(text: string) {
  const { configuration, transport } = surfaceTransport()
  const result = await transport.post<SecretResult>(
    configuration.baseUrl,
    configuration.botId,
    '/human/secret',
    { text },
  )
  await recordSurfaceEvent(configuration, {
    action: 'computer_supply_secret',
    eventType: 'computer.secret_supplied',
    outcome: { characters: result.characters, supplied: result.supplied },
  })
  return result
}

export type ComputerDeploymentStatus = {
  app: { contractVersion: number; features: string[] }
  computer:
    | {
        capabilities?: unknown
        contract?: unknown
        desktop?: unknown
        reachable: true
        status?: unknown
        surface?: unknown
      }
    | { error: string; reachable: false }
  skew: ComputerSkew
}

/**
 * Report what this app build expects against what the running computer answers.
 *
 * `/health` is deliberately the source: it is the one unauthenticated path, it
 * names no Bot and touches no browser, so a parity check cannot itself become a
 * way to reach into a computer. An unreachable computer is reported as such
 * rather than thrown, because "cannot tell" and "mismatched" are different
 * operational states and collapsing them hides one of them.
 */
export async function getComputerDeploymentStatus(
  signal?: AbortSignal,
): Promise<ComputerDeploymentStatus> {
  const app = {
    contractVersion: COMPUTER_CONTRACT_VERSION,
    features: [...COMPUTER_CONTRACT_FEATURES],
  }
  const { baseUrl } = computerConfiguration()

  let health: unknown
  try {
    const response = await fetch(new URL('/health', baseUrl), {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(10_000),
    })
    health = await response.json()
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'The computer is unreachable.'
    return {
      app,
      computer: { error: detail, reachable: false },
      skew: {
        compatible: false,
        detail: `The computer could not be reached, so deployment parity is unknown: ${detail}`,
        expectedVersion: COMPUTER_CONTRACT_VERSION,
        missingFeatures: [],
        reportedVersion: null,
        severity: 'unknown',
      },
    }
  }

  const record =
    typeof health === 'object' && health !== null && !Array.isArray(health)
      ? (health as Record<string, unknown>)
      : {}
  return {
    app,
    computer: {
      capabilities: record.capabilities,
      contract: record.contract,
      desktop: record.desktop,
      reachable: true,
      status: record.status,
      surface: record.surface,
    },
    skew: evaluateComputerContract(health),
  }
}

export function appRequestOrigin(request: Request) {
  const origin = request.headers.get('origin')
  return origin ?? new URL(request.url).origin
}
