// Claude through the Anthropic Messages API, with the official SDK.

import Anthropic from '@anthropic-ai/sdk'
import type { ModelChoice, ModelInfo, ToolCall } from '../../shared/types.ts'
import type { WebActivity } from '../../shared/types.ts'
import { DocumentsRefused, ImagesRefused, carriesDocuments, carriesImages, refusesDocuments, refusesImages, userDocuments, userImages } from './attachments.ts'
import { isErrorResult, newReply, replayOf, searchNote, userText, withSearchNote, withToolResults } from './history.ts'
import type { AssistantMessage, Connection, ModelReply, ModelRequest, ProviderAdapter } from './types.ts'
import { CLAUDE_SEARCH_BLOCKS, WebLog, claudeCall, claudeResult } from './web-search.ts'

type MessageParam = Anthropic.Beta.BetaMessageParam
type BlockParam = Anthropic.Beta.BetaContentBlockParam
type ResultBlock = Anthropic.Beta.BetaToolResultBlockParam
/** What `client.beta.messages.stream` takes. */
type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0]

const OFFICIAL_API = 'https://api.anthropic.com'
const TIMEOUT_MS = 8000
/** Room for the answer and the thinking of one step; every current model can write more than this. */
const MAX_OUTPUT_TOKENS = 64_000
/** The levels `output_config.effort` takes. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]

/**
 * Models that can decline a request for safety reasons and for which the service can hand the
 * request to another model instead of returning the refusal. Other models reject the parameter
 * or ignore it, so it is sent only for these.
 */
const WITH_FALLBACK = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/**
 * Claude's own web search and page reading, which run on Anthropic's side. These versions are
 * called by the model directly; the later ones go through code execution first by default, which
 * took 18 s and 37k tokens for a question the direct search answered in 4 s (tried 2026-11-23).
 * Each step may search and read this many times; a page read gives the model at most this many
 * tokens of the page. Searches cost $10 per 1,000; reading costs only the tokens it adds.
 * Reading takes only addresses that are already in the conversation: the service sees to that.
 */
/**
 * What Claude is to do with a thinking block it is sent back when the conversation before the
 * block is no longer the one it was written in (other instructions, other tools, earlier messages
 * changed): leave the block out and go on. Without this, Claude Opus 5.5 refused the next request
 * once web search had been switched off, which changes the tools, the instructions and the
 * earlier replies (tried 2026-11-23). Haiku 5.5 takes the setting too.
 */
const BINDING_BETA = 'thinking-binding-controls-2026-08-01'

const SERVER_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8, max_content_tokens: 40_000 }
]

const baseURLOf = (connection: Connection): string => connection.baseURL.trim().replace(/\/+$/, '') || OFFICIAL_API
/** A gateway in front of the API may not know the newer request fields, so those go to the real API only. */
const isOfficial = (connection: Connection): boolean => baseURLOf(connection) === OFFICIAL_API

function clientFor(connection: Connection, timeout?: number): Anthropic {
  return new Anthropic({
    apiKey: connection.apiKey,
    // Both given explicitly, so nothing set in the environment of whoever starts the app is used instead.
    authToken: null,
    baseURL: baseURLOf(connection),
    ...(timeout ? { timeout, maxRetries: 0 } : {})
  })
}

/** What the service says about a model, as far as the requests depend on it. */
export interface ModelFacts {
  name: string
  maxTokens: number | null
  /** How many tokens of input the model takes: its context window. */
  contextWindow: number | null
  /** Whether the model takes `thinking: { type: "adaptive" }`. */
  adaptive: boolean
  /** The effort levels it takes; empty when it has no effort setting. */
  efforts: Effort[]
}

const factsCache = new Map<string, Promise<ModelFacts>>()

