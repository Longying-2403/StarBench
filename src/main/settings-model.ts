// The shape of settings.json, how older shapes are brought up to date, and the changes the
// settings page can make. Nothing in this file depends on Electron or touches the disk.

import { COMPACTION_DEFAULTS, CAP_MAX, CAP_MIN, isCap, readShare } from '../shared/compaction.ts'
import type { CompactionSettings } from '../shared/compaction.ts'
import { startingEffort } from '../shared/effort-defaults.ts'
import { cleanWorkspaceName, folderKey, folderName } from '../shared/folders.ts'
import { sendsKeySafely } from '../shared/key-address.ts'
import { DEFAULT_THEME, isTheme } from '../shared/theme.ts'
import type { Theme } from '../shared/theme.ts'
import { CUSTOM_PROMPT_LIMIT, PROVIDER_KINDS, PROVIDER_PRESETS, isLocalAddress, isReasoningEffort } from '../shared/types.ts'
import type { ChatGptAccount, CustomPrompt, ProviderInfo, ProviderInput, ProviderKind, ReasoningEffort, Settings } from '../shared/types.ts'

export interface StoredProvider {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string
  /** The model in use with this provider; empty until one is chosen. */
  model: string
  /** base64 of the key as the operating system encrypted it. */
  encryptedKey?: string
  /** The thinking effort chosen for each model of this provider. Models not listed use the service's default. */
  efforts?: Record<string, ReasoningEffort>
  /** The models of this provider for which faster answers were asked for. */
  fast?: string[]
  /** The models of this provider that may search the web with the service's own search tool. */
  search?: string[]
  /** The person's own instructions for this provider's models. */
  prompt?: CustomPrompt
  /** How many tokens the context of a model holds, for the models the person typed that in for. */
  windows?: Record<string, number>
  /** Set when the provider is signed in to with a ChatGPT account instead of being given a key. */
  auth?: 'chatgpt'
  /** base64 of that sign-in (the registration, the account, the tokens) as the operating system encrypted it. */
  encryptedLogin?: string
  /** Whether that sign-in can be used for requests right now. Kept beside it so this needs no decrypting. */
  signedIn?: boolean
}

export interface StoredSettings {
  providers: StoredProvider[]
  activeProviderId: string
  /** Folders picked as a workspace, most recent first. */
  recentWorkspaces?: string[]
  /** The names the person gave workspaces, by the key of the folder (`folderKey`). The folders keep their own names on the disk. */
  workspaceNames?: Record<string, string>
  /**
   * The folders the person said a model may read, as they were chosen. Absent in a file from
   * before the app asked: the folders in use by then count as trusted (`trustFolders` is first
   * called with them), and from then on the list is here, be it empty.
   */
  trustedFolders?: string[]
  /** Identifies this installation to the ChatGPT sign-in. Made once; it says nothing about the person. */
  hostId?: string
  /** The note that explains ChatGPT plan usage has been shown; it is shown once. */
  chatgptWelcomed?: boolean
  /** Set, to false, when the counting of what conversations cost was switched off. Absent, the app counts. */
  stats?: false
  /** What the person changed about compacting conversations. What is not here is as the app comes (`COMPACTION_DEFAULTS`). */
  compaction?: { auto?: false; share?: number; cap?: number }
  /** The look the person chose, where it is not the one the app comes with (`DEFAULT_THEME`). Absent, the app goes by the system. */
  theme?: Exclude<Theme, typeof DEFAULT_THEME>
  /** Set, to false, when conversations are no longer to be named by the model after their first turn (title.ts). Absent, they are. */
  titles?: false
  /** Set, to false, when the list of conversations no longer says under each when it was last gone on with. Absent, it does. */
  sessionTimes?: false
}

/** What a ChatGPT sign-in is added as. */
const CHATGPT = { name: 'ChatGPT', kind: 'openai-responses' } as const

/**
 * Whether a provider can be used without a key: a model server on this computer or on the local
 * network asks for none.
 */
export const needsNoKey = (provider: StoredProvider): boolean => provider.auth !== 'chatgpt' && isLocalAddress(provider.baseURL)

/** Whether a key may be sent to an address: over https, or over plain http to this computer or a local-network IP address (shared/key-address.ts). */
export { sendsKeySafely }

