// The agent loop: send the conversation to the model, run the tools it asks for,
// feed the results back, repeat until it answers without tool calls.
// Nothing in this file depends on Electron.

import { COMPACTION_DEFAULTS, compactFrom } from '../shared/compaction.ts'
import type { CompactionSettings } from '../shared/compaction.ts'
import { DEFAULT_PERMISSION_MODE, VIEW_ONLY_RESULT, rulingFor } from '../shared/permissions.ts'
import type { PermissionMode, Ruling } from '../shared/permissions.ts'
import type { AgentEvent, CompactionMark, CompactionReport, CustomPrompt, PermissionDecision, StoredMessage, ToolCall } from '../shared/types.ts'
import { STEP_SHARE, TARGET_SHARE, carriedTokens, compact, fitTokens, saysTooLong, sendable, storedWeight, windowSaid } from './compaction.ts'
import { languageOf } from './language.ts'
import { plainMessages, plainReply, plainWeight } from './plain.ts'
import { DocumentsRefused, ImagesRefused, carriesDocuments, pdfWithheld } from './providers/attachments.ts'
import { adapterFor } from './providers/index.ts'
import type { Connection, ModelReply, ModelRequest, ProviderAdapter } from './providers/index.ts'
import { ServiceError, ToolsRefused } from './providers/types.ts'
import { targetOf } from './sampling.ts'
import type { SamplingRegistry } from './sampling.ts'
import type { ToolRegistry } from './tools.ts'
import { expected, fitParts, fitTo, halves, partsTotal, sentTokens } from '../shared/stats.ts'
import type { CompactionDone, ContextParts, Fit, StepMeasure } from '../shared/stats.ts'
import { whole, wholeText } from '../shared/well-formed.ts'
import { meterStep, weigh } from './meter.ts'
import type { MeterHints } from './meter.ts'
import { watchExchange } from './trace.ts'
import type { ExchangeDraft } from './trace.ts'

const MAX_STEPS = 50
/** The least a tool result is given room for, in tokens as guessed, however small the model's context. */
const RESULT_MIN = 200

/** What a turn is told about keeping the conversation within the model's context (compaction.ts). */
export interface RoomOptions {
  /** How many tokens the context of the model holds, where that is known. */
  window?: number
  /** What the person set: whether the conversation is compacted unasked, and from where on. */
  settings: CompactionSettings
  /** How the app's guesses compared with what the service counted of the requests to this model before, where it said. */
  fit?: Fit
}

export interface TurnOptions {
  /** The provider and model this turn talks to. */
  connection: Connection
  workspace: string
  /**
   * Conversation so far as it is kept, ending with the new user message. Mutated in place as the
   * turn proceeds. What is sent of it is `sendable(messages)`: less, once it was compacted.
   */
  messages: StoredMessage[]
  /** Extra system prompt text, such as the list of available skills. */
  systemExtra?: string
  /**
   * What the memory tells the model, which goes last in the instructions (main/memory.ts). The
   * same at every step of a turn, and at every turn of a conversation unless the notes it sees
   * changed: the start of the requests stays as it was, for the services' caches.
   */
  memory?: string
  /** A name for this conversation that tells nothing else about it; see `ModelRequest.conversation`. */
  conversation?: string
  /**
   * A plain chat: the model is sent what was said and nothing of the app's. No tools go with the
   * request, be they the app's, a plugin's, an MCP server's or the service's own search, and none
   * is described in words for a server that takes no definitions. The instructions are the
   * person's own for this provider and nothing else, and none at all where they wrote none: not
   * the workspace, not the date, not the list of skills, nothing of the memory. What the
   * conversation holds of earlier tool calls is told in words (plain.ts). The turn is one request,
   * and a call the reply holds all the same is not run. What the person attached still goes, and
   * so do the sampling fields and the thinking effort they chose, and the name of the
   * conversation where a service is sent one (`conversation`): that one says nothing to the model.
   */
  plain?: boolean
  signal: AbortSignal
  /** Read on every model request, so tools added mid-turn are picked up at the next step. */
  tools: Pick<ToolRegistry, 'specs' | 'needsPermission' | 'execute'> &
    Partial<Pick<ToolRegistry, 'list' | 'accessOf' | 'accessFor'>> & {
      /**
       * Whether a call has to be asked about although the conversation would let it run: a note
       * the memory is to keep that looks as if it holds a secret or personal data. A call the
       * conversation does not let run at all is still not run.
       */
      mustAsk?(name: string, rawArgs: string): boolean
    }
  /** Asked on every model request for the fields plugins add to it, so a changed setting counts from the next step. */
  sampling?: Pick<SamplingRegistry, 'paramsFor'>
  /** Tool names the user chose to always allow; owned by the caller so it outlives one turn. */
  alwaysAllowed: Set<string>
  /**
   * What the model may do in this conversation without asking (shared/permissions.ts). Asked
   * before every tool call, so that a change the person makes while the turn runs counts from
   * the next call. Without it, every tool that asks is asked about.
   */
  permissionMode?(): PermissionMode
  emit(event: AgentEvent): void
  /** Asks the user whether a tool call may run. */
  requestPermission(call: ToolCall): Promise<PermissionDecision>
  /** Called whenever `messages` reached a consistent state worth persisting. */
  checkpoint(): void
  /** Called when the service would not give this model the faster answers that were asked for, so the choice can be taken back. */
  onFastRefused?(): void
  /**
   * Called when the service would not take the level of thinking chosen for this model and the
   * turn went on without one, so the choice can be taken back.
   */
  onEffortRefused?(): void
  /**
   * Called when the server turned out to take no tool definitions and the turn went on with the
   * tools described in the instructions, so that later turns can start that way (`connection.textTools`).
   */
  onToolsRefused?(): void
  /**
   * Called when the server turned out not to stream replies while tools are offered, so later
   * turns can ask for whole replies from the start (`connection.wholeReplies`).
   */
  onStreamRefused?(): void
  /**
   * Called when the model turned out to take no pictures and the turn went on with the pictures
   * told in words, so that later turns can start that way (`connection.noImages`).
   */
  onImagesRefused?(): void
  /**
   * Called when the service turned down the PDFs of a request, or a request with them stayed too
   * long after the conversation was compacted, and the turn went on with the PDFs told of by where
   * they lie, so that later turns can start that way (`connection.noDocuments`).
   */
  onDocumentsRefused?(): void
  /**
   * Where a record of each request and its reply goes while someone watches (trace.ts). `active`
   * is read before every request, so that watching can begin and end in the middle of a turn;
   * while it is false no record is made.
   */
  trace?: { readonly active: boolean; record(exchange: ExchangeDraft): void }
  /**
   * Where what is measured of the turn goes, while the app keeps count of what conversations
   * cost: each request as its reply ends, and the time each tool took to run. With it, every
   * request is measured and the service is asked what the reply cost. `compacted` is told when
   * the conversation was compacted: what the next request is expected to weigh, and what the
   * summary cost.
   */
  stats?: { step(measure: StepMeasure): void; tool(ms: number): void; compacted?(done: CompactionDone): void }
  /**
   * With it, the conversation is kept within the model's context: tool results are cut to fit
   * as they come, and the conversation is compacted when it has grown to the line drawn here, or
   * when the service says it no longer fits. Without it, nothing of that is done.
   */
  room?: RoomOptions
}

