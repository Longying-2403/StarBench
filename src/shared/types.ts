// Types shared between the main process, the preload bridge and the renderer.

import type { CompactionChange, CompactionSettings } from './compaction.ts'
import type { SessionStats } from './stats.ts'

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string of the arguments, exactly as the model produced it. */
  arguments: string
}

/** The wire format a model service speaks. */
export type ProviderKind = 'openai-chat' | 'openai-responses' | 'anthropic'
export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai-chat', 'openai-responses', 'anthropic']

/**
 * One message of the conversation, in a form every provider's format can be built from:
 * text, the calls the model made, and the results of those calls.
 */
export type ChatMessage =
  | {
      role: 'user'
      content: string
      /**
       * A skill the user picked for this message. `prompt` is the skill text exactly as it was
       * sent to the model, kept so later requests replay the same conversation.
       */
      skill?: { name: string; prompt: string }
    }
  | {
      role: 'assistant'
      content: string
      /** The model's thinking, or the summary of it the service returned. Shown to the user. */
      reasoning_content?: string
      tool_calls?: ToolCall[]
      /**
       * Who wrote the message. `replay` holds what that service wants to see again to carry on from
       * this message exactly (signed thinking blocks, encrypted reasoning); only the same provider
       * reads it, anyone else builds the message from the fields above. Absent on messages written
       * before the app knew more than one provider.
       */
      origin?: {
        provider: string
        kind: ProviderKind
        model: string
        replay?: unknown
        /**
         * What the service counted for writing this reply, thinking among it, where it said. A
         * service may keep the thinking with the reply and count it again every time the reply
         * is sent back: this is then what the message takes of the model's context, which can
         * be many times what its text suggests (main/compaction.ts goes by it).
         */
        tokens?: number
      }
    }
  | {
      role: 'tool'
      tool_call_id: string
      content: string
      /**
       * Set once the result was cleared from what the model is sent, to make room in its context
       * (main/compaction.ts): the line that is sent in its place, kept so that it is the same line
       * every time. `content` stays as it was, for the person to read.
       */
      cleared?: string
    }

/**
 * A place where a conversation was compacted to fit the model's context: old tool results were
 * cleared from what is sent, or everything before the mark was replaced by a summary. It stands
 * among the messages where that was done, is shown there as a line, and is never sent itself.
 */
export interface CompactionMark {
  role: 'compaction'
  /** When it was done, in milliseconds since 1970. */
  at: number
  /** Tokens in the context before and after, as near as could be told, and the room the model had where that was known. */
  before: number
  after: number
  window?: number
  /**
   * Set while `after` is the app's own guess. The next request, where one follows at once, is the
   * compacted conversation and nothing else: what the service counts of it then takes the place
   * of the guess, and this goes.
   */
  rough?: boolean
  /** How many tool results were cleared at this point. */
  cleared?: number
  /** Present when everything before the mark is no longer sent, and this is sent in its place. */
  summary?: {
    /** What the model wrote of the conversation up to here. Shown to the person. */
    text: string
    /**
     * What is sent in place of the earlier messages: the summary, with what the app adds to it
     * without asking a model (what the person wrote, and the files that were touched). Kept as
     * it was first sent, since a text that changed would count as a changed conversation.
     */
    sent: string
    /** How many messages of the person and of the model it stands for. */
    covers: number
    /** How many of the person's messages are quoted in it, and how many files are listed. */
    said: number
    files: number
  }
}

/** A conversation as it is kept: its messages, and the marks of where it was compacted. */
export type StoredMessage = ChatMessage | CompactionMark

/**
 * The marks a session can be given in the list, to tell it from the others at a glance. These
 * are the names a session's file stores; the page holds the drawings.
 */
export const SESSION_ICONS = [
  'star',
  'heart',
  'flag',
  'bookmark',
  'pin',
  'bolt',
  'bulb',
  'rocket',
  'bug',
  'code',
  'terminal',
  'flask',
  'book',
  'pencil',
  'chat',
  'globe',
  'check'
] as const
export type SessionIcon = (typeof SESSION_ICONS)[number]
export const isSessionIcon = (value: unknown): value is SessionIcon => (SESSION_ICONS as readonly unknown[]).includes(value)

