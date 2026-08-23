import {
  Agent,
  isOpenAIResponsesRawModelStreamEvent,
  MaxTurnsExceededError,
  OpenAIProvider,
  RunContext,
  Runner,
  RunState,
  webSearchTool,
  type AgentInputItem,
  type RunToolApprovalItem,
} from '@openai/agents'
import OpenAI from 'openai'
import type {
  Response as OpenAIResponse,
  ResponseOutputText,
} from 'openai/resources/responses/responses'

import {
  COMPUTER_AGENT_INSTRUCTIONS,
  MAX_COMPUTER_AGENT_TURNS,
  createComputerAgentTools,
  type ComputerAgentContext,
  type ComputerToolInvocation,
} from '../../../shared/computer-agent'
import { normalizeComputerMarkdown } from '../../../shared/markdown'
import { KhloeiAppClient } from './app-client'
import {
  decodeRunStateCheckpoint,
  encodeRunStateCheckpoint,
} from './checkpoint'
import { TaskEventNotifier } from './notifier'
import { isCommittedActionResult, TaskStore } from './store'
import type {
  PendingApproval,
  TaskRecord,
  WorkerActionResponse,
} from './types'

type OpenAIUrlCitation = Extract<
  ResponseOutputText['annotations'][number],
  { type: 'url_citation' }
>

type ChatSource = { title: string; url: string }

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function markdownDestination(value: string) {
  return `<${value.replaceAll('>', '%3E')}>`
}

function citationLabel(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return 'source'
  }
}

function applyCitations(text: string, citations: OpenAIUrlCitation[]) {
  let output = text
  let guardEnd = Number.POSITIVE_INFINITY
  const ordered = [...citations].sort(
    (left, right) => right.start_index - left.start_index,
  )
  for (const citation of ordered) {
    const url = safeHttpUrl(citation.url)
    if (
      !url ||
      citation.start_index < 0 ||
      citation.end_index <= citation.start_index ||
      citation.end_index > output.length ||
      citation.end_index > guardEnd
    ) {
      continue
    }
    const label = citationLabel(url).replaceAll('[', '\\[').replaceAll(']', '\\]')
    output =
      output.slice(0, citation.start_index) +
      `[${label}](${markdownDestination(url)})` +
      output.slice(citation.end_index)
    guardEnd = citation.start_index
  }
  return output
}

function finalResponse(response: OpenAIResponse) {
  const sources: ChatSource[] = []
  const sourceUrls = new Set<string>()
  const parts: string[] = []

  for (const item of response.output) {
    if (item.type !== 'message') continue
    for (const content of item.content) {
      if (content.type === 'output_text') {
        const citations = content.annotations.filter(
          (annotation): annotation is OpenAIUrlCitation =>
            annotation.type === 'url_citation',
        )
        for (const citation of citations) {
          const url = safeHttpUrl(citation.url)
          if (!url || sourceUrls.has(url)) continue
          sourceUrls.add(url)
          sources.push({
            title: citation.title || citationLabel(url),
            url,
          })
        }
        parts.push(applyCitations(content.text, citations))
      } else if (content.type === 'refusal') {
        parts.push(content.refusal)
      }
    }
  }
  return {
    content: normalizeComputerMarkdown(parts.join('\n\n').trim()),
    sources,
  }
}

function outputItemActivity(value: unknown, completed: boolean) {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  if (value.type === 'reasoning') {
    const summary = Array.isArray(value.summary)
      ? value.summary
          .filter(isRecord)
          .map((item) => (typeof item.text === 'string' ? item.text.trim() : ''))
          .filter(Boolean)
          .join('\n\n')
      : ''
    return {
      activity: {
        id: value.id,
        kind: 'reasoning',
        status: completed ? 'completed' : 'in_progress',
        ...(summary ? { summary } : {}),
      },
      type: 'activity',
    }
  }
  if (
    value.type === 'web_search_call' ||
    value.type === 'openrouter:web_search'
  ) {
    return {
      activity: {
        id: value.id,
        kind: 'web_search',
        status: completed ? 'completed' : 'in_progress',
      },
      type: 'activity',
    }
  }
  return null
}

