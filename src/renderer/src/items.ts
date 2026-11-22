// The transcript as the UI shows it, built either from a stored session or
// incrementally from streamed agent events.

import type { AgentEvent, CompactionMark, ErrorHint, StoredMessage, ToolCall } from '../../shared/types.ts'

export type Item =
  /** `skill` is the name of a skill the user picked for the message. */
  | { kind: 'user'; text: string; skill?: string }
  /** `open` is true while the model is still streaming into this message. */
  | { kind: 'assistant'; reasoning: string; text: string; open: boolean }
  /** `cleared`: the result is no longer sent to the model, to make room in its context. It is still shown. */
  | { kind: 'tool'; call: ToolCall; output?: string; cleared?: boolean }
  /** `hint` marks errors that are shown with a way out instead of as plain text. */
  | { kind: 'error'; message: string; hint?: ErrorHint }
  /** Something worth knowing that did not stop the turn. */
  | { kind: 'notice'; text: string }
  /** A place where the conversation was compacted: a line across it, which says what was done there. */
  | { kind: 'mark'; mark: CompactionMark }

/** What the notices say, by the code they come with. */
const NOTICES: Record<Extract<AgentEvent, { type: 'notice' }>['code'], string> = {
  'fast-mode-refused': '这个模型在当前账户下不支持 Fast Mode，已经自动关闭，这条消息按普通速度发送。',
  'tools-as-text': '这个模型服务不接受工具定义，所以改用文字方式调用工具：工具的说明写进了提示词，模型在回答里写出的调用由应用识别并执行。没有学过工具调用的模型可能用不好。',
  'stream-refused': '这个模型服务在使用工具时不能边生成边显示，所以每次回答会在生成完之后一次出现。中间一段时间没有动静是正常的。',
  'compaction-failed': '上下文快满了，但没能让模型把较早的对话写成摘要，对话按现在的样子继续。'
}

export function itemsFromMessages(messages: readonly StoredMessage[]): Item[] {
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
    } else if (message.role === 'compaction') {
      items.push({ kind: 'mark', mark: message })
    } else {
      const index = items.findLastIndex((i) => i.kind === 'tool' && i.call.id === message.tool_call_id)
      const item = items[index]
      if (item?.kind === 'tool') items[index] = { ...item, output: message.content, ...(message.cleared !== undefined ? { cleared: true } : {}) }
    }
  }
  return items
}

/**
 * Where what the model is still sent begins: the place of the last summary. Everything above it
 * is shown, and no longer sent. -1 when nothing was summed up.
 */
export function lastSummaryAt(items: readonly Item[]): number {
  return items.findLastIndex((item) => item.kind === 'mark' && item.mark.summary !== undefined)
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
    case 'assistant_rewrite': {
      // The message being written, as it reads now, in place of what was shown of it: what was
      // taken for the answer was thinking, or held a tool call that is now a call. A message of
      // which nothing is left is not shown at all.
      const last = items.at(-1)
      const rest = last?.kind === 'assistant' && last.open ? items.slice(0, -1) : items
      return event.text || event.reasoning ? [...rest, { kind: 'assistant', reasoning: event.reasoning, text: event.text, open: true }] : rest
    }
    case 'assistant_done':
    case 'turn_end':
      return items.map((i) => (i.kind === 'assistant' && i.open ? { ...i, open: false } : i))
    case 'tool_start':
      return [...items, { kind: 'tool', call: event.call }]
    case 'tool_result':
      return items.map((i) => (i.kind === 'tool' && i.call.id === event.id ? { ...i, output: event.output } : i))
    case 'compacted':
      // The conversation as it is kept now, with the mark in its place and the cleared results
      // told as such. What the page showed beyond the conversation itself (a notice, an error, the
      // beginning of a reply that was given up) is not part of it.
      return itemsFromMessages(event.messages)
    case 'compaction_counted':
      // The service's count of what the compaction left, in place of the guess on its line.
      return items.map((i) => {
        if (i.kind !== 'mark' || i.mark.at !== event.at) return i
        const { rough: _guess, ...mark } = i.mark
        return { kind: 'mark', mark: { ...mark, after: event.after } }
      })
    case 'error':
      return [...items, { kind: 'error', message: event.message, ...(event.hint ? { hint: event.hint } : {}) }]
    case 'notice': {
      const text = NOTICES[event.code] ?? event.message
      return [...items, { kind: 'notice', text: event.detail ? `${text}（服务返回：${event.detail}）` : text }]
    }
    default:
      return items
  }
}
