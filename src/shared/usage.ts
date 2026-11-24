// What the app keeps of what it asked of the model services, and what DeepSeek says is left on
// an account (main/usage.ts keeps both, UsagePage.tsx and the row under the message box show
// them). The numbers of each request are added up by day, service and model: requests and
// tokens, never anything that was said. DeepSeek is the one service whose usual API key also
// tells the balance; the others show what was used on pages of their own, which are linked.
// Nothing in this file depends on Electron.

import { CHATGPT_USAGE_URL, serviceHost } from './types.ts'
import type { ProviderInfo } from './types.ts'
import type { StepUsage } from './stats.ts'

/** How far back the record goes, in months. What is older is dropped as the record grows. */
export const KEEP_MONTHS = 12

/** The parts of a count the services tell, in the order they are added up. */
const USAGE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const

/** What was asked of one model of one service on one day. */
export interface UsageCount extends StepUsage {
  /** Requests the service answered. */
  requests: number
  /** Of those, the ones the service said nothing of what they cost. */
  untold?: number
}

/** The record as it is kept. */
export interface UsageLog {
  /** By day ("2026-11-24", by the computer's own calendar), by the id of the service, by model. */
  days: Record<string, Record<string, Record<string, UsageCount>>>
  /** The name each service had when it was last counted: the page can still name one that has been removed since. */
  names: Record<string, string>
}

export function emptyLog(): UsageLog {
  return { days: {}, names: {} }
}

// The ids of services and the names of models are keys of the record. Written with `put` and
// read with `own`, a name such as "__proto__" is a key like any other.
const own = <T>(bag: Record<string, T>, key: string): T | undefined => (Object.hasOwn(bag, key) ? bag[key] : undefined)
const put = <T>(bag: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(bag, key, { value, enumerable: true, writable: true, configurable: true })
}

const two = (n: number): string => String(n).padStart(2, '0')

/** The day a moment falls on, by the computer's own calendar: "2026-11-24". */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The stretches of time the usage page adds up. */
export type UsageRange = 'today' | 'month' | 'days30'
export const USAGE_RANGES: readonly UsageRange[] = ['today', 'month', 'days30']
export const isUsageRange = (value: unknown): value is UsageRange => USAGE_RANGES.includes(value as UsageRange)

/** The first day a stretch of time takes in. Every stretch ends today. */
export function firstDayOf(range: UsageRange, now: number): string {
  const d = new Date(now)
  if (range === 'today') return dayKey(now)
  if (range === 'month') return dayKey(new Date(d.getFullYear(), d.getMonth(), 1).getTime())
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29).getTime())
}

/** The first day that is kept: the same day of the month, `KEEP_MONTHS` back. */
export function firstKeptDay(now: number): string {
  const d = new Date(now)
  return dayKey(new Date(d.getFullYear(), d.getMonth() - KEEP_MONTHS, d.getDate()).getTime())
}

/** A request counted into the record. */
export interface UsageEntry {
  /** When it was answered, in milliseconds since 1970. */
  at: number
  /** The id of the service, and its name as the settings show it. */
  provider: string
  name?: string
  model: string
  /** What the service said it cost; nothing where it said nothing. */
  usage?: StepUsage
}

/** The record with one more request counted. The record given is left as it was. */
export function addToLog(log: UsageLog, entry: UsageEntry): UsageLog {
  const day = dayKey(entry.at)
  const days = { ...log.days }
  const byService = { ...(own(days, day) ?? {}) }
  const byModel = { ...(own(byService, entry.provider) ?? {}) }
  const count: UsageCount = { ...(own(byModel, entry.model) ?? { requests: 0 }) }
  count.requests += 1
  let told = false
  for (const key of USAGE_KEYS) {
    const value = entry.usage?.[key]
    if (value === undefined) continue
    count[key] = (count[key] ?? 0) + value
    told = true
  }
  if (!told) count.untold = (count.untold ?? 0) + 1
  put(byModel, entry.model, count)
  put(byService, entry.provider, byModel)
  put(days, day, byService)
  const names = { ...log.names }
  if (entry.name) put(names, entry.provider, entry.name)
  return { days, names }
}

