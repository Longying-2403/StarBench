// OpenAI-compatible chat completions: DeepSeek, xAI and most other services, the model servers
// people run on their own machines among them.

import OpenAI from 'openai'
import { isLocalAddress } from '../../shared/types.ts'
import type { ToolCall } from '../../shared/types.ts'
import { fetchModelInfo, listModels } from '../models.ts'
import { newReply, replayOf, userText, withToolResults } from './history.ts'
import { ThinkTags } from './think-tags.ts'
import type { Split } from './think-tags.ts'
import { ToolsRefused } from './types.ts'
import type { AssistantMessage, Connection, ModelReply, ModelRequest, ProviderAdapter } from './types.ts'

type ApiMessage = OpenAI.Chat.ChatCompletionMessageParam

/**
 * How a service handed over a model's thinking, when not as `reasoning_content`: under the name
 * `reasoning` (Ollama, OpenRouter), or `inline`, between <think> tags at the start of the answer
 * (servers that pass on what the model wrote as it is). Kept with the message as its `replay`.
 */
type Thinking = 'reasoning' | 'inline'

/** What a piece of a reply can hold, be it a chunk of a stream or a whole message. */
interface Piece {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  tool_calls?: readonly { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | null
}

/**
 * The name under which a service wants a message's thinking back, if at all. It gets it under
 * the name it used itself. Thinking that came inside the answer is not sent back: such a server
 * knows no field for it, and the models do not expect to see old thinking again.
 */
function thinkingField(message: AssistantMessage, connection: Connection): 'reasoning_content' | 'reasoning' | undefined {
  const replay = replayOf(message, connection)
  const how: unknown = typeof replay === 'object' && replay !== null ? (replay as { thinking?: unknown }).thinking : undefined
  if (how === 'inline') return undefined
  return how === 'reasoning' ? 'reasoning' : 'reasoning_content'
}

/**
 * Whether an error says that the model, or the server running it, takes no tools. Every server
 * words it its own way: "does not support tools" (Ollama), "tools param requires --jinja flag"
 * (llama.cpp), "tool choice requires --enable-auto-tool-choice" (vLLM), "no endpoints found that
 * support tool use" (gateways). An error about one particular tool does not count.
 */
export function refusesTools(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  const not = String.raw`(?:\bnot\b|n't\b|\bno\b)`
  const tools = String.raw`\b(?:tools?|function)`
  const unsupported = new RegExp(`${not}[^.]{0,60}\\bsupport[^.]{0,60}${tools}|${tools}[^.]{0,60}${not}[^.]{0,30}\\bsupport`, 'i')
  return unsupported.test(err.message) || /requires? --jinja|tool choice requires/i.test(err.message)
}

/**
 * Whether a failed attempt to stream a reply means that this server cannot stream one while tools
 * are offered. Some say so before they start. LLaMA-Factory's API finds out after it has started
 * the reply, so all that arrives is a stream that breaks off before its first piece; that is
 * taken for the same thing on a server of one's own, where a broken line is not the likelier cause.
 */
export function cannotStream(err: unknown, opened: boolean, connection: Pick<Connection, 'baseURL'>): boolean {
  if (err instanceof OpenAI.APIError && err.status !== undefined) {
    return /stream/i.test(err.message) && /\b(?:tools?|function)/i.test(err.message)
  }
  return opened && isLocalAddress(connection.baseURL)
}

/**
 * Servers built on FastAPI answer an error with `{"detail": "..."}`, and some others with a
 * `message` at the top. The client reads `{"error": {"message": "..."}}` and, finding none, reports
 * nothing but the status. This gives such an answer the shape the client reads, so that what the
 * server said reaches the person.
 */
async function readableErrors(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  if (response.ok) return response
  const text = await response.text()
  let said: unknown
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === 'object' && body !== null && !('error' in body)) {
      said = (body as { detail?: unknown }).detail ?? (body as { message?: unknown }).message
    }
  } catch {
    // Not JSON: the client shows the text as it is.
  }
  const headers = new Headers(response.headers)
  // They describe the body as it travelled, not the one made here.
  headers.delete('content-length')
  headers.delete('content-encoding')
  const body = said === undefined ? text : JSON.stringify({ error: { message: typeof said === 'string' ? said : JSON.stringify(said) } })
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/** Put between tool results and a user message that follows them directly, for a server that takes strict turns. */
const NO_REPLY = '(No reply: the turn was stopped here.)'

