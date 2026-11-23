// The model services the app can talk to, by the format they speak.

import type { ProviderKind } from '../../shared/types.ts'
import { anthropicAdapter } from './anthropic.ts'
import { chatAdapter } from './chat.ts'
import { geminiAdapter } from './gemini.ts'
import { responsesAdapter } from './responses.ts'
import type { ProviderAdapter } from './types.ts'

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  'openai-chat': chatAdapter,
  'openai-responses': responsesAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter
}

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  return ADAPTERS[kind]
}

export type { Connection, ModelReply, ModelRequest, ProviderAdapter } from './types.ts'