function factsFor(connection: Connection): Promise<ModelFacts> {
  const key = `${baseURLOf(connection)}\n${connection.apiKey}\n${connection.model}`
  let facts = factsCache.get(key)
  if (!facts) {
    facts = clientFor(connection, TIMEOUT_MS)
      .models.retrieve(connection.model)
      .then((info) => {
        const caps = info.capabilities
        return {
          name: info.display_name,
          maxTokens: info.max_tokens,
          contextWindow: info.max_input_tokens,
          adaptive: caps ? caps.thinking.types.adaptive.supported : true,
          efforts: caps?.effort.supported ? EFFORTS.filter((level) => caps.effort[level]?.supported) : []
        }
      })
    factsCache.set(key, facts)
    // A failed lookup is asked again next time instead of being remembered.
    facts.catch(() => factsCache.delete(key))
  }
  return facts
}

/** Ids from another service can hold characters the Messages API does not take in a tool id. */
const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'call'

function parseInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * A block of a reply of Claude's as it goes back to a request without the search tools: a
 * search becomes a note of what it looked for and found (`searchNote`), its results are left
 * out, and the text loses the citations that pointed into them. Sent as they were, the model
 * went on writing its citations into the answer as text, like `(cite index="4-1">…</cite>`; sent
 * without a word of the search, it took its own sources back as made up (both tried 2026-11-23).
 * Thinking blocks are not touched.
 */
function withoutSearch(block: BlockParam, web: readonly WebActivity[]): BlockParam[] {
  if (block.type === 'server_tool_use') {
    const searched = web.find((a) => a.id === block.id)
    return searched ? [{ type: 'text', text: searchNote(searched) }] : []
  }
  if (CLAUDE_SEARCH_BLOCKS.has(block.type)) return []
  if (block.type === 'text' && block.citations) {
    const { citations: _gone, ...rest } = block
    return [rest]
  }
  return [block]
}

function toMessages(request: ModelRequest, withFallback: boolean, withSearch: boolean): MessageParam[] {
  const out: MessageParam[] = []
  /** The user message the results of one step's tool calls are collected in: they must arrive together. */
  let results: ResultBlock[] | null = null
  for (const message of withToolResults(request.messages)) {
    if (message.role === 'tool') {
      if (!results) {
        results = []
        out.push({ role: 'user', content: results })
      }
      results.push({
        type: 'tool_result',
        tool_use_id: safeId(message.tool_call_id),
        content: message.content || '(no output)',
        ...(isErrorResult(message.content) ? { is_error: true } : {})
      })
      continue
    }
    results = null
    if (message.role === 'user') {
      const text = userText(message, request.connection)
      const images = userImages(message, request.connection)
      const documents = userDocuments(message, request.connection)
      // PDFs and pictures go in front of the words about them, which is where Claude reads them best. A PDF carries its name as its title.
      const blocks: BlockParam[] = [
        ...documents.map((pdf): BlockParam => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.data }, title: pdf.name })),
        ...images.map((image): BlockParam => ({ type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } })),
        ...(text ? [{ type: 'text' as const, text }] : [])
      ]
      out.push({ role: 'user', content: images.length || documents.length ? blocks : text })
      continue
    }

    // Claude's own messages go back exactly as they came: thinking blocks are signed and must not change.
    const blocks = replayOf(message, request.connection)
    if (Array.isArray(blocks)) {
      // A block marking a hand-over to a fallback model is only understood together with that feature.
      const content = (blocks as BlockParam[])
        .filter((b) => withFallback || b.type !== 'fallback')
        .flatMap((b) => (withSearch ? [b] : withoutSearch(b, message.web ?? [])))
      if (content.length) out.push({ role: 'assistant', content })
      continue
    }
    const content: BlockParam[] = []
    // Another service's reply, with its searches told in words.
    const text = withSearchNote(message)
    if (text.trim()) content.push({ type: 'text', text })
    for (const call of message.tool_calls ?? []) {
      content.push({ type: 'tool_use', id: safeId(call.id), name: call.name, input: parseInput(call.arguments) })
    }
    if (content.length) out.push({ role: 'assistant', content })
  }
  return out
}

/**
 * The request for one step of a turn. `facts` is what the service said about the model, or null
 * when it could not be asked: the defaults used then fit every current model.
 */