export interface Session {
  id: string
  title: string
  workspace: string
  updatedAt: number
  /** Put away: kept, but out of the main list. */
  archived?: boolean
  /** The mark shown before the name in the list. */
  icon?: SessionIcon
  messages: StoredMessage[]
  /** What was measured of the conversation since the app began to keep count (shared/stats.ts). */
  stats?: SessionStats
}

export type SessionSummary = Pick<Session, 'id' | 'title' | 'workspace' | 'updatedAt' | 'archived' | 'icon'>

/** A conversation that a search found. */
export interface SessionHit {
  id: string
  /**
   * A piece of the message the words were found in, when not all of them stand in the name.
   * `marks` are the places of the words in that piece: where each starts, and where it ends.
   */
  snippet?: { text: string; marks: [number, number][] }
}

/**
 * How hard the model thinks before it answers, lowest first. `default` sends nothing and leaves
 * the choice to the service; `none` turns thinking off. The others are the names the services
 * use; no service offers all of them.
 */
export const REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
/** A level the user can put the slider on, as opposed to "nothing chosen". */
export type EffortLevel = Exclude<ReasoningEffort, 'default'>
export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  (REASONING_EFFORTS as readonly unknown[]).includes(value)

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The host the rules for a service go by. xAI also serves its API from an address of its own
 * for one region (`us.api.x.ai`): the same service, so the same rules. An address that only has
 * the name somewhere in it (`api.x.ai.example.com`) is another service.
 */
const serviceHost = (url: string): string => {
  const host = hostOf(url)
  return host.endsWith('.api.x.ai') ? 'api.x.ai' : host
}

/**
 * Whether an address is on this computer or on the network around it. That is where the model
 * servers people run themselves are found (Ollama, LM Studio, llama.cpp, vLLM), and those ask
 * for no API key. Only the address is looked at; nothing is looked up.
 */
export function isLocalAddress(baseURL: string): boolean {
  let host: string
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return false
  }
  // IPv6, written in brackets: this computer, an address of the local network, or one of the link.
  if (host.startsWith('[')) return /^\[(::1|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)\]$/.test(host)
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])]
    // This computer, the three private ranges, the link, and the shared range that VPNs between one's own machines use.
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  // A name without a dot is a machine of the local network; the endings are the ones kept for such networks.
  return host === 'localhost' || (host !== '' && !host.includes('.')) || /\.(localhost|local|lan|internal|home\.arpa)$/.test(host)
}

/**
 * The ladder most services have settled on (OpenAI and Anthropic both use exactly this one).
 * Thinking cannot be switched off on their current models, so there is no "none".
 */
const COMMON_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** The services whose models take other levels, by the host of their address. */
const EFFORTS_BY_HOST: Record<string, readonly EffortLevel[]> = {
  // Thinking can be switched off here, and there is nothing between low and high.
  'api.deepseek.com': ['none', 'low', 'high', 'max'],
  // The scale ends one step earlier.
  'api.x.ai': ['low', 'medium', 'high', 'xhigh']
}
/**
 * For a model server on one's own machine. Most of the open models think or do not, so switching
 * it off is the choice that matters; Ollama takes these names, and servers that do not know the
 * request field leave it aside.
 */
const LOCAL_EFFORTS: readonly EffortLevel[] = ['none', 'low', 'medium', 'high']

/**
 * The levels to offer when a service does not say which ones a model takes. A level the model
 * turns out not to know is reported by the service when a message is sent. `kind` is the format
 * the service is spoken to in, when that is known.
 */
export function usualEfforts(baseURL: string, kind: ProviderKind = 'openai-chat'): readonly EffortLevel[] {
  if (kind === 'openai-chat' && isLocalAddress(baseURL)) return LOCAL_EFFORTS
  return EFFORTS_BY_HOST[serviceHost(baseURL)] ?? COMMON_EFFORTS
}

/** A level of thinking, as opposed to none at all. */
export type ThinkingLevel = Exclude<EffortLevel, 'none'>
/** The levels as the services write them. */
const EFFORT_NAMES: Record<ThinkingLevel, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xHigh', max: 'Max' }
/** Where a service has a name of its own for a level: OpenAI's products call `xhigh` "Extra High". */
const EFFORT_NAMES_BY_HOST: Record<string, Partial<Record<ThinkingLevel, string>>> = {
  'api.openai.com': { xhigh: 'Extra High' }
}