/** Why no key is saved for, nor sent to, an address that plain http would expose it on. */
export const KEY_NEEDS_HTTPS =
  "An API key is only sent over https://, or over http:// to this computer or to a local-network IP address: a name could be answered for by another machine on the network. Change the address to https://, or write the server's IP address."

/** Whether requests can be made with a provider as it is stored. */
const usable = (provider: StoredProvider): boolean =>
  provider.auth === 'chatgpt' ? Boolean(provider.signedIn && provider.encryptedLogin) : Boolean(provider.encryptedKey) || needsNoKey(provider)

const DEEPSEEK = PROVIDER_PRESETS[0]

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A custom prompt as it is kept: trimmed and no longer than allowed. Undefined when there is no text to keep. */
function readPrompt(raw: unknown): CustomPrompt | undefined {
  if (!isObject(raw)) return undefined
  const words = text(raw.text).slice(0, CUSTOM_PROMPT_LIMIT)
  return words ? { text: words, replace: raw.replace === true } : undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** A short id made of the readable part of a name, different from the ids already taken. */
function freshId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'provider'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

function readProvider(raw: unknown, taken: readonly string[]): StoredProvider | null {
  if (!isObject(raw)) return null
  const kind = PROVIDER_KINDS.find((k) => k === raw.kind)
  const baseURL = text(raw.baseURL)
  if (!kind || !baseURL) return null
  const name = text(raw.name) || hostOf(baseURL) || kind
  const id = /^[a-z0-9-]{1,40}$/.test(text(raw.id)) && !taken.includes(text(raw.id)) ? text(raw.id) : freshId(name, taken)
  const efforts: Record<string, ReasoningEffort> = {}
  if (isObject(raw.efforts)) {
    for (const [model, effort] of Object.entries(raw.efforts)) {
      // "default" is what an absent entry means, so it is not kept.
      if (isReasoningEffort(effort) && effort !== 'default') efforts[model] = effort
    }
  }
  const fast = Array.isArray(raw.fast) ? [...new Set(raw.fast.filter((m): m is string => typeof m === 'string' && m !== ''))] : []
  const search = Array.isArray(raw.search) ? [...new Set(raw.search.filter((m): m is string => typeof m === 'string' && m !== ''))] : []
  const prompt = readPrompt(raw.prompt)
  const windows: Record<string, number> = {}
  if (isObject(raw.windows)) {
    for (const [model, tokens] of Object.entries(raw.windows)) if (isWindow(tokens)) windows[model] = tokens
  }
  const common = {
    id,
    name,
    baseURL,
    model: text(raw.model),
    ...(Object.keys(efforts).length ? { efforts } : {}),
    ...(fast.length ? { fast } : {}),
    ...(search.length ? { search } : {}),
    ...(prompt ? { prompt } : {}),
    ...(Object.keys(windows).length ? { windows } : {})
  }
  if (raw.auth === 'chatgpt') {
    // A sign-in has no key, and speaks the one format the plan can be used with.
    const login = text(raw.encryptedLogin)
    return { ...common, kind: CHATGPT.kind, auth: 'chatgpt', ...(login ? { encryptedLogin: login, ...(raw.signedIn === true ? { signedIn: true } : {}) } : {}) }
  }
  return { ...common, kind, ...(text(raw.encryptedKey) ? { encryptedKey: text(raw.encryptedKey) } : {}) }
}

/**
 * Before the app knew more than one provider, settings.json held one connection at the top
 * level. That connection becomes the first provider, with its key and its chosen effort.
 */
function fromSingleConnection(raw: Record<string, unknown>): StoredProvider {
  const baseURL = text(raw.baseURL) || DEEPSEEK.baseURL
  const model = text(raw.model) || DEEPSEEK.model
  const preset = PROVIDER_PRESETS.find((p) => hostOf(p.baseURL) === hostOf(baseURL))
  const effort = raw.reasoningEffort
  return {
    id: preset?.id ?? 'custom',
    name: preset?.name ?? (hostOf(baseURL) || 'Custom'),
    // That version spoke chat completions to whatever it was pointed at; this keeps it doing so.
    kind: 'openai-chat',
    baseURL,
    model,
    ...(text(raw.encryptedKey) ? { encryptedKey: text(raw.encryptedKey) } : {}),
    ...(isReasoningEffort(effort) && effort !== 'default' ? { efforts: { [model]: effort } } : {})
  }
}

/**
 * Turns whatever settings.json holds into valid settings: an older file is converted, a
 * hand-edited one is cleaned of what cannot be used, and a missing one becomes the defaults.
 */
export function readSettings(raw: unknown): StoredSettings {
  const source = isObject(raw) ? raw : {}
  const providers: StoredProvider[] = []
  if (Array.isArray(source.providers)) {
    for (const entry of source.providers) {
      const provider = readProvider(
        entry,
        providers.map((p) => p.id)
      )
      if (provider) providers.push(provider)
    }
  } else if ('baseURL' in source || 'model' in source || 'encryptedKey' in source) {
    providers.push(fromSingleConnection(source))
  }
  if (providers.length === 0) {
    providers.push({ id: DEEPSEEK.id, name: DEEPSEEK.name, kind: DEEPSEEK.kind, baseURL: DEEPSEEK.baseURL, model: DEEPSEEK.model })
  }
  const active = providers.find((p) => p.id === source.activeProviderId) ?? providers[0]
  const recent = Array.isArray(source.recentWorkspaces)
    ? source.recentWorkspaces.filter((dir): dir is string => typeof dir === 'string')
    : []
  const compaction = keptCompaction(isObject(source.compaction) ? source.compaction : {})
  const names = keptNames(isObject(source.workspaceNames) ? source.workspaceNames : {})
  // An empty list is kept: it says that the folders from before the app asked have been seen to.
  const trusted = Array.isArray(source.trustedFolders) ? source.trustedFolders.filter((dir): dir is string => typeof dir === 'string' && dir.trim() !== '') : undefined
  return {
    providers,
    activeProviderId: active.id,
    ...(recent.length ? { recentWorkspaces: recent } : {}),
    ...(names ? { workspaceNames: names } : {}),
    ...(trusted ? { trustedFolders: trusted } : {}),
    ...(/^urn:uuid:[0-9a-f-]{36}$/i.test(text(source.hostId)) ? { hostId: text(source.hostId) } : {}),
    ...(source.chatgptWelcomed === true ? { chatgptWelcomed: true } : {}),
    ...(source.stats === false ? { stats: false as const } : {}),
    ...(compaction ? { compaction } : {}),
    ...keptTheme(source.theme),
    ...(source.titles === false ? { titles: false as const } : {}),
    ...(source.sessionTimes === false ? { sessionTimes: false as const } : {})
  }
}

/** The names given to workspaces as they are written down: each as a typed one is kept, none of them empty. Undefined when there is none. */
function keptNames(raw: Record<string, unknown>): StoredSettings['workspaceNames'] {
  const names = new Map<string, string>()
  for (const [key, name] of Object.entries(raw)) {
    const clean = typeof name === 'string' ? cleanWorkspaceName(name) : ''
    if (key && clean) names.set(key, clean)
  }
  // Made of its entries, so that a key like "__proto__" is a folder like any other.
  return names.size ? Object.fromEntries(names) : undefined
}

/**
 * Gives a workspace a name of the person's own, for the lists of the app: the folder keeps its
 * name on the disk. An empty name, or the folder's own, takes a given one back. `name` arrives
 * from the page, and `windows` says how folders are told apart on this computer (`folderKey`).
 */
export function nameWorkspace(settings: StoredSettings, folder: string, name: unknown, windows: boolean): StoredSettings {
  const key = folderKey(folder, windows)
  if (!key) throw new Error('No folder was named.')
  const clean = typeof name === 'string' ? cleanWorkspaceName(name) : ''
  const { workspaceNames: before = {}, ...rest } = settings
  const names = keptNames({ ...before, [key]: clean === folderName(folder) ? '' : clean })
  return names ? { ...rest, workspaceNames: names } : rest
}

/**
 * Forgets a folder as a workspace: it is no longer among the remembered ones, and the name it was
 * given goes with it. Used again later, the folder starts as any folder does, by its own name.
 */
export function forgetWorkspace(settings: StoredSettings, folder: string, windows: boolean): StoredSettings {
  const key = folderKey(folder, windows)
  const { recentWorkspaces: remembered = [], workspaceNames: before = {}, trustedFolders: trusted, ...rest } = settings
  const recent = remembered.filter((dir) => folderKey(dir, windows) !== key)
  const names = keptNames({ ...before, [key]: '' })
  return {
    ...rest,
    ...(recent.length ? { recentWorkspaces: recent } : {}),
    ...(names ? { workspaceNames: names } : {}),
    // The yes it was given goes too: chosen again, it is asked about like any folder.
    ...(trusted ? { trustedFolders: trusted.filter((dir) => folderKey(dir, windows) !== key) } : {})
  }
}

/** Whether the person said a model may read a folder. `windows` says how folders are told apart on this computer (`folderKey`). */
export function isTrusted(settings: Pick<StoredSettings, 'trustedFolders'>, folder: string, windows: boolean): boolean {
  const key = folderKey(folder, windows)
  return key !== '' && (settings.trustedFolders ?? []).some((dir) => folderKey(dir, windows) === key)
}

/**
 * Adds folders to those a model may read, each once, and writes the list down even when it is
 * empty: from then on it is the list that counts (see `StoredSettings.trustedFolders`).
 */
export function trustFolders(settings: StoredSettings, folders: readonly string[], windows: boolean): StoredSettings {
  const trusted = [...(settings.trustedFolders ?? [])]
  const keys = new Set(trusted.map((dir) => folderKey(dir, windows)))
  for (const folder of folders) {
    const key = typeof folder === 'string' ? folderKey(folder, windows) : ''
    if (!key || keys.has(key)) continue
    keys.add(key)
    trusted.push(folder.trim())
  }
  return { ...settings, trustedFolders: trusted }
}

/** What is written down of the settings of compaction: only what differs from how the app comes. Undefined when nothing does. */
function keptCompaction(raw: Record<string, unknown>): StoredSettings['compaction'] {
  const share = typeof raw.share === 'number' ? readShare(raw.share) : COMPACTION_DEFAULTS.share
  const kept: NonNullable<StoredSettings['compaction']> = {
    ...(raw.auto === false ? { auto: false as const } : {}),
    ...(share !== COMPACTION_DEFAULTS.share ? { share } : {}),
    ...(isCap(raw.cap) ? { cap: raw.cap } : {})
  }
  return Object.keys(kept).length ? kept : undefined
}

/** Whether, and from where on, conversations are compacted by themselves. */
export function compactionOf(settings: StoredSettings): CompactionSettings {
  const kept = settings.compaction ?? {}
  return { auto: kept.auto !== false, share: kept.share ?? COMPACTION_DEFAULTS.share, cap: kept.cap ?? null }
}

/**
 * Changes the settings of compaction. `change` arrives from the page: of the three settings it
 * names those that change, and what it does not name stays. A share out of range is brought to
 * the nearest one that can be set; a cap that cannot be one is refused, so that a slip of the
 * hand does not compact every conversation at once.
 */
export function setCompaction(settings: StoredSettings, change: unknown): StoredSettings {
  if (!isObject(change)) throw new Error('Nothing to change was named.')
  const now = compactionOf(settings)
  const next: Record<string, unknown> = { ...now }
  if (typeof change.auto === 'boolean') next.auto = change.auto
  if (change.share !== undefined) {
    if (typeof change.share !== 'number' || !Number.isFinite(change.share)) throw new Error('The share of the context must be a number.')
    next.share = readShare(change.share)
  }
  if (change.cap === null) next.cap = undefined
  else if (change.cap !== undefined) {
    if (!isCap(change.cap)) throw new Error(`The limit must be a whole number of tokens from ${CAP_MIN} to ${CAP_MAX}.`)
    next.cap = change.cap
  }
  const { compaction: _dropped, ...rest } = settings
  const kept = keptCompaction(next)
  return kept ? { ...rest, compaction: kept } : rest
}

export function activeProvider(settings: StoredSettings): StoredProvider {
  return settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0]
}

