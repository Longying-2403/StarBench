// What the app measures of a conversation: how many requests it took, how long they and the
// tools ran, what they cost in tokens, and how full the model's context is. The numbers are kept
// with the conversation. Nothing here draws anything (StatusRow.tsx does) and nothing here talks
// to a service: the adapters hand over what a service said, and this puts it into one shape.

import type { ProviderKind } from './types.ts'

/**
 * What one request cost, in the app's own terms. A number the service did not tell is left out,
 * and stays left out when the requests are added up: it is shown as unknown, not as nought.
 */
export interface StepUsage {
  /** Tokens of the request that were not read from a cache. */
  input?: number
  /** Tokens of the request the service read from its cache. */
  cacheRead?: number
  /** Tokens of the request the service wrote to its cache, where it counts those apart. */
  cacheWrite?: number
  /** Tokens of the reply, thinking among them, also where the service counts the thinking apart. */
  output?: number
  /** Of those, the tokens of thinking, where the service tells them apart. */
  reasoning?: number
}

const USAGE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const

/**
 * The parts a request is made of, as far as the app can tell them apart, in the order they are
 * shown: what the person and the model wrote; the summary that stands for the part of the
 * conversation that was compacted; the tool calls and what the tools returned; the definitions
 * of the tools of the app, of plugins and of MCP servers; the app's own instructions, the
 * person's, and the list of skills that goes with them.
 */
export const CONTEXT_PARTS = ['messages', 'summary', 'toolResults', 'tools', 'pluginTools', 'mcpTools', 'system', 'custom', 'skills'] as const
export type ContextPart = (typeof CONTEXT_PARTS)[number]

/**
 * A guess at what each part of a request weighs, in tokens. A part that is not there is left
 * out. (Numbers kept before the parts were told apart this finely have three of them: `messages`
 * with the tool results in it, `tools` for every tool, and `system` for all the instructions.)
 */
export type ContextParts = Partial<Record<ContextPart, number>>

/** How full the context was at the last request. */
export interface ContextUse {
  /** Tokens in the context after the last reply: what was sent, and what came back. Absent when the service told no usage. */
  tokens?: number
  parts: ContextParts
  /** Which model that was: the room differs from model to model. */
  provider: string
  model: string
  /**
   * How the guesses compare with what the service counted, as far as its requests have shown.
   * With it a guess at the next request comes close enough to tell whether it still fits
   * (main/compaction.ts). Absent while no service said.
   */
  fit?: Fit
}

/**
 * How the app's guesses compare with what a service counts, learned from the requests of a
 * conversation. Learned from a real service (xAI, 2026-11-22), whose counts ran like this: the
 * instructions and the definitions of the tools at 2.3 times what their text suggests; what the
 * tools returned at nearly the guess; and each reply at what the service said it cost, thinking
 * and all, which was up to four times the text of it. So there is no one number that brings a
 * guess to a count. What holds is this: the next request weighs what the last one did, with its
 * reply as the service counted it, and with what was added since at about its guess.
 */
export interface Fit {
  /**
   * Tokens to a guessed token of the instructions and the definitions of the tools. For when
   * there is no last count to go by. Unless `pinned`, it also holds whatever else a count held
   * beyond the text of the conversation.
   */
  base: number
  /**
   * Set once `base` was learned from a request that held no reply yet, so nothing but the
   * instructions, the tools and what the person wrote: what was guessed of the instructions and
   * tools then. From there on `base` is known for those tools and is left alone, and what a later
   * count holds beyond it and the text of the conversation is the thinking kept with the replies.
   */
  pinned?: number
  /** Tokens to a guessed token of what is added to a conversation: what the tools return, what the person writes. */
  said: number
  /** Whether `said` was learned from what a request added, and not taken for want of anything better. */
  learned?: boolean
  /**
   * The last request the service counted: its count, the count with the reply to it, and what was
   * guessed of its instructions and tools, of its conversation, and of that reply. Gone once the
   * conversation was compacted: the next request is not that one grown.
   */
  last?: { sent: number; tokens: number; base: number; said: number; reply: number }
}

