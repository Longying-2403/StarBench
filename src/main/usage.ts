// Keeps the record of what was asked of the model services (shared/usage.ts) in a small file of
// its own in the app's data folder, and asks DeepSeek what is left on an account.
//
// The record holds numbers only: requests and tokens, by day, service and model. It is written
// as soon as a request has been counted, and goes back twelve months.
//
// The balance is asked of DeepSeek only once the person has switched that on, on the usage page
// (it starts off); then with the key that service is used with, and of nobody else: when the
// usage page or the balance under the message box needs it, when the person presses to have it
// asked, and after a turn with DeepSeek. An answer stands for a minute; within it the same
// answer is given again. The balances are not written down: each run of the app asks anew.
// Nothing in this file depends on Electron.

import {
  BALANCE_AGAIN_MS,
  BALANCE_DEFAULT,
  BALANCE_FRESH_MS,
  DEEPSEEK_BALANCE_URL,
  addToLog,
  balanceServiceOf,
  cleanLog,
  emptyLog,
  isAlertAmount,
  isUsageRange,
  pruneLog,
  readDeepSeekBalance,
  summarize
} from '../shared/usage.ts'
import type { Balance, BalanceProblem, BalanceState, UsageEvent, UsageLog, UsageRange, UsageSettings, UsageSummary } from '../shared/usage.ts'
import type { StepUsage } from '../shared/stats.ts'
import type { ProviderInfo } from '../shared/types.ts'
import { readJson, writeJsonText } from './json-file.ts'

export type { UsageEvent }

/** How long DeepSeek is given to answer. */
const TIMEOUT_MS = 15_000
/** The most that is read of its answer, in bytes. A balance comes to a few hundred. */
const MAX_BYTES = 64_000

/** A look at a balance that came to nothing, with the kind of reason the page words. */
export class BalanceError extends Error {
  readonly problem: BalanceProblem
  constructor(problem: BalanceProblem, message: string) {
    super(message)
    this.name = 'BalanceError'
    this.problem = problem
  }
}

