// Tool calls that arrive inside the answer. A model writes a call as text, and it is the server
// that takes the text apart and hands the call over as `tool_calls`. Some servers do not: they
// were started without a parser for the model's format, or the model wrote the call a little
// differently from what the parser knows. And some take no tool definitions at all; for those
// the tools are described in the instructions, and every call comes as text.
// This file reads such calls, in the forms the open models write them in, and writes a
// conversation in the same form for a server of the second kind.
// Nothing in this file depends on Electron.

import { randomBytes } from 'node:crypto'
import type { ToolDefinition } from '../tools.ts'
import { begun } from './think-tags.ts'

const OPEN = '<tool_call>'
const CLOSE = '</tool_call>'
const FUNCTION = '<function='
const FUNCTION_CLOSE = '</function>'
const FENCE = '```'

/** A call read from text: the name, and the arguments as the JSON text every other call has them as. */
export interface WrittenCall {
  name: string
  arguments: string
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The calls a piece of JSON stands for: an object with a name and arguments, or a list of such.
 * Models name the arguments `arguments` or `parameters`, now and then write them as a string of
 * JSON, and some wrap the whole the way the API does (`{"type": "function", "function": {...}}`).
 * With `known`, a call has to name one of these tools and say what with: that is asked of JSON
 * that stands in an answer with no tags around it, which could as well be something shown.
 */
function callsOfJson(value: unknown, known?: ReadonlySet<string>): WrittenCall[] | undefined {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) return undefined
  const calls: WrittenCall[] = []
  for (const entry of list) {
    const item: unknown = isObject(entry) && isObject(entry.function) && !('name' in entry) ? entry.function : entry
    if (!isObject(item) || typeof item.name !== 'string' || !item.name) return undefined
    let args: unknown = item.arguments ?? item.parameters
    if (typeof args === 'string') {
      try {
        args = args.trim() ? JSON.parse(args) : undefined
      } catch {
        return undefined
      }
    }
    if (known) {
      if (!known.has(item.name) || !isObject(args)) return undefined
    } else {
      // A call of a tool that takes nothing may leave the arguments out.
      args ??= {}
    }
    if (!isObject(args)) return undefined
    calls.push({ name: item.name, arguments: JSON.stringify(args) })
  }
  return calls
}

/** The basic types a tool's schema gives one of its parameters, as far as it names any. */
function typesOf(tool: ToolDefinition | undefined, key: string): string[] {
  const properties = tool?.parameters.properties
  const declared = isObject(properties) ? properties[key] : undefined
  if (!isObject(declared)) return []
  const named = (schema: unknown): unknown[] => (isObject(schema) ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [])
  const choices = [declared.anyOf, declared.oneOf].flatMap((list) => (Array.isArray(list) ? list.flatMap(named) : []))
  return [...named(declared), ...choices].filter((type): type is string => typeof type === 'string')
}

/**
 * A parameter's value, which stands between its tags as it is and without quotes, as the kind of
 * value the tool takes. Text stays text whatever it looks like: a file may well consist of "42".
 * So does a value the schema says nothing about.
 */
function valueOf(raw: string, types: readonly string[]): unknown {
  // The form puts the value on lines of its own.
  const text = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  if (types.length === 0 || types.includes('string')) return text
  const bare = text.trim()
  if (types.includes('null') && bare === 'null') return null
  if (types.includes('boolean') && /^(?:true|false)$/i.test(bare)) return bare.toLowerCase() === 'true'
  if ((types.includes('integer') || types.includes('number')) && bare !== '' && Number.isFinite(Number(bare))) return Number(bare)
  if (types.includes('object') || types.includes('array')) {
    try {
      return JSON.parse(bare)
    } catch {
      // Left as text: the tool says what is wrong with it, which the model can act on.
    }
  }
  return text
}

/**
 * The call in a `<function=name>` block, whose arguments stand each in a `<parameter=key>` block
 * (Qwen 3.5, Qwen3-Coder) or all together as JSON (Llama 3). Undefined when the block holds
 * anything besides: half a call is not run.
 */
