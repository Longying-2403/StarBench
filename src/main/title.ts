// The name a conversation goes by in the list. It starts as the first words the person wrote.
// Once the first turn is over, the model in use is asked for a short title of what the
// conversation is about, and that takes the place of those words: "帮我查找 GitHub 上的
// Windows-MCP 插件" becomes "Windows-MCP 总览". Asked once for each conversation, and only while
// that is switched on (设置 → 通用). Here is what the model is told, what it is shown, and what
// is made of its answer; asking it is the agent's (`askAside` in agent.ts).
// Nothing in this file depends on Electron.

import { usualEfforts } from '../shared/types.ts'
import type { ReasoningEffort, StoredMessage } from '../shared/types.ts'
import { cutAt } from '../shared/well-formed.ts'
import type { Connection } from './providers/types.ts'

/** The longest name the model may give, in characters. A reply longer than this was no title: an answer, most likely. */
export const TITLE_MAX = 40
/** How much of the person's first message, and of the answer to it, the model is shown, in characters. */
const SAID_MAX = 1500
const ANSWER_MAX = 800

const clip = (text: string, max: number): string => (text.length <= max ? text : `${cutAt(text, max)} …`)

/** What the model that names a conversation is told. `language` is the one the person writes in, where their writing shows it. */
export function titlePrompt(language?: string): string {
  return [
    'You name conversations. You are given the start of a conversation between a user and an AI coding assistant: what the user wrote first and, where there is one, the beginning of the answer.',
    'Reply with a short title that says what the conversation is about, as it would stand in a list of conversations. Name the subject, not the request: for "Find the Windows-MCP plugin on GitHub for me" a good title is "Windows-MCP overview", and for "帮我查找GitHub上的Windows-MCP插件" it is "Windows-MCP 总览".',
    '',
    'Rules:',
    '- At most 6 words; in Chinese, Japanese or Korean at most 12 characters.',
    '- One line of plain text: no quotation marks around it, no full stop after it, no Markdown, and no "Title:" before it.',
    '- Names of products, files and commands stay as they are written.',
    '- Do not answer the user, do not ask anything, and do not call tools. The title is your whole reply.',
    language ? `- Write the title in ${language}; names stay as they are.` : '- Write the title in the language the user writes in.'
  ].join('\n')
}

/**
 * What the model is shown of a conversation to name it by: the first message of the person, with
 * the names of the files that came with it, and the beginning of the first answer that has words.
 * Undefined where the person has said nothing to name it by.
 */
export function titleRecord(messages: readonly StoredMessage[]): string | undefined {
  const asked = messages.find((message) => message.role === 'user')
  if (!asked || asked.role !== 'user') return undefined
  const files = (asked.attachments ?? []).map((file) => file.name)
  const said = [clip(asked.content.trim(), SAID_MAX), files.length > 0 ? `[attached: ${files.join(', ')}]` : ''].filter(Boolean).join('\n')
  if (!said) return undefined
  const answered = messages.find((message) => message.role === 'assistant' && message.content.trim() !== '')
  const answer = answered?.role === 'assistant' ? clip(answered.content.trim(), ANSWER_MAX) : ''
  return [`<user>\n${said}\n</user>`, answer ? `<assistant>\n${answer}\n</assistant>` : '', 'Write the title of this conversation now.'].filter(Boolean).join('\n\n')
}

/** Marks a model may put around a title though it was told not to: each pair is taken off as a pair, and nothing else is. */
const WRAPS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['【', '】'],
  ['**', '**'],
  ['*', '*'],
  ['`', '`']
]

/**
 * The title in what a model wrote, or undefined where it wrote none that can stand in the list:
 * nothing, or more than a title. Thinking written into the answer is left out, the first line
 * that says something is taken, and what was put around it is taken off: a label, quotation
 * marks, Markdown, the full stop of a sentence.
 */
export function cleanTitle(written: string): string | undefined {
  // Thinking that came in the answer itself, as some models served on one's own computer write it.
  const answer = written.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '')
  let title =
    answer
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  /** Without what ends a sentence: a title is none. Taken off outside the marks around a title and inside them. */
  const unended = (text: string): string => text.replace(/[\s。．.!！?？,，;；:：、]+$/u, '').trim()
  title = unended(title.replace(/^#+\s*/, '').replace(/^(?:title|标题|標題|タイトル|제목)\s*[:：]\s*/i, ''))
  for (let again = true; again; ) {
    again = false
    for (const [open, close] of WRAPS) {
      if (title.length <= open.length + close.length || !title.startsWith(open) || !title.endsWith(close)) continue
      const inside = title.slice(open.length, title.length - close.length)
      // `"A" and "B"` is not one thing in quotation marks.
      if (inside.includes(open) || inside.includes(close)) continue
      title = unended(inside)
      again = true
    }
  }
  title = title.replace(/\s+/g, ' ').trim()
  // A name has at least a letter or a digit in it: marks alone, the empty pair of quotation marks of a model that had nothing to say, name nothing.
  if (!/[\p{L}\p{N}]/u.test(title)) return undefined
  // Counted in characters as a person sees them, so that a name in Chinese is not held to half the length.
  return [...title].length <= TITLE_MAX ? title : undefined
}

/**
 * How hard the model is asked to think about a title: as little as its service lets it, since a
 * title needs no thinking and nobody should wait or pay for some. Where the person chose no level
 * for the model, none is sent here either; and a level is only changed for another of the scale
 * the service is known by, so that nothing is sent that the model in use was not sent before.
 * "Minimal" is passed over: not every model of the service that has it knows it.
 */
export function titleEffort(connection: Pick<Connection, 'baseURL' | 'kind' | 'reasoningEffort'>): ReasoningEffort {
  const { reasoningEffort } = connection
  if (reasoningEffort === 'default') return reasoningEffort
  const scale: readonly ReasoningEffort[] = usualEfforts(connection.baseURL, connection.kind)
  const chosen = scale.indexOf(reasoningEffort)
  if (chosen < 0) return reasoningEffort
  const least = scale.findIndex((level) => level !== 'minimal')
  // Never more than the person chose: someone on "Minimal" stays there.
  return least < 0 || chosen <= least ? reasoningEffort : scale[least]
}
