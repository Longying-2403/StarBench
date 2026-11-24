// What "添加模型" under 设置 → 模型 offers beside a model server of one's own and any other
// service: the services the app knows by name, and signing in with an OpenAI account. All of
// them stay on offer whatever is set up already; what is there is told with them. A service can
// be added again for another key, and the sign-in again for another account.

import { PROVIDER_PRESETS, serviceHost } from './types.ts'
import type { ProviderInfo } from './types.ts'

/** A service the app knows by name, as the menu offers it. */
export interface PresetOffer {
  preset: (typeof PROVIDER_PRESETS)[number]
  /**
   * Whether a provider with a key of its own talks to this service already, under whatever name.
   * The service can be added once more all the same: for a second key, say.
   */
  added: boolean
  /** The name a provider added now starts with: the service's, numbered where that one is taken. */
  name: string
}

/** A name no provider has yet: the one given, or that with the first number from 2 on that is free. */
export function freeName(name: string, providers: readonly Pick<ProviderInfo, 'name'>[]): string {
  const taken = new Set(providers.map((p) => p.name.trim().toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) {
    if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`
  }
}

/** The services the app knows by name, each with whether it is there already and what one more of it would be called. */
export function presetOffers(providers: readonly ProviderInfo[]): PresetOffer[] {
  // A sign-in with an OpenAI account is not a key for OpenAI's API, wherever it talks to.
  const hosts = new Set(providers.filter((p) => p.auth !== 'chatgpt').map((p) => serviceHost(p.baseURL)))
  return PROVIDER_PRESETS.map((preset) => ({ preset, added: hosts.has(serviceHost(preset.baseURL)), name: freeName(preset.name, providers) }))
}

/**
 * The sign-in with an OpenAI account as the menu offers it. Like a service with a key it stays on
 * offer however many accounts are there: each account signs in as a provider of its own, and the
 * entry adds one more. `signedIn` is how many accounts are signed in at the moment.
 */
export function signInOffer(providers: readonly ProviderInfo[]): { signedIn: number } {
  return { signedIn: providers.filter((p) => p.auth === 'chatgpt' && p.account?.signedIn).length }
}

/**
 * What a provider is called where several are listed together, as in the list of models. Its
 * name; and for a sign-in with an OpenAI account, where there is more than one of them, the
 * account as well, since they all come with the same name.
 */
export function providerLabel(provider: ProviderInfo, providers: readonly ProviderInfo[]): string {
  if (provider.auth !== 'chatgpt' || providers.filter((p) => p.auth === 'chatgpt').length < 2) return provider.name
  return `${provider.name}（${provider.account?.email ?? (provider.account?.signedIn ? '已登录' : '未登录')}）`
}
