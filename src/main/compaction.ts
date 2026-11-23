// Keeping a conversation within the room a model has for it. Three things are done, the
// cheapest first: a tool result is cut to fit before it is ever sent (`fitTokens`); old tool
// results are cleared from what is sent; and what is older than the latest part of the
// conversation is replaced by a summary a model writes. The conversation as it is kept and shown
// loses nothing by any of this: what changes is what is sent (`sendable`).
//
// Why in this order. Whatever changes the beginning of a conversation makes the service read all
// of it anew instead of from its cache, so nothing is trimmed a little at a time: a compaction
// brings the conversation well under the line that set it off. Clearing old results costs no
// request and keeps every word that was said; a summary costs a request and keeps the gist.
//
// Nothing in this file depends on Electron, and nothing in it talks to a model: `compact` is
// handed the function that asks one.

import { SUMMARY_CLOSE, SUMMARY_OPEN } from '../shared/compaction.ts'
import { charsWithin, estimateTokens } from '../shared/stats.ts'
import type { ChatMessage, CompactionMark, StoredMessage, WebActivity } from '../shared/types.ts'
import { messageWeight } from './meter.ts'
import { thinkingReturns, userText } from './providers/history.ts'

/** Of what a request weighs when it is compacted, the share that stays as it is: the latest part of the conversation. */
const KEPT_SHARE = 0.25
/** A compaction made unasked brings the conversation under this share of the size that set it off. */
export const TARGET_SHARE = 0.75
/** Of the size from which a conversation is compacted, the share that the results of one step's tool calls may take together. */
export const STEP_SHARE = 0.25
/** A tool result is cleared only when that saves at least this many tokens, as guessed. */
const WORTH_CLEARING = 50
/** Clearing alone, where it does not bring the conversation under the line, is done only if it saves this share of it. */
const WORTH_ALONE = 0.1
/**
 * How long a summary may be: a share of what the conversation weighed when it was compacted, and
 * in tokens at least and at most. Of that weight and not of the model's room: a person who set a
 * limit far under the room of a large model wants the conversation kept small, summary included.
 */
const SUMMARY_SHARE = 0.06
const SUMMARY_MIN = 400
const SUMMARY_MAX = 2000
/** Of the model's room, the share the record of the conversation may take when the summary is asked for. The rest is for the reply and the thinking before it. */
const RECORD_SHARE = 0.7
/** How much of one message of the person's is quoted beside the summary, in characters, and what all of them may weigh. */
const SAID_EACH = 600
const SAID_SHARE = 0.03
const SAID_MAX = 1500
/** How many files are named in each of the two lists beside the summary. */
const FILES_EACH = 30
/** The results of these tools are never cleared: a skill that was loaded is instructions, and the model is following them. */
const NEVER_CLEARED = new Set(['load_skill'])
/** The tools of the app that read a file, and those that change one, for the lists beside the summary. */
const READS = new Set(['read_file'])
const WRITES = new Set(['write_file', 'edit_file'])

/** What follows a summary when the conversation goes on in the middle of a task, with no new message of the person's. */
export const CARRY_ON = 'Carry on with the task from where the summary leaves it. Do not start over, and do not do again what is already done.'

/** The place of the summary that is in force: the last one. -1 when the conversation has none. */
export function lastSummary(stored: readonly StoredMessage[]): number {
  for (let i = stored.length - 1; i >= 0; i--) {
    const message = stored[i]
    if (message.role === 'compaction' && message.summary) return i
  }
  return -1
}

/**
 * The conversation as it is sent to a model: from the summary in force on, with the summary as
 * the start of the first message, and with a line in the place of every tool result that was
 * cleared. The summary goes into the person's message that follows it, so that the turns still
 * alternate for the servers that insist on it; where the model's own step follows, it stands as
 * a message of its own that tells the model to carry on.
 */
