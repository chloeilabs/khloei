import type OpenAI from 'openai'

import type { ChatModelId } from './chat-models'
import {
  createFollowUpQuestions,
  normalizeGeneratedFollowUpQuestionTexts,
  parseJsonObject,
  truncateFollowUpContext,
  type ChatFollowUpContextMessage,
} from './chat-follow-ups'
import type { ChatFollowUpQuestion } from './chat'
import type { ModelProvider } from './model-provider'

const FOLLOW_UP_INSTRUCTIONS = `You generate concise follow-up questions for a chat UI. Return only structured data. Each question must be useful, specific to the assistant's latest answer, written from the user's point of view, and short enough for a compact button. Each question must include a concrete term, entity, claim, or tradeoff from the latest answer. Do not use markdown, numbering, emojis, citations, repeated questions, or generic prompts like asking for an example without naming the topic.`

export async function generateFollowUpQuestions({
  client,
  messages,
  model,
  provider,
  signal,
}: {
  client: OpenAI
  messages: readonly ChatFollowUpContextMessage[]
  model: ChatModelId
  provider: ModelProvider
  signal?: AbortSignal
}): Promise<ChatFollowUpQuestion[]> {
  const context = truncateFollowUpContext(messages)

  try {
    const response = await client.responses.create(
      {
        input: [
          {
            content: [
              {
                text: [
                  'Generate exactly three follow-up questions for the latest assistant response.',
                  'Use this exact JSON shape: {"questions":["...","...","..."]}.',
                  'Avoid questions the assistant already answered directly.',
                  'Conversation:',
                  context,
                ].join('\n\n'),
                type: 'input_text',
              },
            ],
            role: 'user',
          },
        ],
        instructions: FOLLOW_UP_INSTRUCTIONS,
        max_output_tokens: 400,
        model,
        reasoning: { effort: 'low' },
        ...(provider === 'openai' ? { store: false } : {}),
        text: {
          format: {
            name: 'follow_up_questions',
            schema: {
              additionalProperties: false,
              properties: {
                questions: {
                  items: { type: 'string' },
                  type: 'array',
                },
              },
              required: ['questions'],
              type: 'object',
            },
            strict: true,
            type: 'json_schema',
          },
        },
      },
      { signal },
    )

    return createFollowUpQuestions(
      normalizeGeneratedFollowUpQuestionTexts(
        parseJsonObject(response.output_text),
      ),
    )
  } catch {
    return []
  }
}
