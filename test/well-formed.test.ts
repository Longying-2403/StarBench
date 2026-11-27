// Text that is whole (shared/well-formed.ts): cut between characters, and with no half of a
// character left standing alone in what goes to a model service.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cutAt, isWhole, whole, wholeText } from '../src/shared/well-formed.ts'

// The two halves of one emoji (U+1F389), written by their numbers: a half alone cannot be written into a file.
const FIRST = String.fromCharCode(0xd83c)
const SECOND = String.fromCharCode(0xdf89)
const EMOJI = FIRST + SECOND
const MARK = String.fromCharCode(0xfffd)

test('a text is cut between characters, never inside one', () => {
  const text = `ab${EMOJI}cd`
  // No longer than asked for: the text itself.
  assert.equal(cutAt(text, 6), text)
  assert.equal(cutAt(text, 100), text)
  assert.equal(cutAt('', 0), '')
  // Where the cut would fall inside the emoji, the emoji is left out whole.
  assert.equal(cutAt(text, 3), 'ab')
  assert.equal(cutAt(text, 4), `ab${EMOJI}`)
  assert.equal(cutAt(text, 5), `ab${EMOJI}c`)
  assert.equal(cutAt(text, 2), 'ab')
  assert.equal(cutAt(EMOJI.repeat(3), 5), EMOJI.repeat(2))
  // Nothing fits where less than a character is asked for.
  assert.equal(cutAt(EMOJI, 1), '')
  assert.equal(cutAt(text, 0), '')
  assert.equal(cutAt(text, -4), '')
  // Characters of one unit are counted as before.
  assert.equal(cutAt('一二三四五', 3), '一二三')
  for (let max = 0; max <= text.length + 1; max++) {
    const cut = cutAt(text, max)
    assert.ok(cut.length <= max && isWhole(cut) && text.startsWith(cut), String(max))
  }
  // A half that stood alone before the cut is not the cut's doing, and stays.
  assert.equal(cutAt(`a${FIRST}bcd`, 3), `a${FIRST}b`)
})

test('half a character that stands alone is told, and replaced by the mark for what cannot be read', () => {
  for (const sound of ['', 'plain', `一${EMOJI}二`, EMOJI.repeat(4), MARK]) {
    assert.equal(isWhole(sound), true, sound)
    assert.equal(whole(sound), sound)
  }
  const broken: [string, string][] = [
    [`title ${FIRST}`, `title ${MARK}`],
    [`${SECOND} rest`, `${MARK} rest`],
    [`a${FIRST}b`, `a${MARK}b`],
    // The halves the wrong way round are two halves, each alone.
    [`${SECOND}${FIRST}`, `${MARK}${MARK}`],
    // A half before a whole character, and one after it.
    [`${FIRST}${EMOJI}`, `${MARK}${EMOJI}`],
    [`${EMOJI}${SECOND}`, `${EMOJI}${MARK}`],
    [`${FIRST}${FIRST}${SECOND}${SECOND}`, `${MARK}${EMOJI}${MARK}`]
  ]
  for (const [text, made] of broken) {
    assert.equal(isWhole(text), false, JSON.stringify(text))
    assert.equal(whole(text), made, JSON.stringify(text))
    assert.equal(isWhole(whole(text)), true)
  }
  // Asked twice in a row, the answer is the same: nothing is remembered between two texts.
  assert.equal(isWhole(`x${FIRST}`), false)
  assert.equal(isWhole(`x${FIRST}`), false)
  assert.equal(isWhole('x'), true)
})

test('everything that is sent as JSON is made whole, however deep, and what was whole is handed back as it is', () => {
  const fine = { role: 'tool', content: `ok ${EMOJI}`, list: [1, null, true, { deep: ['x'] }] }
  assert.equal(wholeText(fine), fine)
  const messages = [fine, { role: 'user', content: 'hello' }]
  assert.equal(wholeText(messages), messages)
  for (const value of [null, undefined, 3, true, 'text']) assert.equal(wholeText(value), value)

  const cut = { role: 'tool', tool_call_id: 'c1', content: `1a2b3c4 a title that ends in ${FIRST}` }
  const held = [fine, cut, { role: 'assistant', content: '', tool_calls: [{ id: 'c2', name: 'search', arguments: `{"pattern":"${SECOND}"}` }], origin: { replay: { parts: [`${FIRST}`] } } }]
  const made = wholeText(held)
  assert.notEqual(made, held)
  // What was whole in it is the very same thing; the rest is a copy, and what was handed in is as it was.
  assert.equal(made[0], fine)
  assert.deepEqual(made[1], { role: 'tool', tool_call_id: 'c1', content: `1a2b3c4 a title that ends in ${MARK}` })
  assert.deepEqual(made[2], { role: 'assistant', content: '', tool_calls: [{ id: 'c2', name: 'search', arguments: `{"pattern":"${MARK}"}` }], origin: { replay: { parts: [MARK] } } })
  assert.equal(cut.content.endsWith(FIRST), true)

  // Written out, a half character is an escape that stands for none: that is what services turn down.
  assert.match(JSON.stringify(held), /\\ud83c(?!\\udf89)/)
  assert.doesNotMatch(JSON.stringify(made), /\\ud[89ab][0-9a-f]{2}/i)
  assert.deepEqual(JSON.parse(JSON.stringify(made)), made)

  // The names in an object are text as well.
  assert.deepEqual(wholeText({ [`k${FIRST}`]: 1, plain: `v${SECOND}` }), { [`k${MARK}`]: 1, plain: `v${MARK}` })
  // Only what JSON is made of is gone into: anything else is handed back untouched.
  const bytes = new Uint8Array([1, 2, 3])
  const when = new Date(0)
  const other = { bytes, when }
  assert.equal(wholeText(other), other)
  assert.equal(wholeText({ bytes, text: FIRST }).bytes, bytes)
})
