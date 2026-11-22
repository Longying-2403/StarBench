import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ThinkTags } from '../src/main/providers/think-tags.ts'
import type { Unopened } from '../src/main/providers/think-tags.ts'

/** Feeds the pieces through, as a stream would, and collects what came out on each side. */
function split(pieces: string[]): { reasoning: string; text: string; found: boolean } {
  const tags = new ThinkTags()
  let reasoning = ''
  let text = ''
  for (const part of [...pieces.map((piece) => tags.push(piece)), tags.end()]) {
    reasoning += part.reasoning
    text += part.text
  }
  return { reasoning, text, found: tags.found }
}

test('thinking between tags at the start of an answer is taken apart from the answer', () => {
  assert.deepEqual(split(['<think>\nweigh it up\n</think>\n\nThe answer.']), { reasoning: 'weigh it up\n', text: 'The answer.', found: true })
  // White space before the block is not an answer yet.
  assert.deepEqual(split(['\n\n<think>a</think>b']), { reasoning: 'a', text: 'b', found: true })
  // Nothing was thought.
  assert.deepEqual(split(['<think>\n\n</think>\n\nShort.']), { reasoning: '', text: 'Short.', found: true })
})

test('tags cut in two by the stream are still recognised', () => {
  const expected = { reasoning: 'plan first', text: 'then answer', found: true }
  assert.deepEqual(split(['<th', 'ink>plan', ' first</th', 'ink>\n\nthen', ' answer']), expected)
  assert.deepEqual(split(['<', 'think', '>', 'plan first', '<', '/think', '>', '\n', '\n', 'then answer']), expected)
  // One character at a time.
  assert.deepEqual(split([...'<think>plan first</think>\n\nthen answer']), expected)
  // What looked like the end of the block and was not belongs to the thinking.
  assert.deepEqual(split(['<think>a </thi', 'ng> b</think>c']), { reasoning: 'a </thing> b', text: 'c', found: true })
})

test('an answer without a block at its start is left as it is', () => {
  assert.deepEqual(split(['Hello ', 'there.']), { reasoning: '', text: 'Hello there.', found: false })
  // The tags further in are something the model wrote about.
  assert.deepEqual(split(['Write <think>x</think> to think.']), { reasoning: '', text: 'Write <think>x</think> to think.', found: false })
  // The start of another tag, and white space that turned out to open ordinary text.
  assert.deepEqual(split(['<', 'div>', 'x']), { reasoning: '', text: '<div>x', found: false })
  assert.deepEqual(split(['\n', '  indented']), { reasoning: '', text: '\n  indented', found: false })
  assert.deepEqual(split([]), { reasoning: '', text: '', found: false })
})

test('a stream that ends early loses nothing', () => {
  // Cut off while thinking: what was held back as a possible tag is thinking after all.
  assert.deepEqual(split(['<think>still at it</thi']), { reasoning: 'still at it</thi', text: '', found: true })
  // Cut off before it was clear whether a block opens.
  assert.deepEqual(split(['<thi']), { reasoning: '', text: '<thi', found: false })
  assert.deepEqual(split(['  ']), { reasoning: '', text: '  ', found: false })
})

/**
 * The same for an answer whose thinking may come without its opening tag, the way whoever reads
 * the pieces has to take them: text that turns out to have been thinking is moved over.
 */
function read(pieces: string[], unopened: Unopened) {
  const tags = new ThinkTags(unopened)
  let reasoning = ''
  let text = ''
  let moved = 0
  for (const part of [...pieces.map((piece) => tags.push(piece)), tags.end()]) {
    if (part.wasThinking) {
      reasoning += text
      text = ''
      moved++
    }
    reasoning += part.reasoning
    text += part.text
  }
  return { reasoning, text, moved, found: tags.found, bare: tags.bare, assumed: tags.assumed, open: tags.open }
}

/** The ways a stream may cut a text up: whole, seven characters at a time, and one at a time. */
const cuts = (text: string): string[][] => [[text], text.match(/.{1,7}/gs) ?? [], [...text]]

