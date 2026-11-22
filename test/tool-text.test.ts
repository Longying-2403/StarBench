// Tool calls that a model wrote into its answer, and the conversation written the same way.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WrittenCalls, callText, newCallId, resultText, textBeforeCalls, toolsPrompt, trailingCalls } from '../src/main/providers/tool-text.ts'
import type { WrittenCall } from '../src/main/providers/tool-text.ts'
import type { ToolDefinition } from '../src/main/tools.ts'
import { itemsReducer } from '../src/renderer/src/items.ts'
import type { Item } from '../src/renderer/src/items.ts'
import type { AgentEvent } from '../src/shared/types.ts'

const TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: ['integer', 'null'] } }, required: ['path'] }
  },
  { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  {
    name: 'search',
    description: 'Search.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, case_insensitive: { type: 'boolean' }, globs: { type: 'array' }, options: { type: 'object' }, depth: { anyOf: [{ type: 'number' }, { type: 'null' }] } }
    }
  },
  { name: 'list_dir', description: 'List a folder.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
]

/** Feeds the pieces through, as a stream would, and says what was shown and what the answer held. */
function read(pieces: string[], anyName = false) {
  const written = new WrittenCalls(TOOLS, anyName)
  const shown = pieces.map((piece) => written.push(piece)).join('')
  const { text, calls, begun, unfinished } = written.end()
  return { shown, held: text, calls: calls.map((call) => [call.name, JSON.parse(call.arguments)] as [string, unknown]), begun, unfinished }
}

const QWEN_35 = '<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.txt\n</parameter>\n</function>\n</tool_call>'
const HERMES = '<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.txt"}}\n</tool_call>'

test('a call between tags is taken out of the answer, in either of the forms models write', () => {
  // Qwen 3.5 and the Coder models: each argument between tags of its own.
  assert.deepEqual(read([`Let me look.\n\n${QWEN_35}`]), { shown: 'Let me look.\n\n', held: QWEN_35, calls: [['read_file', { path: 'src/a.txt' }]], begun: true, unfinished: false })
  // Hermes, Qwen 2.5 and 3: a JSON object.
  assert.deepEqual(read([HERMES]).calls, [['read_file', { path: 'src/a.txt' }]])
  assert.equal(read([HERMES]).shown, '')
  // The same, however the stream cuts it up.
  for (const text of [`Let me look.\n\n${QWEN_35}`, `Let me look.\n\n${HERMES}`]) {
    const whole = read([text])
    assert.deepEqual(read([...text]), whole, 'one character at a time')
    assert.deepEqual(read(text.match(/.{1,7}/gs) ?? []), whole, 'seven at a time')
  }
})

test('the variations models allow themselves are read', () => {
  const args = { path: 'a.txt' }
  for (const [what, text] of [
    ['on one line', '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>'],
    ['"parameters" for the arguments', '<tool_call>{"name": "read_file", "parameters": {"path": "a.txt"}}</tool_call>'],
    ['the arguments as a string of JSON', '<tool_call>{"name": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}</tool_call>'],
    ['wrapped the way the API has it', '<tool_call>{"type": "function", "function": {"name": "read_file", "arguments": {"path": "a.txt"}}}</tool_call>'],
    ['without the closing tag', '<tool_call>\n{"name": "read_file", "arguments": {"path": "a.txt"}}'],
    ['in a code block inside the tags', '<tool_call>\n```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```\n</tool_call>'],
    ['the block without the tags around it', '<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n</function>'],
    ['with only the closing tag', '<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>'],
    ['the block without its closing tag', '<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n</function>'],
    ['everything on one line', '<tool_call><function=read_file><parameter=path>a.txt</parameter></function></tool_call>'],
    // Llama 3: the arguments together, as JSON.
    ['the arguments as JSON in the block', '<function=read_file>{"path": "a.txt"}</function>']
  ] as const) {
    assert.deepEqual(read([text]).calls, [['read_file', args]], what)
    assert.deepEqual(read([...text]).calls, [['read_file', args]], `${what}, one character at a time`)
    assert.equal(read([...text]).shown, '', what)
  }
  // A tool that takes nothing.
  assert.deepEqual(read(['<tool_call>\n<function=list_dir>\n</function>\n</tool_call>']).calls, [['list_dir', {}]])
  assert.deepEqual(read(['<tool_call>{"name": "list_dir"}</tool_call>']).calls, [['list_dir', {}]])
  assert.deepEqual(read(['<tool_call>{"name": "list_dir", "arguments": ""}</tool_call>']).calls, [['list_dir', {}]])
  // A list of calls in one block.
  assert.deepEqual(read(['<tool_call>[{"name": "list_dir", "arguments": {}}, {"name": "read_file", "arguments": {"path": "a.txt"}}]</tool_call>']).calls, [
    ['list_dir', {}],
    ['read_file', args]
  ])
})

