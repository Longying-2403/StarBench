// Several conversations at work at once: what the page holds of each, and where each event goes
// (src/renderer/src/views.ts).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Item } from '../src/renderer/src/items.ts'
import { EMPTY_VIEW, draftKey, isDraft, unseenIds, viewsReducer, workingIds } from '../src/renderer/src/views.ts'
import type { Views, ViewsAction } from '../src/renderer/src/views.ts'
import { emptyStats } from '../src/shared/stats.ts'
import type { AgentEvent } from '../src/shared/types.ts'

const run = (views: Views, ...actions: ViewsAction[]): Views => actions.reduce(viewsReducer, views)
const said = (key: string, event: AgentEvent, onPage: boolean): ViewsAction => ({ type: 'event', key, event, onPage })
const text = (key: string, words: string, onPage: boolean): ViewsAction => said(key, { type: 'text_delta', text: words }, onPage)
const kinds = (items: readonly Item[]): string[] => items.map((item) => (item.kind === 'assistant' ? `assistant:${item.text}` : item.kind === 'user' ? `user:${item.text}` : item.kind))
const user = (key: string, words: string): ViewsAction => ({ type: 'user', key, text: words, at: 1 })

test('two conversations at work at once each get their own events, on the page or off it', () => {
  const views = run(
    {},
    { type: 'opened', id: 'a', items: [], stats: null, running: false },
    { type: 'opened', id: 'b', items: [], stats: null, running: false },
    user('a', 'question for a'),
    // The person goes to the other conversation and sends there too: both are at work.
    user('b', 'question for b'),
    text('a', 'A1 ', false),
    text('b', 'B1 ', true),
    text('a', 'A2', false),
    said('b', { type: 'assistant_done' }, true),
    text('b', 'B2', true)
  )
  assert.deepEqual(kinds(views.a.items), ['user:question for a', 'assistant:A1 A2'])
  assert.deepEqual(kinds(views.b.items), ['user:question for b', 'assistant:B1 ', 'assistant:B2'])
  assert.deepEqual(workingIds(views).sort(), ['a', 'b'])
  assert.equal(views.a.partial, false, 'followed from the start of its turn: gone back to, it shows as the page has it')
})

test('a turn that ends on the page stays as it is; one that ends off it is kept as it ended and marked as not looked at yet', () => {
  const working = run({}, { type: 'opened', id: 'a', items: [], stats: null, running: false }, user('a', 'q'), text('a', 'answer', true))
  const stats = { ...emptyStats(), turns: 1 }

  const onPage = run(working, said('a', { type: 'stats', stats }, true), said('a', { type: 'turn_end' }, true))
  assert.equal(onPage.a.running, false)
  assert.equal(onPage.a.unseen, false)
  assert.deepEqual(kinds(onPage.a.items), ['user:q', 'assistant:answer'])
  assert.deepEqual(onPage.a.stats, stats)

  const offPage = run(working, said('a', { type: 'stats', stats }, false), said('a', { type: 'turn_end' }, false))
  // What the page followed of it is kept until it is looked at.
  assert.deepEqual(offPage.a, { ...EMPTY_VIEW, items: onPage.a.items, stats, unseen: true })
  assert.deepEqual(unseenIds(offPage), ['a'])

  // A turn that failed off the page keeps the line that says why: the conversation's file holds no such line.
  const failed = run(working, said('a', { type: 'error', message: 'the service refused the request' }, false), said('a', { type: 'turn_end' }, false))
  assert.deepEqual(kinds(failed.a.items), ['user:q', 'assistant:answer', 'error'])
  assert.deepEqual([failed.a.running, failed.a.unseen, failed.a.partial], [false, true, false])
  assert.deepEqual(kinds(run(failed, { type: 'seen', key: 'a' }).a.items), ['user:q', 'assistant:answer', 'error'], 'looked at, it shows as it ended')
  assert.deepEqual(workingIds(offPage), [])
  assert.deepEqual(unseenIds(run(offPage, { type: 'seen', key: 'a' })), [])
  // Opened again, it is as its file has it.
  assert.equal(run(offPage, { type: 'opened', id: 'a', items: [], stats, running: false }).a.unseen, false)
})