/** What was measured of one request and its reply. */
export interface StepMeasure {
  /** From sending the request to the end of the reply, in milliseconds. */
  ms: number
  /** To the first piece of the reply. Absent when the reply came in one piece. */
  firstMs?: number
  /** How many pieces of text and thinking arrived. */
  pieces: number
  usage?: StepUsage
  parts: ContextParts
  /** A guess at what the reply weighs as part of the conversation, when it is sent back with the next request. */
  reply?: number
  /**
   * What of the reply, as the service counted it (`usage.output`), the next request carries,
   * where that is not all of it: thinking that is not sent back with the reply is gone by then.
   * What a request is expected to weigh, and what the context holds after it, go by this; what
   * the reply cost and how fast it came go by the whole count.
   */
  carried?: number
  /** The request held no reply of the model's yet: what it weighs is the instructions, the tools, and what the person wrote. */
  fresh?: boolean
  provider: string
  model: string
}

/** The numbers of a conversation, from when the counting began. */
export interface SessionStats {
  /** Messages the person sent. */
  turns: number
  /** Requests the model answered. One message takes several when the model uses tools. */
  steps: number
  /** Time spent waiting for the model, in milliseconds. */
  modelMs: number
  /** Time the tools took to run, not counting the wait for a permission. */
  toolMs: number
  /** For the average time to the first piece of a reply: the sum over the replies that came in pieces, and how many those were. */
  firstMs: number
  firstCount: number
  /** For the speed of the output: tokens, and the time they took to come. */
  speedTokens: number
  speedMs: number
  /** Part of that was estimated: a service told no usage, or a reply came in one piece. */
  speedRough?: boolean
  /** Tokens, added up over the requests. */
  usage: StepUsage
  context?: ContextUse
  /** How many times the conversation was compacted to fit the model's context. */
  compactions?: number
  /** The conversation had messages before the counting began. */
  partial?: boolean
}

export function emptyStats(partial = false): SessionStats {
  return { turns: 0, steps: 0, modelMs: 0, toolMs: 0, firstMs: 0, firstCount: 0, speedTokens: 0, speedMs: 0, usage: {}, ...(partial ? { partial: true } : {}) }
}

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined)
const field = (raw: unknown, name: string): unknown => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[name] : undefined)
/** Without the entries that hold nothing. */
const told = (usage: StepUsage): StepUsage | undefined => {
  const kept = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as StepUsage
  return Object.keys(kept).length ? kept : undefined
}

/**
 * What a service said a request cost, in the app's terms. The three kinds of API count
 * differently: chat completions and the Responses API give the whole input and, in a detail,
 * how much of it was read from the cache; the Messages API gives the three parts of the input
 * side by side. DeepSeek names its cache hits and misses outright. Undefined when nothing usable was said.
 */
export function normalizeUsage(kind: ProviderKind, raw: unknown): StepUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  if (kind === 'anthropic') {
    return told({
      input: count(field(raw, 'input_tokens')),
      cacheRead: count(field(raw, 'cache_read_input_tokens')),
      cacheWrite: count(field(raw, 'cache_creation_input_tokens')),
      output: count(field(raw, 'output_tokens'))
    })
  }
  const responses = kind === 'openai-responses'
  const whole = count(field(raw, responses ? 'input_tokens' : 'prompt_tokens'))
  const cached = count(field(raw, 'prompt_cache_hit_tokens')) ?? count(field(field(raw, responses ? 'input_tokens_details' : 'prompt_tokens_details'), 'cached_tokens'))
  const missed = count(field(raw, 'prompt_cache_miss_tokens'))
  const reply = count(field(raw, responses ? 'output_tokens' : 'completion_tokens'))
  // Most services count the thinking among the tokens of the reply. One (xAI) counts it apart, and
  // only its total gives that away: the total is then more than the request and the reply together.
  const total = count(field(raw, 'total_tokens'))
  const beyond = whole !== undefined && total !== undefined ? total - whole : undefined
  return told({
    input: missed ?? (whole === undefined ? undefined : Math.max(0, whole - (cached ?? 0))),
    cacheRead: cached,
    output: beyond !== undefined && beyond > (reply ?? 0) ? beyond : reply,
    reasoning: count(field(field(raw, responses ? 'output_tokens_details' : 'completion_tokens_details'), 'reasoning_tokens'))
  })
}