export function sendable(stored: readonly StoredMessage[]): ChatMessage[] {
  const from = lastSummary(stored)
  const out: ChatMessage[] = []
  let lead = from >= 0 ? (stored[from] as CompactionMark).summary?.sent : undefined
  for (let i = from + 1; i < stored.length; i++) {
    const message = stored[i]
    if (message.role === 'compaction') continue
    if (lead !== undefined) {
      const summary = lead
      lead = undefined
      if (message.role === 'user') {
        // The text files of the message are part of its text by now; its pictures stay with it.
        const images = (message.attachments ?? []).filter((file) => file.kind === 'image')
        const said = userText({ ...message, attachments: (message.attachments ?? []).filter((file) => file.kind === 'text') })
        out.push({ role: 'user', content: said ? `${summary}\n\n${said}` : summary, ...(images.length ? { attachments: images } : {}) })
        continue
      }
      out.push({ role: 'user', content: `${summary}\n\n${CARRY_ON}` })
    }
    if (message.role === 'tool' && message.cleared !== undefined) out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.cleared })
    else out.push(message)
  }
  if (lead !== undefined) out.push({ role: 'user', content: `${lead}\n\n${CARRY_ON}` })
  return out
}

/** A guess at what a kept message weighs as it is sent, in tokens. A mark weighs nothing: it is not sent. */
export function storedWeight(message: StoredMessage): number {
  if (message.role === 'compaction') return 0
  if (message.role === 'tool' && message.cleared !== undefined) return estimateTokens(message.cleared)
  const { said, summary, tools } = messageWeight(message)
  return said + summary + tools
}

/**
 * What of a reply the next request carries, of the tokens the service counted for writing it
 * (`counted`). All of them, as a rule: a service counts the thinking again with the reply, or
 * keeps it itself. Not where the thinking stays behind, having come inside the answer: then the
 * count is shared between answer and thinking by what each is guessed to weigh, which leaves the
 * service's own way of counting out of it. Seen with a stand-in server that counts 1.15 tokens to
 * a guessed one (2026-11-23): booked whole, 800 tokens of thinking a step made the next request
 * expected at 2,097 where 1,426 came, and what tool results were taken to weigh was learned at
 * less than half of what they do.
 */
export function carriedTokens(message: Extract<ChatMessage, { role: 'assistant' }>, counted: number): number {
  const thought = message.reasoning_content
  if (!thought || thinkingReturns(message)) return counted
  const answer = storedWeight(message)
  const thinking = estimateTokens(thought)
  return answer + thinking > 0 ? Math.round((counted * answer) / (answer + thinking)) : counted
}

/** Room for the note that says a result was cut. */
const CUT_NOTE_ROOM = 40

/**
 * A tool result cut to weigh `max` tokens at most, as guessed, with a note of how much is
 * missing. Done before the result is first sent, when nothing is lost by it but what would not
 * have fitted: the conversation the service has read is not changed.
 */
export function fitTokens(text: string, max: number): string {
  if (estimateTokens(text) <= max) return text
  const kept = charsWithin(text, Math.max(0, max - CUT_NOTE_ROOM))
  return `${text.slice(0, kept)}\n… [cut here to fit the model's context: ${text.length - kept} more characters. Ask for less at a time, such as a part of a file, to see the rest.]`
}

/** The line sent in the place of a cleared tool result. The call it answers still stands before it and says what it was. */
function clearedNote(content: string): string {
  return `[Result cleared to save room in the context: ${content.length} characters. Read or run it again if it is needed.]`
}

/** The names of the tools that were called, by the id of the call. */
function callNames(messages: readonly StoredMessage[], upTo: number): Map<string, string> {
  const names = new Map<string, string>()
  for (let i = 0; i < upTo; i++) {
    const message = messages[i]
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) names.set(call.id, call.name)
  }
  return names
}

/** Where the latest part of the conversation begins that weighs `keep` at most: the place of its first message. */
function recentFrom(weights: readonly number[], start: number, keep: number): number {
  let sum = 0
  let at = weights.length
  while (at > start && sum + weights[at - 1] <= keep) sum += weights[--at]
  return at
}

interface Clearable {
  at: number
  note: string
  /** Tokens saved by sending the note in place of the result, as guessed. */
  saves: number
}

/** The tool results from `start` up to `recent` that are worth clearing. */
function clearable(messages: readonly StoredMessage[], start: number, recent: number): Clearable[] {
  const names = callNames(messages, recent)
  const found: Clearable[] = []
  for (let i = start; i < recent; i++) {
    const message = messages[i]
    if (message.role !== 'tool' || message.cleared !== undefined) continue
    if (NEVER_CLEARED.has(names.get(message.tool_call_id) ?? '')) continue
    const note = clearedNote(message.content)
    const saves = estimateTokens(message.content) - estimateTokens(note)
    if (saves >= WORTH_CLEARING) found.push({ at: i, note, saves })
  }
  return found
}