/**
 * The level of thinking in use with the provider's current model: the one chosen for it, or,
 * with none chosen, the one a well-known model starts at (`startingEffort`). That one is shown
 * and sent like a chosen one. For any other model it is `default`: nothing is sent, and the
 * service decides.
 */
export function effortOf(provider: StoredProvider): ReasoningEffort {
  return provider.efforts?.[provider.model] ?? startingEffort(provider) ?? 'default'
}

/** Whether faster answers were asked for with the provider's current model. */
export function fastOf(provider: StoredProvider): boolean {
  return Boolean(provider.model) && (provider.fast?.includes(provider.model) ?? false)
}

/** Whether the provider's current model may search the web with the service's own search tool. */
export function searchOf(provider: StoredProvider): boolean {
  return Boolean(provider.model) && (provider.search?.includes(provider.model) ?? false)
}

/**
 * What the page is given: everything but the keys and tokens. `accounts` says, by provider id,
 * what the stored sign-ins hold; a ChatGPT provider that is not in it counts as signed out.
 */
export function toPublic(settings: StoredSettings, accounts: Readonly<Record<string, ChatGptAccount>> = {}): Settings {
  const describe = (p: StoredProvider): ProviderInfo => {
    const common = { id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL, model: p.model, ...(p.prompt ? { prompt: p.prompt } : {}) }
    if (p.auth !== 'chatgpt') return { ...common, ready: usable(p), hasApiKey: Boolean(p.encryptedKey) }
    const account = accounts[p.id] ?? { signedIn: false, planUsage: false }
    return { ...common, ready: account.signedIn && account.planUsage, hasApiKey: false, auth: 'chatgpt', account }
  }
  const providers = settings.providers.map(describe)
  const active = activeProvider(settings)
  return {
    providers,
    activeProviderId: active.id,
    kind: active.kind,
    model: active.model,
    reasoningEffort: effortOf(active),
    fastMode: fastOf(active),
    webSearch: searchOf(active),
    ready: providers.find((p) => p.id === active.id)?.ready ?? false,
    stats: settings.stats !== false,
    compaction: compactionOf(settings),
    workspaceNames: settings.workspaceNames ?? {},
    trustedFolders: settings.trustedFolders ?? [],
    theme: themeOf(settings),
    titles: settings.titles !== false,
    sessionTimes: settings.sessionTimes !== false
  }
}