/**
 * The conversation as chat completions take it. Two user messages in a row, as there are after a
 * reply that failed, go out as one, because many chat templates insist on taking turns.
 *
 * `turns` is for a server that takes nothing but strict turns (see `Connection.wholeReplies`):
 * the results of several tool calls go out as one, and a user message that follows tool results
 * directly gets a line in between that stands for the reply that never came.
 */
export function chatMessages(
  request: Pick<ModelRequest, 'messages' | 'connection' | 'system'>,
  turns: boolean = request.connection.wholeReplies ?? false
): ApiMessage[] {
  const out: ApiMessage[] = [{ role: 'system', content: request.system }]
  for (const message of withToolResults(request.messages)) {
    const before = out.at(-1)
    if (message.role === 'user') {
      if (before?.role === 'user' && typeof before.content === 'string') {
        before.content = `${before.content}\n\n${userText(message)}`
        continue
      }
      if (turns && before?.role === 'tool') out.push({ role: 'assistant', content: NO_REPLY })
      out.push({ role: 'user', content: userText(message) })
    } else if (message.role === 'tool') {
      if (turns && before?.role === 'tool' && typeof before.content === 'string') {
        before.content = `${before.content}\n\n${message.content}`
        continue
      }
      out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content })
    } else {
      // DeepSeek wants its own reasoning back on every assistant message when tools are in the
      // request. Reasoning another service wrote is left out: it means nothing here and an
      // unknown field can be refused. Messages from before origins were recorded are this service's.
      const own = !message.origin || message.origin.provider === request.connection.provider
      const field = thinkingField(message, request.connection)
      out.push({
        role: 'assistant',
        content: message.content,
        // Neither name is in the SDK's message type.
        ...(own && message.reasoning_content && field ? { [field]: message.reasoning_content } : {}),
        ...(message.tool_calls?.length
          ? {
              tool_calls: message.tool_calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments }
              }))
            }
          : {})
      } as ApiMessage)
    }
  }
  return out
}

