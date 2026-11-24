// Google's Gemini through its own API (generateContent). Google's OpenAI-compatible endpoint, which
// chat.ts speaks to, serves the same models, but only this API lets them search Google and read
// web pages while they work with the app's tools, and hands over summaries of their thinking.
//
// From Google's documentation of the generateContent API, read on 2026-11-23. ai.google.dev now
// leads to https://aistudio.google.com/docs, where the pages for this API are the ones ending in
// `?generate-content=true`; the others describe the newer Interactions API.
// - A reply is streamed from `{base}/models/{model}:streamGenerateContent?alt=sse`, with the key in
//   the `x-goog-api-key` header. Each event is a GenerateContentResponse with the parts that came
//   since the one before; the last one says why the reply ended and what it cost.
// - Gemini 3 and later sign their thinking: any part may carry a `thoughtSignature`, and the first
//   call of each step always does. Every part goes back the way it came, and a signed part is not
//   joined to another one, nor another one to it. The calls of the turn under way are checked: a
//   request without their signatures is refused with a 400 (thought-signatures). A call the model
//   did not write goes back with a value the documentation gives for that.
// - The model's own search and page reading (`googleSearch`, `urlContext`) work together with
//   function calls from Gemini 3 on (in preview), once the request asks for the service's own tool
//   calls to be handed over (`toolConfig.includeServerSideToolInvocations`). Those calls then come
//   as `toolCall` and `toolResponse` parts, which go back with the reply like every other part
//   (tool-combination). Gemini 2.5 can have one or the other, not both, so `webSearchService`
//   offers no search with it.
// - What the answer rests on comes with the reply as `groundingMetadata`: the queries, and the
//   pages, at addresses that lead through Google and titled with the site's name. It may also
//   hold Search Suggestions, HTML that Google's terms want shown with the answer; the page shows
//   them under the search they came with (`WebActivity.suggestions`; see "联网搜索" in the README).
// Seen in real replies on 2026-11-24 (Gemini 3.5 Flash-Lite and Gemini 4 Hydrogen, paid tier):
// the search's `toolResponse` part holds the Search Suggestions (`response.search_suggestions`,
// about 5 KB of HTML) and a signature of 26–56 KB, which goes back with every later request
// without being counted as input. The reply's last event brings `groundingMetadata`, which with
// Hydrogen held only the pages (no queries, no `searchEntryPoint`), and `urlContextMetadata`
// beside the page reads' own parts. A key of the free tier gets a 429 for any request with the
// search (see `explained`).

import type { ChatMessage, EffortLevel, ModelChoice, ModelInfo, ToolCall, WebActivity } from '../../shared/types.ts'
import { isGemini } from '../../shared/types.ts'
import type { ToolDefinition } from '../tools.ts'
import { ImagesRefused, carriesImages, refusesImages, userImages } from './attachments.ts'
import { isErrorResult, newReply, replayOf, searchNote, userText, withSearchNote, withToolResults } from './history.ts'
import { newCallId } from './tool-text.ts'
import type { AssistantMessage, Connection, ModelReply, ModelRequest, ProviderAdapter } from './types.ts'
import { WebLog, geminiActivity, geminiGrounding, geminiPagesRead, geminiTitledReads } from './web-search.ts'

type Bag = Record<string, unknown>
const isBag = (value: unknown): value is Bag => typeof value === 'object' && value !== null && !Array.isArray(value)
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** One part of a message as the API has it. Only the fields the app reads are named; whatever else a part holds goes back with it. */
export interface Part {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { id?: string; name?: string; args?: Bag }
  functionResponse?: { id?: string; name: string; response: Bag }
  toolCall?: Bag
  toolResponse?: Bag
  [field: string]: unknown
}

export interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

/**
 * What a reply keeps to be continued from exactly (`origin.replay`): its parts as they came, and
 * the ids the app gave its calls, in the order the calls stand among the parts. Those are
 * Gemini's own ids where it gave any (Gemini 3 always does); the parts keep what Gemini wrote.
 */
