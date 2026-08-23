import 'server-only'

import {
  createComputerTransport,
  StaleSnapshotError,
  type ComputerTransport,
} from './client'
import {
  evaluateActionPolicy,
  type ActionPolicy,
  type PolicyContext,
  type PolicyDecision,
} from './policy'
import type {
  ActionResult,
  ClickInput,
  CloseTabInput,
  ControlState,
  KeyInput,
  ListFilesInput,
  ListFilesResult,
  NavigateInput,
  NavigateResult,
  OpenTabInput,
  ReadFileInput,
  ReadFileResult,
  ReadResult,
  ScreenshotResult,
  ScrollInput,
  SecretRequest,
  SnapshotElement,
  SnapshotResult,
  SwitchTabInput,
  TabsResult,
  TypeInput,
  WriteFileInput,
  WriteFileResult,
} from './schema'
import {
  recordComputerAuditEvent,
  type ComputerAuditDecision,
} from './audit'

export class ActionRefusedError extends Error {
  readonly rule: string | null

  constructor(reason: string, rule: string | null) {
    super(reason)
    this.name = 'ActionRefusedError'
    this.rule = rule
  }
}

export type ComputerProgressStage =
  | 'deciding'
  | 'approved'
  | 'refused'
  | 'completed'
  | 'failed'

export type ComputerGatewayProgress = {
  action: string
  activityId: string
  auditEventId?: string
  decision?: ComputerAuditDecision
  detail?: string
  stage: ComputerProgressStage
  target?: string
}

type GatewayOptions = {
  initialState?: ComputerGatewayState
  onProgress?: (progress: ComputerGatewayProgress) => void
  sessionId: string
  signal?: AbortSignal
}

export type ComputerGatewayState = {
  currentPageUrl: string
  snapshot?: SnapshotResult
}

type GovernedSubject = {
  filePath?: string
  key?: string
  ref?: string
  snapshotId?: number
  tabId?: string
  targetUrl?: string
}

const DEFAULT_POLICY: ActionPolicy = {
  mode: 'enforce',
  // The vendored computer can run commands when it is containerized. Khloei's
  // local integration deliberately does not publish that tool because the
  // service may be running directly on a developer machine.
  deny: ['intent:run_command'],
  allow: ['*'],
}

const ACTIVATING_KEYS = new Set(['Enter', 'NumpadEnter', 'Space', ' '])
const HUMAN_ASSISTANCE_WAIT_MS = 10 * 60_000
const HUMAN_ASSISTANCE_POLL_MS = 1_000

function configuredPolicy(): ActionPolicy {
  const raw = process.env.KHLOEI_COMPUTER_POLICY?.trim()
  if (!raw) return DEFAULT_POLICY

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('KHLOEI_COMPUTER_POLICY must be valid JSON.')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('KHLOEI_COMPUTER_POLICY must be an object.')
  }
  const policy = value as Record<string, unknown>
  if (policy.mode !== 'enforce' && policy.mode !== 'dry-run') {
    throw new Error(
      'KHLOEI_COMPUTER_POLICY.mode must be "enforce" or "dry-run".',
    )
  }
  if (
    !Array.isArray(policy.deny) ||
    !policy.deny.every((item) => typeof item === 'string') ||
    !Array.isArray(policy.allow) ||
    !policy.allow.every((item) => typeof item === 'string')
  ) {
    throw new Error(
      'KHLOEI_COMPUTER_POLICY allow and deny must be arrays of policy rules.',
    )
  }

  return {
    mode: policy.mode,
    deny: policy.deny as string[],
    allow: policy.allow as string[],
  }
}

function hostOf(value: string) {
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}