function callOfBlock(block: string, tools: ReadonlyMap<string, ToolDefinition>): WrittenCall | undefined {
  const whole = /^<function=\s*([^\s<>]+)\s*>([\s\S]*)<\/function>$/.exec(block)
  if (!whole) return undefined
  const [, name, inside] = whole
  if (inside.trimStart().startsWith('{')) {
    try {
      const args: unknown = JSON.parse(inside)
      return isObject(args) ? { name, arguments: JSON.stringify(args) } : undefined
    } catch {
      return undefined
    }
  }
  const args: Record<string, unknown> = {}
  // A value ends at the closing tag that the next parameter or the end of the block follows, so
  // that a value which itself holds such a tag is read whole.
  const parameter = /\s*<parameter=\s*([^\s<>]+)\s*>([\s\S]*?)<\/parameter>(?=\s*<parameter=|\s*$)/y
  let at = 0
  for (;;) {
    parameter.lastIndex = at
    const found = parameter.exec(inside)
    if (!found) break
    args[found[1]] = valueOf(found[2], typesOf(tools.get(name), found[1]))
    at = parameter.lastIndex
  }
  if (inside.slice(at).trim()) return undefined
  return { name, arguments: JSON.stringify(args) }
}

/** Whether every code block in `text` that was opened is closed, so that a fence after it opens a new one. */
const fencesPair = (text: string): boolean => (text.split(FENCE).length - 1) % 2 === 0

/** Whether `text` begins with `tag`, or is the beginning of it with the rest still to come. */
const beginsOrBegan = (text: string, tag: string): boolean => text.startsWith(tag) || tag.startsWith(text)

/** Where the first of the tags that open a call stands in `text`, or -1. */
function openingIn(text: string): number {
  const places = [text.indexOf(OPEN), text.indexOf(FUNCTION)].filter((at) => at >= 0)
  return places.length ? Math.min(...places) : -1
}

/**
 * Takes the tool calls out of an answer as it streams in. What comes before the first call is
 * handed on as it arrives. From the tag that opens a call onwards everything is held back, since
 * a call is not text to show; once the answer has ended, `end` says which calls that was.
 *
 * `anyName`: the model was told to write its calls this way, so a block in this form is a call
 * whatever tool it names, and a wrong name is answered like any call of a tool that is not there.
 * Without it, only a block that names one of the tools counts: the others are text.
 */
export class WrittenCalls {
  private readonly tools: ReadonlyMap<string, ToolDefinition>
  private readonly anyName: boolean
  /** Held back because it may be the beginning of a tag, with the rest still to come. */
  private held = ''
  /** Everything from the tag that opens the first call onwards, once that tag was seen. */
  private rest: string | undefined