/**
 * Adds a provider, or changes the one whose id is given. `key` is the key as it will be stored:
 * a new encrypted value, null to remove the stored one, undefined to leave it alone.
 * A provider added first to a set without any key becomes the active one.
 */
export function saveProvider(settings: StoredSettings, input: ProviderInput, key?: string | null): StoredSettings {
  const kind = PROVIDER_KINDS.find((k) => k === input.kind)
  if (!kind) throw new Error('Unknown kind of provider.')
  const baseURL = text(input.baseURL)
  if (!/^https?:\/\/\S+$/i.test(baseURL)) throw new Error('The address must start with http:// or https://.')
  const name = text(input.name).slice(0, 60) || hostOf(baseURL)
  const model = text(input.model).slice(0, 200)

  const existing = input.id === undefined ? undefined : settings.providers.find((p) => p.id === input.id)
  if (input.id !== undefined && !existing) throw new Error('This provider no longer exists.')

  const next: StoredProvider = {
    ...existing,
    id: existing?.id ?? freshId(name, settings.providers.map((p) => p.id)),
    name,
    kind,
    baseURL,
    model
  }
  if (existing?.auth === 'chatgpt') {
    // Where a sign-in talks to is decided by the sign-in, and it has no key: only its name and model change here.
    next.kind = existing.kind
    next.baseURL = existing.baseURL
  } else {
    if (key === null) delete next.encryptedKey
    else if (key !== undefined) next.encryptedKey = key
    // A key goes to the host it was given for and to no other: moved to another host, the provider is left without it.
    else if (existing?.encryptedKey && hostOf(existing.baseURL) !== hostOf(baseURL)) delete next.encryptedKey
    if (next.encryptedKey && !sendsKeySafely(baseURL)) throw new Error(KEY_NEEDS_HTTPS)
  }

  const providers = existing ? settings.providers.map((p) => (p === existing ? next : p)) : [...settings.providers, next]
  // The first provider that can actually be used takes over from ones that cannot.
  const nobodyUsable = !settings.providers.some(usable)
  const activeProviderId = !existing && usable(next) && nobodyUsable ? next.id : settings.activeProviderId
  return { ...settings, providers, activeProviderId }
}