/**
 * What a level is called: the name its service gives it, as the service writes it, and not a
 * word of the app's own. Put into Chinese, the step above "high" read like the "Ultra" some
 * products have above their highest level (OpenAI's Codex, which does not offer it over the API),
 * and the highest like the end of every scale, which it is not for a service whose scale ends a
 * step earlier. The service is told by the address it is reached at; with an API key or with a
 * ChatGPT sign-in, OpenAI's is the same.
 */
export function effortName(level: ThinkingLevel, baseURL = ''): string {
  return EFFORT_NAMES_BY_HOST[serviceHost(baseURL)]?.[level] ?? EFFORT_NAMES[level]
}

/**
 * Whether a service wants to be told which conversation a request belongs to. xAI keeps what it
 * has read of a conversation on the server that read it, and only there is the next request
 * charged the lower price for what is the same as before. A request that says nothing lands on
 * any server: measured on 2026-11-23, of 8,300 tokens that had all been sent before, 1,150 came
 * back as read from the cache. Told the conversation, it tries to send the request where the
 * others went, and mostly does.
 */
export function routesByConversation(baseURL: string): boolean {
  return serviceHost(baseURL) === 'api.x.ai'
}

/** What the model service reports about the configured model. Services differ, so everything is optional. */
export interface ModelInfo {
  /** Readable name with the version, e.g. "DeepSeek-V4.1-Flash". */
  name?: string
  /** The thinking levels the model accepts. */
  efforts?: EffortLevel[]
  /** The level the service uses when none is sent. */
  defaultEffort?: EffortLevel
  /**
   * How many tokens the model's context holds, and who says so: the person, who typed it in; the
   * service, in its list of models; or the list of well-known models that comes with the app.
   */
  contextWindow?: number
  contextSource?: 'manual' | 'service' | 'known'
}

/** A model a provider offers, for the list the user picks from. */
export interface ModelChoice {
  id: string
  /** Readable name, when the service gives one. */
  name?: string
}

/** The ChatGPT account behind a provider that is signed in to rather than given a key. */
export interface ChatGptAccount {
  /** Whether a sign-in is in place. */
  signedIn: boolean
  /** The account's address, to tell accounts apart. Still known after signing out. */
  email?: string
  /** False when the account is signed in but did not allow the app to use its plan for requests. */
  planUsage: boolean
}

/**
 * Instructions of the person's own for the models of one provider: a preference they hold, or
 * the system prompt a model of theirs was trained with.
 */
export interface CustomPrompt {
  text: string
  /** Stands in place of the app's own instructions, instead of following them. */
  replace: boolean
}
/** The longest custom prompt that is kept, in characters. */
export const CUSTOM_PROMPT_LIMIT = 20000

/** A configured model service, as the page sees it: everything but the key. */
export interface ProviderInfo {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  /** The model used with this provider; empty until one is chosen. */
  model: string
  /**
   * Whether requests can be made: a key is stored, the service is a local one that asks for none
   * (see `isLocalAddress`) or, for a ChatGPT sign-in, the account is signed in and allows its plan
   * to be used.
   */
  ready: boolean
  /** Whether a key is stored. The key itself, like the tokens of a sign-in, never leaves the main process. */
  hasApiKey: boolean
  /** What the person added to, or put in place of, the app's instructions for this provider's models. */
  prompt?: CustomPrompt
  /** Set when requests use a person's ChatGPT plan after signing in, instead of an API key. */
  auth?: 'chatgpt'
  /** Present exactly when `auth` is. */
  account?: ChatGptAccount
}

export interface ProviderInput {
  /** Omit to add a provider; give the id to change one. */
  id?: string
  name: string
  kind: ProviderKind
  baseURL: string
  model: string
  /** Omit to keep the stored key; empty string clears it. */
  apiKey?: string
}

export interface Settings {
  providers: ProviderInfo[]
  /** The provider messages are sent to. */
  activeProviderId: string
  /** The fields below describe the active provider, for the parts of the page that only care about that one. */
  kind: ProviderKind
  model: string
  /** The effort chosen for the active provider's current model. */
  reasoningEffort: ReasoningEffort
  /** Whether faster answers were asked for with that model. It only has an effect where `offersFastMode` says so. */
  fastMode: boolean
  /** Whether requests can be made with it; see `ProviderInfo.ready`. */
  ready: boolean
  /** Whether the app keeps count of what conversations cost: requests, time, tokens, and how full the context is. */
  stats: boolean
  /** Whether, and from where on, a conversation is compacted as it fills the model's context. */
  compaction: CompactionSettings
}