interface Replay {
  parts: Part[]
  calls: string[]
}

const isReplay = (value: unknown): value is Replay => isBag(value) && Array.isArray(value.parts) && Array.isArray(value.calls)

const OFFICIAL_API = 'https://generativelanguage.googleapis.com/v1beta'
const TIMEOUT_MS = 8000

/**
 * What Gemini takes in place of a signature on a call it did not write, such as one another model
 * made earlier in the conversation. The documentation names this value for that (thought-signatures, FAQ).
 */
const NO_SIGNATURE = 'skip_thought_signature_validator'

/**
 * The thinking levels each Gemini model takes, and the one it uses when none is sent, where the
 * documentation lists them (thinking, 2026-11-23). Gemini 4 and 3 are given a level by name
 * (`thinkingLevel`), and none of them stops thinking altogether: "minimal" comes nearest, where
 * there is one. The 2.5 models are given a number of tokens instead (`thinkingBudget`, see
 * BUDGETS); 2.5 Pro cannot stop thinking, Flash and Flash-Lite can, and Flash-Lite does not think
 * unless asked to. The first entry that fits counts.
 */
const LEVELS: readonly (readonly [RegExp, readonly EffortLevel[], EffortLevel?])[] = [
  [/^gemini-4-(neon|hydrogen)\b/, ['low', 'medium', 'high', 'xhigh'], 'high'],
  [/^gemini-4-(carbon|argon)\b/, ['low', 'medium', 'high'], 'medium'],
  [/^gemini-3\.8-flash\b/, ['low', 'medium', 'high'], 'medium'],
  [/^gemini-3\.6-flash\b/, ['minimal', 'low', 'medium', 'high'], 'medium'],
  [/^gemini-3\.5-flash-lite\b/, ['minimal', 'low', 'medium', 'high'], 'minimal'],
  [/^gemini-3\.1-pro\b/, ['low', 'medium', 'high'], 'high'],
  [/^gemini-3\.1-flash-lite\b/, ['minimal', 'low', 'medium', 'high'], 'minimal'],
  [/^gemini-3-flash\b/, ['minimal', 'low', 'medium', 'high'], 'high'],
  [/^gemini-3-pro\b/, ['low', 'high'], 'high'],
  [/^gemini-2\.5-pro\b/, ['low', 'medium', 'high']],
  [/^gemini-2\.5-flash-lite\b/, ['none', 'low', 'medium', 'high'], 'none'],
  [/^gemini-2\.5-flash\b/, ['none', 'low', 'medium', 'high']]
]