/**
 * Stores a ChatGPT sign-in: on the provider whose id is given, or on a provider added for it.
 * `login` is the sign-in as it will be stored, `ready` whether requests can be made with it, and
 * `baseURL` the API it is for. Like a first key, a first sign-in that can be used becomes the provider in use.
 */
export function saveLogin(
  settings: StoredSettings,
  providerId: string | undefined,
  login: { encrypted: string; ready: boolean; baseURL: string }
): { settings: StoredSettings; providerId: string } {
  const existing = providerId === undefined ? undefined : settings.providers.find((p) => p.id === providerId)
  if (providerId !== undefined && existing?.auth !== 'chatgpt') throw new Error('This provider no longer exists.')
  const base: StoredProvider = existing ?? {
    id: freshId(CHATGPT.name, settings.providers.map((p) => p.id)),
    name: CHATGPT.name,
    kind: CHATGPT.kind,
    baseURL: login.baseURL,
    model: '',
    auth: 'chatgpt'
  }
  const next: StoredProvider = { ...base, baseURL: login.baseURL, encryptedLogin: login.encrypted }
  if (login.ready) next.signedIn = true
  else delete next.signedIn
  const providers = existing ? settings.providers.map((p) => (p === existing ? next : p)) : [...settings.providers, next]
  const takesOver = usable(next) && !settings.providers.some(usable)
  return { settings: { ...settings, providers, activeProviderId: takesOver ? next.id : settings.activeProviderId }, providerId: next.id }
}

