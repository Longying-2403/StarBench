// What the agent loop needs from a model service, whatever format the service speaks.

import type { ChatMessage, CustomPrompt, ErrorHint, ModelChoice, ModelInfo, ProviderKind, ReasoningEffort } from '../../shared/types.ts'
import type { ToolDefinition } from '../tools.ts'
import type { WireProbe } from '../trace.ts'

/** Everything needed to reach one model of one configured provider. */
export interface Connection {
  /** Id of the configured provider; recorded on the messages it writes. */
  provider: string
  /** The provider's name as the settings show it, which the model is told along with its own. */
  providerName?: string
  kind: ProviderKind
  /** The API key or, for a ChatGPT sign-in, the access token of the moment. */
  apiKey: string
  baseURL: string
  model: string
  reasoningEffort: ReasoningEffort
  /** The person's own instructions for this provider's models, which follow the app's or stand in their place. */
  prompt?: CustomPrompt
  /** Ask the service to write the answer faster, at its higher price. Set only where the model offers that. */
  fast?: boolean
  /**
   * Set once a server turned out not to stream a reply while tools are offered (LLaMA-Factory's
   * API is one). Replies are then asked for in one piece, and the conversation is kept to strict
   * turns with one tool call at a time, which is all such a server takes.
   */
  wholeReplies?: boolean
  /**
   * Set once a server turned out to take no tool definitions: a model whose template knows none,
   * or a server that was started without what it needs to hand calls over (vLLM without
   * `--enable-auto-tool-choice`, llama.cpp without `--jinja`). The tools are then described at the
   * end of the instructions, the model writes its calls into the answer, where they are read
   * (tool-text.ts), and the results go back as text. Only chat completions knows this.
   */
  textTools?: boolean
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

/**
 * Thrown, before anything of a reply arrived, when the service will not take tool definitions
 * for this model. The message is what the service said. The request can be made again with the
 * tools described in the instructions instead; see `Connection.textTools`.
 */
export class ToolsRefused extends Error {}

export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>

export interface ModelRequest {
  connection: Connection
  system: string
  /** The conversation so far, ending with a user message or with tool results. */
  messages: readonly ChatMessage[]
  tools: readonly ToolDefinition[]
  /**
   * Request fields plugins asked to add, under the names the service knows them by: the
   * temperature and the like. Only chat completions sends them so far, and there they never
   * replace a field the app sets itself.
   */
  sampling?: Readonly<Record<string, unknown>>
  /**
   * A name for the conversation this request belongs to: the same for every request of it, and
   * telling nothing else about it. Handed to a service that sends the requests of one
   * conversation to one server by it (`routesByConversation`), and to no other.
   */
  conversation?: string
  /**
   * Nobody reads this reply as it comes: the app takes its text and puts it to use as it stands
   * (the summary of a conversation). What a person is shown can be put right by what they see
   * next; this cannot. So an adapter makes nothing of such a reply on a guess, and where the
   * reply was cut short it says so (`ModelReply.stopped`) instead of handing on what there is.
   */
  unattended?: boolean
  signal: AbortSignal
  onText(delta: string): void
  onReasoning(delta: string): void
  /**
   * Called when what was handed on of the reply so far has to be read differently: text that
   * came as the answer was the model's thinking, or held a tool call that was taken out of it.
   * `shown` is all of the reply as it stands now; more of it may follow, as before.
   */
  onRewrite?(shown: { text: string; reasoning: string }): void
  /**
   * Called when the service turned down the faster answers `connection.fast` asked for (not
   * every model or account has them) and the request went out again without.
   */
  onFastRefused?(): void
  /**
   * Called when the server would not stream this reply because tools were offered, and the reply
   * was asked for in one piece instead; see `Connection.wholeReplies`.
   */
  onStreamRefused?(): void
  /**
   * There while someone watches what passes between the app and the model (trace.ts). The
   * adapter tells it what it sends and what the service says of the reply, and may ask the
   * service for what it only tells when asked, such as the cost of a streamed reply.
   */
  probe?: WireProbe
}

export interface ModelReply {
  message: AssistantMessage
  /**
   * Set when the reply must not be acted on, with the reason to show the user: the service
   * declined the request, or cut the output short. Tool calls in such a message are not run.
   */
  stopped?: string
  /** Set when that reason is that the conversation no longer fits the model's context: compacting it may help. */
  tooLong?: boolean
}

export interface ProviderAdapter {
  /**
   * Streams one assistant message. Resolves with whatever arrived when the request is aborted;
   * rejects when the service reports an error, with `ToolsRefused` when the error is that the
   * model takes no tools.
   */
  complete(request: ModelRequest): Promise<ModelReply>
  listModels(connection: Connection): Promise<ModelChoice[]>
  /** Null when the service has nothing usable to say about the model. */
  modelInfo(connection: Connection): Promise<ModelInfo | null>
}
