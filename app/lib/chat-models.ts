import {
  OPENROUTER_CHAT_MODEL,
  OPENROUTER_GROK_MODEL,
} from './chat-config'

/** Khloei reaches every model through OpenRouter. */
export type ChatModelProvider = 'openrouter'

export const CHAT_MODELS = [
  {
    id: OPENROUTER_CHAT_MODEL,
    name: 'GLM 5.3 Flash',
    provider: 'openrouter',
    providerName: 'OpenRouter',
  },
  {
    id: OPENROUTER_GROK_MODEL,
    name: 'Grok 4.6',
    provider: 'openrouter',
    providerName: 'OpenRouter',
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