export function anthropicParams(request: ModelRequest, facts: ModelFacts | null): StreamParams {
  const { connection } = request
  const official = isOfficial(connection)
  const withFallback = official && WITH_FALLBACK.has(connection.model)
  // A gateway in front of the API may not know the server tools.
  const withSearch = official && Boolean(connection.webSearch)
  const adaptive = facts?.adaptive !== false
  const betas = [...(withFallback ? [FALLBACK_BETA] : []), ...(official && adaptive ? [BINDING_BETA] : [])]
  const effort = connection.reasoningEffort
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    ...(withSearch ? SERVER_TOOLS : []),
    ...request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.parameters, type: 'object' as const },
      // Lets long tool inputs stream as they are written. The service then no longer checks
      // them, which is why arguments are checked before a tool runs (see ToolRegistry.execute).
      ...(official ? { eager_input_streaming: true } : {})
    }))
  ]
  return {
    model: connection.model,
    max_tokens: Math.min(MAX_OUTPUT_TOKENS, facts?.maxTokens ?? MAX_OUTPUT_TOKENS),
    // Left out where there are none: a plain chat of someone who wrote no instructions of their own.
    ...(request.system ? { system: request.system } : {}),
    messages: toMessages(request, withFallback, withSearch),
    // Caches the unchanging start of the conversation, which every step of a turn sends again.
    cache_control: { type: 'ephemeral' },
    ...(tools.length ? { tools } : {}),
    // "summarized" asks for a readable summary of the thinking; by default none is returned.
    ...(adaptive
      ? { thinking: { type: 'adaptive', display: 'summarized', ...(official ? { block_binding: { prefix_mismatch_behavior: 'drop_block' as const } } : {}) } }
      : {}),
    ...((EFFORTS as readonly string[]).includes(effort) && facts?.efforts.length !== 0
      ? { output_config: { effort: effort as Effort } }
      : {}),
    // "Fast mode": the same model writing faster, at twice the price. Only some models have it,
    // which is decided before the connection is marked (see `offersFastMode`).
    ...(connection.fast && official ? { speed: 'fast' as const } : {}),
    ...(withFallback ? { fallbacks: 'default' as const } : {}),
    ...(betas.length ? { betas } : {})
  }
}

/** Makes one request and collects the reply into `message`, which keeps what arrived if the request fails. */
async function attempt(request: ModelRequest, message: AssistantMessage): Promise<ModelReply> {
  const { connection, signal } = request
  // Not knowing the model is no reason to fail.
  const facts = await factsFor(connection).catch(() => null)
  const stream = clientFor(connection).beta.messages.stream(anthropicParams(request, facts), { signal })
  const web = new WebLog(message, request.onWebActivity)
  /** The searches and page reads being written, by the index of their block, with their input as far as it came. */
  const writing = new Map<number, { block: unknown; input: string }>()

  for await (const event of stream) {
    if (event.type === 'content_block_start' && event.content_block.type === 'thinking' && message.reasoning_content) {
      message.reasoning_content += '\n\n'
      request.onReasoning('\n\n')
    }
    if (event.type === 'content_block_start') {
      // A search begins (its words follow as input), or its results arrive whole.
      const begun = claudeCall(event.content_block)
      if (begun) {
        writing.set(event.index, { block: event.content_block, input: '' })
        web.put(begun)
      }
      const ended = claudeResult(event.content_block)
      if (ended && web.has(ended.id)) web.put(ended)
      if (begun || ended) request.probe?.arrived()
    }
    if (event.type === 'content_block_stop') {
      const call = writing.get(event.index)
      writing.delete(event.index)
      if (call) {
        let input: unknown
        try {
          input = JSON.parse(call.input || '{}')
        } catch {
          // Half an input says nothing yet; the reply as a whole is read again at its end.
        }
        const known = claudeCall(call.block, input)
        if (known) web.put(known)
      }
    }
    if (event.type !== 'content_block_delta') continue
    if (event.delta.type === 'input_json_delta' && writing.has(event.index)) writing.get(event.index)!.input += event.delta.partial_json
    // Text, thinking, or the input of a tool call being written.
    request.probe?.arrived()
    if (event.delta.type === 'text_delta') {
      message.content += event.delta.text
      request.onText(event.delta.text)
    } else if (event.delta.type === 'thinking_delta') {
      message.reasoning_content = (message.reasoning_content ?? '') + event.delta.thinking
      request.onReasoning(event.delta.thinking)
    }
  }
  const final = await stream.finalMessage()
  request.probe?.usage(final.usage)
  if (final.stop_reason) request.probe?.finished(final.stop_reason)
  // The whole reply has the last word on each search: what it searched for, and what came of it.
  for (const block of final.content) {
    const searched = claudeCall(block) ?? claudeResult(block)
    if (searched) web.put(searched)
  }

  if (final.stop_reason === 'refusal') {
    const category = final.stop_details?.category
    return { message, stopped: `The model declined this request${category ? ` (${category})` : ''}.` }
  }
  if (final.stop_reason === 'model_context_window_exceeded') {
    return { message, stopped: "The conversation no longer fits in the model's context window.", tooLong: true }
  }
  const calls: ToolCall[] = []
  for (const block of final.content) {
    if (block.type === 'tool_use') calls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) })
  }
  if (final.stop_reason === 'max_tokens') {
    // A tool input cut off here usually still parses, as a shorter input. It must not run.
    return {
      message,
      stopped: calls.length
        ? 'The model ran out of output space in the middle of a tool call, so the call was not run.'
        : 'The model ran out of output space before it finished.'
    }
  }
  if (calls.length) message.tool_calls = calls
  if (message.origin) message.origin.replay = final.content
  return { message }
}

