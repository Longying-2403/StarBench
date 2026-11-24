// OpenAI-compatible chat completions: DeepSeek, xAI and most other services, the model servers
// people run on their own machines among them.

import OpenAI from 'openai'
import { isGemini, isLocalAddress, routesByConversation } from '../../shared/types.ts'
import type { ToolCall } from '../../shared/types.ts'
import { fetchModelInfo, listModels } from '../models.ts'
import { ImagesRefused, carriesImages, imageUrl, refusesImages, userImages } from './attachments.ts'
import { refusesEffort } from './effort.ts'
import { newReply, replayOf, userText, withSearchNote, withToolResults } from './history.ts'
import { ThinkTags } from './think-tags.ts'
import type { Split } from './think-tags.ts'
import { WrittenCalls, callText, newCallId, resultText, textBeforeCalls, toolsPrompt, trailingCalls } from './tool-text.ts'
import type { WrittenCall } from './tool-text.ts'
import { ToolsRefused } from './types.ts'
import type { AssistantMessage, Connection, ModelReply, ModelRequest, ProviderAdapter } from './types.ts'
import { WebLog, deepSeekActivities } from './web-search.ts'

type ApiMessage = OpenAI.Chat.ChatCompletionMessageParam

/**
 * How a service handed over a model's thinking, when not as `reasoning_content`: under the name
 * `reasoning` (Ollama, OpenRouter), or `inline`, between <think> tags at the start of the answer
 * (servers that pass on what the model wrote as it is). Kept with the message as its `replay`.
 */
type Thinking = 'reasoning' | 'inline'

/**
 * What a reply keeps to be continued from exactly (`origin.replay`): how its thinking came, and
 * the signatures Gemini put on its tool calls, by call id. Gemini 3 and later refuse a request
 * that carries a call of theirs back without its signature
 * (https://ai.google.dev/gemini-api/docs/thought-signatures).
 */
interface ChatReplay {
  thinking?: Thinking
  signatures?: Record<string, string>
}

/**
 * What Gemini's OpenAI-compatible endpoint puts on a tool call besides what OpenAI's has: the
 * signature of the thinking that led to it.
 */
interface GeminiExtra {
  google?: { thought_signature?: unknown }
}

/** What a piece of a reply can hold, be it a chunk of a stream or a whole message. */
interface Piece {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  tool_calls?: readonly { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: GeminiExtra }[] | null
  /** DeepSeek's account of the searches it made itself (`deepseek_web_search`). */
  server_tool_calls?: unknown
}

/**
 * What Gemini takes in place of a signature on a call it did not write, such as one made by
 * another model earlier in the conversation. Its documentation names this value for that.
 */
const NO_SIGNATURE = 'skip_thought_signature_validator'

/**
 * The names DeepSeek keeps for its own tools while its search is on: a function of the request
 * with one of them is refused ("the name `search` is reserved when `deepseek_web_search` is
 * used"; these four found by trying, 2026-11-23). A tool of the app's with such a name goes by
 * another one on the wire, and the model's calls of that name are read back as the tool's own.
 * `search`, the app's search through the files, is the one that matters.
 */
const RESERVED_BY_SEARCH: Readonly<Record<string, string>> = {
  search: 'search_files',
  image_search: 'image_search_tool',
  open: 'open_tool',
  find: 'find_tool'
}

/** What a tool is called on the wire, and what a name from the wire is called in the app, for this connection. */
export function wireNames(connection: Pick<Connection, 'webSearch'>): { out(name: string): string; back(name: string): string } {
  if (!connection.webSearch) return { out: (name) => name, back: (name) => name }
  const backwards = new Map(Object.entries(RESERVED_BY_SEARCH).map(([own, wire]) => [wire, own]))
  return { out: (name) => RESERVED_BY_SEARCH[name] ?? name, back: (name) => backwards.get(name) ?? name }
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
 * Whether an error is a server turning a request down for a field it does not know,
 * `stream_options`: the one that asks what a streamed reply cost. Most servers pass over what
 * they do not know; one with a strict schema names the field in its refusal.
 */
export function refusesStreamOptions(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status === undefined) return false
  return err.status >= 400 && err.status < 500 && /stream_options|include_usage/i.test(err.message)
}