test('a value between tags becomes the kind of value the tool takes', () => {
  const block = (name: string, values: Record<string, string>): string =>
    `<tool_call>\n<function=${name}>\n${Object.entries(values)
      .map(([key, value]) => `<parameter=${key}>\n${value}\n</parameter>`)
      .join('\n')}\n</function>\n</tool_call>`
  const one = (name: string, values: Record<string, string>): unknown => read([block(name, values)], true).calls[0]?.[1]

  assert.deepEqual(one('read_file', { path: 'a.txt', offset: '20', limit: 'null' }), { path: 'a.txt', offset: 20, limit: null })
  assert.deepEqual(one('search', { pattern: 'x', case_insensitive: 'True', globs: '["*.ts", "*.md"]', options: '{"deep": true}', depth: '2.5' }), {
    pattern: 'x',
    case_insensitive: true,
    globs: ['*.ts', '*.md'],
    options: { deep: true },
    depth: 2.5
  })
  // Text stays text whatever it looks like, and keeps its lines, its indentation and its quotes.
  assert.deepEqual(one('write_file', { path: '42', content: 'true' }), { path: '42', content: 'true' })
  assert.deepEqual(one('write_file', { path: 'a.json', content: '{\n  "a": "b\\n"\n}\n' }), { path: 'a.json', content: '{\n  "a": "b\\n"\n}\n' })
  assert.deepEqual(one('write_file', { path: 'a.py', content: '    indented\n\nlast line  ' }), { path: 'a.py', content: '    indented\n\nlast line  ' })
  // What the schema does not speak of, and what does not read as it should, is handed on as text for the tool to refuse.
  assert.deepEqual(one('read_file', { path: 'a.txt', offset: 'ten', more: '7' }), { path: 'a.txt', offset: 'ten', more: '7' })
  assert.deepEqual(one('nobody_knows', { n: '1' }), { n: '1' })

  // A value that holds the closing tags itself: a file about this very format.
  const about = 'Close with </parameter> and then </function>\n</tool_call> at the end.'
  assert.deepEqual(one('write_file', { path: 'notes.md', content: about }), { path: 'notes.md', content: about })
  const json = `<tool_call>\n${JSON.stringify({ name: 'write_file', arguments: { path: 'notes.md', content: about } })}\n</tool_call>`
  assert.deepEqual(read([json]).calls, [['write_file', { path: 'notes.md', content: about }]])
})

test('several calls are read one after the other, and what follows them is dropped', () => {
  const second = '<tool_call>\n{"name": "list_dir", "arguments": {"path": "src"}}\n</tool_call>'
  assert.deepEqual(read([`${QWEN_35}\n${second}`]).calls, [
    ['read_file', { path: 'src/a.txt' }],
    ['list_dir', { path: 'src' }]
  ])
  // A model that goes on after its call makes the result up, and may act on what it made up.
  const invented = `${QWEN_35}\n<tool_response>\nhello\n</tool_response>\nThe file says hello.\n${second}`
  const got = read([...invented])
  assert.deepEqual(got.calls, [['read_file', { path: 'src/a.txt' }]], 'the call after the made-up result is not run')
  assert.equal(got.shown, '')
  // A second call that cannot be read does not take the first one with it.
  assert.deepEqual(read([`${QWEN_35}\n<tool_call>\n{"name": "list_dir", "arguments": {"path": `]).calls, [['read_file', { path: 'src/a.txt' }]])
})