export const anthropicAdapter: ProviderAdapter = {
  async complete(asked: ModelRequest): Promise<ModelReply> {
    let request = asked
    for (let tries = 0; ; tries++) {
      const message = newReply(request.connection)
      try {
        return await attempt(request, message)
      } catch (err) {
        // A stop request keeps whatever text arrived; unfinished tool calls are dropped.
        if (request.signal.aborted) return { message }
        // Faster answers have limits and capacity of their own. When those are used up, the usual
        // speed still works, so the request is made again without asking for speed.
        const noRoom = err instanceof Anthropic.APIError && (err.status === 429 || err.status === 529)
        if (noRoom && request.connection.fast && !message.content && !message.reasoning_content) {
          request = { ...request, connection: { ...request.connection, fast: false } }
          continue
        }
        // The PDFs were what was turned down (too many pages, a request too large with them): the
        // caller can send the message again with those told of by where they lie.
        if (!message.content && !message.reasoning_content && carriesDocuments(request) && refusesDocuments(err)) throw new DocumentsRefused((err as Error).message)
        // The pictures were what was turned down, as a gateway in front of the API may do: the
        // caller can send the message again with those told in words.
        if (!message.content && !message.reasoning_content && carriesImages(request) && refusesImages(err)) throw new ImagesRefused((err as Error).message)
        // What the service reports (bad key, rate limit, invalid request) is for the user to see.
        if (err instanceof Anthropic.APIError) throw err
        // What is left is a dropped connection, or a tool input the SDK could not read at all.
        // Asking again is safe only while nothing of this reply has been shown.
        if (message.content || message.reasoning_content || tries >= 2) throw err
      }
    }
  },

  async listModels(connection: Connection): Promise<ModelChoice[]> {
    const choices: ModelChoice[] = []
    for await (const model of clientFor(connection, TIMEOUT_MS).models.list()) {
      if (model.lifecycle !== 'retired') choices.push({ id: model.id, name: model.display_name })
    }
    return choices
  },

  async modelInfo(connection: Connection): Promise<ModelInfo | null> {
    const facts = await factsFor(connection)
    return {
      name: facts.name,
      ...(facts.efforts.length ? { efforts: facts.efforts } : {}),
      ...(facts.contextWindow ? { contextWindow: facts.contextWindow } : {})
    }
  }
}