  constructor(tools: readonly ToolDefinition[], anyName = false) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]))
    this.anyName = anyName
  }

  /** Takes in a piece of the answer, and returns what is text to show now. */
  push(piece: string): string {
    if (this.rest !== undefined) {
      this.rest += piece
      return this.givenUp()
    }
    const text = this.held + piece
    const at = openingIn(text)
    if (at < 0) {
      const kept = Math.max(begun(text, OPEN), begun(text, FUNCTION))
      this.held = text.slice(text.length - kept)
      return text.slice(0, text.length - kept)
    }
    this.held = ''
    this.rest = text.slice(at)
    return text.slice(0, at) + this.givenUp()
  }

  /**
   * Gives back everything that is held back, and begins anew. For when what came so far turns
   * out not to have been the answer at all (it was the model's thinking): a call in it is none.
   */
  drain(): string {
    const text = this.rest ?? this.held
    this.rest = undefined
    this.held = ''
    return text
  }

  /**
   * What the answer held once it has ended. `calls` are the calls it held, one after the other
   * from the first tag on; what follows them is dropped, as it would be made up (a model that
   * goes on after a call writes the result itself). `text` is everything that was held back, for
   * a caller that got no calls from it to show after all. `begun`: a tag that opens a call was
   * seen. `unfinished`: the answer ends in a call that was begun and never closed, as when the
   * output was cut short.
   */
  end(): { text: string; calls: WrittenCall[]; begun: boolean; unfinished: boolean } {
    const rest = this.rest
    if (rest === undefined) {
      const text = this.held
      this.held = ''
      return { text, calls: [], begun: false, unfinished: false }
    }
    this.rest = undefined
    const calls: WrittenCall[] = []
    let unfinished = false
    let at = 0
    for (;;) {
      const read = this.readAt(rest, at)
      if (!read || read === 'unfinished') {
        unfinished = read === 'unfinished'
        break
      }
      calls.push(...read.calls)
      at = read.next
      while (at < rest.length && /\s/.test(rest[at])) at++
    }
    return { text: rest, calls, begun: true, unfinished }
  }

  /**
   * Hands the held text on when it can no longer be a call: the tag was only written about, or
   * names no tool there is. A later tag may still open one.
   */
  private givenUp(): string {
    const rest = this.rest
    if (rest === undefined || this.mayBeCall(rest)) return ''
    this.rest = undefined
    // Past its first letter, so that the same tag is not found again.
    return rest[0] + this.push(rest.slice(1))
  }

  /** Whether held text can still turn out to be a call: its tag is followed by what a call begins with, or by nothing yet. */
  private mayBeCall(rest: string): boolean {
    if (rest.startsWith(OPEN)) {
      const after = rest.slice(OPEN.length).trimStart()
      if (after === '' || after[0] === '{' || after[0] === '[' || beginsOrBegan(after, FENCE)) return true
      return beginsOrBegan(after, FUNCTION) && this.mayBeCall(after)
    }
    // `<function=name>`, then a parameter, the arguments as JSON, or the end of the block.
    const name = /^<function=\s*([^\s<>]*)/.exec(rest)
    if (!name) return FUNCTION.startsWith(rest)
    const after = rest.slice(name[0].length)
    if (after === '') return true
    const body = after.trimStart()
    if (body === '') return true
    if (body[0] !== '>' || !name[1] || !this.counts(name[1])) return false
    const first = body.slice(1).trimStart()
    return first === '' || first[0] === '<' || first[0] === '{'
  }

  private counts(name: string): boolean {
    return this.anyName || this.tools.has(name)
  }

  /** The calls in what stands between the tags: one of the forms, or nothing that can be read. */
  private callsIn(body: string): WrittenCall[] | undefined {
    let text = body.trim()
    // Some models put the call in a code block of its own.
    const fenced = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text)
    if (fenced) text = fenced[1].trim()
    let calls: WrittenCall[] | undefined
    if (text.startsWith('<')) {
      const call = callOfBlock(text, this.tools)
      calls = call ? [call] : undefined
    } else {
      try {
        calls = callsOfJson(JSON.parse(text))
      } catch {
        calls = undefined
      }
    }
    return calls?.every((call) => this.counts(call.name)) ? calls : undefined
  }

  /**
   * Reads the call that begins at `at`, and says where what follows it begins. A value may hold
   * a closing tag itself (a file that is about this very format), so each closing tag is tried
   * until the text up to it reads as a call.
   */
  private readAt(rest: string, at: number): { calls: WrittenCall[]; next: number } | 'unfinished' | undefined {
    if (rest.startsWith(OPEN, at)) {
      const from = at + OPEN.length
      for (let close = rest.indexOf(CLOSE, from); close >= 0; close = rest.indexOf(CLOSE, close + 1)) {
        const calls = this.callsIn(rest.slice(from, close))
        if (calls) return { calls, next: close + CLOSE.length }
      }
      // A model may stop right after its call, without the closing tag.
      const calls = this.callsIn(rest.slice(from))
      if (calls) return { calls, next: rest.length }
      return rest.includes(CLOSE, from) ? undefined : 'unfinished'
    }
    if (rest.startsWith(FUNCTION, at)) {
      // The block without the tags around it, which models leave out now and then.
      for (let close = rest.indexOf(FUNCTION_CLOSE, at); close >= 0; close = rest.indexOf(FUNCTION_CLOSE, close + 1)) {
        const end = close + FUNCTION_CLOSE.length
        const calls = this.callsIn(rest.slice(at, end))
        if (!calls) continue
        // A closing tag whose opening one was left out belongs to the call.
        const stray = /^\s*<\/tool_call>/.exec(rest.slice(end))
        return { calls, next: end + (stray ? stray[0].length : 0) }
      }
      return rest.includes(FUNCTION_CLOSE, at) ? undefined : 'unfinished'
    }
    return undefined
  }
}

/**
 * A call written as plain JSON at the end of an answer, with no tags around it: an answer that is
 * `{"name": ..., "arguments": {...}}` or a list of such, or that ends in it, on lines of its own
 * or in a code block. That is what is left of a model's call when a server took the tags off and
 * made no call of it. It could as well be something the model shows the person, so it counts
 * only when every name in it is that of a tool that was offered and the arguments are an object.
 * Returns the calls and the text before them.
 */