/** Forgets a provider's ChatGPT sign-in altogether, registration included; the provider itself stays. */
export function dropLogin(settings: StoredSettings, providerId: string): StoredSettings {
  return {
    ...settings,
    providers: settings.providers.map((p) => {
      if (p.id !== providerId) return p
      const { encryptedLogin: _login, signedIn: _signedIn, ...rest } = p
      return rest
    })
  }
}

export function removeProvider(settings: StoredSettings, id: string): StoredSettings {
  const providers = settings.providers.filter((p) => p.id !== id)
  if (providers.length === settings.providers.length) return settings
  if (providers.length === 0) throw new Error('The last provider cannot be removed.')
  const stillThere = providers.some((p) => p.id === settings.activeProviderId)
  // Removing the provider in use moves on to one that can be used, if there is one.
  const fallback = providers.find(usable) ?? providers[0]
  return { ...settings, providers, activeProviderId: stillThere ? settings.activeProviderId : fallback.id }
}

/**
 * Gives a provider's models instructions of the person's own, or takes them away: with null, or
 * with a prompt that has no text. Whatever else is known of the provider stays as it is.
 */
export function setPrompt(settings: StoredSettings, providerId: string, prompt: unknown): StoredSettings {
  const target = settings.providers.find((p) => p.id === providerId)
  if (!target) throw new Error('This provider no longer exists.')
  const kept = readPrompt(prompt)
  const { prompt: _dropped, ...rest } = target
  const next: StoredProvider = kept ? { ...rest, prompt: kept } : rest
  return { ...settings, providers: settings.providers.map((p) => (p === target ? next : p)) }
}

/** Names the model to use with a provider, without making that provider the one in use. */
export function setModel(settings: StoredSettings, providerId: string, model: string): StoredSettings {
  const chosen = text(model).slice(0, 200)
  return { ...settings, providers: settings.providers.map((p) => (p.id === providerId ? { ...p, model: chosen } : p)) }
}

/** Makes a provider and one of its models the one messages go to. */
export function selectModel(settings: StoredSettings, providerId: string, model: string): StoredSettings {
  const target = settings.providers.find((p) => p.id === providerId)
  if (!target) throw new Error('This provider no longer exists.')
  const chosen = text(model).slice(0, 200)
  if (!chosen) throw new Error('No model was named.')
  return {
    ...settings,
    providers: settings.providers.map((p) => (p === target ? { ...p, model: chosen } : p)),
    activeProviderId: target.id
  }
}

/** Sets the thinking effort of the active provider's current model. */
export function setEffort(settings: StoredSettings, effort: ReasoningEffort): StoredSettings {
  const active = activeProvider(settings)
  // The effort belongs to a model; with none chosen yet there is nothing to attach it to.
  if (!active.model) return settings
  const efforts = { ...active.efforts }
  if (effort === 'default') delete efforts[active.model]
  else efforts[active.model] = effort
  const { efforts: _dropped, ...rest } = active
  const next: StoredProvider = Object.keys(efforts).length ? { ...rest, efforts } : rest
  return { ...settings, providers: settings.providers.map((p) => (p === active ? next : p)) }
}