test('thinking that only a closing tag ends is told apart when the tag comes', () => {
  // What a model writes whose template wrote the opening tag for it.
  const told = { reasoning: 'First the plan.\n', text: 'The answer.', moved: 1, found: true, bare: true, assumed: false, open: false }
  for (const pieces of cuts('First the plan.\n</think>\n\nThe answer.')) assert.deepEqual(read(pieces, 'watch'), told)
  // Until the tag comes, it is handed on as the answer: there is no telling yet.
  const tags = new ThinkTags('watch')
  assert.deepEqual(tags.push('First the plan.\n'), { reasoning: '', text: 'First the plan.\n' })
  assert.deepEqual(tags.push('</think>\n\nThe answer.'), { reasoning: '', text: 'The answer.', wasThinking: true })

  // Nothing but thinking, as before a tool call that the server hands over.
  for (const pieces of cuts('Only thinking.\n</think>')) assert.deepEqual(read(pieces, 'watch'), { ...told, reasoning: 'Only thinking.\n', text: '' })
  // No thinking at all, a tag that stands indented, and an answer that follows it on the same line.
  for (const empty of ['</think>\n\nShort.', '\n</think>\n\nShort.']) {
    for (const pieces of cuts(empty)) assert.deepEqual([read(pieces, 'watch').reasoning.trim(), read(pieces, 'watch').text, read(pieces, 'watch').bare], ['', 'Short.', true])
  }
  for (const pieces of cuts('plan\n  </think>\nanswer')) assert.deepEqual(read(pieces, 'watch'), { ...told, reasoning: 'plan\n  ', text: 'answer' })
  for (const pieces of cuts('plan\n</think>The answer.')) assert.deepEqual(read(pieces, 'watch'), { ...told, reasoning: 'plan\n' })

  // Where it is not asked for, such an answer is left as it is.
  assert.deepEqual(read(['First the plan.\n</think>\n\nThe answer.'], 'no'), { reasoning: '', text: 'First the plan.\n</think>\n\nThe answer.', moved: 0, found: false, bare: false, assumed: false, open: false })
})

test('a closing tag that the model only wrote about leaves the answer as it is', () => {
  const left = (text: string) => ({ reasoning: '', text, moved: 0, found: false, bare: false, assumed: false, open: false })
  for (const text of [
    // In the middle of a sentence.
    'A model ends its thinking with </think> and goes on.',
    // With the tag that opens it before it: both are something written about.
    'Write <think>x</think> to think.',
    'What it writes looks like this:\n<think>\nplan\n</think>\nanswer',
    // The beginning of a tag that never came.
    'The line ends with </thi'
  ]) {
    for (const pieces of cuts(text)) assert.deepEqual(read(pieces, 'watch'), left(text), text)
  }
  // The one at the start of a line is the end of the thinking, whatever was written about before it.
  const both = 'I must close with </think> soon.\nDone.\n</think>\nThe answer.'
  for (const pieces of cuts(both)) assert.deepEqual([read(pieces, 'watch').reasoning, read(pieces, 'watch').text], ['I must close with </think> soon.\nDone.\n', 'The answer.'])
})

test('where earlier answers began inside the thinking, the next one is read that way from its first word', () => {
  const told = { reasoning: 'plan first\n', text: 'The answer.', moved: 0, found: true, bare: true, assumed: true, open: false }
  for (const pieces of cuts('plan first\n</think>\n\nThe answer.')) assert.deepEqual(read(pieces, 'expect'), told)
  for (const pieces of cuts('\n\nplan first\n</think>\n\nThe answer.')) assert.deepEqual(read(pieces, 'expect'), told, 'the thinking begins with its first word')
  assert.deepEqual(new ThinkTags('expect').push('plan'), { reasoning: 'plan', text: '' }, 'handed on as thinking at once')
  // Nothing was thought.
  for (const pieces of cuts('</think>\n\nShort.')) assert.deepEqual(read(pieces, 'expect'), { ...told, reasoning: '', text: 'Short.' })

  // An answer whose thinking never ended: whoever expected thinking can tell, and take it for the answer it was.
  for (const pieces of cuts('Just an answer.')) {
    assert.deepEqual(read(pieces, 'expect'), { reasoning: 'Just an answer.', text: '', moved: 0, found: false, bare: false, assumed: true, open: true })
  }
  // An answer that opens with the tag after all is read by its tags.
  for (const pieces of cuts('<think>plan</think>answer')) {
    assert.deepEqual(read(pieces, 'expect'), { reasoning: 'plan', text: 'answer', moved: 0, found: true, bare: false, assumed: false, open: false })
  }
})

test('a service that hands the thinking over itself has its answers left alone', () => {
  const left = (text: string) => ({ reasoning: '', text, moved: 0, found: false, bare: false, assumed: false, open: false })
  for (const unopened of ['watch', 'expect'] as const) {
    const tags = new ThinkTags(unopened)
    tags.settle()
    const answer = 'One line.\n</think>\nAnother.'
    assert.deepEqual([tags.push(answer), tags.end(), tags.assumed, tags.open], [{ reasoning: '', text: answer }, { reasoning: '', text: '' }, false, false], unopened)
    // A block that opens the answer is thinking all the same.
    const opened = new ThinkTags(unopened)
    opened.settle()
    assert.deepEqual(opened.push('<think>plan</think>answer'), { reasoning: 'plan', text: 'answer' })
  }
  // Said in the middle of an answer that was being watched.
  const tags = new ThinkTags('watch')
  const first = tags.push('Some text.\n')
  tags.settle()
  assert.deepEqual([first, tags.push('</think>\nmore'), tags.found], [{ reasoning: '', text: 'Some text.\n' }, { reasoning: '', text: '</think>\nmore' }, false])
  assert.deepEqual(read(['x'], 'no'), left('x'))
})
