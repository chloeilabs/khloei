import 'server-only'

import {
  Agent,
  isOpenAIResponsesRawModelStreamEvent,
  MaxTurnsExceededError,
  OpenAIProvider,
  Runner,
  type RunState,
  webSearchTool,
} from '@openai/agents'
import OpenAI from 'openai'
import type {
  Response as OpenAIResponse,
  ResponseInputMessageContentList,
} from 'openai/resources/responses/responses'

import type { ChatHistoryMessage } from './chat-history'
import type { ChatModelId } from './chat-models'
import type { ChatActivity, ChatStreamEvent } from './chat'
import {
  COMPUTER_AGENT_BUDGET_EXHAUSTED_MESSAGE,
  COMPUTER_AGENT_INSTRUCTIONS,
  computerAgentInput,
  computerAgentTurnLimit,
  createComputerAgentTools,
  type ComputerAgentContext,
} from '@/shared/computer-agent'
import { normalizeComputerMarkdown } from '@/shared/markdown'
import {
  STREAM_HEADERS,
  openAIErrorDetails,
  openRouterErrorDetails,
  seedReasoningParts,
  streamActivity,
  terminalChatEvents,
} from './model-chat-stream'
import { modelResponseHeaders, type ModelProvider } from './model-provider'
import {
  createKhloeiComputerGateway,
  type ComputerGatewayProgress,
} from './computer/gateway'
import {
  desktopScreenshotFromToolOutcome,
  executeComputerTool,
  isBrowserComputerTool,
} from './computer/tools'

type ComputerStreamOptions = {
  client: OpenAI
  content: ResponseInputMessageContentList
  history: readonly ChatHistoryMessage[]
  model: ChatModelId
  provider: ModelProvider
  previousResponseId?: string
  signal: AbortSignal
}

function publicBrowserUrl(value: string | undefined) {
  if (!value) return value
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

function activityStatus(stage: ComputerGatewayProgress['stage']) {
  if (stage === 'completed') return 'completed' as const
  if (stage === 'failed' || stage === 'refused') return 'failed' as const
  return 'in_progress' as const
}

function computerActivity(
  progress: ComputerGatewayProgress,
): ChatActivity {
  return {
    id: `computer-${progress.activityId}`,
    kind: 'computer',
    status: activityStatus(progress.stage),
    computer: {
      action: progress.action,
      stage: progress.stage,
      ...(progress.target ? { target: progress.target } : {}),
      ...(progress.detail ? { detail: progress.detail } : {}),
      ...(progress.auditEventId
        ? { auditEventId: progress.auditEventId }
        : {}),
      ...(progress.decision
        ? {
            decision: {
              allowed: progress.decision.allowed,
              reason: progress.decision.reason,
              rule: progress.decision.rule,
            },
          }
        : {}),
    },
  }
}

function providerCause(error: unknown) {
  let current = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      typeof current === 'object' &&
      current !== null &&
      ('status' in current || 'code' in current)
    ) {
      return current
    }
    if (
      typeof current !== 'object' ||
      current === null ||
      !('cause' in current)
    ) {
      return error
    }
    current = current.cause
  }
  return error
}