/** A model's id as the rules go by it: in any case, and without the `models/` the API puts in front. */
const idOf = (model: string): string => model.trim().toLowerCase().replace(/^models\//, '')

/** The levels a model takes and the one it uses unasked, where the documentation lists them. */
export function geminiLevels(model: string): { efforts: EffortLevel[]; usual?: EffortLevel } | undefined {
  const found = LEVELS.find(([name]) => name.test(idOf(model)))
  return found ? { efforts: [...found[1]], ...(found[2] ? { usual: found[2] } : {}) } : undefined
}

/** The models that think within a number of tokens rather than at a named level: Gemini 2.5 and before. */
const byBudget = (model: string): boolean => /^gemini-[12]\./.test(idOf(model))

/**
 * The tokens of thinking a level stands for with those models: what Google's OpenAI-compatible
 * endpoint makes of the same levels (openai#thinking). "none" switches thinking off where the
 * model allows that; a level above high gets the most the table gives.
 */
const BUDGETS: Partial<Record<EffortLevel, number>> = { none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24576 }

/** What the service says of a model, as far as the requests and the page depend on it. */
export interface ModelFacts {
  name?: string
  /** How many tokens of input the model takes: its context window. */
  inputTokenLimit?: number
  /** Whether the model thinks. Where the service does not say, it is taken to. */
  thinking?: boolean
}

/**
 * The address the API is reached at. The address of the OpenAI-compatible endpoint is the same API
 * one step further down: a provider switched over from that format keeps working with it.
 */
function baseOf(connection: Pick<Connection, 'baseURL'>): string {
  const base = connection.baseURL.trim().replace(/\/+$/, '') || OFFICIAL_API
  return isGemini(base) ? base.replace(/\/openai$/i, '') : base
}

/** The model as the address names it: `models/…`, each piece of its name kept as it is. */
const modelPath = (model: string): string => {
  const id = model.trim()
  return (/^(models|tunedModels)\//.test(id) ? id : `models/${id}`).split('/').map(encodeURIComponent).join('/')
}

const headersOf = (connection: Pick<Connection, 'apiKey'>): Record<string, string> => ({
  'content-type': 'application/json',
  // A server of one's own in front of the API may want none.
  ...(connection.apiKey ? { 'x-goog-api-key': connection.apiKey } : {})
})

/** An error the service reported: its words, with the HTTP status and Google's name for the kind of error. */
export class GeminiError extends Error {
  readonly status?: number
  /** How long the service asked to be left alone before the request is made again, in milliseconds. */
  readonly wait?: number
  constructor(message: string, status?: number, wait?: number) {
    super(message)
    this.status = status
    this.wait = wait
  }
}

/** How long a refusal asks to wait before trying again (`google.rpc.RetryInfo`), in milliseconds. */
function retryDelay(error: Bag): number | undefined {
  for (const detail of Array.isArray(error.details) ? error.details : []) {
    const seconds = isBag(detail) && typeof detail.retryDelay === 'string' ? Number.parseFloat(detail.retryDelay) : NaN
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  }
  return undefined
}

/** An error as Google words it, `{ code, message, status }`, with the HTTP status where the error came as one. */
function failureFrom(error: unknown, httpStatus?: number): GeminiError {
  const said = isBag(error) ? error : {}
  const status = httpStatus ?? (typeof said.code === 'number' ? said.code : undefined)
  const kind = textOf(said.status)
  const detail = [status ? `HTTP ${status}` : '', kind ?? ''].filter(Boolean).join(' ')
  const message = textOf(said.message) ?? 'The service reported that the request failed.'
  return new GeminiError(detail ? `${message} (${detail})` : message, status, retryDelay(said))
}

/** What a refused request said, from the body of the refusal: Google's `{ error: … }`, or whatever text there is. */
async function failureOf(response: Response): Promise<GeminiError> {
  const raw = await response.text().catch(() => '')
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    body = undefined
  }
  // Asked for a stream in its other form, the service answers with a list that holds the error.
  const first = Array.isArray(body) ? body[0] : body
  if (isBag(first) && isBag(first.error)) return failureFrom(first.error, response.status)
  const said = raw.trim().slice(0, 300) || response.statusText || 'The service reported that the request failed.'
  return new GeminiError(`${said} (HTTP ${response.status})`, response.status)
}

/**
 * A request is not followed to another address. The key goes in a header of Google's own, which
 * fetch would carry along to wherever a redirect leads, even from https to plain http, and the
 * conversation with it. An address that sends requests on is said so, naming only the host it
 * sends them to: where it leads could hold anything.
 */
function redirected(response: Response, url: string): GeminiError | null {
  const moved = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400 && response.status !== 304)
  if (!moved) return null
  let to = ''
  try {
    to = new URL(response.headers.get('location') ?? '', url).origin
  } catch {
    to = ''
  }
  const where = to && to !== 'null' ? ` to ${to}` : ' elsewhere'
  return new GeminiError(
    `The service sent the request on${where} (HTTP ${response.status}). StarBench does not follow it there with the API key; if that is the right address, enter it in Settings.`,
    response.status
  )
}