/** Whether a character is as wide as two Latin letters: Chinese, Japanese and Korean writing, and the full-width forms. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g

/**
 * A guess at how many tokens a text is: about one for a Chinese character, and one for every
 * four other characters. Good enough to say how the parts of a request compare; where the
 * service tells the true size, the parts are brought to it (`contextView`).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const wide = text.match(WIDE)?.length ?? 0
  return wide + Math.ceil((text.length - wide) / 4)
}

/** The same characters, for looking at one at a time. */
const WIDE_ONE = new RegExp(WIDE.source)

/**
 * How many characters of a text, from its start, are guessed to be `tokens` tokens at most
 * (`estimateTokens`). Never ends in the middle of a character that takes two places in a string.
 */
export function charsWithin(text: string, tokens: number): number {
  let wide = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (WIDE_ONE.test(text[i])) wide++
    else other++
    if (wide + Math.ceil(other / 4) > tokens) {
      const code = i > 0 ? text.charCodeAt(i - 1) : 0
      return code >= 0xd800 && code <= 0xdbff ? i - 1 : i
    }
  }
  return text.length
}

/** What the parts of a request weigh together. */
export function partsTotal(parts: ContextParts): number {
  return CONTEXT_PARTS.reduce((sum, part) => sum + Math.max(0, parts[part] ?? 0), 0)
}

/** The parts that are the conversation itself: they grow as it goes on. The others are there from the first request. */
const SAID_PARTS: ReadonlySet<ContextPart> = new Set(['messages', 'summary', 'toolResults'])

/** What was guessed of the two halves of a request: the instructions and tools, and the conversation. */
export function halves(parts: ContextParts): { base: number; said: number } {
  let base = 0
  let said = 0
  for (const part of CONTEXT_PARTS) {
    const tokens = Math.max(0, parts[part] ?? 0)
    if (SAID_PARTS.has(part)) said += tokens
    else base += tokens
  }
  return { base, said }
}

/** The same parts, each brought to what a guess of that weight is expected to be counted as. */
export function fitParts(parts: ContextParts, fit: Fit | undefined): ContextParts {
  return Object.fromEntries(
    CONTEXT_PARTS.map((part) => [part, Math.round((parts[part] ?? 0) * ((SAID_PARTS.has(part) ? fit?.said : fit?.base) ?? 1))] as const).filter(([, tokens]) => tokens > 0)
  )
}

/** Whether two guesses at the instructions and tools are of the same ones: a tool added or taken away makes them differ. */
const sameBase = (a: number, b: number): boolean => Math.abs(a - b) <= 0.02 * Math.max(a, b)

/**
 * What a request of these guessed parts is expected to be counted as: in all; of that, what is
 * not the text of the conversation; and how many tokens a guessed token of that text is taken for.
 * Where the last request was counted, this one is that one with its reply and with what was added
 * since. Otherwise the two halves are each brought to what counts made of them before.
 */
export function expected(parts: ContextParts, fit: Fit | undefined): { tokens: number; base: number; scale: number } {
  const guessed = halves(parts)
  const scale = fit?.said ?? 1
  const last = fit?.last
  const added = last ? guessed.said - last.said - last.reply : -1
  if (last && added >= 0 && sameBase(last.base, guessed.base)) {
    const tokens = Math.round(last.tokens + scale * added)
    return { tokens, base: Math.max(0, tokens - Math.round(scale * guessed.said)), scale }
  }
  const base = Math.round((fit?.base ?? 1) * guessed.base)
  return { tokens: base + Math.round(scale * guessed.said), base, scale }
}

