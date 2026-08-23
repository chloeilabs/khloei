import {
  OPENAI_CHAT_MODEL,
  OPENROUTER_CHAT_MODEL,
  OPENROUTER_GROK_MODEL,
} from './chat-config'

export type ChatModelProvider = 'openai' | 'openrouter'

export const CHAT_MODELS = [
  {
    id: OPENROUTER_CHAT_MODEL,
    name: 'Ox Alpha',
    provider: 'openrouter',
    providerName: 'OpenRouter',
  },
  {
    id: OPENROUTER_GROK_MODEL,
    name: 'Grok 4.6',
    provider: 'openrouter',
    providerName: 'OpenRouter',
  },
  {
    id: OPENAI_CHAT_MODEL,
    name: 'GPT-5.6 Terra',
    provider: 'openai',
    providerName: 'OpenAI',
  },
] as const satisfies ReadonlyArray<{
  id: string
  name: string
  provider: ChatModelProvider
  providerName: string
}>

export type ChatModelId = (typeof CHAT_MODELS)[number]['id']

export const DEFAULT_CHAT_MODEL_ID: ChatModelId = OPENROUTER_CHAT_MODEL

export function isChatModelId(value: unknown): value is ChatModelId {
  return CHAT_MODELS.some((model) => model.id === value)
}

export function chatModelById(modelId: ChatModelId) {
  return CHAT_MODELS.find((model) => model.id === modelId)!
}
