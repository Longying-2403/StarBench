// Reading the stored conversation, shared by every provider's request builder.

import type { ChatMessage } from '../../shared/types.ts'
import type { AssistantMessage, Connection } from './types.ts'

/** What stands in for the result of a tool call that never got one. */
export const INTERRUPTED = 'Error: this tool call was interrupted before it produced a result.'

/** What the model sees of a user message: a picked skill's text goes in front of what was typed. */
export function userText(message: Extract<ChatMessage, { role: 'user' }>): string {
  return message.skill ? `${message.skill.prompt}\n\n${message.content}` : message.content
}

/** Whether a stored tool result reports a failure, for the services that want failures marked. */
export function isErrorResult(result: string): boolean {
  return result.startsWith('Error:') || result === 'The user denied this tool call.' || result === 'Cancelled by user'
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