/** The tokens of a request as the service counted them, read from its cache or not. Undefined when it told none of that. */
export function sentTokens(usage: StepUsage | undefined): number | undefined {
  const { input, cacheRead, cacheWrite } = usage ?? {}
  return input === undefined && cacheRead === undefined && cacheWrite === undefined ? undefined : (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
}

/** The least and the most a guessed token is taken to be: a service that counts otherwise is not believed. */
const SAID_LEAST = 0.5
const SAID_MOST = 2.5
const BASE_LEAST = 0.5
const BASE_MOST = 8
/** How much the conversation has to have grown, in guessed tokens, for its growth to say anything. */
const GROWTH = 300
const within = (value: number, least: number, most: number): number => Math.round(Math.min(most, Math.max(least, value)) * 1000) / 1000

/**
 * The fit after one more request: what the service counted of it (`sent`) and of the reply to
 * it (`output`), set against what was guessed of its parts and of that reply. What was added to
 * the conversation since the reply before (results of tools, a message of the person's) is
 * weighed by what the count grew beyond that reply; the reply itself is left out of it, since a
 * service may count far more of a reply than its text shows. Until something was added, a
 * conversation that is short beside the instructions is taken at its guess, and a long one,
 * which is nearly all the count speaks of, at the count. What the count then holds beyond the
 * text of the conversation goes to the instructions and tools. A request the service did not
 * count changes nothing.
 */
export function fitTo(before: Fit | undefined, counted: { sent: number | undefined; output?: number }, parts: ContextParts, reply = 0, fresh = false): Fit | undefined {
  const now = halves(parts)
  const { sent } = counted
  if (sent === undefined || sent <= 0 || now.base + now.said <= 0) return before
  let said = before?.said
  let learned = before?.learned === true
  const last = before?.last
  const added = last && sameBase(last.base, now.base) ? now.said - last.said - last.reply : 0
  if (last && added >= GROWTH) {
    const seen = within((sent - last.tokens) / added, SAID_LEAST, SAID_MOST)
    // Evened out with what was learned before: what one step added may be all code, or all Chinese.
    said = learned && said !== undefined ? within((said + seen) / 2, SAID_LEAST, SAID_MOST) : seen
    learned = true
  }
  said ??= now.said <= now.base ? 1 : within(sent / (now.base + now.said), SAID_LEAST, SAID_MOST)
  // What the instructions and tools weigh is seen best where nothing else of weight is there: no
  // reply yet, and less written by the person than the instructions are long (a first message
  // with a file pasted into it says more of the file than of them). Seen so once, it holds for as
  // long as the tools are the same.
  const alone = fresh && now.base > 0 && now.said <= now.base
  const known = before?.pinned !== undefined && sameBase(before.pinned, now.base)
  const pinned = alone ? now.base : known ? before?.pinned : undefined
  const base = known && !alone ? before!.base : now.base > 0 ? within((sent - said * now.said) / now.base, BASE_LEAST, BASE_MOST) : (before?.base ?? 1)
  return {
    base,
    ...(pinned !== undefined ? { pinned } : {}),
    said,
    ...(learned ? { learned: true } : {}),
    last: { sent, tokens: sent + Math.max(0, counted.output ?? 0), base: now.base, said: now.said, reply: Math.max(0, Math.round(reply)) }
  }
}

/** The numbers with one more message of the person counted. */
export function addTurn(stats: SessionStats): SessionStats {
  return { ...stats, turns: stats.turns + 1 }
}

/** The numbers with the running time of one more tool call counted. */
export function addToolTime(stats: SessionStats, ms: number): SessionStats {
  // Tools are timed finer than a millisecond; what is kept need not carry every digit of that.
  return { ...stats, toolMs: Math.round((stats.toolMs + Math.max(0, ms)) * 100) / 100 }
}

/** The numbers with one more request counted. */
export function addStep(stats: SessionStats, step: StepMeasure): SessionStats {
  const next: SessionStats = { ...stats, steps: stats.steps + 1, modelMs: stats.modelMs + Math.max(0, step.ms), usage: { ...stats.usage } }
  const streamed = step.firstMs !== undefined
  if (step.firstMs !== undefined) {
    next.firstMs += Math.max(0, step.firstMs)
    next.firstCount += 1
  }
  // The speed is that of the reply as it came: from its first piece on, where it came in pieces.
  // A reply in one piece is timed whole, which counts the reading of the request against it.
  const tokens = step.usage?.output ?? (streamed && step.pieces > 1 ? step.pieces : undefined)
  const took = step.ms - (step.firstMs ?? 0)
  if (tokens !== undefined && tokens > 0 && took > 0) {
    next.speedTokens += tokens
    next.speedMs += took
    if (step.usage?.output === undefined || !streamed) next.speedRough = true
  }
  for (const key of USAGE_KEYS) {
    const value = step.usage?.[key]
    if (value !== undefined) next.usage[key] = (next.usage[key] ?? 0) + value
  }
  const sent = sentTokens(step.usage)
  // What of the reply is still there when the next request goes out: all of it, unless its thinking stays behind.
  const output = step.carried ?? step.usage?.output
  // What the requests before taught about the size of a guess holds for the next one of the same model.
  const before = stats.context?.provider === step.provider && stats.context.model === step.model ? stats.context.fit : undefined
  const fit = fitTo(before, { sent, output }, step.parts, step.reply, step.fresh)
  next.context = {
    ...(sent !== undefined ? { tokens: sent + (output ?? 0) } : {}),
    parts: { ...step.parts },
    provider: step.provider,
    model: step.model,
    ...(fit ? { fit } : {})
  }
  return next
}

/** What is known of a compaction once it is done. */
export interface CompactionDone {
  /** What the next request weighs, part by part, as near as can be told. */
  parts: ContextParts
  provider: string
  model: string
  /** How the guesses compare with what the service counts, where it has said. */
  fit?: Fit
  /** The request that asked the model for the summary, where one was made. */
  cost?: StepMeasure
}

/**
 * The numbers with one more compaction counted. What the summary cost is added to the tokens and
 * to the time spent waiting for the model, but is no step of the conversation. The context is
 * what the next request is expected to weigh: a guess, until that request says more.
 */
export function addCompaction(stats: SessionStats, done: CompactionDone): SessionStats {
  const next: SessionStats = { ...stats, compactions: (stats.compactions ?? 0) + 1, usage: { ...stats.usage } }
  if (done.cost) {
    next.modelMs += Math.max(0, done.cost.ms)
    for (const key of USAGE_KEYS) {
      const value = done.cost.usage?.[key]
      if (value !== undefined) next.usage[key] = (next.usage[key] ?? 0) + value
    }
  }
  // Without the last request that was counted: the next one is not that one grown.
  const { last: _gone, ...fit } = done.fit ?? ({} as Fit)
  next.context = { parts: { ...done.parts }, provider: done.provider, model: done.model, ...(done.fit ? { fit } : {}) }
  return next
}

/** All the tokens of a conversation: what was sent, read from a cache or not, and what came back. Undefined when no service told any. */
export function totalTokens(usage: StepUsage): number | undefined {
  const parts = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output].filter((value): value is number => value !== undefined)
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : undefined
}