function providerError(error: unknown, provider: 'openai' | 'openrouter') {
  const status =
    isRecord(error) && typeof error.status === 'number' ? error.status : 500
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  if (code === 'billing_not_active') {
    return `${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} billing is not active for this API key.`
  }
  if (status === 401 || status === 403) {
    return `The ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} API key is invalid or cannot use this model.`
  }
  if (status === 429) return 'The model provider is rate-limiting this task.'
  if (status >= 500) return 'The model provider is temporarily unavailable.'
  return error instanceof Error
    ? error.message.slice(0, 2_000)
    : 'Khloei could not complete the computer task.'
}

function createModelClient(task: TaskRecord) {
  const key =
    task.request.provider === 'openrouter'
      ? process.env.OPENROUTER_API_KEY?.trim()
      : process.env.OPENAI_API_KEY?.trim()
  if (!key) {
    throw new Error(
      `${task.request.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'} is not configured on the worker.`,
    )
  }
  const siteUrl = process.env.OPENROUTER_SITE_URL?.trim()
  return new OpenAI({
    apiKey: key,
    ...(task.request.provider === 'openrouter'
      ? {
          baseURL: OPENROUTER_BASE_URL,
          defaultHeaders: {
            ...(siteUrl ? { 'HTTP-Referer': siteUrl } : {}),
            'X-OpenRouter-Title': 'Khloei',
          },
        }
      : {}),
  })
}

function approvalInvocation(item: RunToolApprovalItem): ComputerToolInvocation {
  const name = item.name
  const rawItem = item.rawItem as { callId?: unknown }
  if (
    typeof name !== 'string' ||
    (name !== 'computer_request_help' && name !== 'computer_request_secret') ||
    typeof rawItem.callId !== 'string'
  ) {
    throw new Error('Khloei received an unsupported approval interruption.')
  }
  let input: unknown
  try {
    input = JSON.parse(item.arguments ?? '{}') as unknown
  } catch {
    throw new Error('Khloei received invalid human-assistance arguments.')
  }
  return { callId: rawItem.callId, input, name }
}

function sameInvocation(
  left: ComputerToolInvocation,
  right: ComputerToolInvocation,
) {
  return left.callId === right.callId && left.name === right.name
}

function recoveryInput(input: AgentInputItem[], note: string) {
  return [
    ...input,
    {
      content: [{ text: note, type: 'input_text' as const }],
      role: 'user' as const,
      type: 'message' as const,
    },
  ] as AgentInputItem[]
}

export class ComputerTaskRuntime {
  constructor(
    private readonly store: TaskStore,
    private readonly notifier: TaskEventNotifier,
    private readonly app = new KhloeiAppClient(),
  ) {}

  private append(taskId: string, payload: unknown) {
    this.store.appendEvent(taskId, payload)
    this.notifier.notify(taskId)
  }

  private appendAppResult(taskId: string, result: WorkerActionResponse) {
    this.store.saveGatewayState(taskId, result.gatewayState)
    for (const event of result.events) this.append(taskId, event)
  }

  async checkHumanApproval(task: TaskRecord) {
    if (task.status !== 'waiting_for_human' || !task.approval) return false
    try {
      const result = await this.app.operation(
        'assistance_status',
        task.id,
        task.approval.invocation,
        task.gatewayState,
        AbortSignal.timeout(10_000),
      )
      this.store.saveGatewayState(task.id, result.gatewayState)
      if (result.ready !== true) return false
      const changed = this.store.markApprovalReady(task.id)
      if (changed) this.notifier.notify(task.id)
      return changed
    } catch {
      return false
    }
  }