/** The record without the days that are no longer kept, and without the names of services none of the rest counts. */
export function pruneLog(log: UsageLog, now: number): UsageLog {
  const from = firstKeptDay(now)
  const days: UsageLog['days'] = {}
  const counted = new Set<string>()
  for (const [day, byService] of Object.entries(log.days)) {
    if (day < from) continue
    put(days, day, byService)
    for (const provider of Object.keys(byService)) counted.add(provider)
  }
  const names: UsageLog['names'] = {}
  for (const [provider, name] of Object.entries(log.names)) if (counted.has(provider)) put(names, provider, name)
  return { days, names }
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isKey = (value: string): boolean => value.length > 0 && value.length <= 300

/** Reads what a kept file says, leaving out whatever is not as it should be. */
export function cleanLog(raw: unknown): UsageLog {
  const log = emptyLog()
  if (typeof raw !== 'object' || raw === null) return log
  const { days, names } = raw as { days?: unknown; names?: unknown }
  if (typeof days === 'object' && days !== null) {
    for (const [day, byService] of Object.entries(days)) {
      if (!DAY.test(day) || typeof byService !== 'object' || byService === null) continue
      const services: Record<string, Record<string, UsageCount>> = {}
      for (const [provider, byModel] of Object.entries(byService)) {
        if (!isKey(provider) || typeof byModel !== 'object' || byModel === null) continue
        const models: Record<string, UsageCount> = {}
        for (const [model, count] of Object.entries(byModel)) {
          if (model.length > 300 || typeof count !== 'object' || count === null) continue
          const from = count as Record<string, unknown>
          if (!isCount(from.requests) || from.requests < 1) continue
          const kept: UsageCount = { requests: Math.round(from.requests) }
          for (const key of USAGE_KEYS) if (isCount(from[key])) kept[key] = Math.round(from[key] as number)
          if (isCount(from.untold) && from.untold > 0) kept.untold = Math.round(from.untold)
          put(models, model, kept)
        }
        if (Object.keys(models).length) put(services, provider, models)
      }
      if (Object.keys(services).length) put(log.days, day, services)
    }
  }
  if (typeof names === 'object' && names !== null) {
    for (const [provider, name] of Object.entries(names)) if (isKey(provider) && typeof name === 'string' && name.trim()) put(log.names, provider, name.slice(0, 200))
  }
  return log
}

/** One line of the usage page: one model of one service, added up over a stretch of time. */
export interface UsageRow extends UsageCount {
  provider: string
  /** The service's name as it was last counted, or its id where none was kept. */
  name: string
  model: string
}

export interface UsageSummary {
  range: UsageRange
  /** The first and the last day added up. */
  from: string
  to: string
  /** The services that were asked the most first; within one, its models likewise. */
  rows: UsageRow[]
  /** The first day anything was counted on, of all that is kept. */
  since?: string
}

/** Adds up what the record holds of a stretch of time. */
export function summarize(log: UsageLog, range: UsageRange, now: number): UsageSummary {
  const from = firstDayOf(range, now)
  const to = dayKey(now)
  const rows = new Map<string, UsageRow>()
  for (const [day, byService] of Object.entries(log.days)) {
    if (day < from || day > to) continue
    for (const [provider, byModel] of Object.entries(byService)) {
      for (const [model, count] of Object.entries(byModel)) {
        const key = JSON.stringify([provider, model])
        const row = rows.get(key) ?? { provider, name: own(log.names, provider) ?? provider, model, requests: 0 }
        row.requests += count.requests
        for (const part of USAGE_KEYS) if (count[part] !== undefined) row[part] = (row[part] ?? 0) + count[part]!
        if (count.untold) row.untold = (row.untold ?? 0) + count.untold
        rows.set(key, row)
      }
    }
  }
  const list = [...rows.values()]
  const perService = new Map<string, number>()
  for (const row of list) perService.set(row.provider, (perService.get(row.provider) ?? 0) + row.requests)
  list.sort(
    (a, b) =>
      perService.get(b.provider)! - perService.get(a.provider)! ||
      a.name.localeCompare(b.name) ||
      a.provider.localeCompare(b.provider) ||
      b.requests - a.requests ||
      a.model.localeCompare(b.model)
  )
  const kept = Object.keys(log.days).sort()
  return { range, from, to, rows: list, ...(kept.length ? { since: kept[0] } : {}) }
}

// ── The balance ────────────────────────────────────────────────────────────────────────────

/** The services whose API tells what is left on the account, with the key the requests use. Only DeepSeek's does. */
export type BalanceService = 'deepseek'

/** Whether a service tells its balance, and which one it is. A ChatGPT sign-in never does. */
export function balanceServiceOf(provider: Pick<ProviderInfo, 'baseURL' | 'auth'>): BalanceService | undefined {
  return provider.auth !== 'chatgpt' && serviceHost(provider.baseURL) === 'api.deepseek.com' ? 'deepseek' : undefined
}

/** Where DeepSeek tells the balance. Asked with the key of the service and nothing else. */
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** DeepSeek's own pages for the account: what was charged, and where money is paid in. */
export const DEEPSEEK_BILLING_URL = 'https://platform.deepseek.com/transactions'
export const DEEPSEEK_TOP_UP_URL = 'https://platform.deepseek.com/top_up'

/** What is left on the account in one currency. */
export interface Balance {
  /** As DeepSeek writes it: "CNY" or "USD". */
  currency: string
  total: number
  /** Of it, what DeepSeek gave and has not run out yet. */
  granted?: number
  /** Of it, what the person paid in. */
  toppedUp?: number
}

/** Why a look at the balance came to nothing, for the page to say in its words. `off`: the person has not switched the looks on. */
export type BalanceProblem = 'key' | 'offline' | 'refused' | 'limited' | 'unreadable' | 'unsupported' | 'off'

/** What the person chose on the usage page. */
export interface UsageSettings {
  /**
   * Whether the app asks DeepSeek for the balance at all: for the page, for the row under the
   * message box, after turns, and for the reminder line. Off until the person switches it on.
   */
  balance: boolean
}

/** The looks at the balance start switched off: asking is the person's choice (2026-11-24, "默认关闭"). */
export const BALANCE_DEFAULT = false

/** What is known of the balance of one service. */
export interface BalanceState {
  provider: string
  /** When DeepSeek last answered, in milliseconds since 1970. Absent until it has. */
  at?: number
  /** False when DeepSeek says the account takes no more calls: what was on it is used up. */
  available?: boolean
  balances?: Balance[]
  /** Why the last look came to nothing. What was known before it stays. */
  problem?: BalanceProblem
  /** A look is under way. */
  checking?: boolean
  /** The person's line: below it, in the currency of the first balance, they are told once. Absent: no line. */
  alert?: number
}

const amountOf = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * What DeepSeek's answer says: whether the account takes calls, and the balance in each currency
 * it has one in. DeepSeek writes the amounts as text ("110.00"), and lists a currency the account
 * holds nothing in as well (an account paid in yuan has "USD" at 0.00 beside it, 2026-11-24): the
 * balances with something in them come first, in DeepSeek's order, so the first is the one to
 * show. Throws when the answer is not one of those.
 */
export function readDeepSeekBalance(raw: unknown): { available: boolean; balances: Balance[] } {
  if (typeof raw !== 'object' || raw === null) throw new Error('The answer is not an object.')
  const { is_available: available, balance_infos: infos } = raw as Record<string, unknown>
  if (typeof available !== 'boolean' || !Array.isArray(infos)) throw new Error('The answer does not say what the balance is.')
  const balances: Balance[] = []
  for (const info of infos) {
    if (typeof info !== 'object' || info === null) continue
    const { currency, total_balance, granted_balance, topped_up_balance } = info as Record<string, unknown>
    const total = amountOf(total_balance)
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || total === undefined) continue
    const granted = amountOf(granted_balance)
    const toppedUp = amountOf(topped_up_balance)
    balances.push({ currency, total, ...(granted !== undefined ? { granted } : {}), ...(toppedUp !== undefined ? { toppedUp } : {}) })
  }
  // Stable: among those with something in them, and among the empty ones, DeepSeek's order stays.
  balances.sort((a, b) => Number(b.total !== 0) - Number(a.total !== 0))
  return { available, balances }
}