/** The share of the input that was read from a cache, from 0 to 1. Undefined when no service said anything of a cache. */
export function cacheHitRate(usage: StepUsage): number | undefined {
  if (usage.cacheRead === undefined) return undefined
  const input = (usage.input ?? 0) + usage.cacheRead + (usage.cacheWrite ?? 0)
  return input > 0 ? usage.cacheRead / input : undefined
}

/** Tokens of output a second, over the whole conversation. `rough` when part of it was estimated. */
export function outputSpeed(stats: SessionStats): { perSecond: number; rough: boolean } | undefined {
  if (stats.speedTokens <= 0 || stats.speedMs <= 0) return undefined
  return { perSecond: (stats.speedTokens * 1000) / stats.speedMs, rough: Boolean(stats.speedRough) }
}

/** The average time to the first piece of a reply, in milliseconds. */
export function firstPieceAverage(stats: SessionStats): number | undefined {
  return stats.firstCount > 0 ? stats.firstMs / stats.firstCount : undefined
}

/** The context as it is shown. */
export interface ContextView {
  /** Tokens in the context. */
  tokens: number
  /** Whether the service told that size. Otherwise it is the sum of the guesses below. */
  exact: boolean
  /** The share of the model's room that is taken, from 0 to 1. Absent while the room is not known. */
  share?: number
  /** Tokens of room left. Absent while the room is not known. */
  free?: number
  /**
   * The parts that weigh something, in the order of `CONTEXT_PARTS`, each with its tokens and its
   * share: of the model's room where that is known, of what is in the context otherwise.
   */
  parts: { part: ContextPart; tokens: number; share: number }[]
}

/**
 * What the parts of a counted context are taken to weigh before they are brought to the count.
 * As a rule, their guesses: the count is then shared out in proportion. But where it is known
 * what the instructions and tools weigh (`Fit.pinned`), they are given that, the text of the
 * conversation what its kind of text weighs, and what the count holds beyond all of it goes to
 * the messages: it is the thinking a service keeps with the replies. Shared out in proportion,
 * such a context would show the tools at many times their weight and the replies at next to nothing.
 */
