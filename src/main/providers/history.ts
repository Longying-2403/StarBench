// Reading the stored conversation, shared by every provider's request builder.

import { fileBlock, goneImageNote, imageNote } from '../../shared/attachments.ts'
import { VIEW_ONLY_RESULT } from '../../shared/permissions.ts'
import type { ChatMessage, WebActivity } from '../../shared/types.ts'
import type { AssistantMessage, Connection } from './types.ts'

/** The most pages of one search that are named in a note of it. */
const NOTE_SOURCES = 8
/** How long a title or an address may be in a note, in characters. */
const NOTE_TITLE_MAX = 120
const NOTE_URL_MAX = 300

/**
 * A title of a page, or a query, as it goes into a note. The note stands among the model's own
 * words, where it is believed more than what a tool brought, and a page's author writes its title:
 * so it stays on one line, closes no bracket of the note, carries no characters that do not show
 * (some models read text written in invisible tag characters), and is not long.
 */
function noteText(text: string, max: number): string {
  const flat = text
    .replace(/\p{Cf}/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .replace(/[[\]<>"]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** An address as it goes into a note: what would end a line or the note, or not show, escaped as an address escapes it. */
function noteUrl(url: string): string {
  const safe = url.replace(/[\s<>[\]"\p{Cc}\p{Cf}]/gu, encodeURIComponent)
  return safe.length > NOTE_URL_MAX ? `${safe.slice(0, NOTE_URL_MAX - 1)}…` : safe
}

/**
 * What one web search or page read of a reply's own is told as, where it cannot go back in the
 * service's own form: to another service, or to a request without the search tool. Without a
 * word of it, a model that saw its earlier answer cite pages it had not visibly looked at took
 * the answer back as made up (Claude, tried 2026-11-23).
 */
export function searchNote(activity: WebActivity): string {
  // Told only by the pages' titles, the model went on to doubt what it had read in them: what it
  // read is not here, and the note says so (tried with Claude, 2026-11-23).
  if (activity.kind === 'open') {
    const page = noteUrl(activity.url ?? '')
    return activity.status === 'failed'
      ? `[Earlier you tried to read the page ${page}, and it failed.]`
      : `[Earlier you read the page ${page}; its content is not repeated here.]`
  }
  const asked = (activity.queries ?? []).map((q) => `"${noteText(q, NOTE_TITLE_MAX)}"`).join(', ')
  const what = `Earlier you searched the web${asked ? ` for ${asked}` : ''}`
  if (activity.status === 'failed') return `[${what}, and the search failed.]`
  const found = (activity.sources ?? [])
    .slice(0, NOTE_SOURCES)
    .map((s) => {
      const title = s.title ? noteText(s.title, NOTE_TITLE_MAX) : ''
      return title ? `${title} <${noteUrl(s.url)}>` : `<${noteUrl(s.url)}>`
    })
    .join('; ')
  return `[${what} and read the results; they are not repeated here.${found ? ` Pages found: ${found}` : ''}]`
}

/** A reply's text with its web searches told in front of it (`searchNote`), as text that goes anywhere. */
export function withSearchNote(message: AssistantMessage): string {
  const note = (message.web ?? []).map(searchNote).join('\n')
  if (!note) return message.content
  return message.content ? `${note}\n\n${message.content}` : note
}

/** What stands in for the result of a tool call that never got one. */
export const INTERRUPTED = 'Error: this tool call was interrupted before it produced a result.'

/**
 * What the model reads of a user message. A picked skill's text goes in front of what was typed,
 * and in front of both the text files the person attached, each under its name. Pictures are not
 * text and go their own way (`userImages` in attachments.ts), except to a model that takes none
 * (`Connection.noImages`): that one is told here that there was a picture it cannot see.
 */
export function userText(message: Extract<ChatMessage, { role: 'user' }>, connection?: Pick<Connection, 'noImages'>): string {
  const typed = message.skill ? `${message.skill.prompt}\n\n${message.content}` : message.content
  const files = (message.attachments ?? []).flatMap((file) =>
    file.kind === 'text' ? [fileBlock(file)] : file.data === '' ? [goneImageNote(file)] : connection?.noImages ? [imageNote(file)] : []
  )
  if (files.length === 0) return typed
  return typed ? `${files.join('\n\n')}\n\n${typed}` : files.join('\n\n')
}

/** Whether a stored tool result reports a failure, for the services that want failures marked. */
export function isErrorResult(result: string): boolean {
  return result.startsWith('Error:') || result === 'The user denied this tool call.' || result === 'Cancelled by user' || result === VIEW_ONLY_RESULT
}

/**
 * Returns the conversation with exactly one result after each tool call, in the order of the calls.
 * Every service rejects a request in which a call has no result, and a session saved while a tool
 * was still running (the app was closed, or crashed) is left that way. Results that belong to no
 * call are dropped for the same reason.
 */
export function withToolResults(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === 'tool') continue
    out.push(message)
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue

    const results = new Map<string, string>()
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]
      if (next.role !== 'tool') break
      if (!results.has(next.tool_call_id)) results.set(next.tool_call_id, next.content)
    }
    for (const call of message.tool_calls) {
      out.push({ role: 'tool', tool_call_id: call.id, content: results.get(call.id) ?? INTERRUPTED })
    }
  }
  return out
}

/**
 * What a provider stored on one of its own messages to continue from it exactly. Undefined for a
 * message another provider wrote; with `sameModel`, also for one this provider wrote with another model.
 */
export function replayOf(message: AssistantMessage, connection: Connection, sameModel = false): unknown {
  const origin = message.origin
  if (!origin || origin.replay === undefined) return undefined
  if (origin.provider !== connection.provider || origin.kind !== connection.kind) return undefined
  if (sameModel && origin.model !== connection.model) return undefined
  return origin.replay
}

/**
 * Whether a reply's thinking goes back to its service when the reply does. Thinking that came
 * inside the answer does not: no field carries it (`thinkingField` in chat.ts), and the models
 * that write it there do not expect to see old thinking again. Everything else goes back, in the
 * form its service gave it, or is kept by the service itself.
 */
export function thinkingReturns(message: AssistantMessage): boolean {
  const replay = message.origin?.replay
  return !(typeof replay === 'object' && replay !== null && (replay as { thinking?: unknown }).thinking === 'inline')
}

/** The empty message a reply is collected into. */
export function newReply(connection: Connection): AssistantMessage {
  return {
    role: 'assistant',
    content: '',
    origin: { provider: connection.provider, kind: connection.kind, model: connection.model }
  }
}