/** The balances beside the first that are worth a line of their own: those with something in them. */
export const otherBalances = (balances: readonly Balance[] | undefined): Balance[] => (balances ?? []).slice(1).filter((balance) => balance.total !== 0)

/** How the balance is to look: in the colours of an error while DeepSeek takes no more calls, of a warning below the person's line. */
export function balanceTone(state: BalanceState | null | undefined): 'warn' | 'danger' | undefined {
  if (!state) return undefined
  if (state.available === false) return 'danger'
  const first = state.balances?.[0]
  return state.alert !== undefined && first !== undefined && first.total < state.alert ? 'warn' : undefined
}

/** The most a line can be set at: an amount that is surely a slip of the keyboard. */
export const ALERT_MAX = 1_000_000

export const isAlertAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= ALERT_MAX

const SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$' }

/** An amount with the mark of its currency: "¥23.48", "$5.00"; one without a mark of its own goes by its code. */
export function formatMoney(amount: number, currency: string): string {
  const text = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const symbol = own(SYMBOLS, currency)
  return `${amount < 0 ? '-' : ''}${symbol ?? `${currency} `}${text}`
}

/** The mark an amount in a currency is written with, for the box the line is typed into. */
export const currencyMark = (currency: string | undefined): string => (currency ? (own(SYMBOLS, currency) ?? currency) : '')

