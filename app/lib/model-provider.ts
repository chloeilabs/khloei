import 'server-only'

import OpenAI from 'openai'

import { OPENROUTER_CHAT_MODEL } from './chat-config'
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

export function chatModelProvider(modelId?: ChatModelId): ModelProvider {
  if (modelId) return chatModelById(modelId).provider
  return 'openrouter'
}

export function modelForProvider() {
  return OPENROUTER_CHAT_MODEL
}

export function modelProviderLabel() {
  return 'OpenRouter'
}

export function modelProviderKey() {
  return process.env.OPENROUTER_API_KEY?.trim()
}

function openRouterHeaders() {
  const headers: Record<string, string> = {
    'X-OpenRouter-Title': 'Khloei',
  }
  const siteUrl = process.env.OPENROUTER_SITE_URL?.trim()
  if (siteUrl) headers['HTTP-Referer'] = siteUrl
  return headers
}

/**
 * The OpenAI client library is how OpenRouter is reached: its API is
 * OpenAI-compatible, so the SDK is the transport rather than a provider choice.
 */
export function createModelClient() {
  const apiKey = modelProviderKey()
  if (!apiKey) {
    throw new ModelProviderConfigurationError(
      'OPENROUTER_API_KEY is not configured on the server.',
    )
  }

  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: openRouterHeaders(),
  })
}

export function modelResponseHeaders(model: string = modelForProvider()) {
  return {
    'X-Khloei-Model': model,
    'X-Khloei-Model-Provider': 'openrouter',
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
