// What the agent loop needs from a model service, whatever format the service speaks.

import type { ChatMessage, ErrorHint, ModelChoice, ModelInfo, ProviderKind, ReasoningEffort } from '../../shared/types.ts'
import type { ToolDefinition } from '../tools.ts'

/** Everything needed to reach one model of one configured provider. */
export interface Connection {
  /** Id of the configured provider; recorded on the messages it writes. */
  provider: string
  kind: ProviderKind
  /** The API key or, for a ChatGPT sign-in, the access token of the moment. */
  apiKey: string
  baseURL: string
  model: string
  reasoningEffort: ReasoningEffort
  /** Ask the service to write the answer faster, at its higher price. Set only where the model offers that. */
  fast?: boolean
  /**
   * Set when requests are paid for by the signed-in person's ChatGPT plan. Its tokens last an
   * hour, so `token` is asked before every request: it resolves with one that is good now, getting
   * a new one when needed. `rejected` names a token the service has just turned down.
   */
  plan?: { token(rejected?: string): Promise<string> }
}

/** An error the page presents with a way out, not just as text. */
export class ServiceError extends Error {
  readonly hint: ErrorHint
  /** The HTTP status, when the error came as one. */
  readonly status?: number
  constructor(message: string, hint: ErrorHint, status?: number) {
    super(message)
    this.hint = hint
    this.status = status
  }
}

export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>

export interface ModelRequest {
  connection: Connection
  system: string
  /** The conversation so far, ending with a user message or with tool results. */
  messages: readonly ChatMessage[]
  tools: readonly ToolDefinition[]
  signal: AbortSignal
  onText(delta: string): void
  onReasoning(delta: string): void
}

export interface ModelReply {
  message: AssistantMessage
  /**
   * Set when the reply must not be acted on, with the reason to show the user: the service
   * declined the request, or cut the output short. Tool calls in such a message are not run.
   */
  stopped?: string
}

export interface ProviderAdapter {
  /**
   * Streams one assistant message. Resolves with whatever arrived when the request is aborted;
   * rejects when the service reports an error.
   */
  complete(request: ModelRequest): Promise<ModelReply>
  listModels(connection: Connection): Promise<ModelChoice[]>
  /** Null when the service has nothing usable to say about the model. */
  modelInfo(connection: Connection): Promise<ModelInfo | null>
}
