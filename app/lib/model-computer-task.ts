import 'server-only'

import type { ResponseInputMessageContentList } from 'openai/resources/responses/responses'

import {
  computerAgentInput,
} from '@/shared/computer-agent'

import type { ChatHistoryMessage } from './chat-history'
import type { ChatModelId } from './chat-models'
import type { ChatStreamEvent } from './chat'
import { STREAM_HEADERS } from './model-chat-stream'
import { modelResponseHeaders, type ModelProvider } from './model-provider'
import { createComputerTask } from './computer/worker-client'
import { createComputerTaskResumeToken } from './computer/worker-auth'

type ComputerTaskOptions = {
  content: ResponseInputMessageContentList
  history: readonly ChatHistoryMessage[]
  /** Absent means a computer task, which is what every worker task once was. */
  kind?: 'computer' | 'deep-research'
  model: ChatModelId
  provider: ModelProvider
  signal: AbortSignal
}

/**
 * Hand a long-running request to the durable worker.
 *
 * The response is a two-event stream that tells the browser where the work
 * lives; everything after that arrives through the resume endpoint, which is
 * what lets a reload or a serverless timeout rejoin instead of losing the run.
 */
export async function createComputerTaskResponse({
  content,
  history,
  kind,
  model,
  provider,
  signal,
}: ComputerTaskOptions) {
  const taskId = await createComputerTask(
    {
      input: computerAgentInput(history, content),
      ...(kind === 'deep-research' ? { kind } : {}),
      model,
      provider,
    },
    signal,
  )
  const events: ChatStreamEvent[] = [
    {
      backgroundKind: 'computer',
      resumeToken: createComputerTaskResumeToken(taskId),
      sequenceNumber: 0,
      taskId,
      type: 'background',
    },
    { type: 'reconnect' },
  ]

  return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    headers: {
      ...STREAM_HEADERS,
      ...modelResponseHeaders(model),
    },
  })
}