export function createComputerStreamResponse({
  client,
  content,
  history,
  model,
  provider,
  previousResponseId,
  signal,
}: ComputerStreamOptions) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let modelProvider: OpenAIProvider | undefined
      const reasoningParts = seedReasoningParts()
      const send = (event: ChatStreamEvent) => {
        if (closed || signal.aborted) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          closed = true
        }
      }
      const close = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // The browser may already have closed its side of the stream.
        }
      }

      try {
        const sessionId = crypto.randomUUID()
        const frameSource: {
          current?: ReturnType<typeof createKhloeiComputerGateway>
        } = {}
        const publishFrame = (frame: {
          base64: string
          capturedAt: string
          height: number
          mimeType?: 'image/jpeg' | 'image/png'
          url?: string
          width: number
        }) => {
          if (frame.url === 'about:blank') return
          send({
            frame: {
              capturedAt: frame.capturedAt,
              dataUrl: `data:${frame.mimeType ?? 'image/png'};base64,${frame.base64}`,
              height: frame.height,
              url: publicBrowserUrl(frame.url),
              width: frame.width,
            },
            type: 'computer-frame',
          })
        }
        const onBrowserAction = async () => {
          try {
            const gateway = frameSource.current
            if (!gateway) return
            const frame = await gateway.screenshot()
            publishFrame(frame)
          } catch {
            // The tool result still reaches the agent. A missing observational frame must not turn
            // a completed action into a failed action.
          }
        }
        const gateway = createKhloeiComputerGateway({
          sessionId,
          signal,
          onProgress: (progress) => {
            send({ activity: computerActivity(progress), type: 'activity' })
            if (
              progress.stage === 'approved' &&
              (progress.action === 'computer_request_help' ||
                progress.action === 'computer_request_secret')
            ) {
              // Human assistance can be the first computer tool in a run. Publish the screen as soon
              // as the request becomes active so the person has a visible wheel to take while the
              // tool is waiting, not only after the wait has ended.
              void onBrowserAction()
            }
          },
        })
        frameSource.current = gateway

        const tools = createComputerAgentTools()
        const agent = new Agent<ComputerAgentContext>({
          name: 'Khloei Computer',
          instructions: COMPUTER_AGENT_INSTRUCTIONS,
          model,
          modelSettings: {
            maxTokens: 8_192,
            parallelToolCalls: false,
            reasoning:
              provider === 'openai'
                ? {
                    context: 'all_turns',
                    effort: 'medium',
                    summary: 'auto',
                  }
                : { effort: 'medium' },
            ...(provider === 'openai'
              ? { store: true, text: { verbosity: 'medium' as const } }
              : {}),
            toolChoice: 'auto',
          },
          tools:
            provider === 'openai'
              ? [
                  webSearchTool({ searchContextSize: 'medium' }),
                  ...tools,
                ]
              : tools,
        })

        modelProvider = new OpenAIProvider({
          openAIClient: client,
          strictFeatureValidation: false,
          useResponses: true,
        })
        const runner = new Runner({
          modelProvider,
          // Tool inputs can contain page text and workspace data. Khloei's own hash-chained audit
          // is the intended record; do not export sensitive traces to a second service by default.
          traceIncludeSensitiveData: false,
          tracingDisabled: true,
        })
        const contextValue: ComputerAgentContext = {
          durableHumanApprovals: false,
          executeTool: async ({ callId, input, name }) => {
            const outcome = await executeComputerTool(
              {
                arguments: JSON.stringify(input),
                call_id: callId,
                name,
                type: 'function_call',
              },
              gateway,
            )
            if (outcome.ok && isBrowserComputerTool(name)) {
              await onBrowserAction()
            }
            const desktopFrame = desktopScreenshotFromToolOutcome(name, outcome)
            if (desktopFrame) publishFrame(desktopFrame)
            return outcome
          },
        }
        let runInput:
          | ReturnType<typeof computerAgentInput>
          | RunState<ComputerAgentContext, typeof agent> = computerAgentInput(
          history,
          content,
        )
        let turnLimit = computerAgentTurnLimit({ currentTurn: 0 })
        let firstSegment = true

        if (turnLimit === null) {
          throw new Error(COMPUTER_AGENT_BUDGET_EXHAUSTED_MESSAGE)
        }

        for (;;) {
          const segmentInput:
            | ReturnType<typeof computerAgentInput>
            | RunState<ComputerAgentContext, typeof agent> = runInput
          const run: Awaited<
            ReturnType<
              typeof runner.run<typeof agent, ComputerAgentContext>
            >
          > =
            await runner.run<typeof agent, ComputerAgentContext>(
              agent,
              segmentInput,
              {
                context: contextValue,
                maxTurns: turnLimit,
                ...(firstSegment && provider === 'openai' && previousResponseId
                  ? { previousResponseId }
                  : {}),
                signal,
                stream: true,
              },
            )

          let terminal: OpenAIResponse | undefined
          try {
            for await (const runEvent of run) {
              if (!isOpenAIResponsesRawModelStreamEvent(runEvent)) continue
              const event = runEvent.data.event
              const activity = streamActivity(event, reasoningParts)
              if (activity) send({ activity, type: 'activity' })

              if (event.type === 'response.output_text.delta') {
                send({ delta: event.delta, type: 'text-delta' })
              } else if (event.type === 'response.refusal.delta') {
                send({ delta: event.delta, type: 'text-delta' })
              } else if (
                event.type === 'response.completed' ||
                event.type === 'response.incomplete' ||
                event.type === 'response.failed'
              ) {
                // The SDK may complete several function-call turns. The last raw response is the
                // final response after it has executed all local tools.
                terminal = event.response
              } else if (event.type === 'error') {
                throw new Error(event.message)
              }
            }
            await run.completed
          } catch (error) {
            if (error instanceof MaxTurnsExceededError) {
              const nextTurnLimit = computerAgentTurnLimit(run.state.toJSON())
              if (nextTurnLimit !== null && nextTurnLimit > turnLimit) {
                // The SDK preserves the complete tool/result transcript in RunState. Resume that
                // state with a cumulative ceiling so no completed action is repeated.
                runInput = run.state
                turnLimit = nextTurnLimit
                firstSegment = false
                continue
              }
            }
            throw error
          }

          if (!terminal) {
            throw new Error('The Agents SDK response stream ended unexpectedly.')
          }
          for (const event of terminalChatEvents(terminal)) {
            send(
              event.type === 'message'
                ? {
                    ...event,
                    content: normalizeComputerMarkdown(event.content),
                  }
                : event,
            )
          }
          break
        }
        close()
      } catch (error) {
        if (!signal.aborted) {
          if (error instanceof MaxTurnsExceededError) {
            send({
              message: COMPUTER_AGENT_BUDGET_EXHAUSTED_MESSAGE,
              type: 'error',
            })
          } else {
            const details =
              provider === 'openrouter'
                ? openRouterErrorDetails(providerCause(error))
                : openAIErrorDetails(providerCause(error))
            send({ message: details.message, type: 'error' })
          }
        }
        close()
      } finally {
        await modelProvider?.close().catch(() => undefined)
      }
    },
  })

  return new Response(body, {
    headers: {
      ...STREAM_HEADERS,
      ...modelResponseHeaders(provider, model),
    },
  })
}
