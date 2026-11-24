// The times the conversation shows: under each message of the person when it was sent, and
// under the last thing of each turn when the model had finished. Kept with the messages, built
// into what the page shows, and never sent to a service.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { anthropicParams } from '../src/main/providers/anthropic.ts'
import { chatMessages } from '../src/main/providers/chat.ts'
import { geminiContents } from '../src/main/providers/gemini.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { responsesInput } from '../src/main/providers/responses.ts'
import { itemsFromMessages, itemsReducer, turnEnds } from '../src/renderer/src/items.ts'
import type { Item, ItemsAction } from '../src/renderer/src/items.ts'
import type { StoredMessage } from '../src/shared/types.ts'

const stored: StoredMessage[] = [
  { role: 'user', content: '看一下 notes.txt', at: 1000 },
  // A reply that is a call and no words: its time is all that is left of it on the page.
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"notes.txt"}' }], at: 2000 },
  { role: 'tool', tool_call_id: 'c1', content: 'a file to list' },
  { role: 'assistant', content: '里面只有一行。', at: 3000 },
  { role: 'user', content: '好', at: 4000 },
  // From before the app wrote the times down.
  { role: 'assistant', content: '还有别的要看吗？' }
]

test('a conversation that was kept says when each message was sent and when each turn was finished', () => {
  const items = itemsFromMessages(stored)
  assert.deepEqual(
    items.map((item) => [item.kind, 'at' in item ? item.at : undefined]),
    [
      ['user', 1000],
      ['tool', 2000],
      ['assistant', 3000],
      ['user', 4000],
      ['assistant', undefined]
    ]
  )
  // The first turn ends at its last item, with the time of the last thing the model wrote in it.
  // Of the second no time was kept, so nothing is said under it.
  assert.deepEqual([...turnEnds(items, false)], [[2, 3000]])
  assert.deepEqual([...turnEnds(items, true)], [[2, 3000]])
})

test('the turn that is under way has no end yet, and one in which the model wrote nothing has none at all', () => {
  const items: Item[] = [
    { kind: 'user', text: 'a', at: 10 },
    { kind: 'assistant', reasoning: '', text: 'first', open: false, at: 20 },
    { kind: 'user', text: 'b', at: 30 },
    { kind: 'error', message: 'the service is not there' },
    { kind: 'user', text: 'c', at: 40 },
    { kind: 'tool', call: { id: 'c1', name: 'run_command', arguments: '{}' }, at: 50 },
    { kind: 'notice', text: 'something worth knowing' },
    { kind: 'mark', mark: { role: 'compaction', at: 60, cleared: 1, before: 900, after: 300 } }
  ]
  // While it runs: only what is over. Once it is over: the last thing the model wrote in it, and
  // not what the app put after that.
  assert.deepEqual([...turnEnds(items, true)], [[1, 20]])
  assert.deepEqual(
    [...turnEnds(items, false)],
    [
      [1, 20],
      [5, 50]
    ]
  )
  assert.deepEqual([...turnEnds([], false)], [])

  // Of several things the model wrote in a turn, the place is that of the last and the time the latest.
  const two: Item[] = [
    { kind: 'user', text: 'a' },
    { kind: 'assistant', reasoning: '', text: 'looking', open: false, at: 70 },
    { kind: 'tool', call: { id: 'c2', name: 'list_dir', arguments: '{}' }, at: 70 },
    { kind: 'assistant', reasoning: '', text: 'done', open: false, at: 90 },
    { kind: 'error', message: 'and then the service went away' }
  ]
  assert.deepEqual([...turnEnds(two, false)], [[3, 90]])
})

test('as a turn goes by on the page, each thing in it is given the time it happened', () => {
  const steps: ItemsAction[] = [
    { type: 'user', text: '看一下 notes.txt', at: 100 },
    { type: 'event', event: { type: 'reasoning_delta', text: 'hm' }, at: 110 },
    { type: 'event', event: { type: 'assistant_done' }, at: 120 },
    { type: 'event', event: { type: 'tool_start', call: { id: 'c1', name: 'read_file', arguments: '{}' } }, at: 121 },
    { type: 'event', event: { type: 'tool_result', id: 'c1', output: 'a file to list' }, at: 130 },
    { type: 'event', event: { type: 'text_delta', text: '里面只有' }, at: 140 },
    { type: 'event', event: { type: 'text_delta', text: '一行。' }, at: 150 }
  ]
  let items: Item[] = []
  for (const step of steps) items = itemsReducer(items, step)
  assert.deepEqual(
    items.map((item) => [item.kind, 'at' in item ? item.at : undefined]),
    [
      ['user', 100],
      ['assistant', 120],
      ['tool', 121],
      // Still being written.
      ['assistant', undefined]
    ]
  )
  assert.deepEqual([...turnEnds(items, true)], [], 'nothing is said under a turn that is not over')

  items = itemsReducer(items, { type: 'event', event: { type: 'turn_end' }, at: 160 })
  assert.equal(items.at(-1)?.kind === 'assistant' && items.at(-1), items.at(-1))
  assert.deepEqual([...turnEnds(items, false)], [[3, 160]])

  // An action without a time, as from before, leaves the items without one.
  const untimed = itemsReducer([], { type: 'user', text: 'x' })
  assert.equal('at' in untimed[0], false)
})