test('what only looks like a call stays text', () => {
  // The tag was written about. It is handed on as soon as what follows shows that.
  const prose = 'Models write `<tool_call>` tags, then `<function=name>` and so on.'
  assert.deepEqual(read([prose]), { shown: prose, held: '', calls: [], begun: false, unfinished: false })
  assert.deepEqual(read([...prose]).shown, prose)
  const early = new WrittenCalls(TOOLS)
  assert.equal(early.push('See <tool_call> in '), 'See <tool_call> in ', 'not held back to the end of the answer')
  assert.equal(early.push('the docs. <function=foo bar'), 'the docs. <function=foo bar')

  // A call that cannot be read is given back whole, for showing.
  for (const text of [
    '<tool_call>\n{"name": "read_file", "arguments": {"path": }\n</tool_call>',
    '<tool_call>\n{"arguments": {"path": "a.txt"}}\n</tool_call>',
    '<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</function>\n</tool_call>',
    '<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\nand some words\n</function>\n</tool_call>'
  ]) {
    const got = read([`Before. ${text}`], true)
    assert.deepEqual([got.shown, got.held, got.calls, got.unfinished], ['Before. ', text, [], false], text)
  }
  // And one that does not even begin like a call is not held back for it.
  const words = 'Before. <tool_call>\n<function=read_file>\nsome words\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>'
  assert.deepEqual(read([...words], true), { shown: words, held: '', calls: [], begun: false, unfinished: false })

  // A tool that is not there: text, unless the model was told to write its calls this way.
  const unknown = '<tool_call>\n{"name": "open_file", "arguments": {"path": "a.txt"}}\n</tool_call>'
  assert.deepEqual(read([unknown]).calls, [])
  assert.equal(read([unknown]).held, unknown)
  assert.deepEqual(read([unknown], true).calls, [['open_file', { path: 'a.txt' }]])
  const unknownBlock = 'Use <function=open_file>\n<parameter=path>\na.txt\n</parameter>\n</function> here.'
  assert.equal(read([...unknownBlock]).shown, unknownBlock, 'handed on as soon as the name is read')
  assert.deepEqual(read([unknownBlock], true).calls, [['open_file', { path: 'a.txt' }]])
})

test('an answer that ends in the middle of a call says so', () => {
  const cut = read(['Saving. <tool_call>\n<function=write_file>\n<parameter=path>\na.txt\n</parameter>\n<parameter=content>\nhalf of the fi'])
  assert.deepEqual([cut.shown, cut.calls, cut.begun, cut.unfinished], ['Saving. ', [], true, true])
  assert.equal(read(['<tool_call>\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "half']).unfinished, true)
  assert.equal(read(['<function=write_file>\n<parameter=path>\na.t']).unfinished, true)
  // The beginning of a tag that never came is text, and nothing was begun.
  assert.deepEqual(read(['The end <tool_c']), { shown: 'The end ', held: '<tool_c', calls: [], begun: false, unfinished: false })
})