async function getJson(connection: Pick<Connection, 'apiKey'>, url: string): Promise<Bag> {
  const response = await fetch(url, { headers: headersOf(connection), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  const moved = redirected(response, url)
  if (moved) throw moved
  if (!response.ok) throw await failureOf(response)
  const body: unknown = await response.json()
  if (!isBag(body)) throw new Error('The service did not answer with what was asked for.')
  return body
}

const factsCache = new Map<string, Promise<ModelFacts>>()

function factsFor(connection: Connection): Promise<ModelFacts> {
  const key = `${baseOf(connection)}\n${connection.apiKey}\n${connection.model}`
  let facts = factsCache.get(key)
  if (!facts) {
    facts = getJson(connection, `${baseOf(connection)}/${modelPath(connection.model)}`).then((raw) => {
      const name = textOf(raw.displayName)
      const limit = raw.inputTokenLimit
      return {
        ...(name ? { name } : {}),
        ...(typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? { inputTokenLimit: limit } : {}),
        ...(typeof raw.thinking === 'boolean' ? { thinking: raw.thinking } : {})
      }
    })
    factsCache.set(key, facts)
    // A failed lookup is asked again next time instead of being remembered.
    facts.catch(() => factsCache.delete(key))
  }
  return facts
}

/** How the model is to think: as hard as was chosen, and with a summary of its thinking handed over. Nothing for a model that does not think. */
function thinkingConfig(connection: Connection, facts: ModelFacts | null): Bag | undefined {
  if (facts?.thinking === false) return undefined
  const effort = connection.reasoningEffort
  if (effort === 'default') return { includeThoughts: true }
  return byBudget(connection.model)
    ? { includeThoughts: true, thinkingBudget: BUDGETS[effort] ?? BUDGETS.high }
    : { includeThoughts: true, thinkingLevel: effort }
}

/**
 * The app's tools as Gemini takes them. Their schemas go as JSON Schema, which this field takes as
 * it is (`parametersJsonSchema`), where the older `parameters` takes a part of OpenAPI's schemas
 * only and refuses what lies outside it. The `$schema` an MCP server puts at the top says nothing to it.
 */
function declarations(tools: readonly ToolDefinition[]): Bag[] {
  return tools.map((tool) => {
    const { $schema: _unused, ...schema } = tool.parameters
    return { name: tool.name, description: tool.description || tool.name, parametersJsonSchema: schema }
  })
}

function argsOf(raw: string): Bag {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    return isBag(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** A tool's result as Gemini takes it: the output, or what went wrong, under the keys its documentation names for them. */
const resultOf = (content: string): Bag => (isErrorResult(content) ? { error: content } : { output: content })

/**
 * What the person wrote, with the files they put with it, as the parts of a message: the pictures
 * first, as Google advises for a picture with a question, then the text, with the text files in it.
 */
function userParts(message: Extract<ChatMessage, { role: 'user' }>, connection: Connection): Part[] {
  const pictures: Part[] = userImages(message, connection).map((image) => ({ inlineData: { mimeType: image.type, data: image.data } }))
  const text = userText(message, connection)
  return text ? [...pictures, { text }] : pictures
}

/**
 * A reply of Gemini's own that searched, for a request without the search: each search and page
 * read goes as a note of what it looked for and found (`searchNote`), in front of the reply, and
 * the parts of the search are left out. That breaks no signature that is checked: only the turn
 * under way is (thought-signatures), and the switch is read as a turn begins, so a turn has its
 * search from the first step to the last or not at all.
 */
function withoutSearch(parts: readonly Part[], web: readonly WebActivity[]): Part[] {
  const rest = parts.filter((part) => !part.toolCall && !part.toolResponse)
  const notes = web.map(searchNote).join('\n')
  return notes ? [{ text: notes }, ...rest] : rest
}

/**
 * What one reply goes back as. Gemini's own goes as it came, part for part. Another model's, or
 * one of Gemini's that was stopped and kept none of its parts, is made of its text, with its
 * searches told in words, and of its calls, the first of which carries the value that stands for
 * a signature. `calls` learns the calls the results that follow answer.
 */
function modelParts(message: AssistantMessage, connection: Connection, calls: Map<string, { name: string; id?: string }>): Part[] {
  const replay = replayOf(message, connection)
  if (isReplay(replay)) {
    // The calls among the parts are the reply's calls, in the same order (a call without a name was not taken for one).
    replay.parts
      .filter((part) => typeof part.functionCall?.name === 'string' && part.functionCall.name)
      .forEach((part, index) => {
        const id = replay.calls[index]
        const call = part.functionCall ?? {}
        if (id) calls.set(id, { name: String(call.name ?? ''), ...(call.id ? { id: call.id } : {}) })
      })
    return connection.webSearch ? replay.parts : withoutSearch(replay.parts, message.web ?? [])
  }
  const parts: Part[] = []
  const text = withSearchNote(message)
  if (text) parts.push({ text })
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    calls.set(call.id, { name: call.name, id: call.id })
    parts.push({ functionCall: { id: call.id, name: call.name, args: argsOf(call.arguments) }, ...(index === 0 ? { thoughtSignature: NO_SIGNATURE } : {}) })
  }
  return parts
}

/**
 * The conversation as Gemini takes it. The results of one step's calls go back together in a
 * message of the user's, each with the name and the id of its call. Two messages of the person's
 * in a row (after a reply that failed) go as one.
 */
export function geminiContents(request: Pick<ModelRequest, 'messages' | 'connection'>): Content[] {
  const out: Content[] = []
  /** The calls the results answer, by the app's id: their name, and the id Gemini knows them by, where it gave one. */
  const calls = new Map<string, { name: string; id?: string }>()
  for (const message of withToolResults(request.messages)) {
    const last = out.at(-1)
    if (message.role === 'user') {
      const parts = userParts(message, request.connection)
      if (!parts.length) continue
      if (last?.role === 'user' && !last.parts.some((part) => part.functionResponse)) last.parts.push(...parts)
      else out.push({ role: 'user', parts })
    } else if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id)
      const part: Part = { functionResponse: { name: call?.name ?? '', ...(call?.id ? { id: call.id } : {}), response: resultOf(message.content) } }
      if (last?.role === 'user' && last.parts.every((other) => other.functionResponse)) last.parts.push(part)
      else out.push({ role: 'user', parts: [part] })
    } else {
      const parts = modelParts(message, request.connection, calls)
      if (parts.length) out.push({ role: 'model', parts })
    }
  }
  return out
}

/** The request for one step of a turn. `facts` is what the service said of the model, or null where it could not be asked. */
export function geminiBody(request: Pick<ModelRequest, 'connection' | 'system' | 'messages' | 'tools'>, facts: ModelFacts | null = null): Bag {
  const { connection } = request
  const search = Boolean(connection.webSearch)
  const tools: Bag[] = [
    ...(request.tools.length ? [{ functionDeclarations: declarations(request.tools) }] : []),
    // The model's own search, and its reading of the pages it found or was given: both run on Google's side.
    ...(search ? [{ googleSearch: {} }, { urlContext: {} }] : [])
  ]
  const thinking = thinkingConfig(connection, facts)
  return {
    contents: geminiContents(request),
    ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    ...(tools.length ? { tools } : {}),
    // Without it the service takes its own tools and the app's in one request no longer, and would
    // not hand over its own calls, which go back with the reply.
    ...(search ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
    ...(thinking ? { generationConfig: { thinkingConfig: thinking } } : {})
  }
}

/** A part that holds text and nothing else: no signature, no call. Only such parts are joined as a reply streams in. */
const bare = (part: Part): boolean => typeof part.text === 'string' && Object.keys(part).every((key) => key === 'text' || key === 'thought')

/**
 * Adds a part that came in a stream to the parts of the reply. Text comes in many small parts and
 * is joined to the part before it while both are nothing but text of the same kind. A part with a
 * signature keeps its place and its text as they came, and nothing is joined to it (thought-signatures).
 */
export function keepPart(parts: Part[], part: Part): void {
  if (bare(part) && !part.text) return
  const last = parts.at(-1)
  if (last && bare(last) && bare(part) && Boolean(last.thought) === Boolean(part.thought)) {
    last.text = `${last.text ?? ''}${part.text ?? ''}`
    return
  }
  parts.push(structuredClone(part))
}

const readEvent = (data: string): unknown => {
  try {
    return JSON.parse(data)
  } catch {
    throw new Error('The service sent a piece of the reply that could not be read.')
  }
}

/** The events of a stream of server-sent events, each one's data read as JSON. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  const field = (line: string): void => {
    if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (line) field(line)
        else if (data.length) {
          yield readEvent(data.join('\n'))
          data = []
        }
      }
      if (done) break
    }
    field(buffer.replace(/\r$/, ''))
    if (data.length) yield readEvent(data.join('\n'))
  } finally {
    // Closes the connection when the reader stops early: the reply was stopped, or could not be read.
    void reader.cancel().catch(() => {})
  }
}

/** Why a reply ended, when it ended as it should. */
const FINISHED = new Set(['STOP', 'FINISH_REASON_UNSPECIFIED'])
/** Why a reply ended when the model ran out of room for its output. */
const OUT_OF_ROOM = new Set(['MAX_TOKENS', 'CONTINUATION'])

/** Makes one request and collects the reply into `message`, which keeps what arrived if the request fails. */
async function attempt(request: ModelRequest, message: AssistantMessage): Promise<ModelReply> {
  const { connection, signal, probe } = request
  // Not knowing the model is no reason to fail.
  const facts = await factsFor(connection).catch(() => null)
  const body = geminiBody(request, facts)
  probe?.sent(body)
  const url = `${baseOf(connection)}/${modelPath(connection.model)}:streamGenerateContent?alt=sse`
  const response = await fetch(url, {
    method: 'POST',
    headers: headersOf(connection),
    body: JSON.stringify(body),
    redirect: 'manual',
    signal
  })
  const moved = redirected(response, url)
  if (moved) throw moved
  if (!response.ok || !response.body) throw await failureOf(response)

  const web = new WebLog(message, request.onWebActivity)
  // Search Suggestions are drawn as HTML (App.tsx): they are taken from Google's own API alone.
  const fromGoogle = isGemini(baseOf(connection))
  const told = (activity: WebActivity): WebActivity => {
    if (fromGoogle || activity.suggestions === undefined) return activity
    const { suggestions: _dropped, ...rest } = activity
    return rest
  }
  const parts: Part[] = []
  const calls: ToolCall[] = []
  /** What the activities of this reply that have no id of the service's are told under: unique to the reply. */
  const tag = `gemini-${newCallId()}`
  let usage: unknown
  let finish: string | undefined
  let finishText: string | undefined
  let blocked: string | undefined
  /** What came last: the answer, the thinking, or something else (a call, a search). */
  let lastKind: 'text' | 'thought' | 'other' | undefined

  const say = (text: string): void => {
    // Text after a search or a call begins a paragraph of its own.
    const piece = lastKind === 'other' && message.content && !message.content.endsWith('\n') ? `\n\n${text}` : text
    message.content += piece
    request.onText(piece)
    lastKind = 'text'
  }
  const think = (text: string): void => {
    const piece = lastKind !== 'thought' && message.reasoning_content ? `\n\n${text}` : text
    message.reasoning_content = (message.reasoning_content ?? '') + piece
    request.onReasoning(piece)
    lastKind = 'thought'
  }
  const take = (part: Part): void => {
    const call = part.functionCall
    if (isBag(call) && typeof call.name === 'string' && call.name) {
      calls.push({ id: textOf(call.id) ?? newCallId(), name: call.name, arguments: JSON.stringify(isBag(call.args) ? call.args : {}) })
      lastKind = 'other'
    } else if (part.toolCall || part.toolResponse) {
      const activity = geminiActivity(part)
      if (activity) web.put(told(activity))
      lastKind = 'other'
    } else if (typeof part.text === 'string' && part.text) {
      if (part.thought) think(part.text)
      else say(part.text)
    }
    keepPart(parts, part)
  }
  /**
   * What the reply rests on. Searches told as they began (the parts of the service's own calls)
   * get the pages with the last of them: the service names the pages of the whole reply, not of
   * each search. Without such parts, the reply's searching is one search of its own.
   */
  const grounded = (metadata: unknown): void => {
    const found = geminiGrounding(metadata, `${tag}-search`)
    if (!found) return
    const last = message.web?.filter((a) => a.kind === 'search' && a.id !== found.id).at(-1)
    // A search keeps what it said itself: its queries, and the suggestions that came with it.
    web.put(told(last ? { ...found, id: last.id, ...(last.queries ? { queries: last.queries } : {}), ...(last.suggestions ? { suggestions: last.suggestions } : {}) } : found))
  }
  /** The pages read, where the parts of the service's own calls did not tell of them already. */
  const pagesRead = (metadata: unknown): void => {
    if (message.web?.some((a) => a.kind === 'open' && !a.id.startsWith(`${tag}-`))) return
    for (const page of geminiPagesRead(metadata, `${tag}-page`)) web.put(page)
  }

  try {
    for await (const chunk of events(response.body)) {
      // What had already arrived when the reply was stopped is not taken in.
      if (signal.aborted) break
      if (!isBag(chunk)) continue
      // An error after the reply began comes as an event of its own.
      if (isBag(chunk.error)) throw failureFrom(chunk.error)
      if (chunk.usageMetadata !== undefined) usage = chunk.usageMetadata
      const feedback = isBag(chunk.promptFeedback) ? chunk.promptFeedback : undefined
      if (typeof feedback?.blockReason === 'string') blocked = feedback.blockReason
      const candidate = Array.isArray(chunk.candidates) && isBag(chunk.candidates[0]) ? chunk.candidates[0] : undefined
      if (!candidate) continue
      const content = isBag(candidate.content) ? candidate.content : undefined
      for (const part of Array.isArray(content?.parts) ? content.parts : []) {
        if (signal.aborted) break
        if (!isBag(part)) continue
        probe?.arrived()
        take(part as Part)
      }
      if (candidate.groundingMetadata !== undefined) grounded(candidate.groundingMetadata)
      if (candidate.urlContextMetadata !== undefined) pagesRead(candidate.urlContextMetadata)
      if (typeof candidate.finishReason === 'string') {
        finish = candidate.finishReason
        finishText = textOf(candidate.finishMessage)
      }
    }
  } catch (err) {
    // A stop keeps the text and the thinking that arrived; a call that had come is not run.
    if (signal.aborted) return { message }
    throw err
  }
  if (signal.aborted) return { message }
  // The pages it read get the names its searches gave them, which are known by now.
  for (const read of geminiTitledReads(message.web ?? [])) web.put(read)
  if (usage !== undefined) probe?.usage(usage)
  if (finish) probe?.finished(finish)
  if (!finish) {
    if (blocked) return { message, stopped: `The service declined this request (${blocked}).` }
    throw new Error('The connection to the service ended before the reply was complete.')
  }
  if (OUT_OF_ROOM.has(finish)) {
    return {
      message,
      stopped: calls.length
        ? 'The model ran out of output space in the middle of a tool call, so the call was not run.'
        : 'The model ran out of output space before it finished.'
    }
  }
  if (!FINISHED.has(finish)) return { message, stopped: `The service ended the reply early (${finish}${finishText ? `: ${finishText}` : ''}).` }
  if (calls.length) message.tool_calls = calls
  if (message.origin) message.origin.replay = { parts, calls: calls.map((call) => call.id) } satisfies Replay
  return { message }
}

/** Statuses that say the service is busy for the moment. */
const BUSY = new Set([500, 502, 503, 504])
/** The longest a refusal for too many requests is waited out before the request is made again. */
const LONGEST_WAIT = 10_000

/**
 * How long to wait before asking again, after a failure that a second try may get past: the
 * service was busy, or asked for a pause it named, or the connection failed. Undefined when it is
 * not to be tried again. Two tries more at most.
 */
function pauseBefore(err: unknown, tries: number): number | undefined {
  if (tries >= 2) return undefined
  if (err instanceof GeminiError) {
    if (err.status === 429) return err.wait !== undefined && err.wait <= LONGEST_WAIT ? err.wait : undefined
    return err.status !== undefined && BUSY.has(err.status) ? 1000 * 2 ** tries : undefined
  }
  // Fetch tells of a connection that failed or broke off with a TypeError of its own.
  return err instanceof TypeError && /fetch failed|terminated|network|socket/i.test(err.message) ? 1000 * 2 ** tries : undefined
}

/**
 * What a refusal for too many requests means where the request asked for Google's search. A key
 * of Google's free tier gets one for every such request to Gemini 3 and later, which have no
 * search there, in words that read like a limit that was reached (tried 2026-11-24: "You
 * exceeded your current quota", HTTP 429, within 0.1 s, while the same key was served without
 * the search). Other refusals go as they came.
 */
function explained(err: unknown, connection: Connection): unknown {
  if (!(err instanceof GeminiError) || err.status !== 429 || !connection.webSearch) return err
  const hint = "If this key is on Google's free tier: Gemini 3 and later cannot use Google Search there, only with a paid-tier key. Switch web search off and send again."
  return new GeminiError(`${err.message} ${hint}`, err.status, err.wait)
}

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/**
 * Models the list holds that do not hold a conversation, by their names: pictures, speech,
 * embeddings, video, music, the Live API, and the agents of the Interactions API.
 */
const NOT_FOR_CHAT = /embed|imagen|image|veo|tts|audio|live|transcri|translate|lyria|banana|omni|aqa|robotics|computer-use|genie|decision|deep-research|antigravity/i

export const geminiAdapter: ProviderAdapter = {
  async complete(request: ModelRequest): Promise<ModelReply> {
    for (let tries = 0; ; tries++) {
      const message = newReply(request.connection)
      try {
        return await attempt(request, message)
      } catch (err) {
        // A stop keeps whatever text arrived.
        if (request.signal.aborted) return { message }
        // Asking again is safe only while nothing of this reply has been shown.
        const shown = Boolean(message.content || message.reasoning_content || message.web?.length)
        // A model that takes no pictures: the caller sends the message again with them told in words.
        if (!shown && carriesImages(request) && refusesImages(err)) throw new ImagesRefused((err as Error).message)
        const wait = shown ? undefined : pauseBefore(err, tries)
        if (wait === undefined) throw explained(err, request.connection)
        await pause(wait, request.signal)
        if (request.signal.aborted) return { message }
      }
    }
  },

  async listModels(connection: Connection): Promise<ModelChoice[]> {
    const choices: ModelChoice[] = []
    let next = ''
    for (let page = 0; page < 5; page++) {
      const raw = await getJson(connection, `${baseOf(connection)}/models?pageSize=1000${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`)
      for (const entry of Array.isArray(raw.models) ? raw.models : []) {
        if (!isBag(entry)) continue
        const id = textOf(entry.name)?.replace(/^models\//, '')
        const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : []
        if (!id || NOT_FOR_CHAT.test(id) || (methods.length && !methods.includes('generateContent'))) continue
        const name = textOf(entry.displayName)
        choices.push({ id, ...(name ? { name } : {}) })
      }
      next = textOf(raw.nextPageToken) ?? ''
      if (!next) break
    }
    return choices
  },

  async modelInfo(connection: Connection): Promise<ModelInfo | null> {
    const facts = await factsFor(connection)
    const levels = geminiLevels(connection.model)
    const info: ModelInfo = {
      ...(facts.name ? { name: facts.name } : {}),
      ...(levels ? { efforts: levels.efforts } : {}),
      ...(levels?.usual ? { defaultEffort: levels.usual } : {}),
      ...(facts.inputTokenLimit ? { contextWindow: facts.inputTokenLimit } : {})
    }
    return Object.keys(info).length ? info : null
  }
}
