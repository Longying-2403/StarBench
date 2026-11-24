// The rail of a conversation's turns: what each tick stands for, and how the ticks are laid out
// and drawn (src/renderer/src/turns.ts).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Item } from '../src/renderer/src/items.ts'
import { RAIL, nearness, plainExcerpt, railLayout, tickLength, turnMarks } from '../src/renderer/src/turns.ts'

test('a turn is a message of the person, told by what they wrote and by how the answer to it begins', () => {
  const call = { id: 'c1', name: 'read_file', arguments: '{}' }
  const items: Item[] = [
    { kind: 'user', text: 'first question\n  on two lines' },
    { kind: 'assistant', reasoning: '', text: 'Let me look.', open: false },
    { kind: 'tool', call, output: 'x' },
    { kind: 'assistant', reasoning: 'thinking', text: '## Answer\n\n**Done** with [the docs](https://x.example) and `code`.\n\n```bash\nnpm i\n```\nAfter.', open: false },
    { kind: 'user', text: '', skill: 'commit-message' },
    { kind: 'error', message: 'no answer came' },
    { kind: 'user', text: '   ', attachments: [{ kind: 'text', name: 'a.txt', text: '' }] },
    { kind: 'assistant', reasoning: '', text: 'Still wri', open: true }
  ]
  assert.deepEqual(turnMarks(items), [
    // The last thing the model wrote in the turn is its answer.
    { at: 0, title: 'first question on two lines', excerpt: 'Answer Done with the docs and code. After.' },
    { at: 4, title: 'Skill · commit-message', excerpt: '' },
    { at: 6, title: 'a.txt', excerpt: 'Still wri' }
  ])
  // What the model wrote before the person said anything belongs to no turn.
  assert.deepEqual(turnMarks([{ kind: 'assistant', reasoning: '', text: 'hello', open: false }]), [])
})

test('the beginning of an answer is plain words: no marks, a link by its words, no code that is set apart', () => {
  assert.equal(plainExcerpt('# Title\n\n> quoted\n\n- one\n- two\n1. three\n'), 'Title quoted one two three')
  assert.equal(plainExcerpt('See ![a chart](out/chart.png) and [the page](<https://x.example/a b>).'), 'See a chart and the page.')
  assert.equal(plainExcerpt('| a | b |\n|---|:-:|\n| 1 | 2 |'), 'a b 1 2')
  assert.equal(plainExcerpt('keeps tool_call and snake_case names'), 'keeps tool_call and snake_case names')
  // Code still being written, whose fence is not closed yet, is left out as well.
  assert.equal(plainExcerpt('Run this:\n\n```bash\nnpm run dev'), 'Run this:')
  const long = plainExcerpt('word '.repeat(200), 50)
  assert.equal(long.length, 50)
  assert.equal(long.endsWith('…'), true)
})

test('the ticks stand apart where there is room, closer in a long conversation, and around the turn in view where not all fit', () => {
  const space = 500 - 2 * RAIL.margin
  assert.deepEqual(railLayout(14, 500, 13), { pitch: RAIL.pitch, first: 0, shown: 14 })
  const closer = railLayout(60, 500, 0)
  assert.equal(closer.shown, 60)
  assert.ok(Math.abs(closer.pitch - space / 60) < 1e-9)
  assert.ok(closer.pitch < RAIL.pitch && closer.pitch > RAIL.least)

  const fits = Math.floor(space / RAIL.least)
  assert.deepEqual(railLayout(200, 500, 199), { pitch: RAIL.least, first: 200 - fits, shown: fits })
  assert.deepEqual(railLayout(200, 500, 0), { pitch: RAIL.least, first: 0, shown: fits })
  assert.deepEqual(railLayout(200, 500, 100), { pitch: RAIL.least, first: 100 - Math.floor(fits / 2), shown: fits })

  // No room, or nothing to show.
  assert.equal(railLayout(5, 40, 0).shown, 0)
  assert.equal(railLayout(0, 500, 0).shown, 0)
})

test('the tick of the turn in view stands out until the pointer is on the rail; then the one under the pointer does, and those around it fall off gently', () => {
  assert.equal(tickLength(100, null, true), RAIL.current)
  assert.equal(tickLength(100, null, false), RAIL.short)

  // With the pointer on the rail the turn in view is a tick like any other.
  assert.equal(tickLength(100, 100, false), RAIL.long)
  assert.equal(tickLength(300, 100, true), tickLength(300, 100, false))
  assert.ok(tickLength(300, 100, true) - RAIL.short < 0.01)

  // Shorter the further away, the same on either side, and never shorter than a tick is.
  const lengths = [0, 1, 2, 3, 4, 5, 6].map((n) => tickLength(100 + n * RAIL.pitch, 100, false))
  for (let n = 1; n < lengths.length; n++) assert.ok(lengths[n] < lengths[n - 1], `tick ${n}`)
  assert.equal(tickLength(100 - 2 * RAIL.pitch, 100, false), lengths[2])
  assert.ok(lengths.every((length) => length >= RAIL.short && length <= RAIL.long))
  // Gently: the neighbour keeps most of the length, and it is some ticks before the fall is over.
  assert.ok(lengths[1] > RAIL.short + 0.8 * (RAIL.long - RAIL.short))
  assert.ok(lengths[4] < RAIL.short + 0.1 * (RAIL.long - RAIL.short))
  assert.ok(Math.abs(nearness(0, RAIL.spread) - Math.exp(-0.5)) < 1e-12)
})
