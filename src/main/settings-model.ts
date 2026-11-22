// The shape of settings.json, how older shapes are brought up to date, and the changes the
// settings page can make. Nothing in this file depends on Electron or touches the disk.

import { PROVIDER_KINDS, PROVIDER_PRESETS, isLocalAddress, isReasoningEffort } from '../shared/types.ts'
import type { ChatGptAccount, ProviderInfo, ProviderInput, ProviderKind, ReasoningEffort, Settings } from '../shared/types.ts'

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
  /** Identifies this installation to the ChatGPT sign-in. Made once; it says nothing about the person. */
  hostId?: string
  /** The note that explains ChatGPT plan usage has been shown; it is shown once. */
  chatgptWelcomed?: boolean
}

/** What a ChatGPT sign-in is added as. */
const CHATGPT = { name: 'ChatGPT', kind: 'openai-responses' } as const

/**
 * Whether a provider can be used without a key: a model server on this computer or on the local
 * network asks for none.
 */
export const needsNoKey = (provider: StoredProvider): boolean => provider.auth !== 'chatgpt' && isLocalAddress(provider.baseURL)

/** Whether requests can be made with a provider as it is stored. */
const usable = (provider: StoredProvider): boolean =>
  provider.auth === 'chatgpt' ? Boolean(provider.signedIn && provider.encryptedLogin) : Boolean(provider.encryptedKey) || needsNoKey(provider)

const DEEPSEEK = PROVIDER_PRESETS[0]

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
  const common = {
    id,
    name,
    baseURL,
    model: text(raw.model),
    ...(Object.keys(efforts).length ? { efforts } : {}),
    ...(fast.length ? { fast } : {})
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
  return {
    providers,
    activeProviderId: active.id,
    ...(recent.length ? { recentWorkspaces: recent } : {}),
    ...(/^urn:uuid:[0-9a-f-]{36}$/i.test(text(source.hostId)) ? { hostId: text(source.hostId) } : {}),
    ...(source.chatgptWelcomed === true ? { chatgptWelcomed: true } : {})
  }
}

export function activeProvider(settings: StoredSettings): StoredProvider {
  return settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0]
}

export function effortOf(provider: StoredProvider): ReasoningEffort {
  return provider.efforts?.[provider.model] ?? 'default'
}

/** Whether faster answers were asked for with the provider's current model. */
export function fastOf(provider: StoredProvider): boolean {
  return Boolean(provider.model) && (provider.fast?.includes(provider.model) ?? false)
}

/**
 * What the page is given: everything but the keys and tokens. `accounts` says, by provider id,
 * what the stored sign-ins hold; a ChatGPT provider that is not in it counts as signed out.
 */
export function toPublic(settings: StoredSettings, accounts: Readonly<Record<string, ChatGptAccount>> = {}): Settings {
  const describe = (p: StoredProvider): ProviderInfo => {
    const common = { id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL, model: p.model }
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
    ready: providers.find((p) => p.id === active.id)?.ready ?? false
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
  } else if (key === null) delete next.encryptedKey
  else if (key !== undefined) next.encryptedKey = key

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

/** Turns faster answers on or off for the active provider's current model. */
export function setFast(settings: StoredSettings, on: boolean): StoredSettings {
  const active = activeProvider(settings)
  return setFastFor(settings, active.id, active.model, on)
}
