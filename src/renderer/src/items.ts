// The transcript as the UI shows it, built either from a stored session or
// incrementally from streamed agent events.

import type { AgentEvent, ChatMessage, ErrorHint, ToolCall } from '../../shared/types.ts'

export type Item =
  /** `skill` is the name of a skill the user picked for the message. */
  | { kind: 'user'; text: string; skill?: string }
  /** `open` is true while the model is still streaming into this message. */
  | { kind: 'assistant'; reasoning: string; text: string; open: boolean }
  | { kind: 'tool'; call: ToolCall; output?: string }
  /** `hint` marks errors that are shown with a way out instead of as plain text. */
  | { kind: 'error'; message: string; hint?: ErrorHint }
  /** Something worth knowing that did not stop the turn. */
  | { kind: 'notice'; text: string }

/** What the notices say, by the code they come with. */
const NOTICES: Record<Extract<AgentEvent, { type: 'notice' }>['code'], string> = {
  'fast-mode-refused': '这个模型在当前账户下不支持 Fast Mode，已经自动关闭，这条消息按普通速度发送。'
}

export function itemsFromMessages(messages: ChatMessage[]): Item[] {
  const items: Item[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      items.push({ kind: 'user', text: message.content, skill: message.skill?.name })
    } else if (message.role === 'assistant') {
      if (message.content || message.reasoning_content) {
        items.push({
          kind: 'assistant',
          reasoning: message.reasoning_content ?? '',
          text: message.content,
          open: false
        })
      }
      for (const call of message.tool_calls ?? []) items.push({ kind: 'tool', call })
    } else {
      const index = items.findLastIndex((i) => i.kind === 'tool' && i.call.id === message.tool_call_id)
      const item = items[index]
      if (item?.kind === 'tool') items[index] = { ...item, output: message.content }
    }
  }
  return items
}

export type ItemsAction =
  | { type: 'reset'; items: Item[] }
  | { type: 'user'; text: string; skill?: string }
  | { type: 'event'; event: AgentEvent }

function appendDelta(items: Item[], field: 'reasoning' | 'text', text: string): Item[] {
  const last = items.at(-1)
  if (last?.kind === 'assistant' && last.open) {
    return [...items.slice(0, -1), { ...last, [field]: last[field] + text }]
  }
  return [...items, { kind: 'assistant', reasoning: '', text: '', open: true, [field]: text }]
}

export function itemsReducer(items: Item[], action: ItemsAction): Item[] {
  if (action.type === 'reset') return action.items
  if (action.type === 'user') return [...items, { kind: 'user', text: action.text, skill: action.skill }]

  const { event } = action
  switch (event.type) {
    case 'reasoning_delta':
      return appendDelta(items, 'reasoning', event.text)
    case 'text_delta':
      return appendDelta(items, 'text', event.text)
    case 'assistant_done':
    case 'turn_end':
      return items.map((i) => (i.kind === 'assistant' && i.open ? { ...i, open: false } : i))
    case 'tool_start':
      return [...items, { kind: 'tool', call: event.call }]
    case 'tool_result':
      return items.map((i) => (i.kind === 'tool' && i.call.id === event.id ? { ...i, output: event.output } : i))
    case 'error':
      return [...items, { kind: 'error', message: event.message, ...(event.hint ? { hint: event.hint } : {}) }]
    case 'notice':
      return [...items, { kind: 'notice', text: NOTICES[event.code] ?? event.message }]
    default:
      return items
  }
}
