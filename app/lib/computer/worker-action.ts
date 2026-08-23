import 'server-only'

import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses'

import type {
  ChatActivity,
  ChatComputerFrame,
  ChatStreamEvent,
} from '../chat'
import {
  createKhloeiComputerGateway,
  type ComputerGatewayProgress,
  type ComputerGatewayState,
} from './gateway'
import type { SecretRequest } from './schema'
import {
  executeComputerTool,
  isBrowserComputerTool,
} from './tools'

export type WorkerComputerInvocation = {
  callId: string
  input: unknown
  name: string
}

export type WorkerComputerOperation =
  | {
      gatewayState?: ComputerGatewayState
      invocation: WorkerComputerInvocation
      operation: 'tool'
      taskId: string
    }
  | {
      gatewayState?: ComputerGatewayState
      invocation: WorkerComputerInvocation
      operation: 'begin_assistance'
      taskId: string
    }
  | {
      gatewayState?: ComputerGatewayState
      invocation: WorkerComputerInvocation
      operation: 'assistance_status'
      taskId: string
    }
  | {
      gatewayState?: ComputerGatewayState
      invocation: WorkerComputerInvocation
      operation: 'cancel_assistance'
      taskId: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inputRecord(value: unknown) {
  if (!isRecord(value)) throw new Error('Computer tool input must be an object.')
  return value
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`)
  }
  return value
}

function requiredNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} is required.`)
  }
  return value
}

function helpReason(invocation: WorkerComputerInvocation) {
  return requiredString(inputRecord(invocation.input).reason, 'reason')
}

function secretRequest(invocation: WorkerComputerInvocation): SecretRequest {
  const input = inputRecord(invocation.input)
  return {
    label: requiredString(input.label, 'label'),
    ref: requiredString(input.ref, 'ref'),
    snapshotId: requiredNumber(input.snapshotId, 'snapshotId'),
  }
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

function computerActivity(progress: ComputerGatewayProgress): ChatActivity {
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

function functionCall(
  invocation: WorkerComputerInvocation,
): ResponseFunctionToolCall {
  return {
    arguments: JSON.stringify(invocation.input),
    call_id: invocation.callId,
    name: invocation.name,
    type: 'function_call',
  }
}

export async function performWorkerComputerOperation(
  request: WorkerComputerOperation,
) {
  const events: ChatStreamEvent[] = []
  const gateway = createKhloeiComputerGateway({
    initialState: request.gatewayState,
    onProgress: (progress) => {
      events.push({ activity: computerActivity(progress), type: 'activity' })
    },
    sessionId: request.taskId,
  })

  const frame = async () => {
    const screenshot = await gateway.screenshot()
    if (screenshot.url === 'about:blank') return
    const value: ChatComputerFrame = {
      capturedAt: screenshot.capturedAt,
      dataUrl: `data:image/png;base64,${screenshot.base64}`,
      height: screenshot.height,
      url: publicBrowserUrl(screenshot.url),
      width: screenshot.width,
    }
    events.push({ frame: value, type: 'computer-frame' })
  }

  if (request.operation === 'begin_assistance') {
    if (request.invocation.name === 'computer_request_help') {
      await gateway.beginHelp(
        helpReason(request.invocation),
        request.invocation.callId,
      )
    } else if (request.invocation.name === 'computer_request_secret') {
      await gateway.beginSecret(
        secretRequest(request.invocation),
        request.invocation.callId,
      )
    } else {
      throw new Error('Only human-assistance tools can pause a task.')
    }
    await frame().catch(() => undefined)
    return { events, gatewayState: gateway.exportState(), ready: false }
  }

  if (request.operation === 'assistance_status') {
    const control = await gateway.control()
    const ready =
      request.invocation.name === 'computer_request_help'
        ? control.holder === 'bot' && !control.requested
        : request.invocation.name === 'computer_request_secret'
          ? control.secretWanted === undefined
          : false
    return { events, gatewayState: gateway.exportState(), ready }
  }

  if (request.operation === 'cancel_assistance') {
    if (request.invocation.name === 'computer_request_help') {
      await gateway.cancelAssistance(
        'computer_request_help',
        request.invocation.callId,
        'human assistance',
      )
    } else if (request.invocation.name === 'computer_request_secret') {
      const secret = secretRequest(request.invocation)
      await gateway.cancelAssistance(
        'computer_request_secret',
        request.invocation.callId,
        secret.label,
      )
    } else {
      throw new Error('Only a human-assistance request can be cancelled.')
    }
    return { events, gatewayState: gateway.exportState(), ready: false }
  }

  let outcome: Awaited<ReturnType<typeof executeComputerTool>>
  if (request.invocation.name === 'computer_request_help') {
    outcome = {
      ok: true,
      result: await gateway.completeHelp(
        helpReason(request.invocation),
        request.invocation.callId,
        'answered',
      ),
    }
  } else if (request.invocation.name === 'computer_request_secret') {
    outcome = {
      ok: true,
      result: await gateway.completeSecret(
        secretRequest(request.invocation),
        request.invocation.callId,
        'answered',
      ),
    }
  } else {
    outcome = await executeComputerTool(functionCall(request.invocation), gateway)
  }

  if (outcome.ok && isBrowserComputerTool(request.invocation.name)) {
    await frame().catch(() => undefined)
  }
  return { events, gatewayState: gateway.exportState(), outcome }
}