/** The date where the person is. Told to the model as it stands on their calendar, not as it is in Greenwich. */
export function today(now = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

/** What the system prompt is made from. */
export interface PromptParts {
  workspace: string
  /** The model in use as the settings name it, and the provider it is asked from, so that it can say what it is. */
  model?: { id: string; provider?: string }
  /** The person's own instructions for the provider in use. */
  custom?: CustomPrompt
  /** What goes after the instructions, such as the list of skills. */
  extra?: string
  /** What the memory tells the model: last of all, after the skills, also where the person's own instructions stand in place of the app's. */
  memory?: string
  /** The language the person writes in, where their writing shows it (`languageOf`): the model is asked to think in it. */
  language?: string
  /** The model can search the web with its service's own tool (`Connection.webSearch`). */
  webSearch?: boolean
}

/**
 * What the model is told about questions like "who are you?". Two things were learned from real
 * models. A prompt that opens with "You are a coding agent" is taken for a name, and the model
 * says it is "a coding agent". And left to its memory, a model may name another one altogether,
 * or say it was not told: so it is told which model the settings name.
 */
function askedWho(parts: PromptParts): string {
  const name = parts.model
    ? 'name the model in use given above instead of answering from memory'
    : 'say what model you are, as you would anywhere'
  return `What this prompt describes is your job in this app, not who you are. When asked who you are or which model you are, ${name}, and say that you are working in StarBench.`
}

/**
 * What the model is told about the language of its thinking, which the person reads as well as
 * the answer. Learned from a real model that thinks in English by habit (DeepSeek): "answer in
 * the language the user writes in" does not reach the thinking, and neither does a mild "think in
 * it too", nor a prompt that is in Chinese throughout. Asked with weight but left to see the
 * language for itself, it thought in Chinese in three tries of seven. Told as a fact which
 * language the person writes in, as here, it did in every try with Chinese, at the highest effort
 * and between tool calls too. With Korean it did in one try of two.
 *
 * The answer is not spoken of: it follows what the person wrote last, as the instructions say
 * elsewhere, while this language is that of the conversation (`languageOf`).
 */
function thinkingIn(language: string): string {
  return `IMPORTANT: The user writes in ${language}. Write your reasoning (your thinking before the answer) in ${language} as well, never in English.`
}

/** What the model has to know about where it runs, whoever wrote the rest of the prompt: the tools depend on it. */
function surroundings(parts: PromptParts): string[] {
  const shell = process.platform === 'win32' ? 'PowerShell' : '/bin/sh'
  return [`Workspace root: ${parts.workspace}`, `Operating system: ${process.platform}`, `Shell used by run_command: ${shell}`, `Today's date: ${today()}`]
}

/** The app's own instructions, with what it knows of the model and its surroundings in their place. */
function ownInstructions(parts: PromptParts): string {
  const model = parts.model ? [`Model in use: ${parts.model.id}${parts.model.provider ? ` (provider: ${parts.model.provider})` : ''}`] : []
  // Last, where it was when real models were tried with it.
  const thinking = parts.language ? ['', thinkingIn(parts.language)] : []
  // The search tool is the service's own and comes with the service's own instructions; this says
  // when to reach for it here, and that it is there at all. Told only that it could search with
  // its service's own tools, deepseek-flash answered in 9 tries of 24 that it had no web access
  // (2026-11-24, asked for the latest Electron release, at high and low effort). With the search
  // told apart from the app's tools and the access said outright, it searched in all 16; questions
  // it searched for anyway went on as before.
  const web = parts.webSearch
    ? [
        '- Web search is on in this conversation. Besides this app\'s tools for files and commands, the service you run on gives you its own tools to search the web and read pages, so you do have internet access. Use them whenever the answer may have changed since your training or you are not sure, and name the pages you relied on.'
      ]
    : []
  return [
    'You are working as a coding agent inside StarBench, a desktop app on the user\'s computer.',
    'You help with software tasks by reading and editing files and running commands through the provided tools.',
    '',
    ...model,
    ...surroundings(parts),
    '',
    'Guidelines:',
    '- All file paths are relative to the workspace root; you cannot access files outside it.',
    '- Look before you change: read a file before editing it, and inspect the project before making assumptions.',
    '- Prefer edit_file for changes to existing files; use write_file for new files.',
    '- The user approves file changes and commands individually. If a request is denied, do not retry it unchanged; adjust or ask.',
    '- When the work is done, reply with a short summary of what changed. Answer in the language the user writes in.',
    ...web,
    `- ${askedWho(parts)}`,
    ...thinking
  ].join('\n')
}

/**
 * The system prompt. The person's own instructions follow the app's, or stand in their place;
 * then nothing of the app's is left but the surroundings. The name of the model is not among
 * what is left: a prompt written for a model of one's own says who that model is. Nor is the
 * language to think in: that is an instruction, and the instructions are now the person's.
 */
export function systemPrompt(parts: PromptParts): string {
  const custom = parts.custom?.text.trim()
  const sections = custom && parts.custom?.replace ? [custom, surroundings(parts).join('\n')] : [ownInstructions(parts), ...(custom ? [custom] : [])]
  if (parts.extra) sections.push(parts.extra)
  if (parts.memory) sections.push(parts.memory)
  return sections.join('\n\n')
}

/**
 * The app's own instructions as the page shows them, with words where the model, the workspace
 * and the language of a conversation would be. The line about the language is shown although a
 * conversation in a language that is not named has none: it is the one a prompt of the person's
 * own, put in place of this one, would have to bring along.
 */
export function builtinPrompt(): string {
  return ownInstructions({
    workspace: '<the workspace folder of the conversation>',
    model: { id: '<the model chosen>', provider: '<its provider>' },
    language: '<the language of the conversation>'
  })
}

/** Result texts the UI recognises to label a call as cancelled or refused. */
const CANCELLED = 'Cancelled by user'
const DENIED = 'The user denied this tool call.'

/** Produces the result of one tool call. Always resolves: every call needs a result, or the next request is rejected. */
async function runToolCall(call: ToolCall, opts: TurnOptions): Promise<string> {
  if (opts.signal.aborted) return CANCELLED
  // What the conversation is set to says whether the call is run, asked about, or not run at all.
  // Judged by the call where the tools can (a write into `.git` is more than an edit), else by the tool.
  const access =
    (await opts.tools.accessFor?.(call.name, call.arguments, opts.workspace)) ??
    opts.tools.accessOf?.(call.name) ??
    (opts.tools.needsPermission(call.name) ? 'other' : 'read')
  const ruling: Ruling = rulingFor(opts.permissionMode?.() ?? DEFAULT_PERMISSION_MODE, access)
  if (ruling === 'refuse') return VIEW_ONLY_RESULT
  // Asked about whatever was allowed for the conversation: what the call holds is what it is asked about.
  const forced = opts.tools.mustAsk?.(call.name, call.arguments) === true
  if (forced || (ruling === 'ask' && !opts.alwaysAllowed.has(call.name))) {
    // The answer to a question that was asked stands, whatever the setting was changed to meanwhile.
    const decision = await opts.requestPermission(call)
    // A stop while the prompt was open ends the wait; that is a cancellation, not a refusal.
    if (opts.signal.aborted) return CANCELLED
    // Only a yes runs the call: an answer of any other kind is none.
    if (decision !== 'allow' && decision !== 'always') return DENIED
    if (decision === 'always' && !forced) opts.alwaysAllowed.add(call.name)
  }
  // The time the tool takes to run, which begins once it was allowed. Many tools take less than a millisecond.
  const started = performance.now()
  try {
    return await opts.tools.execute(call.name, call.arguments, { workspace: opts.workspace, signal: opts.signal })
  } finally {
    opts.stats?.tool(performance.now() - started)
  }
}

/** Says of each tool where it comes from, for telling the weight of the app's own tools from that of the others. */
function toolKinds(tools: TurnOptions['tools']): (name: string) => 'builtin' | 'plugin' | 'mcp' {
  const sources = new Map((tools.list?.() ?? []).map((tool) => [tool.name, tool.source]))
  return (name) => {
    const source = sources.get(name) ?? 'builtin'
    return source === 'builtin' ? 'builtin' : source.startsWith('mcp:') ? 'mcp' : 'plugin'
  }
}

const statusOf = (err: unknown): unknown => (typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined)

/**
 * A request with every text in it whole (shared/well-formed.ts): what the model is told, the
 * conversation, and what is said of the tools. Half a character anywhere in it makes a body that
 * services turn down, at this request and at every one after it for as long as the conversation
 * holds that half: a result an earlier version cut in the middle of an emoji, or one a tool
 * brought. Every request goes out through `ask`, whichever format the service takes, so this is
 * the one place where that is put right; the conversation itself is left as it is kept.
 */
export function sound(request: ModelRequest): ModelRequest {
  const system = whole(request.system)
  const messages = wholeText(request.messages)
  const tools = wholeText(request.tools)
  if (system === request.system && messages === request.messages && tools === request.tools) return request
  return { ...request, system, messages, tools }
}

/**
 * Makes one request to the model. A provider that is signed in to is asked for a token that is
 * good now; should the service turn that one down before anything arrived, a new one is
 * fetched and the request made once more.
 */
async function ask(adapter: ProviderAdapter, asked: ModelRequest): Promise<ModelReply> {
  const request = sound(asked)
  const { plan } = request.connection
  if (!plan) return adapter.complete(request)
  let arrived = false
  const withToken = (apiKey: string): ModelRequest => ({
    ...request,
    connection: { ...request.connection, apiKey },
    onText: (delta) => ((arrived = true), request.onText(delta)),
    onReasoning: (delta) => ((arrived = true), request.onReasoning(delta))
  })
  const token = await plan.token()
  try {
    return await adapter.complete(withToken(token))
  } catch (err) {
    if (statusOf(err) !== 401 || arrived || request.signal.aborted) throw err
    const fresh = await plan.token(token)
    // The same token again means there was no newer one to be had.
    if (fresh === token) throw err
    return adapter.complete(withToken(fresh))
  }
}

/**
 * Asks a model one thing that is about a conversation and no part of it, and resolves with what
 * it wrote: the name the conversation is to go by (title.ts). The model is given no tools and no
 * search, and is not asked for faster answers at their price. Nobody reads the reply as it comes,
 * so it is taken whole or not at all (`ModelRequest.unattended`). Rejects when the service
 * refuses, or cut the reply short. `measured` hears what the request cost, where the app keeps
 * count of what the services were asked (main/usage.ts).
 */
export async function askAside(job: {
  connection: Connection
  system: string
  text: string
  signal: AbortSignal
  trace?: TurnOptions['trace']
  measured?: (measure: StepMeasure) => void
}): Promise<string> {
  const connection: Connection = { ...job.connection, fast: false, webSearch: false }
  const watch = job.trace?.active ? watchExchange(connection) : undefined
  const meter = job.measured ? meterStep(connection) : undefined
  const bare: ModelRequest = {
    connection,
    system: job.system,
    messages: [{ role: 'user', content: job.text }],
    tools: [],
    unattended: true,
    signal: job.signal,
    onText: () => {},
    onReasoning: () => {}
  }
  const watched = watch ? watch.over(bare) : bare
  const reply = await ask(adapterFor(connection.kind), meter ? meter.over(watched) : watched).catch((err: unknown) => {
    if (watch) job.trace?.record(watch.failed(err))
    throw err
  })
  if (watch) job.trace?.record(watch.done(reply))
  if (meter) job.measured?.(meter.done())
  if (reply.stopped) throw new Error(reply.stopped)
  return reply.message.content
}

/** What a turn, or a compaction asked for by hand, knows of the conversation it works on, as it goes. */
interface Talk {
  opts: TurnOptions
  adapter: ProviderAdapter
  /** The connection as it is now: a turn learns things about it on the way (see `requestOf` and `runTurn`). */
  connection: Connection
  /** The person writes nothing more while the turn runs, so their language is the same at every step of it. */
  language: string | undefined
  /** How many tokens the model's context holds, as far as known: told beforehand, or said by the service when it refused a request. */
  window: number | undefined
  /** How the app's guesses compare with what the service counts, as far as it has told (`Fit` in shared/stats.ts). */
  fit: Fit | undefined
  /**
   * A summary was called for in this turn and could not be had. It is not asked for again at every
   * step that follows, each time for nothing; a request the service refuses as too long still is.
   */
  summaryFailed?: boolean
  /**
   * The mark of a compaction made just before a request of this turn. What it says the
   * conversation weighs now is a guess; that request is the compacted conversation and nothing
   * else, so what the service counts of it is put in the place of the guess.
   */
  uncounted?: CompactionMark
}

function talkOf(opts: TurnOptions): Talk {
  return {
    opts,
    adapter: adapterFor(opts.connection.kind),
    connection: opts.connection,
    language: languageOf(opts.messages),
    window: opts.room?.window,
    fit: opts.room?.fit
  }
}

/** The parts of a request that are the same at every step of a turn: the instructions, the tools, and what the memory tells. */
const FIXED_PARTS = ['system', 'custom', 'skills', 'memory', 'tools', 'pluginTools', 'mcpTools'] as const

/**
 * The most a PDF may be guessed to weigh and still go to the model as it is (`Connection.pdfRoom`):
 * what the model's context holds, a twentieth kept for the reply, less what the instructions, the
 * tools and the memory take. No compaction could make room for a larger one. Undefined where the
 * size of the context is not known.
 */
function pdfRoomOf(talk: Talk): number | undefined {
  if (talk.window === undefined) return undefined
  const parts = weigh(requestOf(talk), hintsOf(talk))
  const fixed = FIXED_PARTS.reduce((sum, part) => sum + (parts[part] ?? 0), 0)
  return Math.max(0, Math.floor(talk.window * 0.95) - fixed)
}

/** The talk, with how much one PDF may weigh set on its connection (`pdfRoomOf`). */
function fitPdfs(talk: Talk): Talk {
  const pdfRoom = pdfRoomOf(talk)
  if (pdfRoom !== undefined) talk.connection = { ...talk.connection, pdfRoom }
  return talk
}

/** What plugins add to a request to this connection. */
function samplingOf(opts: TurnOptions, connection: Connection): ModelRequest['sampling'] {
  return opts.sampling?.paramsFor(targetOf(connection))
}

/** The tools of a turn that has none: nothing to offer, and nothing that runs. */
const NO_TOOLS: TurnOptions['tools'] = {
  specs: () => [],
  needsPermission: () => true,
  execute: async () => 'Error: this conversation has no tools.'
}

/** What a plain chat is made from: the turn it was asked as, less the tools and what the app would add to the instructions. */
function plainTurn(opts: TurnOptions): TurnOptions {
  const { systemExtra: _skills, memory: _memory, ...rest } = opts
  return { ...rest, tools: NO_TOOLS }
}

/** What tells the parts of a request apart when it is weighed. */
function hintsOf(talk: Talk): MeterHints {
  return { custom: talk.connection.prompt?.text, skills: talk.opts.systemExtra, memory: talk.opts.memory, toolKind: toolKinds(talk.opts.tools) }
}

/** The next request, as things stand now. */
function requestOf(talk: Talk): ModelRequest {
  const { opts } = talk
  const plain = opts.plain === true
  // A plain chat offers no search of the service's and writes no tools into the instructions,
  // whatever the connection was set to or has learned: the adapters go by these two.
  const connection: Connection = plain ? { ...talk.connection, webSearch: false, textTools: false } : talk.connection
  // What is kept, less what was compacted away.
  const kept = sendable(opts.messages)
  return {
    connection,
    // In a plain chat the person's own instructions, as they wrote them, or none.
    system: plain
      ? (connection.prompt?.text.trim() ?? '')
      : systemPrompt({
          workspace: opts.workspace,
          model: { id: connection.model, provider: connection.providerName },
          custom: connection.prompt,
          extra: opts.systemExtra,
          memory: opts.memory,
          language: talk.language,
          webSearch: connection.webSearch
        }),
    messages: plain ? plainMessages(kept) : kept,
    tools: plain ? [] : opts.tools.specs(),
    sampling: samplingOf(opts, connection),
    ...(opts.conversation ? { conversation: opts.conversation } : {}),
    signal: opts.signal,
    onText: (text) => opts.emit({ type: 'text_delta', text }),
    onReasoning: (text) => opts.emit({ type: 'reasoning_delta', text }),
    onRewrite: (shown) => opts.emit({ type: 'assistant_rewrite', ...shown }),
    onWebActivity: (activity) => opts.emit({ type: 'web_activity', activity }),
    onFastRefused: () => {
      // Not asked again for the rest of the turn: it would be refused at every step.
      talk.connection = { ...talk.connection, fast: false }
      opts.emit({
        type: 'notice',
        code: 'fast-mode-refused',
        message: 'The service does not offer Fast Mode for this model here. It was switched off and the message sent at the usual speed.'
      })
      opts.onFastRefused?.()
    },
    onEffortRefused: (said) => {
      // Not named again for the rest of the turn: it would be refused at every step.
      talk.connection = { ...talk.connection, reasoningEffort: 'default' }
      opts.emit({
        type: 'notice',
        code: 'effort-refused',
        message: 'The service does not take the level of thinking chosen for this model. The message was sent without one, and the choice was taken back.',
        detail: said
      })
      opts.onEffortRefused?.()
    },
    onStreamRefused: () => {
      // Asked for in one piece from here on: streaming would fail again at every step.
      talk.connection = { ...talk.connection, wholeReplies: true }
      opts.emit({
        type: 'notice',
        code: 'stream-refused',
        message: 'This model server cannot stream a reply while tools are offered, so each reply appears all at once when it is finished. Nothing moving for a while is normal.'
      })
      opts.onStreamRefused?.()
    }
  }
}

/**
 * A message as the page is handed it when the whole conversation is: without what a service
 * wants back to carry on from it (signed thinking, encrypted reasoning), which the page neither
 * shows nor needs, and which can weigh as much as the conversation itself.
 */
function forPage(message: StoredMessage): StoredMessage {
  if (message.role !== 'assistant' || message.origin?.replay === undefined) return message
  const { replay: _kept, ...origin } = message.origin
  return { ...message, origin }
}

/**
 * What a request weighs beyond its messages, and what each message weighs as it is sent, where
 * the whole is expected to be counted as `weight.tokens`. A message weighs its text; a reply of
 * this provider's weighs, beyond its text, a share of what the service counted for writing it
 * (`origin.tokens`): the thinking, which a service may keep with the reply and count again each
 * time the reply is sent back. How much of that it does is not asked but read from the count:
 * what the count holds beyond the instructions, the tools and the text is that thinking, as far
 * as there is thinking to account for it. One service counts all of it (xAI: a reply of 300
 * tokens with 10,900 of thinking made the next request 11,200 heavier), another none.
 */
function weigher(talk: Talk, parts: ContextParts, weight: { tokens: number; scale: number }): { base: number; weigh(message: StoredMessage): number } {
  // In a plain chat a message weighs what it is sent as there (plain.ts): a tool's result cut
  // short, a reply as its text, and no thinking that comes back with it. Weighed as in a turn
  // with tools, the messages would not add up to the request, and clearing old results would
  // seem to free what was never sent.
  const plain = talk.opts.plain === true
  // A PDF weighs what goes for it to the connection as it is now: a refusal of PDFs changes that within the turn.
  const text = (message: StoredMessage): number => weight.scale * (plain ? plainWeight(message, talk.connection) : storedWeight(message, talk.connection))
  const beyond = (message: StoredMessage): number =>
    !plain && message.role === 'assistant' && message.origin?.tokens && message.origin.provider === talk.connection.provider ? Math.max(0, message.origin.tokens - text(message)) : 0
  let visible = 0
  let hidden = 0
  for (const message of sendable(talk.opts.messages)) {
    visible += text(message)
    hidden += beyond(message)
  }
  // What the instructions and tools weigh: known where a request held nothing else, and otherwise taken at the guess.
  const guessed = halves(parts).base
  const fixed = talk.fit?.pinned !== undefined ? talk.fit.base * guessed : guessed
  const share = hidden > 0 ? Math.min(1, Math.max(0, (weight.tokens - fixed - visible) / hidden)) : 0
  return { base: Math.max(0, weight.tokens - visible - share * hidden), weigh: (message) => text(message) + share * beyond(message) }
}

/**
 * Why room is made: the conversation has grown `full` to the line drawn for it, the person
 * `asked` for it, or the service `refused` a request as too long.
 */
type Why = 'full' | 'asked' | 'refused'

/**
 * Compacts the conversation where that is called for (compaction.ts), and tells the page and the
 * numbers of the conversation what was done. Resolves with whether anything was.
 */
async function makeRoom(talk: Talk, why: Why, refusal?: unknown): Promise<CompactionReport> {
  const { opts } = talk
  if (!opts.room || (why === 'full' && talk.summaryFailed)) return { done: false }
  // An error that says how much the model takes is the best word there is on it.
  if (why === 'refused') talk.window ??= windowSaid(refusal)
  const parts = weigh(requestOf(talk), hintsOf(talk))
  let weight = expected(parts, talk.fit)
  const from = compactFrom(opts.room.settings, talk.window)
  let limit: number
  if (why === 'full') {
    if (from === undefined || weight.tokens < from) return { done: false }
    limit = Math.floor(from * TARGET_SHARE)
  } else if (why === 'asked') {
    // Under the line a compaction made unasked aims for, and in any case a good deal less than there is now.
    limit = Math.floor(Math.min(from === undefined ? Infinity : from * TARGET_SHARE, weight.tokens * 0.8))
  } else {
    // The service counts more than was guessed here: the guess is brought up to what it must be at the least.
    if (talk.window !== undefined && weight.tokens > 0 && weight.tokens < talk.window) {
      const more = Math.min(4, (talk.window * 1.05) / weight.tokens)
      talk.fit = { base: (talk.fit?.base ?? 1) * more, said: (talk.fit?.said ?? 1) * more }
      weight = expected(parts, talk.fit)
    }
    limit = Math.floor(weight.tokens * 0.5)
  }

  let cost: StepMeasure | undefined
  let summarizing = false
  const weights = weigher(talk, parts, weight)
  const result = await compact({
    messages: opts.messages,
    base: weights.base,
    scale: weight.scale,
    weigh: weights.weigh,
    window: talk.window,
    limit,
    language: talk.language,
    signal: opts.signal,
    onSummarizing: () => {
      summarizing = true
      opts.emit({ type: 'compacting', on: true })
    },
    summarize: async (system, record) => {
      // Not at the price of faster answers: nobody is waiting to read these words as they come.
      // Nor with a search: the summary is of what was said, and nothing on the web belongs in it.
      const connection: Connection = { ...talk.connection, fast: false, webSearch: false }
      const watch = opts.trace?.active ? watchExchange(connection) : undefined
      const meter = opts.stats ? meterStep(connection) : undefined
      // Without the name of the conversation: this is a request about it, not one of it, and
      // nothing a server has kept of the conversation is at the start of this one.
      const bare: ModelRequest = {
        connection,
        system,
        messages: [{ role: 'user', content: record }],
        tools: [],
        sampling: samplingOf(opts, connection),
        // What comes back is put in the place of the conversation as it stands: half a summary,
        // or the thinking before one, must not be taken for it.
        unattended: true,
        signal: opts.signal,
        onText: () => {},
        onReasoning: () => {}
      }
      const watched = watch ? watch.over(bare) : bare
      const reply = await ask(talk.adapter, meter ? meter.over(watched) : watched).catch((err: unknown) => {
        if (watch) opts.trace?.record(watch.failed(err))
        throw err
      })
      if (watch) opts.trace?.record(watch.done(reply))
      cost = meter?.done()
      if (reply.stopped) throw new Error(reply.stopped)
      return reply.message.content
    }
  })
  if (summarizing) opts.emit({ type: 'compacting', on: false })
  if (result.mark) {
    // The next request is not the last one grown: what it weighs says nothing of what was added since.
    if (talk.fit?.last) {
      const { last: _gone, ...kept } = talk.fit
      talk.fit = kept
    }
    // What the next request is expected to weigh, part by part. The parts are text; what the mark
    // says beyond their sum is the thinking kept with the replies that are still sent, and goes to the messages.
    const left = fitParts(weigh(requestOf(talk), hintsOf(talk)), talk.fit)
    const beyond = result.mark.after - partsTotal(left)
    if (beyond > 0) left.messages = (left.messages ?? 0) + beyond
    opts.stats?.compacted?.({
      parts: left,
      provider: talk.connection.provider,
      model: talk.connection.model,
      ...(talk.fit ? { fit: talk.fit } : {}),
      ...(cost ? { cost } : {})
    })
    // A request follows at once, unless the person asked for this between two turns.
    talk.uncounted = why === 'asked' ? undefined : result.mark
    // After the numbers were brought up to date: they are saved with the conversation.
    opts.checkpoint()
    // All of it, and not what changed: the page rebuilds what it shows, with the mark in its place.
    opts.emit({ type: 'compacted', messages: opts.messages.map(forPage) })
  }
  // Said after the page was told of what was done, so that it stands below it. A person who asked is answered instead.
  if (result.problem) talk.summaryFailed = true
  if (result.problem && why !== 'asked') {
    opts.emit({
      type: 'notice',
      code: 'compaction-failed',
      message: 'The conversation could not be summarized to make room in the context of the model, so it goes on as it is.',
      detail: result.problem
    })
  }
  return { done: Boolean(result.mark), ...(result.problem ? { problem: result.problem } : {}) }
}

/**
 * What each result of a step's tool calls may weigh, in tokens as guessed: together they take a
 * share of the size from which the conversation is compacted, so that one step cannot fill the
 * context. Undefined where no size is known to take a share of.
 */
function resultBudget(talk: Talk, calls: number): number | undefined {
  const room = talk.opts.room
  if (!room) return undefined
  // With compacting switched off, the line it would be drawn at as the app comes still says what fits.
  const from = compactFrom(room.settings, talk.window) ?? (talk.window !== undefined ? talk.window * COMPACTION_DEFAULTS.share : undefined)
  if (from === undefined) return undefined
  return Math.max(RESULT_MIN, Math.floor((from * STEP_SHARE) / (talk.fit?.said ?? 1) / Math.max(1, calls)))
}

/**
 * Compacts a conversation because the person asked for it, whatever room its model still has.
 * Takes what a turn takes, of which it uses what a request is made from; `room` has to be there.
 */
export function compactConversation(opts: TurnOptions): Promise<CompactionReport> {
  return makeRoom(fitPdfs(talkOf(opts)), 'asked')
}

export async function runTurn(asked: TurnOptions): Promise<void> {
  // A plain chat has no tools from here on, whatever the caller handed over: none to offer, none to run.
  const opts = asked.plain === true ? plainTurn(asked) : asked
  const talk = fitPdfs(talkOf(opts))
  const stored = opts.messages
  // A PDF of the message just sent that is longer than the model's context holds goes as a note
  // from the start (`pdfWithheld`), instead of after a compaction that could not make room for it.
  // The person is told once, at the turn it came with.
  const newest = stored.findLast((message) => message.role === 'user')
  if (newest?.role === 'user' && (newest.attachments ?? []).some((file) => file.kind === 'pdf' && pdfWithheld(file, talk.connection) === 'long')) {
    opts.emit({
      type: 'notice',
      code: 'document-too-long',
      message: "A PDF of this message is longer than this model's context holds, so it was not sent as it is: the model was told where it lies instead."
    })
  }

  /**
   * From now on the PDFs of the conversation are told of by where they lie (`Connection.noDocuments`),
   * and the person is told why, with the service's own words for looking it up.
   */
  const dropDocuments = (detail: string): void => {
    talk.connection = { ...talk.connection, noDocuments: true }
    opts.emit({
      type: 'notice',
      code: 'documents-refused',
      message: 'The model service did not take the PDFs, so they were left out and the model was told where they lie instead.',
      detail
    })
    opts.onDocumentsRefused?.()
  }

  /** Makes one request with the conversation as it stands, measured and written down as far as anyone asked for that. */
  const exchange = async (): Promise<ModelReply> => {
    // While someone watches, this request and its reply are written down, however it ends.
    const watch = opts.trace?.active ? watchExchange(talk.connection) : undefined
    // While the app keeps count, the request is measured as well, which costs next to nothing.
    const meter = opts.stats ? meterStep(talk.connection, hintsOf(talk)) : undefined
    const next = (): ModelRequest => {
      const watched = watch ? watch.over(requestOf(talk)) : requestOf(talk)
      return meter ? meter.over(watched) : watched
    }
    /**
     * The request, made again where the model turned out to take no pictures: with those the
     * person attached told in words instead (`Connection.noImages`). The person is told, with
     * the service's own words for looking it up.
     */
    const withoutImages = (err: unknown): Promise<ModelReply> => {
      if (!(err instanceof ImagesRefused) || talk.connection.noImages) throw err
      talk.connection = { ...talk.connection, noImages: true }
      opts.emit({
        type: 'notice',
        code: 'images-refused',
        message: 'This model does not take pictures, so the pictures were left out and it was told their file names instead.',
        detail: err.message
      })
      opts.onImagesRefused?.()
      // A request that also carries PDFs may be turned down for those next.
      return ask(talk.adapter, next()).catch(withoutDocuments)
    }
    /** The same for the PDFs the person attached: the request made again with those told of by where they lie (`Connection.noDocuments`). */
    const withoutDocuments = (err: unknown): Promise<ModelReply> => {
      if (!(err instanceof DocumentsRefused) || talk.connection.noDocuments) throw err
      dropDocuments(err.message)
      return ask(talk.adapter, next()).catch(withoutImages)
    }
    const reply = await ask(talk.adapter, next())
      .catch(withoutDocuments)
      .catch(withoutImages)
      .catch((err: unknown) => {
        if (!(err instanceof ToolsRefused) || talk.connection.textTools) throw err
        // The server takes no tool definitions. That says little of the model: many a model
        // that calls tools well runs on a server that was not started for it. So the message
        // goes out again with the tools described in the instructions, and the calls are read
        // from what the model writes. The person is told what that means; the service's own
        // words go along for looking it up.
        talk.connection = { ...talk.connection, textTools: true }
        opts.emit({
          type: 'notice',
          code: 'tools-as-text',
          message:
            'This model server does not accept tool definitions, so the tools are described in the instructions instead, and the calls the model writes in its answers are read from the text. A model that never learned to call tools may not manage it.',
          detail: err.message
        })
        opts.onToolsRefused?.()
        // A server that takes no tools may take no pictures or PDFs either, and says so only now.
        return ask(talk.adapter, next()).catch(withoutDocuments).catch(withoutImages)
      })
      .catch((err: unknown) => {
        if (watch) opts.trace?.record(watch.failed(err))
        throw err
      })
    if (watch) opts.trace?.record(watch.done(reply))
    const settled = talk.uncounted
    talk.uncounted = undefined
    if (meter) {
      // With a guess at what the reply weighs once it is part of the conversation: the next request carries it.
      const measure: StepMeasure = { ...meter.done(), reply: storedWeight(reply.message) }
      // And with how much of what the service counted for the reply comes back with it, where
      // that is not all of it: thinking that stays behind fills no later request.
      const counted = measure.usage?.output
      const output = counted === undefined ? undefined : carriedTokens(reply.message, counted)
      if (output !== undefined && output < counted!) measure.carried = output
      opts.stats?.step(measure)
      const sent = sentTokens(measure.usage)
      // Kept with the reply: it is what the reply may take of the context when it is sent back (see `weigher`).
      if (reply.message.origin && output !== undefined) reply.message.origin.tokens = output
      // What the service counted of this request says how far the guesses are off, for the next one.
      talk.fit = fitTo(talk.fit, { sent, output }, measure.parts, measure.reply, measure.fresh)
      if (settled && sent !== undefined) {
        settled.after = sent
        delete settled.rough
        opts.emit({ type: 'compaction_counted', at: settled.at, after: sent })
      }
    }
    return reply
  }

  /**
   * A request still too long for the model after the conversation was compacted, or one that could
   * not be compacted. Where it carries PDFs, those are as a rule what is too much (each page goes as
   * its text and a picture of it), so it is made once more with them told of by where they lie.
   * Anything else stays the error it was.
   */
  const tooLongWithDocuments = (err: unknown): Promise<ModelReply> => {
    if (opts.signal.aborted || !saysTooLong(err) || talk.connection.noDocuments || !carriesDocuments(requestOf(talk))) throw err
    dropDocuments(err instanceof Error ? err.message : String(err))
    return exchange()
  }

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Before the request: the conversation is compacted once it has grown to the line drawn for it.
      await makeRoom(talk, 'full')
      // A stop while the summary was written ends the turn like a stop anywhere else.
      if (opts.signal.aborted) return
      let reply = await exchange().catch(async (err: unknown) => {
        // The service says the conversation is too long. Compacted, it is sent once more; and where
        // that cannot be done, or it is still too long, once more with its PDFs told of by where
        // they lie, since one PDF can be more than a model takes (`tooLongWithDocuments`).
        if (opts.signal.aborted || !saysTooLong(err)) throw err
        if (!(await makeRoom(talk, 'refused', err)).done) return tooLongWithDocuments(err)
        return exchange().catch(tooLongWithDocuments)
      })
      // The same, found out while the reply was being written: what came of it is dropped, and the page shows the conversation anew.
      if (reply.tooLong && !opts.signal.aborted && (await makeRoom(talk, 'refused')).done) reply = await exchange()
      const { message: assistant, stopped } = reply
      // A plain chat offered no tools, so a call in the reply is one nobody asked for: a server
      // that makes them up, or a model that was trained to. It is not run and not kept, and the
      // reply is kept as its text and nothing its service would want back (`plainReply`).
      const dropped = opts.plain === true ? plainReply(assistant) : []
      // When it was finished: the page says it under the last reply of the turn.
      assistant.at = Date.now()
      if (assistant.content || assistant.tool_calls || assistant.reasoning_content || assistant.web?.length) stored.push(assistant)
      opts.emit({ type: 'assistant_done' })
      opts.checkpoint()
      // The service declined, or cut the reply short: what came is kept, nothing in it is run.
      if (stopped) {
        opts.emit({ type: 'error', message: stopped })
        return
      }
      if (dropped.length) {
        opts.emit({
          type: 'notice',
          code: 'plain-call-dropped',
          message: `The model tried to call a tool (${dropped.join(', ')}). This is a plain chat, which runs no tools, so the call was dropped.`
        })
      }
      // The one request of a plain chat is made.
      if (opts.plain === true || !assistant.tool_calls || opts.signal.aborted) return

      // Cut to fit before they are ever sent: nothing that the service has read is changed by that.
      const each = resultBudget(talk, assistant.tool_calls.length)
      for (const call of assistant.tool_calls) {
        opts.emit({ type: 'tool_start', call })
        const result = await runToolCall(call, opts)
        const output = each === undefined ? result : fitTokens(result, each)
        stored.push({ role: 'tool', tool_call_id: call.id, content: output })
        opts.emit({ type: 'tool_result', id: call.id, output })
      }
      opts.checkpoint()
      if (opts.signal.aborted) return
    }
    opts.emit({ type: 'error', message: `Stopped after ${MAX_STEPS} steps without finishing.` })
  } catch (err) {
    opts.emit({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      // With whose request it was: several ChatGPT accounts can be signed in, and the way out is that account's.
      ...(err instanceof ServiceError ? { hint: err.hint, provider: talk.connection.provider } : {})
    })
  } finally {
    opts.checkpoint()
    opts.emit({ type: 'turn_end' })
  }
}