/** The Claude models that answer faster on request, with nothing to apply for first. */
const FAST_CLAUDE = new Set(['claude-fable-5-2', 'claude-mythos-5-2', 'claude-opus-5-5'])

/**
 * Whether a provider's current model can be asked to write its answers faster, for a higher
 * price ("fast mode"). OpenAI offers this on its own API and with a ChatGPT sign-in, Anthropic
 * for some models on its own API; a gateway in front of either may not know the request field.
 */
export function offersFastMode(provider: Pick<ProviderInfo, 'kind' | 'baseURL' | 'model' | 'auth'>): boolean {
  if (!provider.model) return false
  const host = hostOf(provider.baseURL)
  if (provider.kind === 'openai-responses') return provider.auth === 'chatgpt' || host === 'api.openai.com'
  if (provider.kind === 'anthropic') return host === 'api.anthropic.com' && FAST_CLAUDE.has(provider.model)
  return false
}

/** Starting points for the services the app knows how to talk to. */
export const PROVIDER_PRESETS: readonly (Omit<ProviderInfo, 'ready' | 'hasApiKey'> & { keyHint: string })[] = [
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', keyHint: 'sk-…' },
  { id: 'openai', name: 'OpenAI', kind: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: '', keyHint: 'sk-…' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-opus-5-5', keyHint: 'sk-ant-…' },
  { id: 'xai', name: 'xAI', kind: 'openai-chat', baseURL: 'https://api.x.ai/v1', model: '', keyHint: 'xai-…' }
]

/**
 * The programs people run models with on their own computer, and the address each one listens at
 * unless told otherwise. All of them speak chat completions there. The first is what a new local
 * provider starts from.
 */
export const LOCAL_SERVERS: readonly { name: string; baseURL: string }[] = [
  { name: 'Ollama', baseURL: 'http://localhost:11434/v1' },
  { name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
  { name: 'llama.cpp', baseURL: 'http://localhost:8080/v1' },
  { name: 'vLLM', baseURL: 'http://localhost:8000/v1' }
]

/** Where a person sees and limits what apps use of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'
/** OpenAI's own explanations of using a ChatGPT plan in other apps. */
export const CHATGPT_HELP_URL = 'https://help.openai.com'

/** What may be asked for when starting a ChatGPT sign-in. */
export interface SignInOptions {
  /** The provider to sign in to again. Without one, a provider is added. */
  providerId?: string
  /** Forget the account that provider was registered with and let the person pick any account. */
  otherAccount?: boolean
  /** Ask the account again for the permission to use its plan. */
  consent?: boolean
}

/** How a ChatGPT sign-in ended. */
export type SignInResult =
  | {
      ok: true
      settings: Settings
      providerId: string
      /** True the first time a sign-in with plan usage succeeds on this computer: the moment to explain what it means. */
      welcome: boolean
    }
  | {
      ok: false
      /** `denied`: the person said no on the sign-in page. */
      reason: 'cancelled' | 'denied' | 'timeout' | 'failed'
      detail: string
    }

/** Errors the page presents with a way out (a link, a button) instead of as plain text. */
export type ErrorHint = 'chatgpt-usage' | 'chatgpt-sign-in'

export interface PluginInfo {
  /** Folder name under the plugins directory. */
  id: string
  name: string
  version: string
  description: string
  /** It came with the app and was not put into the plugins folder by the person. */
  builtin: boolean
  enabled: boolean
  /**
   * `waiting`: enabled, but a service it injects is not available yet. `held`: enabled, and not
   * started because the app was started with every plugin left out.
   */
  status: 'disabled' | 'active' | 'waiting' | 'error' | 'held'
  error?: string
  /** Names of the tools it currently provides. */
  tools: string[]
  /** Names of the skills it currently provides. */
  skills: string[]
  /** It is running and has an interface for the page to load: a `ui/index.js` in its folder. */
  ui: boolean
  /** That interface comes with a style sheet, a `ui/index.css`, for the page to put in force for it. */
  uiStyle: boolean
  /** Which start of a plugin this is, counted since the app started; 0 while it is not running. Another number means it was started again, and its interface is to be loaded again. */
  run: number
}

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  state: 'disabled' | 'connecting' | 'connected' | 'error'
  error?: string
  /** Names of its tools as the model sees them (`mcp__server__tool`). */
  tools: string[]
}

export interface SkillInfo {
  name: string
  description: string
  /** "user" for the user's own skills folder, "builtin" for those that come with the app, otherwise the id of the plugin that ships it. */
  source: string
}

export type PermissionDecision = 'allow' | 'always' | 'deny'

export type AgentEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  /**
   * What came of the message being written so far reads differently now: text that was taken for
   * the answer was the model's thinking (or the other way round), or held a tool call that was
   * taken out of it. `text` and `reasoning` are all of the message as it stands, in place of
   * what the deltas added up to; more deltas may follow.
   */
  | { type: 'assistant_rewrite'; text: string; reasoning: string }
  /** The model finished one assistant message (text and/or tool calls). */
  | { type: 'assistant_done' }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_result'; id: string; output: string }
  | { type: 'permission_request'; id: string; call: ToolCall }
  | { type: 'turn_end' }
  /** The numbers of the conversation, after a request or a tool call changed them. */
  | { type: 'stats'; stats: SessionStats }
  /** A summary of the conversation is being asked of the model, which takes a while, or that has ended. */
  | { type: 'compacting'; on: boolean }
  /** The conversation was compacted. `messages` is all of it as it is kept now, with the mark of that in its place. */
  | { type: 'compacted'; messages: StoredMessage[] }
  /** The service has counted the conversation as the compaction made at `at` left it: `after` tokens, in place of the guess. */
  | { type: 'compaction_counted'; at: number; after: number }
  | { type: 'error'; message: string; hint?: ErrorHint }
  /**
   * Something the person should know that did not stop the turn. `code` is what the page words it
   * by; `detail` is what the service itself said, when that helps to look the matter up.
   */
  | { type: 'notice'; code: 'fast-mode-refused' | 'tools-as-text' | 'stream-refused' | 'compaction-failed'; message: string; detail?: string }

export interface SessionEvent {
  sessionId: string
  event: AgentEvent
}

/** What became of an attempt to compact a conversation. */
export interface CompactionReport {
  /** Whether anything was done: results cleared, or a summary put in place. */
  done: boolean
  /** Why no summary was made although one was called for, in the words of whoever refused it. */
  problem?: string
}

/** Why a file that an answer points to cannot be shown or opened: it is not there, or it is not in the folder of the conversation. */
export type FileProblem = 'missing' | 'outside'

/** A picture an answer shows, as an address the page can draw, or why there is none. */
export type ImagePreview = { ok: true; url: string } | { ok: false; reason: FileProblem | 'not-image' | 'too-large' }

/**
 * What became of a press on a link to a file. `revealed`: the file was pointed out in its folder
 * and not opened, as is done with every kind of file that opening might run.
 */
export type OpenOutcome = { ok: true; how: 'opened' | 'revealed' } | { ok: false; reason: FileProblem | 'failed'; detail?: string }

export interface HarnessApi {
  getSettings(): Promise<Settings>
  /** What the running app is: its version, as it was built. */
  appInfo(): Promise<{ version: string }>
  /** Adds a provider or changes one. Resolves with the updated settings. */
  saveProvider(input: ProviderInput): Promise<Settings>
  /** The last provider cannot be removed. */
  removeProvider(id: string): Promise<Settings>
  /**
   * Opens the ChatGPT sign-in page in the browser. Resolves once it is open, with the page's
   * address for a person whose browser did not come up; `finishSignIn` tells how it ended.
   */
  startSignIn(options?: SignInOptions): Promise<{ url: string }>
  /** Resolves when the sign-in started last has ended, one way or another. */
  finishSignIn(): Promise<SignInResult>
  cancelSignIn(): Promise<void>
  /**
   * Signs a provider out of ChatGPT. `revoked` is false when OpenAI could not be told: the tokens
   * are gone from this computer either way, but the person may want to disconnect the app in ChatGPT.
   */
  signOut(providerId: string): Promise<{ settings: Settings; revoked: boolean }>
  /** Makes a provider and one of its models the one messages go to. */
  selectModel(providerId: string, model: string): Promise<Settings>
  /** The models a provider offers. Rejects when the service cannot be asked (no key, unreachable). */
  listModels(providerId: string): Promise<ModelChoice[]>
  /** Applies to the current model, from the next message on. Resolves with the updated settings. */
  setReasoningEffort(effort: ReasoningEffort): Promise<Settings>
  /** Asks for faster answers from the current model, or stops asking. Resolves with the updated settings. */
  setFastMode(on: boolean): Promise<Settings>
  /** Asks the model service about the current model. Null when it has nothing to say or cannot be reached. */
  getModelInfo(): Promise<ModelInfo | null>
  /** Says how many tokens the context of a model holds, for a model the app cannot find it out for. Null takes the number back. */
  setContextWindow(providerId: string, model: string, tokens: number | null): Promise<Settings>
  /** Switches the counting of what conversations cost on or off. */
  setStats(on: boolean): Promise<Settings>
  /** Changes whether, and from where on, conversations are compacted by themselves. What is left out stays as it is. */
  setCompaction(change: CompactionChange): Promise<Settings>
  /** The instructions the app itself gives every model, for showing them next to the person's own. */
  builtinPrompt(): Promise<string>
  /**
   * Gives a provider's models instructions of the person's own; null, or a prompt without text,
   * takes them away. Counts from the next message. Resolves with the updated settings.
   */
  setPrompt(providerId: string, prompt: CustomPrompt | null): Promise<Settings>
  listPlugins(): Promise<PluginInfo[]>
  /** Whether the app was started with every plugin left out (`--no-plugins`), the way out when a plugin keeps it from being usable. */
  pluginsHeld(): Promise<boolean>
  /** Resolves with the refreshed list. */
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo[]>
  /** Stops a running plugin and starts it again, to take up changes in its folder. Resolves with the refreshed list. */
  reloadPlugin(id: string): Promise<PluginInfo[]>
  /** Tells when a plugin was switched on or off, so that the page loads or drops its interface. Returns the function that stops the telling. */
  onPluginsChanged(listener: () => void): () => void
  /** Asks the main-process half of a plugin a question on behalf of its interface. Rejects when the plugin is off or has no answer to it. */
  callPlugin(plugin: string, name: string, payload?: unknown): Promise<unknown>
  /** What the main-process halves of plugins tell their interfaces. Returns the function that stops the telling. */
  onPluginEvent(listener: (told: { plugin: string; event: string; payload: unknown }) => void): () => void
  openPluginsFolder(): Promise<void>
  listSkills(): Promise<SkillInfo[]>
  openSkillsFolder(): Promise<void>
  /** The text of mcp.json and the state of each server in it. `error` is set when the file could not be loaded. */
  getMcp(): Promise<{ config: string; servers: McpServerStatus[]; error?: string }>
  /** Validates and saves the text, then reconnects. Rejects with a readable message when it is invalid. */
  saveMcp(config: string): Promise<McpServerStatus[]>
  reconnectMcp(): Promise<McpServerStatus[]>
  mcpStatus(): Promise<McpServerStatus[]>
  /** Opens the system folder dialog. Resolves with null when it is cancelled. */
  pickWorkspace(): Promise<string | null>
  /** Folders used before that still exist, most recent first. */
  listWorkspaces(): Promise<string[]>
  /** A picture in the workspace that an answer shows. `address` is what the answer wrote: a path, or a file: address. */
  readImage(workspace: string, address: string): Promise<ImagePreview>
  /** Opens a file or folder in the workspace that an answer points to, with the program the system has for it. */
  openFile(workspace: string, address: string): Promise<OpenOutcome>
  listSessions(): Promise<SessionSummary[]>
  /** The conversations in which every word of `query` is found, in the name or in what was said. */
  searchSessions(query: string): Promise<SessionHit[]>
  loadSession(id: string): Promise<Session | null>
  deleteSession(id: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  /** Archived sessions stay on disk and can be brought back. */
  setSessionArchived(id: string, archived: boolean): Promise<void>
  /** The mark before the session's name in the list; null takes it away. */
  setSessionIcon(id: string, icon: SessionIcon | null): Promise<void>
  /**
   * Starts a turn. Creates the session when `sessionId` is null. Resolves with the session id.
   * `skill` names a skill the user picked for this message.
   */
  send(sessionId: string | null, workspace: string, text: string, skill?: string): Promise<string>
  /**
   * Compacts a conversation now, with the model in use, whatever its context still holds. What
   * was done is told through `onEvent`, as in a turn. `done` is false when there was nothing
   * worth compacting; `problem` says why no summary could be had.
   */
  compactSession(sessionId: string): Promise<CompactionReport>
  stop(sessionId: string): Promise<void>
  respondPermission(id: string, decision: PermissionDecision): Promise<void>
  onEvent(listener: (e: SessionEvent) => void): () => void
}
