import 'server-only'

import OpenAI from 'openai'

import {
  OPENAI_CHAT_MODEL,
  OPENROUTER_CHAT_MODEL,
} from './chat-config'
import {
  chatModelById,
  type ChatModelId,
  type ChatModelProvider,
} from './chat-models'

export type ModelProvider = ChatModelProvider

export type OpenRouterWebSearchTool = {
  parameters: {
    max_results: number
    max_total_results: number
    search_context_size: 'high' | 'low' | 'medium'
  }
  type: 'openrouter:web_search'
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export class ModelProviderConfigurationError extends Error {
  readonly status = 503

  constructor(message: string) {
    super(message)
    this.name = 'ModelProviderConfigurationError'
  }
}

function configuredProvider() {
  const value = process.env.KHLOEI_MODEL_PROVIDER?.trim().toLowerCase()
  if (!value) return undefined
  if (value === 'openai' || value === 'openrouter') return value
  throw new ModelProviderConfigurationError(
    'KHLOEI_MODEL_PROVIDER must be either "openai" or "openrouter".',
  )
}

export function chatModelProvider(modelId?: ChatModelId): ModelProvider {
  if (modelId) return chatModelById(modelId).provider
  return (
    configuredProvider() ??
    (process.env.OPENROUTER_API_KEY?.trim() ? 'openrouter' : 'openai')
  )
}

export function modelForProvider(provider: ModelProvider) {
  return provider === 'openrouter'
    ? OPENROUTER_CHAT_MODEL
    : OPENAI_CHAT_MODEL
}

export function modelProviderLabel(provider: ModelProvider) {
  return provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'
}

export function modelProviderKey(provider: ModelProvider) {
  return provider === 'openrouter'
    ? process.env.OPENROUTER_API_KEY?.trim()
    : process.env.OPENAI_API_KEY?.trim()
}

function openRouterHeaders() {
  const headers: Record<string, string> = {
    'X-OpenRouter-Title': 'Khloei',
  }
  const siteUrl = process.env.OPENROUTER_SITE_URL?.trim()
  if (siteUrl) headers['HTTP-Referer'] = siteUrl
  return headers
}

export function createModelClient(provider: ModelProvider) {
  const apiKey = modelProviderKey(provider)
  if (!apiKey) {
    throw new ModelProviderConfigurationError(
      `${provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'} is not configured on the server.`,
    )
  }

  return new OpenAI({
    apiKey,
    ...(provider === 'openrouter'
      ? {
          baseURL: OPENROUTER_BASE_URL,
          defaultHeaders: openRouterHeaders(),
        }
      : {}),
  })
}

export function modelResponseHeaders(
  provider: ModelProvider,
  model = modelForProvider(provider),
) {
  return {
    'X-Khloei-Model': model,
    'X-Khloei-Model-Provider': provider,
  }
}

export function openRouterWebSearchTool(
  searchContextSize: OpenRouterWebSearchTool['parameters']['search_context_size'] =
    'medium',
): OpenRouterWebSearchTool {
  return {
    parameters: {
      max_results: 5,
      max_total_results: 10,
      search_context_size: searchContextSize,
    },
    type: 'openrouter:web_search',
  }
}
