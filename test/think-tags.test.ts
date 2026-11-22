import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ThinkTags } from '../src/main/providers/think-tags.ts'

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