/** Turns faster answers on or off for one model of one provider. */
export function setFastFor(settings: StoredSettings, providerId: string, model: string, on: boolean): StoredSettings {
  const provider = settings.providers.find((p) => p.id === providerId)
  // Like the effort, the choice belongs to a model.
  if (!provider || !model) return settings
  const others = (provider.fast ?? []).filter((m) => m !== model)
  const fast = on ? [...others, model] : others
  const { fast: _dropped, ...rest } = provider
  const next: StoredProvider = fast.length ? { ...rest, fast } : rest
  return { ...settings, providers: settings.providers.map((p) => (p === provider ? next : p)) }
}

/** Lets one model of one provider search the web with the service's own search tool, or stops it. */
export function setSearchFor(settings: StoredSettings, providerId: string, model: string, on: boolean): StoredSettings {
  const provider = settings.providers.find((p) => p.id === providerId)
  // Like faster answers, the choice belongs to a model: what it costs differs from model to model.
  if (!provider || !model) return settings
  const others = (provider.search ?? []).filter((m) => m !== model)
  const search = on ? [...others, model] : others
  const { search: _dropped, ...rest } = provider
  const next: StoredProvider = search.length ? { ...rest, search } : rest
  return { ...settings, providers: settings.providers.map((p) => (p === provider ? next : p)) }
}

/** A number of tokens that can be the size of a model's context. */
const isWindow = (tokens: unknown): tokens is number => typeof tokens === 'number' && Number.isInteger(tokens) && tokens >= 256 && tokens <= 100_000_000

/** How many tokens the person said the context of the provider's current model holds, if they said. */
export function windowOf(provider: StoredProvider): number | undefined {
  return provider.model ? provider.windows?.[provider.model] : undefined
}

/** Says how many tokens the context of one model of one provider holds, or with null takes that back. */
export function setWindow(settings: StoredSettings, providerId: string, model: string, tokens: number | null): StoredSettings {
  const provider = settings.providers.find((p) => p.id === providerId)
  if (!provider || !model) return settings
  if (tokens !== null && !isWindow(tokens)) throw new Error('That is not a size a context can have.')
  const windows = { ...provider.windows }
  if (tokens === null) delete windows[model]
  else windows[model] = tokens
  const { windows: _dropped, ...rest } = provider
  const next: StoredProvider = Object.keys(windows).length ? { ...rest, windows } : rest
  return { ...settings, providers: settings.providers.map((p) => (p === provider ? next : p)) }
}

/** Switches the counting of what conversations cost on or off. On is how the app comes, and is not written down. */
export function setStats(settings: StoredSettings, on: boolean): StoredSettings {
  const { stats: _dropped, ...rest } = settings
  return on ? rest : { ...rest, stats: false }
}

/** The look as it is written down: named only where it is not how the app comes. Anything a file holds that is no look is left out. */
const keptTheme = (value: unknown): Pick<StoredSettings, 'theme'> => (isTheme(value) && value !== DEFAULT_THEME ? { theme: value } : {})

/** The look in use: the one that was chosen, or how the app comes. */
export function themeOf(settings: Pick<StoredSettings, 'theme'>): Theme {
  return settings.theme ?? DEFAULT_THEME
}

/** Switches the naming of conversations by the model on or off. On is how the app comes, and is not written down. */
export function setTitles(settings: StoredSettings, on: boolean): StoredSettings {
  const { titles: _dropped, ...rest } = settings
  return on ? rest : { ...rest, titles: false }
}

/** Shows, or no longer shows, under each conversation in the list when it was last gone on with. Shown is how the app comes, and is not written down. */
export function setSessionTimes(settings: StoredSettings, on: boolean): StoredSettings {
  const { sessionTimes: _dropped, ...rest } = settings
  return on ? rest : { ...rest, sessionTimes: false }
}

/** Chooses the look of the app: dark, light, or as the system is set. `theme` is checked here, since it arrives over IPC. */
export function setTheme(settings: StoredSettings, theme: unknown): StoredSettings {
  if (!isTheme(theme)) throw new Error('Unknown look of the app.')
  const { theme: _dropped, ...rest } = settings
  return { ...rest, ...keptTheme(theme) }
}

/** Turns faster answers on or off for the active provider's current model. */
export function setFast(settings: StoredSettings, on: boolean): StoredSettings {
  const active = activeProvider(settings)
  return setFastFor(settings, active.id, active.model, on)
}

/** Lets the active provider's current model search the web with the service's own search tool, or stops it. */
export function setSearch(settings: StoredSettings, on: boolean): StoredSettings {
  const active = activeProvider(settings)
  return setSearchFor(settings, active.id, active.model, on)
}