const describe = (err: unknown): string => (err instanceof Error ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ''}` : String(err))

/** The text of an answer, read piece by piece and given up on once it is longer than `limit` bytes. */
async function readUpTo(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const pieces: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new BalanceError('unreadable', 'The answer is longer than a balance can be.')
    }
    pieces.push(value)
  }
  return Buffer.concat(pieces).toString('utf8')
}

export interface AskBalanceOptions {
  /** Another address to ask, for tests. */
  url?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Asks DeepSeek for the balance of the account a key belongs to, and resolves with its answer as
 * it is. The key goes in the request's Authorization header and nowhere else; the request is not
 * sent on anywhere, a redirect ends it.
 */
export async function askDeepSeekBalance(apiKey: string, options: AskBalanceOptions = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(options.url ?? DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    })
  } catch (err) {
    throw new BalanceError('offline', describe(err))
  }
  try {
    if (response.status === 401 || response.status === 403) throw new BalanceError('key', `DeepSeek answered ${response.status}: it does not take the key.`)
    if (response.status === 429) throw new BalanceError('limited', 'DeepSeek answered 429: too many requests for now.')
    if (response.status !== 200) throw new BalanceError('refused', `DeepSeek answered ${response.status}.`)
    const text = await readUpTo(response, MAX_BYTES)
    try {
      return JSON.parse(text)
    } catch {
      throw new BalanceError('unreadable', 'The answer is not JSON.')
    }
  } catch (err) {
    await response.body?.cancel().catch(() => {})
    if (err instanceof BalanceError) throw err
    // The connection broke, or the time ran out, while the answer was being read.
    throw new BalanceError('offline', describe(err))
  }
}

/** What the service needs to know of a model service. */
export type UsageProvider = Pick<ProviderInfo, 'id' | 'name' | 'baseURL' | 'auth' | 'hasApiKey'>

export interface UsageServiceOptions {
  /** Where the record and the person's lines are kept: a file in the app's data folder. */
  file: string
  /** The model services as they are set up now. */
  providers: () => Promise<readonly UsageProvider[]>
  /** The key of one of them, as the requests use it. Null when it has none. */
  keyOf: (providerId: string) => Promise<string | null>
  /** Asks DeepSeek. Tests put an answer in its place. */
  askBalance?: (apiKey: string) => Promise<unknown>
  emit?: (event: UsageEvent) => void
  now?: () => number
}

/** What is kept in the file. */
interface Kept extends UsageLog {
  /** The person's lines, by service. */
  alerts: Record<string, number>
  /** The services whose balance has been said to be below the line, and has not been above it since. */
  warned: string[]
  /** Whether the balance is asked at all (`UsageSettings.balance`). */
  balance: boolean
}

/** Keeps the record, and the balances as DeepSeek last told them. */
export class UsageService {
  private readonly opts: UsageServiceOptions
  private log: UsageLog = emptyLog()
  private readonly alerts = new Map<string, number>()
  private readonly warned = new Set<string>()
  private balanceOn = BALANCE_DEFAULT
  private loaded: Promise<void> | null = null
  /** A write is due: what was counted since the last one began. */
  private dirty = false
  private flushing: Promise<void> | null = null
  /** The balances as last told, by service, without the lines and without whether a look is under way. */
  private readonly states = new Map<string, BalanceState>()
  private readonly asking = new Map<string, Promise<BalanceState>>()
  /** When a look was last begun, by service: within a minute of one, none is made by itself. */
  private readonly lastAsked = new Map<string, number>()

  constructor(opts: UsageServiceOptions) {
    this.opts = opts
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private emit(event: UsageEvent): void {
    try {
      this.opts.emit?.(event)
    } catch (err) {
      console.error('[usage] could not tell the page:', err instanceof Error ? err.message : err)
    }
  }

  /** Reads what was kept. Everything else waits for it; a file that is missing or broken counts as empty. */
  init(): Promise<void> {
    this.loaded ??= (async () => {
      const raw = await readJson<unknown>(this.opts.file)
      this.log = pruneLog(cleanLog(raw), this.now())
      const from = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      if (typeof from.alerts === 'object' && from.alerts !== null) {
        for (const [provider, amount] of Object.entries(from.alerts)) if (isAlertAmount(amount)) this.alerts.set(provider, amount)
      }
      if (Array.isArray(from.warned)) for (const provider of from.warned) if (typeof provider === 'string' && this.alerts.has(provider)) this.warned.add(provider)
      if (typeof from.balance === 'boolean') this.balanceOn = from.balance
    })()
    return this.loaded
  }

  private kept(): Kept {
    return { ...this.log, alerts: Object.fromEntries(this.alerts), warned: [...this.warned], balance: this.balanceOn }
  }

  async settings(): Promise<UsageSettings> {
    await this.init()
    return { balance: this.balanceOn }
  }

  /**
   * Switches the looks at the balance on or off. Off, what DeepSeek said is forgotten, a look under
   * way is not taken up, and nothing more is asked; the lines stay for when it is on again.
   */
  async setBalance(on: boolean): Promise<UsageSettings> {
    await this.init()
    this.balanceOn = on
    if (!on) {
      this.states.clear()
      this.lastAsked.clear()
    }
    await this.save()
    const settings = { balance: this.balanceOn }
    this.emit({ type: 'settings', settings })
    return settings
  }

  /**
   * Writes what is kept: at once, and once more after the write under way where more came in
   * meanwhile. A write that fails is not tried again; the next count writes everything anyway.
   */
  private save(): Promise<void> {
    this.dirty = true
    this.flushing ??= (async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          await writeJsonText(this.opts.file, JSON.stringify(this.kept())).catch((err: unknown) => {
            console.error('[usage] could not keep the record:', err instanceof Error ? err.message : err)
          })
        }
      } finally {
        this.flushing = null
      }
    })()
    return this.flushing
  }

  /** Resolves once everything counted so far is in the file, as far as it could be written. */
  async settled(): Promise<void> {
    await this.init()
    while (this.flushing) await this.flushing
  }

  /**
   * Counts one request into the record: the measure of it the app took (main/meter.ts), and the
   * name the service has in the settings. Nothing is waited for: the record is written behind.
   */
  record(measure: { provider: string; model: string; usage?: StepUsage }, name?: string): void {
    const at = this.now()
    void this.init()
      .then(() => {
        this.log = pruneLog(addToLog(this.log, { at, provider: measure.provider, model: measure.model, ...(name ? { name } : {}), ...(measure.usage ? { usage: measure.usage } : {}) }), at)
        void this.save()
        this.emit({ type: 'changed' })
      })
      .catch((err: unknown) => console.error('[usage] a request was not counted:', err instanceof Error ? err.message : err))
  }

  async summary(range: UsageRange): Promise<UsageSummary> {
    await this.init()
    return summarize(this.log, isUsageRange(range) ? range : 'month', this.now())
  }

  /** Empties the record. The person's lines, and what was said of them, stay. */
  async clear(): Promise<void> {
    await this.init()
    this.log = emptyLog()
    await this.save()
    this.emit({ type: 'changed' })
  }

  /** The balance as known, with the person's line and whether a look is under way. */
  private stateOf(providerId: string): BalanceState {
    const known = this.states.get(providerId) ?? { provider: providerId }
    const alert = this.alerts.get(providerId)
    const { checking: _was, alert: _old, ...rest } = known
    return { ...rest, ...(alert !== undefined ? { alert } : {}), ...(this.asking.has(providerId) ? { checking: true } : {}) }
  }

  /**
   * The balance of a service, asked of DeepSeek unless it answered a moment ago: within a minute
   * by itself, within a few seconds when the person presses for it (`fresh`). Two looks at one
   * balance never run at once. Always resolves: a look that fails is told in the state.
   */
  async balance(providerId: string, fresh = false): Promise<BalanceState> {
    await this.init()
    if (!this.balanceOn) return { ...this.stateOf(providerId), problem: 'off' }
    const running = this.asking.get(providerId)
    if (running) return running
    const now = this.now()
    const last = this.lastAsked.get(providerId)
    if (last !== undefined && now >= last && now - last < (fresh ? BALANCE_AGAIN_MS : BALANCE_FRESH_MS)) return this.stateOf(providerId)
    this.lastAsked.set(providerId, now)
    const asking = this.look(providerId).finally(() => this.asking.delete(providerId))
    this.asking.set(providerId, asking)
    // The page shows that a look is under way.
    this.emit({ type: 'balance', state: this.stateOf(providerId) })
    return asking
  }

  private async look(providerId: string): Promise<BalanceState> {
    const before = this.states.get(providerId) ?? { provider: providerId }
    let provider: UsageProvider | undefined
    try {
      provider = (await this.opts.providers()).find((p) => p.id === providerId)
      if (!provider || !balanceServiceOf(provider)) throw new BalanceError('unsupported', 'This service does not tell its balance.')
      const key = provider.hasApiKey ? await this.opts.keyOf(providerId).catch(() => null) : null
      if (!key) throw new BalanceError('key', 'No API key is stored for this service.')
      const told = readDeepSeekBalance(await (this.opts.askBalance ?? askDeepSeekBalance)(key))
      this.states.set(providerId, { provider: providerId, at: this.now(), available: told.available, balances: told.balances })
    } catch (err) {
      console.error('[usage] the balance could not be had:', describe(err))
      // What was known stays, with why this look came to nothing.
      const { problem: _old, ...kept } = before
      this.states.set(providerId, { ...kept, problem: err instanceof BalanceError ? err.problem : 'unreadable' })
    }
    if (!this.balanceOn) {
      // Switched off while DeepSeek was being asked: what it said is not kept, and nobody is told of it.
      this.states.delete(providerId)
      const { checking: _gone, ...forgotten } = this.stateOf(providerId)
      return { ...forgotten, problem: 'off' }
    }
    const { checking: _done, ...state } = this.stateOf(providerId)
    if (!state.problem && provider) this.weigh(provider, state)
    this.emit({ type: 'balance', state })
    return state
  }

  /** After an answer: tells the person once when the balance has fallen below their line, and readies the next telling once it is above again. */
  private weigh(provider: UsageProvider, state: BalanceState): void {
    const first = state.balances?.[0]
    if (state.alert === undefined || !first) return
    const below = first.total < state.alert
    if (below && !this.warned.has(provider.id)) {
      this.warned.add(provider.id)
      void this.save()
      this.emit({ type: 'low', provider: provider.id, name: provider.name, balance: first, alert: state.alert })
    } else if (!below && this.warned.delete(provider.id)) {
      void this.save()
    }
  }

  /**
   * Sets the line below which the person is told, or takes it away with null. Nothing is said of a
   * balance that is below a line just set: the person sees the two side by side. They are told
   * when it next falls below.
   */
  async setAlert(providerId: string, amount: unknown): Promise<BalanceState> {
    await this.init()
    if (!providerId || providerId.length > 300) throw new Error('No such service.')
    if (amount === null) {
      this.alerts.delete(providerId)
      this.warned.delete(providerId)
    } else if (isAlertAmount(amount)) {
      this.alerts.set(providerId, amount)
      const first: Balance | undefined = this.states.get(providerId)?.balances?.[0]
      if (first && first.total < amount) this.warned.add(providerId)
      else this.warned.delete(providerId)
    } else {
      throw new Error('A reminder line is an amount above nought.')
    }
    await this.save()
    const state = this.stateOf(providerId)
    this.emit({ type: 'balance', state })
    return state
  }

  /**
   * After a turn with a service: DeepSeek's balance is asked anew, unless it was a moment ago, where
   * something shows it (`shown`: the row under the message box is on) or a line waits on it.
   */
  async turnEnded(providerId: string, shown: boolean): Promise<void> {
    try {
      await this.init()
      if (!this.balanceOn || (!shown && !this.alerts.has(providerId))) return
      const provider = (await this.opts.providers()).find((p) => p.id === providerId)
      if (provider && provider.hasApiKey && balanceServiceOf(provider)) await this.balance(providerId)
    } catch (err) {
      console.error('[usage] the balance was not asked after the turn:', describe(err))
    }
  }
}

/** What the main process's IPC needs of `ipcMain`. */
interface Handles {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

/** The page's way to the record and the balances (the usage page of the settings, the row under the message box). */
export function registerUsageIpc(ipc: Handles, usage: UsageService): void {
  ipc.handle('usage:summary', (_e, range: unknown) => usage.summary(isUsageRange(range) ? range : 'month'))
  ipc.handle('usage:clear', () => usage.clear())
  ipc.handle('usage:balance', (_e, providerId: unknown, fresh: unknown) => usage.balance(String(providerId ?? ''), fresh === true))
  ipc.handle('usage:setAlert', (_e, providerId: unknown, amount: unknown) => usage.setAlert(String(providerId ?? ''), amount))
  ipc.handle('usage:settings', () => usage.settings())
  ipc.handle('usage:setBalance', (_e, on: unknown) => usage.setBalance(on === true))
}