/**
 * The servers that refused that field, by address. It is only ever sent while someone watches
 * (see `ModelRequest.probe`), and a server that refused it once is not sent it again for as long
 * as the app runs: the watching must not cost a failed request every time.
 */
const takesNoStreamOptions = new Set<string>()

/**
 * The models whose answers begin inside the thinking, by server and name. Their template writes
 * the opening tag itself (Qwen 3.5 is one) and the server passes on what the model wrote, so
 * that only a closing tag shows where the thinking ends. Once an answer showed that, the next
 * ones are read as thinking from their first word on, instead of being shown as the answer until
 * the tag comes. Kept for as long as the app runs; an answer without the tag takes the model off again.
 */
const thinksUnopened = new Set<string>()

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

type UserPart = OpenAI.Chat.ChatCompletionContentPart
/** What a user message says, as the parts of a message that also holds pictures. Text that is empty is no part. */
const partsOf = (content: string | readonly UserPart[]): UserPart[] => (typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : [...content])

/**
 * The conversation as chat completions take it. Two user messages in a row, as there are after a
 * reply that failed, go out as one, because many chat templates insist on taking turns.
 *
 * `turns` is for a server that takes nothing but strict turns (see `Connection.wholeReplies`):
 * the results of several tool calls go out as one, and a user message that follows tool results
 * directly gets a line in between that stands for the reply that never came.
 *
 * For a server that takes no tool definitions (see `Connection.textTools`) everything about tools
 * is written out: the tools at the end of the instructions, each call in the reply that made it,
 * and the results as a message of the user's, the way the models' own templates put them. Such a
 * conversation is strict turns by itself.
 */