test('a call written as plain JSON at the end of an answer is found', () => {
  const found = (text: string) => {
    const got = trailingCalls(text, TOOLS)
    return got ? { text: got.text, calls: got.calls.map((call) => [call.name, JSON.parse(call.arguments)]) } : undefined
  }
  const call = [['read_file', { path: 'a.txt' }]]
  assert.deepEqual(found('{"name": "read_file", "arguments": {"path": "a.txt"}}'), { text: '', calls: call })
  assert.deepEqual(found('I will read it.\n\n{"name": "read_file", "parameters": {"path": "a.txt"}}\n'), { text: 'I will read it.', calls: call })
  assert.deepEqual(found('I will read it.\n\n```json\n{\n  "name": "read_file",\n  "arguments": {\n    "path": "a.txt"\n  }\n}\n```'), { text: 'I will read it.', calls: call })
  assert.deepEqual(found('[{"name": "list_dir", "arguments": {}}, {"name": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}]'), {
    text: '',
    calls: [['list_dir', {}], ...call]
  })
  assert.deepEqual(found('{"type": "function", "function": {"name": "read_file", "arguments": {"path": "a.txt"}}}'), { text: '', calls: call })

  // Not a call: it names no tool there is, says nothing of the arguments, or is not where the answer ends.
  for (const text of [
    '{"name": "open_file", "arguments": {"path": "a.txt"}}',
    '{"name": "read_file"}',
    '{"name": "read_file", "arguments": ["a.txt"]}',
    '{"name": "read_file", "arguments": {"path": "a.txt"}} is how a call looks.',
    'The config:\n{\n  "tools": [\n    {"name": "read_file", "arguments": {"path": "a.txt"}}\n  ]\n}',
    'Like this: {"name": "read_file", "arguments": {"path": "a.txt"}}',
    '```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```\nThat is the format.',
    'A list:\n[1, 2, 3]',
    'Plain words.',
    ''
  ]) {
    assert.equal(found(text), undefined, text)
  }
  // A fence at the end that closes something else.
  assert.equal(found('```\nsome code\n```\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```'), undefined)
})

test('the text before a call loses the code block the call was put in', () => {
  assert.equal(textBeforeCalls('Let me look.\n\n'), 'Let me look.')
  assert.equal(textBeforeCalls('Let me look.\n\n```xml\n'), 'Let me look.')
  assert.equal(textBeforeCalls('```\n'), '')
  // A block that was closed is part of the answer.
  assert.equal(textBeforeCalls('Run this:\n```\nnpm test\n```\n'), 'Run this:\n```\nnpm test\n```')
  assert.equal(textBeforeCalls('Run this:\n```\nnpm test\n```\nThen:\n```json'), 'Run this:\n```\nnpm test\n```\nThen:')
})