export function trailingCalls(text: string, tools: readonly ToolDefinition[]): { text: string; calls: WrittenCall[] } | undefined {
  const known = new Set(tools.map((tool) => tool.name))
  let body = text.trimEnd()
  const fenced = body.endsWith(FENCE)
  if (fenced) body = body.slice(0, -FENCE.length).trimEnd()
  if (!body.endsWith('}') && !body.endsWith(']')) return undefined
  // Every line it could begin on, the first one first.
  for (let line = 0; line >= 0 && line < body.length; line = body.indexOf('\n', line) + 1 || -1) {
    const first = /^[ \t]*([{[])/.exec(body.slice(line, line + 200))
    if (!first) continue
    let calls: WrittenCall[] | undefined
    try {
      calls = callsOfJson(JSON.parse(body.slice(line)), known)
    } catch {
      continue
    }
    if (!calls) continue
    let before = body.slice(0, line)
    if (fenced) {
      // The block has to open right before it; otherwise the fence at the end closes something else.
      const opening = /(?:^|\n)[ \t]*```[\w-]*[ \t]*\r?\n$/.exec(before)
      if (!opening || !fencesPair(before.slice(0, opening.index))) continue
      before = before.slice(0, opening.index)
    }
    return { text: before.trimEnd(), calls }
  }
  return undefined
}

/**
 * The text before a call that was read from the answer: without the white space at its end, and
 * without the opening of a code block, where a model put its call inside one.
 */
export function textBeforeCalls(text: string): string {
  const trimmed = text.trimEnd()
  const fence = /(?:^|\n)[ \t]*```[\w-]*$/.exec(trimmed)
  // Only a block that was opened and not closed.
  if (!fence || !fencesPair(trimmed.slice(0, fence.index))) return trimmed
  return trimmed.slice(0, fence.index).trimEnd()
}

/**
 * What a model is told of the tools when its server takes no definitions of them. The form is
 * the one the Qwen models write their calls in since 3.5, which others follow from the
 * description. A value stands between its tags as it is, so the text of a file needs no
 * escaping: the thing small models get wrong when they have to write it as JSON.
 */
export function toolsPrompt(tools: readonly ToolDefinition[]): string {
  return [
    '# Tools',
    '',
    'You have access to the following functions:',
    '',
    '<tools>',
    ...tools.map((tool) => JSON.stringify({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
    '</tools>',
    '',
    'To call a function, reply with a block in exactly this format:',
    '',
    '<tool_call>',
    '<function=example_function_name>',
    '<parameter=example_parameter_1>',
    'value_1',
    '</parameter>',
    '<parameter=example_parameter_2>',
    'A value can span',
    'several lines',
    '</parameter>',
    '</function>',
    '</tool_call>',
    '',
    'Rules:',
    '- A call is a <function=...></function> block inside <tool_call></tool_call> tags, with one <parameter=...></parameter> block for each argument. Give every required parameter.',
    '- This format is the only one understood here. A call written in any other syntax you may know is not run: it is shown to the user as text.',
    '- Write a value as it is, without quotes and without escaping. Write an object or a list as JSON.',
    '- You may say what you are about to do before a call. Write nothing after it: end your reply there.',
    '- The result comes back to you in the next message, inside <tool_response></tool_response> tags. Never write a <tool_response> yourself, and never make a result up.',
    '- To call several functions at once, write one <tool_call> block after the other.',
    '- When no function is needed, answer as usual.'
  ].join('\n')
}

/** A call as it stands in the conversation sent to such a server: in the form the model was asked to write it in. */
export function callText(call: WrittenCall): string {
  let args: unknown
  try {
    args = JSON.parse(call.arguments || '{}')
  } catch {
    // Arguments that never were JSON: the call is told without them, and its result says what was wrong.
  }
  const lines = [OPEN, `${FUNCTION}${call.name}>`]
  for (const [key, value] of Object.entries(isObject(args) ? args : {})) {
    lines.push(`<parameter=${key}>`, typeof value === 'string' ? value : JSON.stringify(value), '</parameter>')
  }
  lines.push(FUNCTION_CLOSE, CLOSE)
  return lines.join('\n')
}

/** The result of a call as it stands in that conversation. */
export function resultText(result: string): string {
  return `<tool_response>\n${result}\n</tool_response>`
}

const ID_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * An id for a call that came without one. Nine letters and digits, the one form every server
 * takes back: the templates of the Mistral models accept no other.
 */
export function newCallId(): string {
  return Array.from(randomBytes(9), (byte) => ID_LETTERS[byte % ID_LETTERS.length]).join('')
}