// ── The services' own pages ────────────────────────────────────────────────────────────────

const GEMINI_API_HOST = 'generativelanguage.googleapis.com'

/**
 * The page where a service shows what was used, for the person to look at in the browser: its
 * own figures, which also count what was done with the same key elsewhere. Undefined for a
 * service the app knows no such page of, such as one on the person's own computer.
 */
export function usagePageOf(provider: Pick<ProviderInfo, 'baseURL' | 'auth'>): string | undefined {
  if (provider.auth === 'chatgpt') return CHATGPT_USAGE_URL
  switch (serviceHost(provider.baseURL)) {
    case 'api.deepseek.com':
      return 'https://platform.deepseek.com/usage'
    case 'api.openai.com':
      return 'https://platform.openai.com/usage'
    case 'api.anthropic.com':
      return 'https://platform.claude.com/usage'
    case 'api.x.ai':
      return 'https://console.x.ai/'
    case GEMINI_API_HOST:
      // AI Studio shows it under Dashboard → Usage.
      return 'https://aistudio.google.com/'
    default:
      return undefined
  }
}

// ── Between the page and the main process ─────────────────────────────────────────────────

/** What the page is told without asking. */
export type UsageEvent =
  /** The record has changed: a request was counted, or it was emptied. */
  | { type: 'changed' }
  /** A look at a balance began or ended, or the person's line was set. */
  | { type: 'balance'; state: BalanceState }
  /** A balance has fallen below the person's line. Said once each time it does. */
  | { type: 'low'; provider: string; name: string; balance: Balance; alert: number }
  /** The person changed what they chose on the usage page. */
  | { type: 'settings'; settings: UsageSettings }

/** What the page can ask of the record and the balances (window.usage, src/preload/index.ts). */
export interface UsageApi {
  summary(range: UsageRange): Promise<UsageSummary>
  /** Empties the record. The lines set for the balances stay. */
  clear(): Promise<void>
  /**
   * The balance of a DeepSeek service: as last told where that was a moment ago, else asked anew.
   * `fresh` is the person pressing to have it asked again.
   */
  balance(providerId: string, fresh?: boolean): Promise<BalanceState>
  /** Sets the line below which the person is told, or takes it away with null. */
  setAlert(providerId: string, amount: number | null): Promise<BalanceState>
  settings(): Promise<UsageSettings>
  /** Switches the looks at the balance on or off. Off, what DeepSeek said is forgotten and nothing more is asked. */
  setBalance(on: boolean): Promise<UsageSettings>
  onEvent(listener: (event: UsageEvent) => void): () => void
}

/** How long an answer of DeepSeek's stands before one is asked for by itself, and the least time between two asked for by hand. */
export const BALANCE_FRESH_MS = 60_000
export const BALANCE_AGAIN_MS = 3_000