  async run(task: TaskRecord, signal: AbortSignal) {
    let modelProvider: OpenAIProvider | undefined
    let activeRunState: RunState<ComputerAgentContext, Agent<ComputerAgentContext>> | undefined
    let gatewayState = task.gatewayState
    const executeTool = async (invocation: ComputerToolInvocation) => {
      if (signal.aborted || this.store.isCancellationRequested(task.id)) {
        throw new DOMException('The computer task was cancelled.', 'AbortError')
      }
      const action = this.store.beginAction(
        task.id,
        invocation.callId,
        invocation.name,
        invocation.input,
      )
      if (action.kind === 'replay') {
        if (isCommittedActionResult(action.result)) {
          gatewayState = action.result.gatewayState
          return JSON.stringify(action.result.outcome)
        }
        // Checkpoints written by the first local worker build stored only the
        // tool outcome. Keeping this one-way compatibility path lets those
        // tasks finish, while every new commit stores the complete boundary.
        return JSON.stringify(action.result)
      }

      const result = await this.app.operation(
        'tool',
        task.id,
        invocation,
        gatewayState,
        signal,
      )
      gatewayState = result.gatewayState
      const runState = activeRunState
        ? encodeRunStateCheckpoint(activeRunState.toString())
        : undefined
      const appendedEvents = this.store.commitActionResult(
        task.id,
        invocation.callId,
        result,
        runState,
      )
      if (appendedEvents > 0) this.notifier.notify(task.id)
      return JSON.stringify(result.outcome)
    }

    try {
      const client = createModelClient(task)
      const tools = createComputerAgentTools({ durableHumanApprovals: true })
      const agent = new Agent<ComputerAgentContext>({
        name: 'Khloei Computer',
        instructions: COMPUTER_AGENT_INSTRUCTIONS,
        model: task.request.model,
        modelSettings: {
          maxTokens: 8_192,
          parallelToolCalls: false,
          reasoning:
            task.request.provider === 'openai'
              ? { context: 'all_turns', effort: 'medium', summary: 'auto' }
              : { effort: 'medium' },
          ...(task.request.provider === 'openai'
            ? { store: true, text: { verbosity: 'medium' as const } }
            : {}),
          toolChoice: 'auto',
        },
        tools:
          task.request.provider === 'openai'
            ? [webSearchTool({ searchContextSize: 'medium' }), ...tools]
            : tools,
      })
      modelProvider = new OpenAIProvider({
        openAIClient: client,
        strictFeatureValidation: false,
        useResponses: true,
      })
      const runner = new Runner({
        modelProvider,
        traceIncludeSensitiveData: false,
        tracingDisabled: true,
      })
      const contextValue: ComputerAgentContext = {
        durableHumanApprovals: true,
        executeTool,
        taskId: task.id,
      }
      const recoveryNote = this.store.takeRecoveryNote(task.id)
      let input: AgentInputItem[] | RunState<ComputerAgentContext, typeof agent>

      if (task.runState) {
        const checkpoint = decodeRunStateCheckpoint(task.runState)
        const state = await RunState.fromStringWithContext(
          agent,
          checkpoint.serializedState,
          new RunContext(contextValue),
          { contextStrategy: 'replace' },
        )
        activeRunState = state
        if (recoveryNote) state.addInput(recoveryNote)
        if (task.approval?.ready) {
          const interruption = state
            .getInterruptions()
            .find((item) =>
              sameInvocation(
                approvalInvocation(item),
                task.approval!.invocation,
              ),
            )
          if (!interruption) {
            throw new Error('The saved human approval no longer matches this run.')
          }
          state.approve(interruption)
          this.store.clearApproval(task.id)
          this.store.saveRunState(
            task.id,
            encodeRunStateCheckpoint(state.toString()),
          )
        }
        input = state
      } else {
        input = recoveryNote
          ? recoveryInput(task.request.input, recoveryNote)
          : task.request.input
      }

      const run = await runner.run(agent, input, {
        context: contextValue,
        maxTurns: MAX_COMPUTER_AGENT_TURNS,
        ...(task.request.provider === 'openai' &&
        task.request.previousResponseId &&
        !task.runState
          ? { previousResponseId: task.request.previousResponseId }
          : {}),
        signal,
        stream: true,
      })
      activeRunState = run.state
      let pendingText = ''
      let terminal: OpenAIResponse | undefined
      let lastTextFlush = Date.now()
      let lastRunStateCheckpoint = 0

      const checkpointRunState = (force = false) => {
        const now = Date.now()
        if (!force && now - lastRunStateCheckpoint < 100) return
        this.store.saveRunState(
          task.id,
          encodeRunStateCheckpoint(run.state.toString()),
        )
        lastRunStateCheckpoint = now
      }

      const flushText = () => {
        if (!pendingText) return
        this.append(task.id, { delta: pendingText, type: 'text-delta' })
        pendingText = ''
        lastTextFlush = Date.now()
      }

      for await (const runEvent of run) {
        checkpointRunState()
        if (!isOpenAIResponsesRawModelStreamEvent(runEvent)) continue
        const event = runEvent.data.event

        if (
          event.type === 'response.output_text.delta' ||
          event.type === 'response.refusal.delta'
        ) {
          pendingText += event.delta
          if (pendingText.length >= 256 || Date.now() - lastTextFlush >= 100) {
            flushText()
          }
          continue
        }

        flushText()
        if (
          event.type === 'response.output_item.added' ||
          event.type === 'response.output_item.done'
        ) {
          checkpointRunState(true)
          const activity = outputItemActivity(
            event.item,
            event.type === 'response.output_item.done',
          )
          if (activity) this.append(task.id, activity)
        } else if (
          event.type === 'response.web_search_call.in_progress' ||
          event.type === 'response.web_search_call.searching' ||
          event.type === 'response.web_search_call.completed'
        ) {
          this.append(task.id, {
            activity: {
              id: event.item_id,
              kind: 'web_search',
              status:
                event.type === 'response.web_search_call.searching'
                  ? 'searching'
                  : event.type === 'response.web_search_call.completed'
                    ? 'completed'
                    : 'in_progress',
            },
            type: 'activity',
          })
        } else if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete' ||
          event.type === 'response.failed'
        ) {
          checkpointRunState(true)
          terminal = event.response
        } else if (event.type === 'error') {
          throw new Error(event.message)
        }
      }
      flushText()
      await run.completed
      checkpointRunState(true)

      if (run.interruptions.length > 0) {
        if (run.interruptions.length !== 1) {
          throw new Error('Khloei received multiple human requests at once.')
        }
        const invocation = approvalInvocation(run.interruptions[0]!)
        const begin = await this.app.operation(
          'begin_assistance',
          task.id,
          invocation,
          gatewayState,
          signal,
        )
        gatewayState = begin.gatewayState
        this.appendAppResult(task.id, begin)
        const approval: PendingApproval = {
          invocation,
          ready: false,
          requestedAt: Date.now(),
        }
        this.store.setWaiting(
          task.id,
          encodeRunStateCheckpoint(run.state.toString()),
          approval,
        )
        this.notifier.notify(task.id)
        return
      }

      if (!terminal) {
        const content = normalizeComputerMarkdown(
          typeof run.finalOutput === 'string' ? run.finalOutput : '',
        )
        this.append(task.id, {
          content,
          responseId: run.lastResponseId ?? task.id,
          sources: [],
          type: 'message',
        })
        this.append(task.id, { type: 'done' })
        this.store.markTerminal(task.id, 'completed')
        return
      }

      if (terminal.status === 'failed') {
        throw new Error(terminal.error?.message || 'The model response failed.')
      }
      if (terminal.status === 'cancelled') {
        this.append(task.id, { type: 'cancelled' })
        this.store.markTerminal(task.id, 'cancelled')
        return
      }
      const final = finalResponse(terminal)
      this.append(task.id, {
        content: final.content,
        responseId: terminal.id,
        sources: final.sources,
        type: 'message',
      })
      if (terminal.status === 'completed') {
        this.append(task.id, { type: 'done' })
        this.store.markTerminal(task.id, 'completed')
      } else {
        throw new Error(
          'The response stopped before it could finish. Try narrowing the task.',
        )
      }
    } catch (error) {
      if (activeRunState) {
        try {
          this.store.saveRunState(
            task.id,
            encodeRunStateCheckpoint(activeRunState.toString()),
          )
        } catch {
          // The original task error remains the useful one.
        }
      }
      if (this.store.isCancellationRequested(task.id)) {
        if (!TERMINAL_STATUSES.has(this.store.getTask(task.id)?.status ?? '')) {
          this.append(task.id, { type: 'cancelled' })
          this.store.markTerminal(task.id, 'cancelled')
        }
        return
      }
      if (signal.aborted) return
      const message =
        error instanceof MaxTurnsExceededError
          ? 'Khloei stopped after the computer tool safety limit was reached. Start a new request to continue.'
          : providerError(error, task.request.provider)
      this.append(task.id, { message, type: 'error' })
      this.store.markTerminal(task.id, 'failed', message)
    } finally {
      await modelProvider?.close().catch(() => undefined)
      this.notifier.notify(task.id)
    }
  }
}