/** The kinds of block that hold Claude's thinking. They are signed, and the signature holds only for the conversation as it was when they were written. */
const THINKING = new Set(['thinking', 'redacted_thinking'])

/**
 * Takes the thinking out of what Claude's messages from `from` on are sent back with. A thinking
 * block is bound to everything that stood before it: once that has changed, the service drops
 * the block or refuses the request. Taken out here, once and for good, the same messages go out
 * every time. What the person is shown of the thinking stays. Other services bind nothing to what
 * came before, and their messages are left alone.
 */
export function dropThinking(messages: StoredMessage[], from: number): void {
  for (let i = Math.max(0, from); i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== 'assistant' || message.origin?.kind !== 'anthropic' || !Array.isArray(message.origin.replay)) continue
    message.origin.replay = (message.origin.replay as unknown[]).filter(
      (block) => !(typeof block === 'object' && block !== null && THINKING.has(String((block as { type?: unknown }).type)))
    )
  }
}

/**
 * Where the summary is to end and the part that stays as it is to begin: before a message of the
 * person's or before a step of the model's (never between a call and its result), at or after
 * `recent`. Before a message of the person's where that keeps at least half of what could be
 * kept: a part that begins with what was asked reads best.
 */
function cutAt(messages: readonly StoredMessage[], weights: readonly number[], start: number, recent: number): number {
  const length = messages.length
  const tail = (from: number): number => {
    let sum = 0
    for (let i = from; i < length; i++) sum += weights[i]
    return sum
  }
  let step = length
  let turn = length
  for (let i = recent; i < length; i++) {
    const role = messages[i].role
    if (step === length && (role === 'user' || role === 'assistant')) step = i
    if (role === 'user') {
      turn = i
      break
    }
  }
  const cut = turn < length && tail(turn) * 2 >= tail(step) ? turn : step
  // What the person wrote last, while nothing has answered it, is what is being asked: it stays.
  let asked = length
  for (let i = length - 1; i >= start; i--) {
    const role = messages[i].role
    if (role === 'assistant') break
    if (role === 'user') asked = i
  }
  return Math.min(cut, asked)
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)} … [${text.length - max} more characters]`)
/** Without the tags that mark where a summary begins and ends, should a text happen to hold them. */
const untagged = (text: string): string => text.split(SUMMARY_OPEN).join('').split(SUMMARY_CLOSE).join('')

/** How much of each kind of thing is written into the record a summary is made from, in characters. */
interface Clips {
  text: number
  args: number
  result: number
}
/** From what reads well down to what just fits: a long conversation is given in less detail. */
const CLIPS: readonly Clips[] = [
  { text: 8000, args: 1000, result: 2000 },
  { text: 4000, args: 400, result: 800 },
  { text: 2000, args: 200, result: 300 },
  { text: 800, args: 120, result: 120 }
]
const LEFT_OUT = '[The beginning of this part of the conversation is left out here: it did not fit.]'

/** The most pages of one search that are named in the record. */
const RECORD_SOURCES = 8

/**
 * A web search or page read that a service did by itself for a reply, as a line of the record:
 * what was looked for, and what was found. Such a search is no tool call and leaves no result
 * among the messages, so without this line a summary knew of it only as far as the reply's own
 * text spoke of it, and the model might search for the same thing again.
 */
function searchLine(activity: WebActivity, clips: Clips): string {
  const failed = activity.status === 'failed' ? ', which failed' : ''
  const pages = (activity.sources ?? [])
    .slice(0, RECORD_SOURCES)
    .map((source) => (source.title ? `${source.title} <${source.url}>` : `<${source.url}>`))
    .join('; ')
  if (activity.kind === 'open') return `[assistant read the web page ${clip(activity.url ?? pages, clips.result)}${failed}]`
  const asked = (activity.queries ?? []).map((query) => `"${query}"`).join(', ')
  return `[assistant searched the web${asked ? ` for ${clip(asked, clips.args)}` : ''}${failed}]${pages ? ` ${clip(`Pages found: ${pages}`, clips.result)}` : ''}`
}

/** The messages from `from` up to `to` written out as a record for a model to summarize. */
function recordOf(messages: readonly StoredMessage[], from: number, to: number, clips: Clips, names: ReadonlyMap<string, string>): string {
  const blocks: string[] = []
  for (let i = from; i < to; i++) {
    const message = messages[i]
    if (message.role === 'compaction') continue
    if (message.role === 'user') {
      // What came with the message is named; what the files said is in the replies that were made of them.
      const came = [
        ...(message.skill ? [`the skill "${message.skill.name}"`] : []),
        ...(message.attachments ?? []).map((file) => `the ${file.kind === 'image' ? 'picture' : 'file'} "${file.name}"`)
      ]
      blocks.push(`[user${came.length ? `, with ${came.join(', ')} attached` : ''}]\n${clip(message.content, clips.text)}`)
    } else if (message.role === 'assistant') {
      // The searches the service did by itself stand before what was written with them, as they do on the page.
      const lines = (message.web ?? []).map((activity) => searchLine(activity, clips))
      if (message.content.trim()) lines.push(`[assistant]\n${clip(message.content.trim(), clips.text)}`)
      for (const call of message.tool_calls ?? []) lines.push(`[assistant calls ${call.name}] ${clip(call.arguments, clips.args)}`)
      if (lines.length) blocks.push(lines.join('\n'))
    } else {
      blocks.push(`[result of ${names.get(message.tool_call_id) ?? 'a tool'}]\n${message.cleared ?? clip(message.content, clips.result)}`)
    }
  }
  return blocks.join('\n\n')
}

/**
 * The record a summary is made from, in as much detail as fits into `budget` tokens, as
 * guessed. `earlier` is the summary in force, which the new one continues. Undefined when not
 * even the end of the conversation fits.
 */
function recordFor(messages: readonly StoredMessage[], start: number, cut: number, earlier: string | undefined, budget: number): string | undefined {
  const names = callNames(messages, cut)
  const head = earlier ? `[summary of what came before this record]\n${earlier}\n\n` : ''
  for (const clips of CLIPS) {
    const text = head + recordOf(messages, start, cut, clips, names)
    if (estimateTokens(text) <= budget) return text
  }
  // Cut to the bone it still does not fit: the oldest of it is left out, as little as it takes.
  const begins: number[] = []
  for (let i = start + 1; i < cut; i++) if (messages[i].role === 'user' || messages[i].role === 'assistant') begins.push(i)
  const from = (at: number): string => `${head}${LEFT_OUT}\n\n${recordOf(messages, at, cut, CLIPS[CLIPS.length - 1], names)}`
  let low = 0
  let high = begins.length - 1
  let found: string | undefined
  while (low <= high) {
    const middle = (low + high) >> 1
    const text = from(begins[middle])
    if (estimateTokens(text) <= budget) {
      found = text
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  return found
}

/**
 * What the person wrote before `upTo`, in their own words, as numbered lines: the first message,
 * and as many of the latest as weigh `budget` tokens at most. A summary can lose an instruction;
 * this cannot.
 */
function saidOf(messages: readonly StoredMessage[], upTo: number, budget: number): { lines: string[]; quoted: number } {
  const all: string[] = []
  for (let i = 0; i < upTo; i++) {
    const message = messages[i]
    if (message.role === 'user' && message.content.trim()) all.push(clip(untagged(message.content.trim()), SAID_EACH))
  }
  if (all.length === 0) return { lines: [], quoted: 0 }
  const kept = new Set([0])
  let room = budget - estimateTokens(all[0])
  for (let i = all.length - 1; i > 0; i--) {
    const cost = estimateTokens(all[i])
    if (cost > room) break
    room -= cost
    kept.add(i)
  }
  const lines: string[] = []
  let skipped = 0
  all.forEach((text, i) => {
    if (!kept.has(i)) return void skipped++
    if (skipped) lines.push(`[… ${skipped} more ${skipped === 1 ? 'message' : 'messages'} left out here …]`)
    skipped = 0
    lines.push(`${i + 1}. ${text}`)
  })
  return { lines, quoted: kept.size }
}

/** The files the app's own tools read and changed before `upTo`, each list in the order of last use. A file that was changed is not listed as read. */
function filesOf(messages: readonly StoredMessage[], upTo: number): { read: string[]; changed: string[] } {
  const read = new Set<string>()
  const changed = new Set<string>()
  const touch = (set: Set<string>, file: string): void => {
    set.delete(file)
    set.add(file)
  }
  for (let i = 0; i < upTo; i++) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    for (const call of message.tool_calls ?? []) {
      const reads = READS.has(call.name)
      if (!reads && !WRITES.has(call.name)) continue
      let file: unknown
      try {
        file = (JSON.parse(call.arguments || '{}') as { path?: unknown }).path
      } catch {
        continue
      }
      if (typeof file !== 'string' || !file.trim()) continue
      touch(reads ? read : changed, untagged(file.trim()).slice(0, 300))
    }
  }
  for (const file of changed) read.delete(file)
  return { read: [...read], changed: [...changed] }
}

const listed = (files: readonly string[]): string => {
  const shown = files.slice(-FILES_EACH)
  const more = files.length - shown.length
  return `${more > 0 ? `(${more} earlier ones not listed) ` : ''}${shown.join(', ')}`
}

/** What stands over the person's earlier messages where they are quoted beside the summary. */
export const SAID_BEFORE =
  'What the user wrote before this point, oldest first, in their own words. These are earlier messages, kept so that nothing they asked for is lost. They are not new requests: the summary above says what was done about them.'

/** What is sent in the place of the compacted part of a conversation: the summary, and what the app knows without asking. */
function handover(summary: string, said: readonly string[], files: { read: readonly string[]; changed: readonly string[] }): string {
  const parts = [
    'The earlier part of this conversation was compacted to save room in your context. This summary stands in its place; what comes after it is the latest part of the conversation, unchanged.',
    summary,
    // Said to be old in so many words: quoted in a message of the person's, an earlier request reads like a new one.
    said.length ? `${SAID_BEFORE}\n${said.join('\n')}` : '',
    [files.read.length ? `Files read: ${listed(files.read)}` : '', files.changed.length ? `Files written or edited: ${listed(files.changed)}` : ''].filter(Boolean).join('\n')
  ].filter(Boolean)
  return `${SUMMARY_OPEN}\n${parts.join('\n\n')}\n${SUMMARY_CLOSE}`
}

/**
 * The five headings of a summary, in the languages the app can tell a conversation is in
 * (`writtenIn` in language.ts names them so). They are given to the model as they are to be
 * written: told only to write "the headings too" in the person's language, two real models of
 * three left them in English over a text in Chinese.
 */
const HEADINGS: Record<string, readonly [string, string, string, string, string]> = {
  Chinese: ['目标', '决定和约束', '已做的事', '问题', '状态'],
  'Chinese (繁體中文, Traditional characters)': ['目標', '決定與約束', '已做的事', '問題', '狀態'],
  Japanese: ['目標', '決定事項と制約', '実施した作業', '問題', '現状'],
  'Korean (한국어)': ['목표', '결정 사항과 제약', '수행한 작업', '문제', '상태']
}
const HEADINGS_ELSE = ['Goal', 'Decisions and constraints', 'Work done', 'Problems', 'State'] as const

/** What the model that writes the summary is told. `tokens` is how long the summary may be. */
export function summaryPrompt(tokens: number, language?: string): string {
  const words = Math.max(50, Math.round((tokens * 0.75) / 50) * 50)
  const characters = Math.max(100, Math.round(tokens / 100) * 100)
  const named = language ? HEADINGS[language] : undefined
  const [goal, decisions, done, problems, state] = named ?? HEADINGS_ELSE
  return [
    'You write the summary that lets an AI coding assistant carry on a long conversation with less of it in view.',
    "You are given a record of the earlier part of a conversation between a user and the assistant, who works in the user's project with tools: reading and editing files, running commands.",
    'Your summary will stand in the place of that record. The assistant will then see your summary, a list of what the user wrote, a list of the files that were touched, and the latest part of the conversation. It will see nothing else of what you are reading now.',
    '',
    `Write the summary under these headings, in this order${named ? ', written exactly as they stand here' : ''}. Leave a heading out when there is nothing to say under it.`,
    `1. ${goal}: what the user wants, and what each of their requests was, in order.`,
    `2. ${decisions}: what was agreed or ruled out, and what the user said about how they want things done.`,
    `3. ${done}: what was changed and what was found out. Name files, functions, commands and exact values. Keep code only where its exact wording matters later.`,
    `4. ${problems}: the errors that came up and how each was dealt with, or that it is still open.`,
    `5. ${state}: what is finished, what was being done where the record ends, and what comes next.`,
    '',
    'Rules:',
    '- State what happened as fact, in plain sentences or short lists. Do not address the user, and do not comment on the summary.',
    '- Use only what is in the record. Where the record was cut ("… [N more characters]"), do not guess at what is missing.',
    '- A record that begins with an earlier summary continues from it: carry over what still matters of it.',
    '- Do not call tools and do not continue the conversation. The summary is your whole reply.',
    `- Keep it under about ${words} words (in Chinese, Japanese or Korean: about ${characters} characters).`,
    language
      ? `- Write the summary in ${language}${named ? '' : ', the headings included'}; names, code and commands stay as they are.`
      : '- Write the summary in the language the user writes in, the headings included; names, code and commands stay as they are.'
  ].join('\n')
}

const clamp = (value: number, least: number, most: number): number => Math.min(most, Math.max(least, value))

/** What a compaction is given to work with. */
export interface CompactJob {
  /** The conversation as it is kept. Changed in place, and only when something is done. */
  messages: StoredMessage[]
  /** What a request weighs without its messages: the instructions and the definitions of the tools, in tokens. */
  base: number
  /** How many tokens a guessed token of text really is, as far as a service has told. 1 where none has. */
  scale: number
  /**
   * What a kept message weighs as it is sent, in tokens. Left out, its text at `scale`. A service
   * may count far more of a reply than its text: the thinking, which it keeps with the reply and
   * counts again whenever the reply is sent back. Whoever knows what the service counted of each
   * reply says so here, or a conversation that is mostly thinking has nothing in it to compact.
   */
  weigh?(message: StoredMessage): number
  /** How many tokens the context of the model holds, where that is known. */
  window?: number
  /** The size the request is to be brought under, in tokens. */
  limit: number
  /** The language the person writes in, where their writing shows it: the summary is written in it. */
  language?: string
  signal: AbortSignal
  /**
   * Asks a model for the summary of a record, given what to tell it. Resolves with what it wrote;
   * rejects when none was to be had, with the reason.
   */
  summarize(system: string, record: string): Promise<string>
  /** Called when the summary is about to be asked for: from here on it takes a while. */
  onSummarizing?(): void
  /** The time, for the mark. */
  now?(): number
}

export interface CompactResult {
  /** The mark that was put into the conversation, when something was done. */
  mark?: CompactionMark
  /** Why no summary was made although one was called for. */
  problem?: string
}

/**
 * Brings a conversation under `limit`: by clearing old tool results where that is enough, and
 * otherwise by putting a summary in the place of everything but its latest part. Should the
 * summary not be had, the results are cleared after all, which helps as far as it goes. A stop
 * while the summary is written leaves everything as it was.
 */
export async function compact(job: CompactJob): Promise<CompactResult> {
  const { messages, scale } = job
  const real = (guessed: number): number => Math.round(guessed * scale)
  const weigh = job.weigh ?? ((message: StoredMessage): number => scale * storedWeight(message))
  const now = job.now ?? Date.now
  const at = lastSummary(messages)
  const start = at + 1
  const inForce = at >= 0 ? (messages[at] as CompactionMark).summary : undefined
  /** What each message weighs as it is sent, in tokens. */
  const weights = messages.map(weigh)
  const weightOf = (from: number, to: number): number => {
    let sum = 0
    for (let i = from; i < to; i++) sum += weights[i]
    return sum
  }
  const lead = inForce ? scale * estimateTokens(inForce.sent) : 0
  const used = Math.round(job.base + lead + weightOf(start, messages.length))
  /** What the model can take, as far as known: what the record for the summary has to fit into. */
  const room = job.window ?? used
  /** The size the conversation is kept to: what the summary and what goes with it are measured by. */
  const size = Math.min(room, used)
  /** What of the latest part stays as it is, in tokens. */
  const keep = used * KEPT_SHARE
  const recent = recentFrom(weights, start, keep)
  const marked = (rest: Pick<CompactionMark, 'after' | 'cleared' | 'summary'>): CompactionMark => ({
    role: 'compaction',
    at: now(),
    before: used,
    ...(job.window !== undefined ? { window: job.window } : {}),
    // A guess until the service has counted what is left (see `CompactionMark.rough`).
    rough: true,
    ...rest
  })

  // First: old tool results, where clearing them is enough.
  const old = clearable(messages, start, recent)
  const freed = real(old.reduce((sum, entry) => sum + entry.saves, 0))
  const clear = (problem?: string): CompactResult => {
    for (const { at: index, note } of old) (messages[index] as Extract<StoredMessage, { role: 'tool' }>).cleared = note
    dropThinking(messages, old[0].at)
    const mark = marked({ after: Math.max(0, used - freed), cleared: old.length })
    messages.push(mark)
    return { mark, ...(problem ? { problem } : {}) }
  }
  if (old.length > 0 && used - freed <= job.limit) return clear()
  /** What is done when no summary is made: clearing, where that is worth changing the conversation for. */
  const without = (problem?: string): CompactResult => (old.length > 0 && freed >= used * WORTH_ALONE ? clear(problem) : problem ? { problem } : {})

  // Then: a summary in the place of everything before the latest part.
  const cut = cutAt(messages, weights, start, recent)
  const longest = clamp(Math.round(size * SUMMARY_SHARE), SUMMARY_MIN, SUMMARY_MAX)
  // A summary that would not be much shorter than what it stands for is not worth asking for.
  if (cut <= start || weightOf(start, cut) < longest * 1.5) return without()
  const record = recordFor(messages, start, cut, inForce?.text, Math.floor((room * RECORD_SHARE - longest) / scale))
  if (record === undefined) return without('The conversation is too long for this model to summarize.')

  job.onSummarizing?.()
  let text: string
  try {
    text = untagged(await job.summarize(summaryPrompt(longest, job.language), `<record>\n${record}\n</record>\n\nWrite the summary of this record now.`)).trim()
  } catch (err) {
    if (job.signal.aborted) return {}
    return without(err instanceof Error ? err.message : String(err))
  }
  if (job.signal.aborted) return {}
  if (!text) return without('The model returned no summary.')
  // A model that ran on far past what it was asked for: the summary must not take the room it is to make.
  if (estimateTokens(text) > longest * 2) text = `${text.slice(0, charsWithin(text, longest * 2))}\n… [the summary was cut here: it ran too long]`

  const said = saidOf(messages, cut, Math.floor(Math.min(SAID_MAX, size * SAID_SHARE) / scale))
  const files = filesOf(messages, cut)
  const sent = handover(text, said.lines, files)
  let covers = 0
  for (let i = 0; i < cut; i++) if (messages[i].role === 'user' || messages[i].role === 'assistant') covers++
  const mark = marked({ after: 0, summary: { text, sent, covers, said: said.quoted, files: files.read.length + files.changed.length } })
  messages.splice(cut, 0, mark)
  // What is kept after the summary was written before it: Claude's thinking in it no longer holds.
  dropThinking(messages, cut + 1)
  // What the next request weighs: the instructions and tools, the summary, and the part that was kept.
  mark.after = Math.round(job.base + sendable(messages).reduce((sum, message) => sum + weigh(message), 0))
  return { mark }
}

/**
 * How services word that a request holds more than the model's context takes. Every one has its
 * own words: "This model's maximum context length is 8192 tokens" (OpenAI, vLLM, DeepSeek),
 * "prompt is too long: 215000 tokens > 200000 maximum" (Anthropic), "maximum prompt length is
 * 131072" (xAI), "exceeds the available context size" (llama.cpp), "context length of only 4096
 * tokens" (LM Studio), "input token count exceeds the maximum" (Gemini's compatible API).
 */
const TOO_LONG: readonly RegExp[] = [
  /context[ _-]?(?:length|window|size)/i,
  /maximum context/i,
  /prompt is too long/i,
  /too many (?:input |prompt )?tokens/i,
  /maximum prompt length/i,
  /input (?:is )?too long/i,
  /exceeds? the (?:available |maximum )?context/i,
  /input token count/i,
  /reduce the length/i
]

/** Whether an error says that the conversation no longer fits the model's context. */
export function saysTooLong(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'context_length_exceeded') return true
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return TOO_LONG.some((pattern) => pattern.test(message))
}

/** Where such an error names the size of the model's context. */
const WINDOW_SAID: readonly RegExp[] = [
  /maximum context length (?:is|of) ([\d,]+)/i,
  /context (?:length|window|size) (?:is|of)(?: only)? ([\d,]+)/i,
  /> ?([\d,]+) maximum/i,
  /maximum prompt length is ([\d,]+)/i,
  /n_ctx\D{0,12}([\d,]+)/i
]

/** How many tokens the model's context holds, where the error that says "too long" says that as well. */
export function windowSaid(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  for (const pattern of WINDOW_SAID) {
    const found = pattern.exec(message)
    const tokens = found ? Number(found[1].replace(/,/g, '')) : NaN
    if (Number.isInteger(tokens) && tokens >= 256 && tokens <= 100_000_000) return tokens
  }
  return undefined
}