test('a conversation written out for a server without tools reads back as the calls it holds', () => {
  const prompt = toolsPrompt(TOOLS)
  assert.match(prompt, /^# Tools\n\nYou have access to the following functions:\n\n<tools>\n\{"type":"function","function":\{"name":"read_file","description":"Read a file\."/)
  assert.equal(prompt.match(/^\{"type":"function"/gm)?.length, TOOLS.length, 'one line for each tool')
  assert.match(prompt, /<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n<\/parameter>/)
  assert.match(prompt, /<tool_response><\/tool_response>/)

  const calls: WrittenCall[] = [
    { name: 'write_file', arguments: JSON.stringify({ path: 'a.py', content: 'def f():\n    return "x"\n' }) },
    { name: 'search', arguments: JSON.stringify({ pattern: '^a', case_insensitive: false, globs: ['*.ts'], depth: 3 }) },
    { name: 'list_dir', arguments: '{}' }
  ]
  assert.equal(callText(calls[0]), '<tool_call>\n<function=write_file>\n<parameter=path>\na.py\n</parameter>\n<parameter=content>\ndef f():\n    return "x"\n\n</parameter>\n</function>\n</tool_call>')
  assert.equal(callText(calls[2]), '<tool_call>\n<function=list_dir>\n</function>\n</tool_call>')
  // What the model reads of its own calls is what it is asked to write.
  const back = new WrittenCalls(TOOLS, true)
  back.push(calls.map(callText).join('\n'))
  assert.deepEqual(back.end().calls, calls)
  // Arguments that never were JSON: the call is still told.
  assert.equal(callText({ name: 'read_file', arguments: 'not json' }), '<tool_call>\n<function=read_file>\n</function>\n</tool_call>')

  assert.equal(resultText('1\thello'), '<tool_response>\n1\thello\n</tool_response>')
  const ids = new Set(Array.from({ length: 200 }, newCallId))
  assert.equal(ids.size, 200)
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{9}$/)
})

test('the page shows a message anew when what came of it reads differently', () => {
  const after = (items: Item[], ...events: AgentEvent[]): Item[] => events.reduce((list, event) => itemsReducer(list, { type: 'event', event }), items)
  const asked: Item[] = [{ kind: 'user', text: 'read it' }]
  const shown = after(asked, { type: 'reasoning_delta', text: 'The file first.' }, { type: 'text_delta', text: 'Now the file.\n\n{"name": "read_file", ' }, { type: 'text_delta', text: '"arguments": {"path": "a.txt"}}' })
  assert.deepEqual(shown.at(-1), { kind: 'assistant', reasoning: 'The file first.', text: 'Now the file.\n\n{"name": "read_file", "arguments": {"path": "a.txt"}}', open: true })

  // A call that stood in the text is gone from it, and its card follows.
  const call = { id: 'aB3dE6gH9', name: 'read_file', arguments: '{"path":"a.txt"}' }
  assert.deepEqual(after(shown, { type: 'assistant_rewrite', text: 'Now the file.', reasoning: 'The file first.' }, { type: 'assistant_done' }, { type: 'tool_start', call }), [
    ...asked,
    { kind: 'assistant', reasoning: 'The file first.', text: 'Now the file.', open: false },
    { kind: 'tool', call }
  ])
  // A message that was nothing but the call leaves nothing to show.
  const bare = after(asked, { type: 'text_delta', text: '{"name": "read_file", "arguments": {"path": "a.txt"}}' })
  assert.deepEqual(after(bare, { type: 'assistant_rewrite', text: '', reasoning: '' }, { type: 'assistant_done' }), asked)

  // Text that was the thinking moves over while the message is still being written, and the answer goes on after it.
  const thinking = after(asked, { type: 'text_delta', text: 'First the plan.\n' }, { type: 'assistant_rewrite', text: '', reasoning: 'First the plan.\n' })
  assert.deepEqual(thinking, [...asked, { kind: 'assistant', reasoning: 'First the plan.\n', text: '', open: true }])
  assert.deepEqual(after(thinking, { type: 'text_delta', text: 'The answer.' }, { type: 'assistant_done' }).at(-1), { kind: 'assistant', reasoning: 'First the plan.\n', text: 'The answer.', open: false })
  // And the other way round: what was taken for thinking is taken back, and comes again as the answer.
  const taken = after(asked, { type: 'reasoning_delta', text: 'Just an answer.' }, { type: 'assistant_rewrite', text: '', reasoning: '' }, { type: 'text_delta', text: 'Just an answer.' })
  assert.deepEqual(taken, [...asked, { kind: 'assistant', reasoning: '', text: 'Just an answer.', open: true }])
  // Where nothing was shown yet, there is nothing to take the place of.
  assert.deepEqual(after(asked, { type: 'assistant_rewrite', text: '', reasoning: '' }), asked)
  assert.deepEqual(after(asked, { type: 'assistant_rewrite', text: 'x', reasoning: '' }).at(-1), { kind: 'assistant', reasoning: '', text: 'x', open: true })

  // As a rule the message is what was shown, and is only closed.
  assert.deepEqual(after(shown, { type: 'assistant_done' }).at(-1), { ...shown.at(-1), open: false })
  assert.deepEqual(after(shown, { type: 'turn_end' }).at(-1), { ...shown.at(-1), open: false })
})

test('what was held back of an answer can be given up, when it was no answer', () => {
  const written = new WrittenCalls(TOOLS)
  assert.equal(written.push(`I might call it:\n${QWEN_35}\nor not.`), 'I might call it:\n')
  assert.equal(written.drain(), `${QWEN_35}\nor not.`)
  // It begins anew: a call that follows is one.
  assert.equal(written.push(`Looking. ${HERMES}`), 'Looking. ')
  assert.deepEqual(written.end().calls, [{ name: 'read_file', arguments: '{"path":"src/a.txt"}' }])
  // The beginning of a tag is given back as well.
  const partial = new WrittenCalls(TOOLS)
  assert.deepEqual([partial.push('so <tool_'), partial.drain(), partial.end()], ['so ', '<tool_', { text: '', calls: [], begun: false, unfinished: false }])
})