test('a new chat goes by a key of its own until the main process has given it an id', () => {
  const key = draftKey(3)
  assert.equal(isDraft(key), true)
  assert.equal(isDraft('3f1c'), false)
  const sending = run({}, { type: 'draft', key }, user(key, 'first message'))
  assert.equal(sending[key].running, true)
  assert.deepEqual(workingIds(sending), [], 'a chat without an id is not in the list of conversations')

  const bound = run(sending, { type: 'bound', key, id: 's1', onPage: true }, { type: 'plain', key: 's1', at: 1 }, text('s1', 'hello', true))
  assert.equal(key in bound, false)
  assert.deepEqual(kinds(bound.s1.items), ['user:first message', 'assistant:hello'])
  assert.equal(bound.s1.items[0].kind === 'user' && bound.s1.items[0].plain, true)
  assert.deepEqual(workingIds(bound), ['s1'])

  // What was heard of it before its id was known here follows what the page had of it.
  const early = run(sending, text('s1', 'early ', false), { type: 'bound', key, id: 's1', onPage: true }, text('s1', 'later', true))
  assert.deepEqual(kinds(early.s1.items), ['user:first message', 'assistant:early later'])
  assert.equal(early.s1.partial, false)
  // So is a notice that came before anything else of the turn, as one of a PDF too long for the model does.
  const told = run(sending, said('s1', { type: 'notice', code: 'document-too-long', message: 'too long' }, false), { type: 'bound', key, id: 's1', onPage: true }, text('s1', 'read in parts', true))
  assert.deepEqual(kinds(told.s1.items), ['user:first message', 'notice', 'assistant:read in parts'])

  // The person began another chat while the first was being sent: each keeps to its own key.
  const next = draftKey(4)
  const two = run(sending, { type: 'draft', key: next }, { type: 'bound', key, id: 's1', onPage: false }, text('s1', 'answer', false))
  assert.deepEqual(two[next], EMPTY_VIEW)
  assert.deepEqual(kinds(two.s1.items), ['user:first message', 'assistant:answer'])
})

test('a conversation the page holds nothing of is taken to be at work only by what a turn alone brings', () => {
  for (const event of [{ type: 'turn_end' }, { type: 'titled', title: 'A name' }, { type: 'compaction_counted', at: 1, after: 10 }, { type: 'error', message: 'late' }] as AgentEvent[]) {
    assert.deepEqual(run({}, said('x', event, false)), {}, event.type)
  }
  const heard = run({}, text('x', 'the end of an answer', false))
  assert.equal(heard.x.running, true)
  assert.equal(heard.x.partial, true, 'not followed from the start of its turn')
  assert.deepEqual(workingIds(heard), ['x'])
  assert.deepEqual(unseenIds(run(heard, said('x', { type: 'turn_end' }, false))), ['x'])

  // Read from its file while its turn runs, it is known to have gaps until the turn is over.
  const opened = run({}, { type: 'opened', id: 'x', items: [], stats: null, running: true })
  assert.deepEqual([opened.x.running, opened.x.partial], [true, true])
})

test('work that is no turn, a message that could not be sent, and a conversation the page lets go', () => {
  const idle = run({}, { type: 'opened', id: 'a', items: [], stats: null, running: false })
  const compacting = run(idle, { type: 'work', key: 'a', on: true }, said('a', { type: 'compacting', on: true }, true))
  assert.deepEqual([compacting.a.running, compacting.a.betweenTurns, compacting.a.compacting], [true, true, true])
  const done = run(compacting, { type: 'work', key: 'a', on: false })
  assert.deepEqual([done.a.running, done.a.betweenTurns, done.a.compacting], [false, false, false])

  const failed = run(idle, user('a', 'q'), { type: 'failed', key: 'a', message: 'no connection' })
  assert.equal(failed.a.running, false)
  assert.deepEqual(kinds(failed.a.items), ['user:q', 'error'])

  assert.deepEqual(run(idle, { type: 'dropped', key: 'a' }), {})
  assert.equal(run(idle, { type: 'dropped', key: 'nobody' }), idle)
  assert.equal(run(idle, { type: 'work', key: 'nobody', on: true }), idle)
})