function auditUrl(value: unknown) {
  if (typeof value !== 'string') return value
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value.split(/[?#]/, 1)[0]
  }
}

function describeFile(path: string) {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return {
    path,
    name,
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
  }
}

function intentOf(
  action: string,
  key: string | undefined,
): PolicyContext['intent'] {
  switch (action) {
    case 'computer_click':
      return 'activate'
    case 'computer_key':
    case 'computer_type':
      return key && ACTIVATING_KEYS.has(key) ? 'activate' : 'type'
    case 'computer_navigate':
    case 'computer_open_tab':
      return 'navigate'
    case 'computer_switch_tab':
    case 'computer_close_tab':
      return 'activate'
    case 'computer_read':
    case 'computer_list_tabs':
    case 'computer_snapshot':
    case 'computer_scroll':
      return 'read'
    case 'computer_read_file':
      return 'read_file'
    case 'computer_write_file':
      return 'write_file'
    case 'computer_list_files':
      return 'list_files'
    case 'computer_run_command':
      return 'run_command'
    default:
      return undefined
  }
}

function auditDecision(decision: PolicyDecision): ComputerAuditDecision {
  return {
    allowed: decision.allowed,
    carriedOut: decision.forward,
    mode: decision.mode,
    reason: decision.reason,
    rule: decision.matched,
    source: decision.source,
  }
}

function targetLabel(
  action: string,
  subject: GovernedSubject,
  element: SnapshotElement | undefined,
) {
  if (subject.filePath) return subject.filePath
  if (subject.targetUrl) return hostOf(subject.targetUrl) || subject.targetUrl
  if (subject.tabId) return subject.tabId
  if (element?.name) return element.name
  if (subject.key) return subject.key
  return action.replace(/^computer_/, '').replaceAll('_', ' ')
}

function auditTarget(
  pageUrl: string,
  subject: GovernedSubject,
  element: SnapshotElement | undefined,
) {
  return {
    page: auditUrl(pageUrl),
    ref: subject.ref ?? null,
    ...(subject.filePath ? { file: subject.filePath } : {}),
    ...(subject.key ? { key: subject.key } : {}),
    ...(subject.tabId ? { tab: subject.tabId } : {}),
    ...(element
      ? {
          element: {
            name: element.name,
            role: element.role,
            ...(element.type ? { type: element.type } : {}),
          },
        }
      : {}),
  }
}

function safeOutcome(action: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  const result = value as Record<string, unknown>

  if (action === 'computer_navigate' || action === 'computer_read') {
    return {
      url: auditUrl(result.url),
      title: result.title,
      truncated: result.truncated,
      ...(typeof result.elapsedMs === 'number'
        ? { elapsedMs: result.elapsedMs }
        : {}),
    }
  }
  if (action === 'computer_snapshot') {
    return {
      url: auditUrl(result.url),
      title: result.title,
      snapshotId: result.snapshotId,
      elements: Array.isArray(result.elements) ? result.elements.length : 0,
      truncated: result.truncated,
    }
  }
  if (
    action === 'computer_list_tabs' ||
    action === 'computer_open_tab' ||
    action === 'computer_switch_tab' ||
    action === 'computer_close_tab'
  ) {
    const tabs = Array.isArray(result.tabs)
      ? (result.tabs as Array<Record<string, unknown>>)
      : []
    const active = tabs.find((tab) => tab.id === result.activeTabId)
    return {
      activeTabId: result.activeTabId,
      tabs: tabs.length,
      url: auditUrl(active?.url),
    }
  }
  if (action === 'computer_list_files') {
    return {
      path: result.path,
      entries: Array.isArray(result.entries) ? result.entries.length : 0,
      truncated: result.truncated,
    }
  }
  if (action === 'computer_read_file') {
    return {
      path: result.path,
      bytes: result.bytes,
      truncated: result.truncated,
    }
  }
  if (action === 'computer_write_file') {
    return {
      path: result.path,
      bytes: result.bytes,
      appended: result.appended,
    }
  }
  return Object.fromEntries(
    ['action', 'url', 'elapsedMs', 'characters', 'submitted', 'key', 'deltaY']
      .filter((key) => result[key] !== undefined)
      .map((key) => [key, key === 'url' ? auditUrl(result[key]) : result[key]]),
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The computer action failed.'
}

function safeErrorMessage(error: unknown) {
  return errorMessage(error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => String(auditUrl(value)))
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 2_000)
}

export function createKhloeiComputerGateway(options: GatewayOptions) {
  const baseUrl =
    process.env.KHLOEI_COMPUTER_URL?.trim() ||
    process.env.AGENT_COMPUTER_URL?.trim() ||
    'http://127.0.0.1:4100'
  const token = process.env.COMPUTER_TOKEN?.trim()
  if (!token) {
    throw new Error('COMPUTER_TOKEN is not configured on the server.')
  }

  const botId =
    process.env.KHLOEI_COMPUTER_BOT_ID?.trim() ||
    process.env.KHLOEI_COMPUTER_ID?.trim() ||
    'khloei'
  const actor = 'local-user'
  const policy = configuredPolicy()
  const transport: ComputerTransport = createComputerTransport({
    token,
    allowPrivateHosts:
      process.env.KHLOEI_COMPUTER_ALLOW_PRIVATE_HOSTS === 'true',
  })
  let currentPageUrl = options.initialState?.currentPageUrl ?? ''
  let snapshot = options.initialState?.snapshot
  if (
    snapshot &&
    (typeof snapshot.computerSessionId !== 'string' ||
      !snapshot.computerSessionId)
  ) {
    snapshot = undefined
  }

  const progress = (event: ComputerGatewayProgress) => {
    try {
      options.onProgress?.(event)
    } catch {
      // Rendering progress is observational. It must not change whether an
      // already-audited action is carried out.
    }
  }

  function resolveElement(subject: GovernedSubject) {
    if (!subject.ref || !snapshot) return undefined
    if (snapshot.snapshotId !== subject.snapshotId) return undefined
    return snapshot.elements.find((element) => element.ref === subject.ref)
  }

  async function govern<T>(
    activityId: string,
    action: string,
    subject: GovernedSubject,
    run: () => Promise<T>,
  ): Promise<T> {
    const element = resolveElement(subject)
    const pageUrl = subject.targetUrl ?? currentPageUrl
    const target = targetLabel(action, subject, element)
    progress({ action, activityId, stage: 'deciding', target })

    const intent = intentOf(action, subject.key)
    const context: PolicyContext = {
      tool: { name: action },
      bot: { id: botId },
      actor: { id: actor },
      page: { url: pageUrl, host: hostOf(pageUrl) },
      ...(intent ? { intent } : {}),
      key: subject.key ?? '',
      element: element
        ? {
            ref: element.ref,
            role: element.role,
            name: element.name,
            type: element.type ?? '',
          }
        : { ref: '', role: '', name: '', type: '' },
      file: subject.filePath
        ? describeFile(subject.filePath)
        : { path: '', name: '', extension: '' },
      command: '',
    }
    const decision = evaluateActionPolicy(policy, context)
    const recordedDecision = auditDecision(decision)
    const targetRecord = auditTarget(pageUrl, subject, element)
    const decisionEvent = await recordComputerAuditEvent({
      action,
      actor,
      bot: botId,
      decision: recordedDecision,
      eventType: 'computer.action_decided',
      sessionId: options.sessionId,
      target: targetRecord,
    })

    progress({
      action,
      activityId,
      auditEventId: decisionEvent.id,
      decision: recordedDecision,
      stage: decision.forward ? 'approved' : 'refused',
      target,
    })
    if (!decision.forward) {
      throw new ActionRefusedError(decision.reason, decision.matched)
    }

    try {
      if (subject.ref && snapshot && !element) {
        throw new StaleSnapshotError(
          `${subject.ref} is not on the page this computer is showing, so nothing can be checked against it before acting. Take a fresh snapshot and use the refs it returns.`,
        )
      }
      const result = await run()
      const completedEvent = await recordComputerAuditEvent({
        action,
        actor,
        bot: botId,
        decision: recordedDecision,
        eventType: 'computer.action_completed',
        outcome: safeOutcome(action, result),
        sessionId: options.sessionId,
        target: targetRecord,
      })
      progress({
        action,
        activityId,
        auditEventId: completedEvent.id,
        decision: recordedDecision,
        stage: 'completed',
        target,
      })
      return element && result && typeof result === 'object'
        ? ({
            ...result,
            element: { name: element.name, role: element.role },
          } as T)
        : result
    } catch (error) {
      const detail = safeErrorMessage(error)
      const failedEvent = await recordComputerAuditEvent({
        action,
        actor,
        bot: botId,
        decision: recordedDecision,
        eventType: 'computer.action_failed',
        outcome: { error: detail },
        sessionId: options.sessionId,
        target: targetRecord,
      })
      progress({
        action,
        activityId,
        auditEventId: failedEvent.id,
        decision: recordedDecision,
        detail,
        stage: 'failed',
        target,
      })
      throw new Error(detail, { cause: error })
    }
  }

  const call = <T>(path: string) =>
    transport.call<T>(baseUrl, botId, path, undefined, options.signal)
  const post = <T>(path: string, body: unknown) =>
    transport.post<T>(baseUrl, botId, path, body, options.signal)

  const withSnapshotSession = <T extends object>(input: T) =>
    snapshot?.computerSessionId
      ? { ...input, computerSessionId: snapshot.computerSessionId }
      : input

  async function waitForPerson(
    done: (state: ControlState) => boolean,
  ): Promise<'answered' | 'cancelled' | 'gave_up'> {
    const deadline = Date.now() + HUMAN_ASSISTANCE_WAIT_MS
    while (Date.now() < deadline) {
      if (options.signal?.aborted) return 'cancelled'
      const state = await call<ControlState>('/control').catch(() => null)
      if (state && done(state)) return 'answered'
      await new Promise((resolve) =>
        setTimeout(resolve, HUMAN_ASSISTANCE_POLL_MS),
      )
    }
    return 'gave_up'
  }

  const beginHelp = async (reason: string, activityId: string) => {
    const state = await post<ControlState>('/control/request', { reason })
    const event = await recordComputerAuditEvent({
      action: 'computer_request_help',
      actor,
      bot: botId,
      eventType: 'computer.help_requested',
      outcome: { requested: state.requested },
      sessionId: options.sessionId,
      target: { reason },
    })
    progress({
      action: 'computer_request_help',
      activityId,
      auditEventId: event.id,
      stage: 'approved',
      target: 'human assistance',
    })
    return state
  }

  const completeHelp = async (
    reason: string,
    activityId: string,
    assistance: 'answered' | 'cancelled' | 'gave_up',
  ) => {
    const event = await recordComputerAuditEvent({
      action: 'computer_request_help',
      actor,
      bot: botId,
      eventType: 'computer.help_completed',
      outcome: { assistance },
      sessionId: options.sessionId,
      target: { reason },
    })
    progress({
      action: 'computer_request_help',
      activityId,
      auditEventId: event.id,
      stage: 'completed',
      target: 'human assistance',
    })
    return {
      assistance,
      requested: assistance !== 'answered',
      message:
        assistance === 'answered'
          ? 'The person finished and handed control back. Take a fresh snapshot because the page may have changed.'
          : assistance === 'cancelled'
            ? 'The request was cancelled.'
            : 'Nobody took control. Explain what help is still needed instead of trying the blocked step yourself.',
    }
  }

  const beginSecret = async (input: SecretRequest, activityId: string) => {
    const state = await post<ControlState>('/control/secret', input)
    const event = await recordComputerAuditEvent({
      action: 'computer_request_secret',
      actor,
      bot: botId,
      eventType: 'computer.secret_requested',
      outcome: { requested: Boolean(state.secretWanted) },
      sessionId: options.sessionId,
      target: {
        label: input.label,
        ref: input.ref,
        snapshotId: input.snapshotId,
      },
    })
    progress({
      action: 'computer_request_secret',
      activityId,
      auditEventId: event.id,
      stage: 'approved',
      target: input.label,
    })
    return state
  }

  const completeSecret = async (
    input: SecretRequest,
    activityId: string,
    assistance: 'answered' | 'cancelled' | 'gave_up',
  ) => {
    const event = await recordComputerAuditEvent({
      action: 'computer_request_secret',
      actor,
      bot: botId,
      eventType: 'computer.secret_completed',
      outcome: { assistance },
      sessionId: options.sessionId,
      target: {
        label: input.label,
        ref: input.ref,
        snapshotId: input.snapshotId,
      },
    })
    progress({
      action: 'computer_request_secret',
      activityId,
      auditEventId: event.id,
      stage: 'completed',
      target: input.label,
    })
    return {
      assistance,
      requested: assistance !== 'answered',
      message:
        assistance === 'answered'
          ? `The person entered ${input.label} directly into the field without revealing it. Submit separately if needed.`
          : assistance === 'cancelled'
            ? 'The secret request was cancelled.'
            : `Nobody entered ${input.label}. Do not ask for the value another way.`,
    }
  }

  const cancelAssistance = async (
    action: 'computer_request_help' | 'computer_request_secret',
    activityId: string,
    target: string,
  ) => {
    const state = await post<ControlState>('/control/release', {})
    const event = await recordComputerAuditEvent({
      action,
      actor,
      bot: botId,
      eventType: 'computer.assistance_cancelled',
      outcome: { cancelled: true },
      sessionId: options.sessionId,
      target: { label: target },
    })
    progress({
      action,
      activityId,
      auditEventId: event.id,
      detail: 'The computer task was cancelled.',
      stage: 'failed',
      target,
    })
    return state
  }

  return {
    async navigate(input: NavigateInput, activityId: string) {
      const result = await govern<NavigateResult>(
        activityId,
        'computer_navigate',
        { targetUrl: input.url },
        () => transport.navigate(baseUrl, botId, input.url),
      )
      currentPageUrl = result.url
      snapshot = undefined
      return result
    },

    async read(activityId: string) {
      const result = await govern<ReadResult>(
        activityId,
        'computer_read',
        {},
        () => call<ReadResult>('/read'),
      )
      currentPageUrl = result.url
      return result
    },

    async snapshot(activityId: string) {
      const result = await govern<SnapshotResult>(
        activityId,
        'computer_snapshot',
        {},
        () => post<SnapshotResult>('/snapshot', {}),
      )
      currentPageUrl = result.url
      snapshot = result
      return result
    },

    async requestHelp(reason: string, activityId: string) {
      await beginHelp(reason, activityId)
      const assistance = await waitForPerson(
        (current) => current.holder === 'bot' && !current.requested,
      )
      return completeHelp(reason, activityId, assistance)
    },

    async requestSecret(input: SecretRequest, activityId: string) {
      await beginSecret(input, activityId)
      const assistance = await waitForPerson(
        (current) => current.secretWanted === undefined,
      )
      return completeSecret(input, activityId, assistance)
    },

    beginHelp,
    beginSecret,

    completeHelp,
    completeSecret,
    cancelAssistance,

    control() {
      return call<ControlState>('/control')
    },

    exportState(): ComputerGatewayState {
      return {
        currentPageUrl,
        ...(snapshot ? { snapshot } : {}),
      }
    },

    async listTabs(activityId: string) {
      const result = await govern<TabsResult>(
        activityId,
        'computer_list_tabs',
        {},
        () => call<TabsResult>('/tabs'),
      )
      currentPageUrl =
        result.tabs.find((tab) => tab.id === result.activeTabId)?.url ??
        currentPageUrl
      return result
    },

    async openTab(input: OpenTabInput, activityId: string) {
      const result = await govern<TabsResult>(
        activityId,
        'computer_open_tab',
        { targetUrl: input.url },
        () =>
          transport.openTab(
            baseUrl,
            botId,
            input.url,
            options.signal,
          ),
      )
      currentPageUrl =
        result.tabs.find((tab) => tab.id === result.activeTabId)?.url ??
        input.url
      snapshot = undefined
      return result
    },

    async switchTab(input: SwitchTabInput, activityId: string) {
      const result = await govern<TabsResult>(
        activityId,
        'computer_switch_tab',
        { tabId: input.tabId },
        () => post<TabsResult>('/tabs/activate', input),
      )
      currentPageUrl =
        result.tabs.find((tab) => tab.id === result.activeTabId)?.url ?? ''
      snapshot = undefined
      return result
    },

    async closeTab(input: CloseTabInput, activityId: string) {
      const result = await govern<TabsResult>(
        activityId,
        'computer_close_tab',
        { tabId: input.tabId },
        () => post<TabsResult>('/tabs/close', input),
      )
      currentPageUrl =
        result.tabs.find((tab) => tab.id === result.activeTabId)?.url ?? ''
      snapshot = undefined
      return result
    },

    async click(input: ClickInput, activityId: string) {
      const result = await govern<ActionResult>(
        activityId,
        'computer_click',
        input,
        () => post<ActionResult>('/click', withSnapshotSession(input)),
      )
      currentPageUrl = result.url
      snapshot = undefined
      return result
    },

    async type(input: TypeInput, activityId: string) {
      const result = await govern<ActionResult>(
        activityId,
        'computer_type',
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          ...(input.submit ? { key: 'Enter' } : {}),
        },
        () => post<ActionResult>('/type', withSnapshotSession(input)),
      )
      currentPageUrl = result.url
      snapshot = undefined
      return result
    },

    async key(input: KeyInput, activityId: string) {
      const result = await govern<ActionResult>(
        activityId,
        'computer_key',
        {
          ...(input.ref ? { ref: input.ref } : {}),
          ...(input.snapshotId !== undefined
            ? { snapshotId: input.snapshotId }
            : {}),
          key: input.key,
        },
        () => post<ActionResult>('/key', withSnapshotSession(input)),
      )
      currentPageUrl = result.url
      snapshot = undefined
      return result
    },

    async scroll(input: ScrollInput, activityId: string) {
      const result = await govern<ActionResult>(
        activityId,
        'computer_scroll',
        {},
        () => post<ActionResult>('/scroll', input),
      )
      currentPageUrl = result.url
      snapshot = undefined
      return result
    },

    listFiles(input: ListFilesInput, activityId: string) {
      return govern<ListFilesResult>(
        activityId,
        'computer_list_files',
        { filePath: input.path ?? '.' },
        () => post<ListFilesResult>('/files/list', input),
      )
    },

    readFile(input: ReadFileInput, activityId: string) {
      return govern<ReadFileResult>(
        activityId,
        'computer_read_file',
        { filePath: input.path },
        () => post<ReadFileResult>('/files/read', input),
      )
    },

    writeFile(input: WriteFileInput, activityId: string) {
      return govern<WriteFileResult>(
        activityId,
        'computer_write_file',
        { filePath: input.path },
        () => post<WriteFileResult>('/files/write', input),
      )
    },

    screenshot() {
      return call<ScreenshotResult>('/screenshot')
    },
  }
}

export type KhloeiComputerGateway = ReturnType<
  typeof createKhloeiComputerGateway
>