export const chatAdapter: ProviderAdapter = {
  async complete(request: ModelRequest): Promise<ModelReply> {
    const { connection, signal } = request
    const client = new OpenAI({ apiKey: connection.apiKey, baseURL: connection.baseURL, fetch: readableErrors })
    const message = newReply(connection)
    const calls: ToolCall[] = []
    const effort = connection.reasoningEffort
    let cutShort = false
    /** How the thinking came, when not under its usual name. */
    let thinking: Thinking | undefined
    const tags = new ThinkTags()
    const take = ({ reasoning, text }: Split): void => {
      if (reasoning) {
        message.reasoning_content = (message.reasoning_content ?? '') + reasoning
        request.onReasoning(reasoning)
      }
      if (text) {
        message.content += text
        request.onText(text)
      }
    }
    /** Takes in one piece of the reply: a chunk of a stream, or the whole message of a reply that came in one piece. */
    const absorb = (piece: Piece): void => {
      // The thinking has two names: DeepSeek's, which most services took over, and a shorter one.
      if (typeof piece.reasoning_content === 'string' && piece.reasoning_content) {
        take({ reasoning: piece.reasoning_content, text: '' })
      } else if (typeof piece.reasoning === 'string' && piece.reasoning) {
        thinking = 'reasoning'
        take({ reasoning: piece.reasoning, text: '' })
      }
      // Or none, and comes at the start of the answer between tags.
      if (typeof piece.content === 'string' && piece.content) take(tags.push(piece.content))
      for (const [position, part] of (piece.tool_calls ?? []).entries()) {
        // A stream numbers its calls; in a whole message their order is their number.
        const call = (calls[part.index ?? position] ??= { id: '', name: '', arguments: '' })
        if (part.id) call.id = part.id
        if (part.function?.name) call.name += part.function.name
        if (part.function?.arguments) call.arguments += part.function.arguments
      }
    }
    /** The request, but for how the reply is to come. `turns` is for a server that takes strict turns only. */
    const body = (turns: boolean) => ({
      model: connection.model,
      messages: chatMessages(request, turns),
      // The API rejects an empty tools array.
      ...(request.tools.length ? { tools: request.tools.map((t) => ({ type: 'function' as const, function: { ...t } })) } : {}),
      // Left out unless the user chose a level: not every compatible service knows the parameter.
      // The cast is for levels the SDK's list does not have but some services do.
      ...(effort !== 'default' ? { reasoning_effort: effort as OpenAI.ReasoningEffort } : {})
    })
    /** An error from before anything of the reply arrived, turned into what it means where that is known. */
    const explained = (err: unknown): unknown => {
      if (signal.aborted) return err
      // The caller can send the message again without tools.
      if (request.tools.length && refusesTools(err)) return new ToolsRefused((err as Error).message)
      // A model server on one's own machine that does not answer is, as a rule, one that was not started.
      if (err instanceof OpenAI.APIConnectionError && isLocalAddress(connection.baseURL)) {
        return new Error(`Could not reach the model server at ${connection.baseURL}. Is it running?`)
      }
      return err
    }

    /** The reply is asked for in one piece: the server is known not to stream it, or turns out not to. */
    let whole = Boolean(connection.wholeReplies) && request.tools.length > 0
    try {
      if (!whole) {
        let opened = false
        let pieces = 0
        try {
          const stream = await client.chat.completions.create({ ...body(false), stream: true }, { signal })
          opened = true
          for await (const chunk of stream) {
            pieces++
            const choice = chunk.choices[0]
            if (choice?.finish_reason === 'length') cutShort = true
            if (choice?.delta) absorb(choice.delta)
          }
          // A stream that ends without a single piece is the same failure, taken more quietly.
          if (pieces === 0 && !signal.aborted && request.tools.length && isLocalAddress(connection.baseURL)) whole = true
        } catch (err) {
          if (pieces > 0) throw err
          if (signal.aborted || !request.tools.length || !cannotStream(err, opened, connection)) throw explained(err)
          whole = true
        }
      }
      if (whole) {
        const completion = await client.chat.completions.create({ ...body(true), stream: false }, { signal }).catch((err: unknown) => {
          throw explained(err)
        })
        // Found out with this very request: said before the reply, which now appears all at once.
        if (!connection.wholeReplies) request.onStreamRefused?.()
        const choice = completion.choices?.[0]
        if (choice?.finish_reason === 'length') cutShort = true
        if (choice?.message) absorb(choice.message)
      }
    } catch (err) {
      // A stop request keeps whatever text arrived; half-received tool calls are dropped.
      if (!signal.aborted) throw err
      take(tags.end())
      return { message }
    }
    take(tags.end())
    if (tags.found) thinking = 'inline'
    if (thinking && message.reasoning_content && message.origin) message.origin.replay = { thinking }
    let complete = calls.filter((c) => c && c.id && c.name)
    // Strict turns have room for one result. The model makes its other calls once it has seen this one.
    if (whole && complete.length > 1) complete = complete.slice(0, 1)
    if (complete.length) message.tool_calls = complete
    // Cut off in the middle of a tool call, its arguments are incomplete: running it would act on half an input.
    if (cutShort && complete.length) {
      delete message.tool_calls
      return { message, stopped: 'The model ran out of output space in the middle of a tool call, so the call was not run.' }
    }
    return { message }
  },

  listModels: (connection) => listModels(connection),
  modelInfo: (connection) => fetchModelInfo(connection)
}