function weighed(context: ContextUse): ContextParts {
  const { fit, tokens } = context
  if (tokens === undefined || fit?.pinned === undefined || !sameBase(fit.pinned, halves(context.parts).base)) return context.parts
  const known = fitParts(context.parts, fit)
  const over = tokens - partsTotal(known)
  return over > 0 ? { ...known, messages: (known.messages ?? 0) + over } : known
}

/**
 * The context as it is shown: how many tokens are in it, what share of the model's room that
 * is, and what its parts weigh. The parts are guesses; where the service told the true size
 * they are brought to add up to it exactly, and without it their sum stands for the size.
 */
export function contextView(context: ContextUse, window?: number): ContextView {
  const parts = weighed(context)
  const guesses = CONTEXT_PARTS.map((part) => ({ part, guess: Math.max(0, parts[part] ?? 0) })).filter(({ guess }) => guess > 0)
  const guessed = guesses.reduce((sum, { guess }) => sum + guess, 0)
  const tokens = context.tokens ?? guessed
  // Brought to the true size: each part its share of it in whole tokens, and the tokens that
  // rounding down left over go to the parts that lost most by it.
  const scaled = guesses.map(({ part, guess }) => {
    const exact = guessed > 0 ? (guess * tokens) / guessed : 0
    return { part, tokens: Math.floor(exact), lost: exact - Math.floor(exact) }
  })
  let left = tokens - scaled.reduce((sum, entry) => sum + entry.tokens, 0)
  for (const entry of [...scaled].sort((a, b) => b.lost - a.lost)) {
    if (left <= 0) break
    entry.tokens += 1
    left -= 1
  }
  const room = window && window > 0 ? window : undefined
  const of = room ?? tokens
  return {
    tokens,
    exact: context.tokens !== undefined,
    ...(room ? { share: Math.min(1, tokens / room), free: Math.max(0, room - tokens) } : {}),
    parts: scaled.filter((entry) => entry.tokens > 0).map((entry) => ({ part: entry.part, tokens: entry.tokens, share: of > 0 ? Math.min(1, entry.tokens / of) : 0 }))
  }
}

/** A length of time as people say it: 12 毫秒, 1.3 秒, 50.1 秒, 1 分 26 秒, 1 小时 05 分. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  // Shorter than a tenth of a second would read as nothing at all in seconds.
  if (seconds < 0.0995) return seconds === 0 ? '0 秒' : `${Math.max(1, Math.round(seconds * 1000))} 毫秒`
  if (seconds < 59.95) return `${seconds.toFixed(1)} 秒`
  const whole = Math.round(seconds)
  const two = (n: number): string => String(n).padStart(2, '0')
  if (whole < 3600) return `${Math.floor(whole / 60)} 分 ${two(whole % 60)} 秒`
  return `${Math.floor(whole / 3600)} 小时 ${two(Math.floor((whole % 3600) / 60))} 分`
}

/** A number of tokens in short: 940, 6.1K, 133K, 1.5M. */
export function formatTokens(tokens: number): string {
  const short = (value: number, unit: string): string => `${value >= 99.95 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}${unit}`
  if (tokens < 999.5) return String(Math.round(tokens))
  if (tokens < 999_500) return short(tokens / 1000, 'K')
  return short(tokens / 1_000_000, 'M')
}

/** A number written out, with its thousands set apart: 1,524,521. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** A share as a percentage with one decimal, for a list of parts where small ones matter: 28.8%, 0.3%, 0.0%. */
export function formatShareFine(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

/** A share as a percentage without decimals; under one percent it says so instead of saying nought. */
export function formatShare(share: number): string {
  const percent = share * 100
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`
}

/**
 * What a model's room is written as when typed by hand: a plain number of tokens, or one with a
 * K or an M behind it (128K, 1M, 32768). Null when it is not that, or not a size a model has.
 */
export function readWindow(text: string): number | null {
  const found = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(text.replace(/[,，_ ]/g, ''))
  if (!found) return null
  const tokens = Math.round(Number(found[1]) * (found[2] === '' ? 1 : found[2].toLowerCase() === 'k' ? 1000 : 1_000_000))
  return tokens >= 256 && tokens <= 100_000_000 ? tokens : null
}