export function chatMessages(
  request: Pick<ModelRequest, 'messages' | 'connection' | 'system'> & Partial<Pick<ModelRequest, 'tools'>>,
  turns: boolean = request.connection.wholeReplies ?? false
): ApiMessage[] {
  const written = Boolean(request.connection.textTools)
  const system = written && request.tools?.length ? `${request.system}\n\n${toolsPrompt(request.tools)}` : request.system
  // No instructions (a plain chat of someone who wrote none) is no system message, not an empty
  // one: a chat template makes of the two what it will, and often not the same.
  const out: ApiMessage[] = system ? [{ role: 'system', content: system }] : []
  const names = wireNames(request.connection)
  for (const message of withToolResults(request.messages)) {
    const before = out.at(-1)
    if (message.role === 'user') {
      const text = userText(message, request.connection)
      // Pictures make the message a list of parts: the text, then each picture as an address that holds it.
      const images = userImages(message, request.connection).map((image): UserPart => ({ type: 'image_url', image_url: { url: imageUrl(image) } }))
      if (before?.role === 'user') {
        if (typeof before.content === 'string' && images.length === 0) before.content = `${before.content}\n\n${text}`
        else before.content = [...partsOf(before.content), ...partsOf(text), ...images]
        continue
      }
      if (turns && before?.role === 'tool') out.push({ role: 'assistant', content: NO_REPLY })
      out.push({ role: 'user', content: images.length ? [...partsOf(text), ...images] : text })
    } else if (message.role === 'tool') {
      if (written) {
        // The results of one reply's calls stand together, one under the other.
        if (before?.role === 'user' && typeof before.content === 'string') before.content = `${before.content}\n${resultText(message.content)}`
        else out.push({ role: 'user', content: resultText(message.content) })
        continue
      }
      if (turns && before?.role === 'tool' && typeof before.content === 'string') {
        before.content = `${before.content}\n\n${message.content}`
        continue
      }
      out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content })
    } else {
      // DeepSeek wants its own reasoning back on every assistant message when tools are in the
      // request, and counts it as input again. xAI asks for it too, for the sake of its cache;
      // what it counts of a reply's thinking in every later request it puts there itself, sent
      // back or not (tried with one conversation through two connections, 2026-11-23). So leaving
      // it out saves nothing there, and with DeepSeek only by going against what it asks for.
      // Reasoning another service wrote is left out: it means nothing here and an unknown field
      // can be refused. Messages from before origins were recorded are this service's.
      const own = !message.origin || message.origin.provider === request.connection.provider
      const field = thinkingField(message, request.connection)
      const calls = message.tool_calls ?? []
      // Gemini wants its own calls back with their signatures, and the first call of a reply it
      // did not write with the value that stands for none.
      const replay = replayOf(message, request.connection)
      const signatures = typeof replay === 'object' && replay !== null ? ((replay as ChatReplay).signatures ?? {}) : {}
      const gemini = isGemini(request.connection.baseURL)
      const signed = (id: string, first: boolean): { extra_content?: GeminiExtra } => {
        const signature = signatures[id] ?? (gemini && first ? NO_SIGNATURE : undefined)
        return signature ? { extra_content: { google: { thought_signature: signature } } } : {}
      }
      // The reply's own web searches are told in words in front of it: they never go back in another form here.
      const said = withSearchNote(message)
      out.push({
        role: 'assistant',
        // Written out, a call follows what the model said before it, as the model would write it.
        content: written && calls.length ? [said, calls.map(callText).join('\n')].filter(Boolean).join('\n\n') : said,
        // Neither name is in the SDK's message type.
        ...(own && message.reasoning_content && field ? { [field]: message.reasoning_content } : {}),
        ...(calls.length && !written
          ? {
              tool_calls: calls.map((c, index) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: names.out(c.name), arguments: c.arguments },
                ...signed(c.id, index === 0)
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
    const { connection, signal, probe } = request
    const client = new OpenAI({ apiKey: connection.apiKey, baseURL: connection.baseURL, fetch: readableErrors })
    const message = newReply(connection)
    const calls: ToolCall[] = []
    /** The signatures Gemini put on the calls, by call (see `ChatReplay`). */
    const signatureOf = new Map<ToolCall, string>()
    const web = new WebLog(message, request.onWebActivity)
    /** The level of thinking the request names: the one chosen, until the service turns out not to take it. */
    let level = connection.reasoningEffort
    /** What the service said when it turned the level down, kept until it has taken the request without one. */
    let levelRefused: string | undefined
    // Which conversation this is, for a service that sends a conversation's requests to one
    // server by it. In this format xAI reads it from a header.
    const named = request.conversation && routesByConversation(connection.baseURL) ? { 'x-grok-conv-id': request.conversation } : undefined
    const routed = named ? { headers: named } : {}
    let cutShort = false
    /** How the thinking came, when not under its usual name. */
    let thinking: Thinking | undefined
    /** What this model goes by among those whose answers begin inside the thinking. */
    const thinker = `${connection.baseURL}\n${connection.model}`
    // Thinking without its opening tag is looked for where a server passes on what the model
    // wrote: on a server of one's own. A service on the internet keeps the thinking apart, and a
    // line of its answer that happens to begin with the closing tag is part of the answer.
    const tags = new ThinkTags(thinksUnopened.has(thinker) ? 'expect' : isLocalAddress(connection.baseURL) ? 'watch' : 'no')
    /** What `tags` handed on as thinking on the strength of earlier answers alone. */
    let assumed = ''
    const offered = request.tools.length > 0
    /** The tools are described in the instructions and not handed over, so every call comes as text (`Connection.textTools`). */
    const described = offered && Boolean(connection.textTools)
    /** The tools go out in the request, the way the API has them. */
    const wired = offered && !described
    // A server of one's own may also leave a call in the answer although it took the tools: it
    // has no parser for the model's format, or the model wrote the call a little differently. So
    // the answer is watched for calls there too. Not with a service on the internet: those hand
    // their calls over, and a model that merely quotes a text with such a call in it (a file it
    // was asked to show) must not have made one by that.
    const watched = described || (offered && isLocalAddress(connection.baseURL))
    const written = watched ? new WrittenCalls(request.tools, described) : undefined
    const show = (text: string): void => {
      if (!text) return
      message.content += text
      request.onText(text)
    }
    /** Tells whoever shows the reply that what it was handed so far reads differently now. */
    const rewrite = (): void => request.onRewrite?.({ text: message.content, reasoning: message.reasoning_content ?? '' })
    const take = ({ reasoning, text, wasThinking }: Split): void => {
      if (wasThinking) {
        // The answer had begun inside the thinking. What was handed on as its text so far is
        // thinking, and so is what was held back of it as a possible tool call: a call the model
        // only thought about is none.
        const thought = message.content + (written?.drain() ?? '')
        message.content = ''
        if (thought.trim()) message.reasoning_content = (message.reasoning_content ?? '') + thought.trimStart()
        if (thought) rewrite()
        if (!message.reasoning_content) reasoning = reasoning.trimStart()
      }
      if (reasoning) {
        message.reasoning_content = (message.reasoning_content ?? '') + reasoning
        request.onReasoning(reasoning)
      }
      show(written ? written.push(text) : text)
    }
    /** Takes in what `tags` made of a piece of the answer. */
    const said = (split: Split): void => {
      if (tags.assumed) assumed += split.reasoning
      take(split)
    }
    /** The service hands the thinking over by itself: none of it is to be looked for in the answer. */
    const apart = (): void => {
      tags.settle()
      thinksUnopened.delete(thinker)
    }
    /** Takes in one piece of the reply: a chunk of a stream, or the whole message of a reply that came in one piece. */
    const absorb = (piece: Piece): void => {
      // The thinking has two names: DeepSeek's, which most services took over, and a shorter one.
      if (typeof piece.reasoning_content === 'string' && piece.reasoning_content) {
        apart()
        take({ reasoning: piece.reasoning_content, text: '' })
      } else if (typeof piece.reasoning === 'string' && piece.reasoning) {
        thinking = 'reasoning'
        apart()
        take({ reasoning: piece.reasoning, text: '' })
      }
      // Or none, and comes inside the answer: between tags at its start, or up to a closing tag.
      if (typeof piece.content === 'string' && piece.content) said(tags.push(piece.content))
      for (const [position, part] of (piece.tool_calls ?? []).entries()) {
        // A stream numbers its calls; in a whole message their order is their number.
        const call = (calls[part.index ?? position] ??= { id: '', name: '', arguments: '' })
        if (part.id) call.id = part.id
        if (part.function?.name) call.name += part.function.name
        if (part.function?.arguments) call.arguments += part.function.arguments
        const signature = part.extra_content?.google?.thought_signature
        if (typeof signature === 'string' && signature) signatureOf.set(call, signature)
      }
      // DeepSeek tells of its searches in one piece, every one of them done.
      if (piece.server_tool_calls) for (const searched of deepSeekActivities(piece.server_tool_calls)) web.put(searched)
    }
    /**
     * DeepSeek's own web search, which it runs itself and tells of in `server_tool_calls`. Only
     * DeepSeek is ever marked for it (`webSearchService`); the SDK's type does not know the tool.
     */
    const search = connection.webSearch && !described ? [{ type: 'deepseek_web_search' } as unknown as OpenAI.Chat.ChatCompletionTool] : []
    const names = wireNames(connection)
    const functions = wired ? request.tools.map((t) => ({ type: 'function' as const, function: { ...t, name: names.out(t.name) } })) : []
    /** The request, but for how the reply is to come. `turns` is for a server that takes strict turns only. */
    const body = (turns: boolean) => ({
      // What plugins add. It comes first, so that nothing in it replaces a field below.
      ...(request.sampling as object | undefined),
      model: connection.model,
      messages: chatMessages(request, turns),
      // The API rejects an empty tools array. A server that takes none finds them in the instructions.
      ...(functions.length || search.length ? { tools: [...functions, ...search] } : {}),
      // Left out unless the user chose a level: not every compatible service knows the parameter.
      // The cast is for levels the SDK's list does not have but some services do.
      ...(level !== 'default' ? { reasoning_effort: level as OpenAI.ReasoningEffort } : {})
    })
    /** An error from before anything of the reply arrived, turned into what it means where that is known. */
    const explained = (err: unknown): unknown => {
      if (signal.aborted) return err
      // The caller can send the message again with the tools described in the instructions.
      if (wired && refusesTools(err)) return new ToolsRefused((err as Error).message)
      // Or, where it was the pictures that were turned down, with those told in words.
      if (carriesImages(request) && refusesImages(err)) return new ImagesRefused((err as Error).message)
      // A model server on one's own machine that does not answer is, as a rule, one that was not started.
      if (err instanceof OpenAI.APIConnectionError && isLocalAddress(connection.baseURL)) {
        return new Error(`Could not reach the model server at ${connection.baseURL}. Is it running?`)
      }
      return err
    }
    /**
     * Whether an error from before anything of the reply arrived is the service turning down the
     * level of thinking. The request is then made again without one: a level the model does not
     * take must not be what stops the conversation, and nothing but leaving it out puts that right.
     */
    const dropsLevel = (err: unknown): boolean => {
      if (level === 'default' || signal.aborted || !refusesEffort(err)) return false
      levelRefused = (err as Error).message
      level = 'default'
      return true
    }
    /** The service took the request. Where it had turned the level down, it is known now that the level was all that was wrong. */
    const accepted = (): void => {
      if (levelRefused === undefined) return
      request.onEffortRefused?.(levelRefused)
      levelRefused = undefined
    }

    /**
     * What is kept of a reply that was stopped: the text and the thinking that arrived. A tool
     * call that was still coming is dropped, whether the service was handing it over or the model
     * was writing it into the answer: its arguments are cut off, and kept with the message they
     * would be sent back as they are with every later request.
     */
    const halted = (): ModelReply => {
      said(tags.end())
      // The beginning of a tag that never came is text; a call that had begun is not.
      const tail = written?.end()
      if (tail && !tail.begun) show(tail.text)
      // Thinking still going on is thinking, also where it was only taken for it: nothing has
      // shown that it was the answer. It goes back to the server the way it came, or not at all.
      if (tags.found || (tags.assumed && tags.open)) thinking = 'inline'
      if (thinking && message.reasoning_content && message.origin) message.origin.replay = { thinking }
      if (tags.bare) thinksUnopened.add(thinker)
      return { message }
    }

    /** The reply is asked for in one piece: the server is known not to stream it, or turns out not to. */
    let whole = Boolean(connection.wholeReplies) && wired
    try {
      if (!whole) {
        let opened = false
        let pieces = 0
        // What a streamed reply cost is told only when asked for, in a last piece of its own. It
        // is asked for while the app keeps count or a plugin watches, and not otherwise: a server
        // may not know the field.
        let askCost = Boolean(probe) && !takesNoStreamOptions.has(connection.baseURL)
        for (;;) {
          try {
            const wire = { ...body(false), stream: true as const, ...(askCost ? { stream_options: { include_usage: true } } : {}) }
            probe?.sent(wire, named)
            const stream = await client.chat.completions.create(wire, { signal, ...routed })
            opened = true
            accepted()
            for await (const chunk of stream) {
              pieces++
              const choice = chunk.choices[0]
              if (chunk.usage) probe?.usage(chunk.usage)
              if (choice?.finish_reason) probe?.finished(choice.finish_reason)
              if (choice?.finish_reason === 'length') cutShort = true
              if (choice?.delta) {
                probe?.arrived()
                absorb(choice.delta)
              }
            }
            // A stream that ends without a single piece is the same failure, taken more quietly.
            if (pieces === 0 && !signal.aborted && wired && isLocalAddress(connection.baseURL)) whole = true
          } catch (err) {
            if (pieces > 0) throw err
            // Watching must not be what breaks the conversation: a server that turns the field
            // down is asked again without it, and the record goes without the cost.
            if (askCost && !signal.aborted && refusesStreamOptions(err)) {
              takesNoStreamOptions.add(connection.baseURL)
              askCost = false
              continue
            }
            // Neither must a level of thinking the model does not take: asked again without one.
            if (dropsLevel(err)) continue
            if (signal.aborted || !wired || !cannotStream(err, opened, connection)) throw explained(err)
            whole = true
          }
          break
        }
      }
      if (whole) {
        const asked = async (): Promise<OpenAI.Chat.ChatCompletion> => {
          for (;;) {
            const wire = { ...body(true), stream: false as const }
            probe?.sent(wire, named)
            try {
              return await client.chat.completions.create(wire, { signal, ...routed })
            } catch (err) {
              // Once more without the level of thinking, where that is what the server turned down.
              if (!dropsLevel(err)) throw explained(err)
            }
          }
        }
        const completion = await asked()
        accepted()
        // Found out with this very request: said before the reply, which now appears all at once.
        if (!connection.wholeReplies) request.onStreamRefused?.()
        const choice = completion.choices?.[0]
        if (completion.usage) probe?.usage(completion.usage)
        if (choice?.finish_reason) probe?.finished(choice.finish_reason)
        if (choice?.finish_reason === 'length') cutShort = true
        if (choice?.message) absorb(choice.message)
      }
    } catch (err) {
      // A stop before the reply began, or while it was awaited in one piece.
      if (!signal.aborted) throw err
      return halted()
    }
    // A stop in the middle of a streamed reply throws nothing: the client ends the stream
    // quietly, and the pieces just stop coming. What arrived is no finished reply either.
    if (signal.aborted) return halted()
    said(tags.end())
    if (tags.bare) thinksUnopened.add(thinker)
    if (tags.assumed && tags.open && !cutShort && !request.unattended) {
      // Taken for thinking, and the end of the thinking never came: the model did not think this
      // time, and what it wrote was the answer. It goes where an answer goes, with any tool call
      // in it; the next answer is not taken for thinking unasked. (An answer that ran out of
      // output space is left as it is: that it ran out while thinking is the likelier case. And
      // nothing is guessed about a reply nobody reads as it comes: taken for the answer wrongly,
      // the thinking would be put to use as it stands.)
      thinksUnopened.delete(thinker)
      if (assumed) {
        const thought = message.reasoning_content ?? ''
        const before = thought.slice(0, thought.length - assumed.length)
        if (before) message.reasoning_content = before
        else delete message.reasoning_content
        rewrite()
        take({ reasoning: '', text: assumed })
      }
    }
    const tail = written?.end()
    // Thinking that was only taken for it and is left as it is came inside the answer as well.
    if (tags.found || (tags.assumed && tags.open)) thinking = 'inline'
    if (thinking && message.reasoning_content && message.origin) message.origin.replay = { thinking }
    // Calls of a tool that went by another name on the wire are calls of the tool (`wireNames`).
    let complete = calls.filter((c) => c && c.id && c.name)
    for (const call of complete) call.name = names.back(call.name)
    const called = (found: readonly WrittenCall[]): ToolCall[] => found.map((call) => ({ id: newCallId(), ...call }))
    if (tail && !complete.length && tail.calls.length) {
      // The server left the calls in the answer, where they were held back from the page. What
      // stood before them is the text of the message.
      complete = called(tail.calls)
      const before = textBeforeCalls(message.content)
      // The opening of a code block that the model put its call in was shown as it came.
      const shown = before !== message.content.trimEnd()
      message.content = before
      if (shown) rewrite()
    } else if (tail && !(cutShort && tail.unfinished)) {
      // Held back for nothing: text like any other. (Half a call that the output was cut short in is not text to show.)
      show(tail.text)
      // Or the call stands at the end of the answer with no tags around it, and was shown as it came.
      const bare = !complete.length && !cutShort ? trailingCalls(message.content, request.tools) : undefined
      if (bare) {
        complete = called(bare.calls)
        message.content = bare.text
        rewrite()
      }
    }
    // Strict turns have room for one result. The model makes its other calls once it has seen this one.
    if (whole && complete.length > 1) complete = complete.slice(0, 1)
    if (complete.length) message.tool_calls = complete
    const signatures = Object.fromEntries(complete.flatMap((c) => (signatureOf.has(c) ? [[c.id, signatureOf.get(c)!]] : [])))
    if (Object.keys(signatures).length && message.origin) {
      const replay: ChatReplay = { ...(message.origin.replay as ChatReplay | undefined), signatures }
      message.origin.replay = replay
    }
    // Cut off in the middle of a tool call, its arguments are incomplete: running it would act on half an input.
    if (cutShort && (complete.length || tail?.unfinished)) {
      delete message.tool_calls
      return { message, stopped: 'The model ran out of output space in the middle of a tool call, so the call was not run.' }
    }
    // A reply the app puts to use as it stands is no use cut short: it is half of what was asked
    // for, or the thinking before it. The words are the ones the other formats say this in.
    if (cutShort && request.unattended) return { message, stopped: 'The model ran out of output space before it finished.' }
    return { message }
  },

  listModels: (connection) => listModels(connection),
  modelInfo: (connection) => fetchModelInfo(connection)
}
