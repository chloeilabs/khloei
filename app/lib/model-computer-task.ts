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
  model: ChatModelId
  previousResponseId?: string
  provider: ModelProvider
  signal: AbortSignal
}

export async function createComputerTaskResponse({
  content,
  history,
  model,
  previousResponseId,
  provider,
  signal,
}: ComputerTaskOptions) {
  const taskId = await createComputerTask(
    {
      input: computerAgentInput(history, content),
      model,
      provider,
      ...(previousResponseId ? { previousResponseId } : {}),
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
      ...modelResponseHeaders(provider, model),
    },
  })
}
