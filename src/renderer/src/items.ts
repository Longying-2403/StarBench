// The transcript as the UI shows it, built either from a stored session or
// incrementally from streamed agent events.

import type { Attachment } from '../../shared/attachments.ts'
import type { AgentEvent, CompactionMark, ErrorHint, StoredMessage, ToolCall, WebActivity } from '../../shared/types.ts'

export type Item =
  /**
   * `skill` is the name of a skill the user picked for the message; `attachments` are the files put with it; `at` is when it was sent;
   * `plain` says it went out as a plain chat, with no tools and nothing of the app's beside it.
   */
  | { kind: 'user'; text: string; skill?: string; attachments?: Attachment[]; at?: number; plain?: true }
  /** `open` is true while the model is still streaming into this message; `at` is when it had finished. */
  | { kind: 'assistant'; reasoning: string; text: string; open: boolean; at?: number }
  /**
   * `cleared`: the result is no longer sent to the model, to make room in its context. It is still shown.
   * `at` is when the model had finished the reply the call was made in: a reply that is calls and no words leaves no other trace of it.
   */
  | { kind: 'tool'; call: ToolCall; output?: string; cleared?: boolean; at?: number }
  /** A web search or page read that the model's service did by itself, with its own search tool. */
  | { kind: 'web'; activity: WebActivity }
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
  'compaction-failed': '上下文快满了，但没能让模型把较早的对话写成摘要，对话按现在的样子继续。',
  'images-refused': '这个模型不能看图片，所以图片没有发给它，只告诉了它图片的文件名。换成能看图的模型后，这个对话里的图片会照常发送。',
  'plain-call-dropped': '这条消息是以纯对话发出的，没有给模型任何工具，但它的回应里仍然带了工具调用。纯对话不执行工具调用，这次调用已经丢弃。'
}

/** A moment, as a part of an item that is only there when the moment is known. */
const timed = (at: number | undefined): { at?: number } => (at !== undefined ? { at } : {})

export function itemsFromMessages(messages: readonly StoredMessage[]): Item[] {
  const items: Item[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      items.push({
        kind: 'user',
        text: message.content,
        skill: message.skill?.name,
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        ...timed(message.at),
        ...(message.plain ? { plain: true as const } : {})
      })
    } else if (message.role === 'assistant') {
      // The service's own searches stand above what it wrote with them, as they did while it wrote.
      for (const activity of message.web ?? []) items.push({ kind: 'web', activity })
      if (message.content || message.reasoning_content) {
        items.push({
          kind: 'assistant',
          reasoning: message.reasoning_content ?? '',
          text: message.content,
          open: false,
          ...timed(message.at)
        })
      }
      for (const call of message.tool_calls ?? []) items.push({ kind: 'tool', call, ...timed(message.at) })
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

/**
 * Where the model's part of each turn that is over ends, and when: the place of the last thing it
 * wrote in the turn (an answer, or a call), and the moment it had finished it. What may stand
 * after that in the turn (an error, a notice, the line of a compaction) is not of the model, so
 * the time goes above it. A turn is what follows a message of the person, up to their next one.
 * The turn that is still under way (`running`) has no end yet, and a turn in which the model wrote
 * nothing, or of which no time was kept, is not in here.
 */
export function turnEnds(items: readonly Item[], running: boolean): Map<number, number> {
  const ends = new Map<number, number>()
  let last = -1
  let finished = 0
  const close = (): void => {
    if (last >= 0) ends.set(last, finished)
    last = -1
    finished = 0
  }
  items.forEach((item, index) => {
    if (item.kind === 'user') close()
    else if ((item.kind === 'assistant' || item.kind === 'tool') && item.at !== undefined) {
      last = index
      finished = Math.max(finished, item.at)
    }
  })
  if (!running) close()
  return ends
}

/** `at` is the time by the clock of the page, for what the action brings about: a message sent, a reply finished. */
export type ItemsAction =
  | { type: 'reset'; items: Item[] }
  | { type: 'user'; text: string; skill?: string; attachments?: Attachment[]; at?: number }
  /** The message that was sent at `at` went out as a plain chat, which the main process says once it has taken the message. */
  | { type: 'plain'; at: number }
  | { type: 'event'; event: AgentEvent; at?: number }

function appendDelta(items: Item[], field: 'reasoning' | 'text', text: string): Item[] {
  const last = items.at(-1)
  if (last?.kind === 'assistant' && last.open) {
    return [...items.slice(0, -1), { ...last, [field]: last[field] + text }]
  }
  return [...items, { kind: 'assistant', reasoning: '', text: '', open: true, [field]: text }]
}

export function itemsReducer(items: Item[], action: ItemsAction): Item[] {
  if (action.type === 'reset') return action.items
  if (action.type === 'user') {
    return [...items, { kind: 'user', text: action.text, skill: action.skill, ...(action.attachments?.length ? { attachments: action.attachments } : {}), ...timed(action.at) }]
  }
  if (action.type === 'plain') {
    // The message it was said of, wherever the reply to it has got to meanwhile: told by the
    // moment it was sent, so that a page which shows another conversation by now marks nothing.
    const at = items.findLastIndex((item) => item.kind === 'user' && item.at === action.at)
    return at < 0 ? items : items.map((item, index) => (index === at && item.kind === 'user' ? { ...item, plain: true as const } : item))
  }

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
      // What was being written is finished, and that is when it was.
      return items.map((i) => (i.kind === 'assistant' && i.open ? { ...i, open: false, ...timed(action.at) } : i))
    case 'tool_start':
      return [...items, { kind: 'tool', call: event.call, ...timed(action.at) }]
    case 'tool_result':
      return items.map((i) => (i.kind === 'tool' && i.call.id === event.id ? { ...i, output: event.output } : i))
    case 'web_activity': {
      const item: Item = { kind: 'web', activity: event.activity }
      // Told again as it goes on: the row it has already is brought up to date.
      if (items.some((i) => i.kind === 'web' && i.activity.id === event.activity.id)) {
        return items.map((i) => (i.kind === 'web' && i.activity.id === event.activity.id ? item : i))
      }
      // A new one goes above the reply being written, where it stands once the reply is kept.
      const last = items.at(-1)
      return last?.kind === 'assistant' && last.open ? [...items.slice(0, -1), item, last] : [...items, item]
    }
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