test('the times of the messages are sent to no service', () => {
  const connection: Connection = { provider: 'test', kind: 'openai-chat', apiKey: 'k', baseURL: 'https://example.invalid/v1', model: 'm', reasoningEffort: 'default' }
  const messages = stored.filter((message): message is Exclude<StoredMessage, { role: 'compaction' }> => message.role !== 'compaction')
  const sent = {
    chat: chatMessages({ messages, connection, system: 's' }),
    responses: responsesInput({ messages, connection: { ...connection, kind: 'openai-responses' } }),
    gemini: geminiContents({ messages, connection: { ...connection, kind: 'gemini' } }),
    anthropic: anthropicParams({ messages, connection: { ...connection, kind: 'anthropic' }, system: 's', tools: [], signal: new AbortController().signal, onText: () => {}, onReasoning: () => {} }, null).messages
  }
  for (const [format, body] of Object.entries(sent)) {
    const text = JSON.stringify(body)
    assert.ok(text.includes('notes.txt'), `${format}: the messages are there`)
    assert.doesNotMatch(text, /"at":/, `${format}: without their times`)
  }
})

test('a message that went out as a plain chat says so: in a conversation that was kept, and as the page is told of it', () => {
  const kept: StoredMessage[] = [
    { role: 'user', content: '你好', at: 1000, plain: true },
    { role: 'assistant', content: '你好！', at: 2000 },
    { role: 'user', content: '看一下 notes.txt', at: 3000 }
  ]
  const items = itemsFromMessages(kept)
  assert.deepEqual(items[0], { kind: 'user', text: '你好', skill: undefined, at: 1000, plain: true })
  assert.equal('plain' in items[2], false, 'and one that went out with its tools does not')

  // On the page the message is shown at once, and marked when the main process has said how it
  // went out: the person's last message, wherever the reply to it has got to by then.
  let live = itemsReducer([], { type: 'user', text: 'a', at: 1 })
  live = itemsReducer(live, { type: 'event', event: { type: 'text_delta', text: 'hi' } })
  live = itemsReducer(live, { type: 'user', text: 'b', at: 2 })
  live = itemsReducer(live, { type: 'event', event: { type: 'text_delta', text: 'ho' } })
  live = itemsReducer(live, { type: 'plain', at: 2 })
  assert.deepEqual(
    live.map((item) => (item.kind === 'user' ? [item.text, item.plain] : item.kind)),
    [['a', undefined], 'assistant', ['b', true], 'assistant']
  )
  // It is said of one message, the one sent at that moment: a page that shows another conversation by then marks none of its own.
  assert.equal(itemsReducer(live, { type: 'plain', at: 3 }), live)
  assert.deepEqual(itemsReducer([], { type: 'plain', at: 2 }), [], 'with no message on the page there is nothing to mark')

  // A call the model made all the same is told to the person in their words.
  const told = itemsReducer([], { type: 'event', event: { type: 'notice', code: 'plain-call-dropped', message: 'The model tried to call a tool (x).' } })
  assert.match((told[0] as Extract<Item, { kind: 'notice' }>).text, /纯对话不执行工具调用/)

  // The mark is the app's own, like the times: a later turn with tools sends it to no service.
  const connection: Connection = { provider: 'test', kind: 'openai-chat', apiKey: 'k', baseURL: 'https://example.invalid/v1', model: 'm', reasoningEffort: 'default' }
  const messages = kept.filter((message): message is Exclude<StoredMessage, { role: 'compaction' }> => message.role !== 'compaction')
  const sent = {
    chat: chatMessages({ messages, connection, system: 's' }),
    responses: responsesInput({ messages, connection: { ...connection, kind: 'openai-responses' } }),
    gemini: geminiContents({ messages, connection: { ...connection, kind: 'gemini' } }),
    anthropic: anthropicParams({ messages, connection: { ...connection, kind: 'anthropic' }, system: 's', tools: [], signal: new AbortController().signal, onText: () => {}, onReasoning: () => {} }, null).messages
  }
  for (const [format, body] of Object.entries(sent)) {
    const text = JSON.stringify(body)
    assert.ok(text.includes('你好'), `${format}: the messages are there`)
    assert.doesNotMatch(text, /"plain"|"at":/, `${format}: without the mark, and without the times`)
  }
})
