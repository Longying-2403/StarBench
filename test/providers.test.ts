// The three ways of talking to a model service, each against a fake server that speaks its format.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { runTurn } from '../src/main/agent.ts'
import { anthropicParams } from '../src/main/providers/anthropic.ts'
import { chatMessages } from '../src/main/providers/chat.ts'
import { INTERRUPTED, withToolResults } from '../src/main/providers/history.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { adapterFor } from '../src/main/providers/index.ts'
import { responsesInput } from '../src/main/providers/responses.ts'
import { ToolRegistry, checkArguments, registerBuiltinTools } from '../src/main/tools.ts'
import type { AgentEvent, ChatMessage, ProviderKind } from '../src/shared/types.ts'

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: any
}

/** A server that records what it is asked and answers with whatever `reply` returns. */
async function fakeService(
  reply: (seen: Seen, count: number) => { status?: number; type?: string; body: string; headers?: Record<string, string> }
) {
  const requests: Seen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const seen: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null }
      requests.push(seen)
      const posts = requests.filter((r) => r.method === 'POST').length
      const { status = 200, type = 'text/event-stream', body, headers = {} } = reply(seen, posts)
      res.writeHead(status, { 'content-type': type, ...headers }).end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const posts = (): Seen[] => requests.filter((r) => r.method === 'POST')
  // Closed when the run ends, whether the tests passed or not: an open server keeps the process alive.
  after(() => void server.closeAllConnections?.(), { timeout: 2000 })
  after(() => void server.close())
  return { requests, posts, baseURL }
}

const sse = (events: { type: string }[]): string => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

const connection = (kind: ProviderKind, baseURL: string, extra: Partial<Connection> = {}): Connection => ({
  provider: 'p1',
  kind,
  apiKey: 'test-key',
  baseURL,
  model: 'model-x',
  reasoningEffort: 'default',
  ...extra
})

/** Runs one turn with the built-in tools in a folder that holds a.txt, and reports what happened. */
async function turn(conn: Connection, messages: ChatMessage[]) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench-providers-'))
  await writeFile(path.join(workspace, 'a.txt'), 'hello from the file')
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const events: AgentEvent[] = []
  await runTurn({
    connection: conn,
    workspace,
    messages,
    signal: new AbortController().signal,
    tools,
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    requestPermission: async () => 'allow'
  })
  const ofType = <T extends AgentEvent['type']>(type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
  return {
    events,
    text: ofType('text_delta').map((e) => e.text).join(''),
    reasoning: ofType('reasoning_delta').map((e) => e.text).join(''),
    errors: ofType('error').map((e) => e.message),
    toolResults: ofType('tool_result').map((e) => e.output)
  }
}

test('withToolResults gives every call exactly one result', () => {
  const call = (id: string) => ({ id, name: 'read_file', arguments: '{}' })
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'tool', tool_call_id: 'stray', content: 'belongs to nothing' },
    { role: 'assistant', content: '', tool_calls: [call('a'), call('b'), call('c')] },
    { role: 'tool', tool_call_id: 'c', content: 'third' },
    { role: 'tool', tool_call_id: 'a', content: 'first' },
    { role: 'tool', tool_call_id: 'a', content: 'first again' },
    { role: 'user', content: 'next' },
    // The app was closed while this call ran: no result was ever saved.
    { role: 'assistant', content: 'working', tool_calls: [call('d')] }
  ]
  assert.deepEqual(
    withToolResults(messages).map((m) => (m.role === 'tool' ? `${m.tool_call_id}=${m.content}` : m.role)),
    ['user', 'assistant', 'a=first', `b=${INTERRUPTED}`, 'c=third', 'user', 'assistant', `d=${INTERRUPTED}`]
  )
  assert.equal(messages.length, 8, 'the stored conversation is left as it is')
})

test('checkArguments catches incomplete and mistyped tool arguments', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'number' }, deep: { type: 'boolean' }, tags: { type: ['array', 'null'] } },
    required: ['path']
  }
  assert.equal(checkArguments(schema, { path: 'a.txt' }), null)
  assert.equal(checkArguments(schema, { path: 'a.txt', limit: '20', deep: null, tags: null, extra: {} }), null)
  assert.match(checkArguments(schema, {}) ?? '', /missing "path"/)
  assert.match(checkArguments(schema, { path: null }) ?? '', /missing "path"/)
  assert.match(checkArguments(schema, { path: 7 }) ?? '', /"path" must be string/)
  assert.match(checkArguments(schema, { path: 'a', deep: 'yes' }) ?? '', /"deep" must be boolean/)
  assert.match(checkArguments(schema, { path: 'a', limit: 'many' }) ?? '', /"limit" must be number/)
  assert.match(checkArguments(schema, { path: 'a', tags: 'x' }) ?? '', /"tags" must be array or null/)
  // A schema that says nothing accepts anything.
  assert.equal(checkArguments({}, { whatever: 1 }), null)
})

test('a tool is not run on arguments that are missing a required part', async () => {
  const tools = new ToolRegistry()
  let ran = false
  tools.register(
    { name: 'save', description: 'saves', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, run: () => ((ran = true), 'saved') },
    'test'
  )
  const context = { workspace: '.', signal: new AbortController().signal }
  const result = await tools.execute('save', '{"path":"a.txt"}', context)
  assert.match(result, /^Error: invalid arguments for save: missing "content"\. Received: \{"path":"a\.txt"\}$/)
  assert.equal(ran, false)
  assert.equal(await tools.execute('save', '{"path":"a.txt","content":""}', context), 'saved')
})

test('the Responses API: reasoning, a tool call and the answer', async () => {
  const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Need the file.' }], encrypted_content: 'ENC1' }
  const callItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}', status: 'completed' }
  const answerItem = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'It says hello.', annotations: [] }] }
  const service = await fakeService((_seen, count) => ({
    body:
      count === 1
        ? sse([
            { type: 'response.created' },
            { type: 'response.reasoning_summary_part.added' },
            { type: 'response.reasoning_summary_text.delta', delta: 'Need the ' } as never,
            { type: 'response.reasoning_summary_text.delta', delta: 'file.' } as never,
            { type: 'response.output_item.done', item: reasoningItem } as never,
            { type: 'response.output_item.done', item: callItem } as never,
            { type: 'response.completed', response: { status: 'completed' } } as never
          ])
        : sse([
            { type: 'response.output_text.delta', delta: 'It says ' } as never,
            { type: 'response.output_text.delta', delta: 'hello.' } as never,
            { type: 'response.output_item.done', item: answerItem } as never,
            { type: 'response.completed', response: { status: 'completed' } } as never
          ])
  }))
  const conn = connection('openai-responses', service.baseURL, { reasoningEffort: 'xhigh' })
  const messages: ChatMessage[] = [{ role: 'user', content: 'read it', skill: { name: 's', prompt: 'SKILL' } }]
  const result = await turn(conn, messages)

  assert.deepEqual(result.errors, [])
  assert.equal(result.reasoning, 'Need the file.')
  assert.equal(result.text, 'It says hello.')
  assert.deepEqual(result.toolResults, ['1\thello from the file'])

  const [first, second] = service.posts()
  assert.equal(first.url, '/responses')
  assert.equal(first.headers.authorization, 'Bearer test-key')
  assert.equal(first.body.model, 'model-x')
  assert.match(first.body.instructions, /coding agent/)
  assert.deepEqual(first.body.input, [{ role: 'user', content: 'SKILL\n\nread it' }])
  assert.deepEqual(first.body.reasoning, { summary: 'auto', effort: 'xhigh' })
  assert.deepEqual([first.body.store, first.body.stream, first.body.include], [false, true, ['reasoning.encrypted_content']])
  const readFile = first.body.tools.find((t: { name: string }) => t.name === 'read_file')
  assert.deepEqual([readFile.type, readFile.strict, readFile.parameters.required], ['function', false, ['path']])

  // The model's own output goes back as it came, encrypted reasoning included, followed by the result.
  assert.deepEqual(second.body.input, [
    { role: 'user', content: 'SKILL\n\nread it' },
    reasoningItem,
    callItem,
    { type: 'function_call_output', call_id: 'call_1', output: '1\thello from the file' }
  ])

  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: '',
    reasoning_content: 'Need the file.',
    tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
    origin: { provider: 'p1', kind: 'openai-responses', model: 'model-x', replay: [reasoningItem, callItem] }
  })
  assert.equal(messages.at(-1)?.role === 'assistant' && messages.at(-1)?.content, 'It says hello.')
})

test('the Responses API: summaries that are refused are done without, and a cut-off call is not run', async () => {
  const refusing = await fakeService((seen, count) =>
    seen.body.reasoning.summary
      ? { status: 400, type: 'application/json', body: JSON.stringify({ error: { message: 'Your organization must be verified to generate reasoning summaries.', type: 'invalid_request_error', param: 'reasoning.summary' } }) }
      : { body: sse([{ type: 'response.output_text.delta', delta: `ok after ${count} tries` } as never, { type: 'response.completed', response: { status: 'completed' } } as never]) }
  )
  const first = await turn(connection('openai-responses', refusing.baseURL), [{ role: 'user', content: 'hi' }])
  assert.deepEqual([first.errors, first.text], [[], 'ok after 2 tries'])
  assert.deepEqual(refusing.posts().map((r) => r.body.reasoning), [{ summary: 'auto' }, {}])

  const cut = await fakeService(() => ({
    body: sse([
      { type: 'response.output_text.delta', delta: 'Let me save that' } as never,
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc', call_id: 'c1', name: 'write_file', arguments: '{"path":"b.txt","content":"half' } } as never,
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } } as never
    ])
  }))
  const messages: ChatMessage[] = [{ role: 'user', content: 'save' }]
  const second = await turn(connection('openai-responses', cut.baseURL), messages)
  assert.deepEqual(second.toolResults, [], 'no tool ran')
  assert.match(second.errors[0], /ran out of output space/)
  assert.equal(cut.posts().length, 1)
  assert.deepEqual(messages[1], { role: 'assistant', content: 'Let me save that', origin: { provider: 'p1', kind: 'openai-responses', model: 'model-x' } })
})

/** The stream of one Claude message, block by block, as the Messages API sends it. */
function claudeStream(blocks: Record<string, any>[], stop: Record<string, unknown>): string {
  const events: { type: string }[] = [
    {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'model-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }
    } as never
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } as never)
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } } as never)
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } } as never)
    } else if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } } as never)
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } } as never)
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } } as never)
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.json } } as never)
    }
    events.push({ type: 'content_block_stop', index } as never)
  })
  events.push({ type: 'message_delta', delta: { stop_sequence: null, ...stop }, usage: { output_tokens: 9 } } as never)
  events.push({ type: 'message_stop' })
  return sse(events)
}

const supported = { supported: true }
const claudeModel = {
  type: 'model',
  id: 'model-x',
  display_name: 'Claude Test 1',
  created_at: '2026-01-01T00:00:00Z',
  max_input_tokens: 1_000_000,
  max_tokens: 32_000,
  capabilities: {
    thinking: { supported: true, types: { adaptive: supported, enabled: { supported: false }, disabled: supported, between_tools: supported } },
    effort: { supported: true, low: supported, medium: supported, high: supported, xhigh: null, max: supported }
  }
}

test('the Messages API: thinking, a tool call and the answer', async () => {
  const thinking = { type: 'thinking', thinking: 'Need the file.', signature: 'SIG1' }
  const service = await fakeService((seen, count) => {
    if (seen.method === 'GET') return { type: 'application/json', body: JSON.stringify(claudeModel) }
    return {
      body:
        count === 1
          ? claudeStream([thinking, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', json: '{"path": "a.txt"}' }], { stop_reason: 'tool_use' })
          : claudeStream([{ type: 'text', text: 'It says hello.' }], { stop_reason: 'end_turn' })
    }
  })
  const conn = connection('anthropic', service.baseURL, { reasoningEffort: 'high' })
  const messages: ChatMessage[] = [{ role: 'user', content: 'read it' }]
  const result = await turn(conn, messages)

  assert.deepEqual(result.errors, [])
  assert.equal(result.reasoning, 'Need the file.')
  assert.equal(result.text, 'Reading.It says hello.')
  assert.deepEqual(result.toolResults, ['1\thello from the file'])

  assert.deepEqual(service.requests.filter((r) => r.method === 'GET').map((r) => r.url), ['/v1/models/model-x'], 'the model is asked about once')
  const [first, second] = service.posts()
  assert.match(first.url, /^\/v1\/messages/)
  // This version of the SDK sends an API key as a bearer token.
  assert.equal(first.headers.authorization, 'Bearer test-key')
  assert.equal(first.body.model, 'model-x')
  assert.equal(first.body.max_tokens, 32_000, "the model's own limit, being lower than the app's")
  assert.match(first.body.system, /coding agent/)
  assert.deepEqual(first.body.messages, [{ role: 'user', content: 'read it' }])
  assert.deepEqual(first.body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(first.body.output_config, { effort: 'high' })
  assert.deepEqual(first.body.cache_control, { type: 'ephemeral' })
  const readFile = first.body.tools.find((t: { name: string }) => t.name === 'read_file')
  assert.deepEqual([readFile.input_schema.type, readFile.input_schema.required], ['object', ['path']])
  // A gateway is not sent the fields only the real API is known to take.
  assert.deepEqual([readFile.eager_input_streaming, first.body.fallbacks, first.headers['anthropic-beta']], [undefined, undefined, undefined])

  // Claude's message goes back block for block, the signed thinking untouched, then the result.
  const replayed = [thinking, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }]
  assert.deepEqual(
    second.body.messages.map((m: { role: string }) => m.role),
    ['user', 'assistant', 'user']
  )
  assert.deepEqual(
    second.body.messages[1].content.map((b: any) => (b.type === 'text' ? { type: b.type, text: b.text } : b.type === 'tool_use' ? { type: b.type, id: b.id, name: b.name, input: b.input } : b)),
    replayed
  )
  assert.deepEqual(second.body.messages[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\thello from the file' }])

  const stored = messages[1]
  assert.ok(stored.role === 'assistant')
  assert.deepEqual([stored.content, stored.reasoning_content, stored.tool_calls], ['Reading.', 'Need the file.', [{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.txt"}' }]])
  assert.equal(stored.origin?.kind, 'anthropic')

  // What the settings page and the slider are told about the model.
  assert.deepEqual(await adapterFor('anthropic').modelInfo(conn), { name: 'Claude Test 1', efforts: ['low', 'medium', 'high', 'max'] })
})

test('the Messages API: a refusal and a cut-off tool call stop the turn without running anything', async () => {
  const service = await fakeService((seen, count) => {
    if (seen.method === 'GET') return { status: 404, type: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no such model' } }) }
    return {
      body:
        count === 1
          ? claudeStream([{ type: 'text', text: 'I can' }], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } })
          : claudeStream([{ type: 'tool_use', id: 'toolu_9', name: 'write_file', json: '{"path": "b.txt", "content": "half' }], { stop_reason: 'max_tokens' })
    }
  })
  const conn = connection('anthropic', service.baseURL)
  const refused: ChatMessage[] = [{ role: 'user', content: 'do it' }]
  const first = await turn(conn, refused)
  assert.deepEqual(first.errors, ['The model declined this request (cyber).'])
  assert.deepEqual(first.toolResults, [])
  assert.deepEqual(refused[1], { role: 'assistant', content: 'I can', origin: { provider: 'p1', kind: 'anthropic', model: 'model-x' } })
  // The model could not be looked up, so the request used the defaults.
  assert.equal(service.posts()[0].body.max_tokens, 64_000)
  assert.deepEqual(service.posts()[0].body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(service.posts()[0].body.output_config, undefined)

  const cut: ChatMessage[] = [{ role: 'user', content: 'save' }]
  const second = await turn(conn, cut)
  assert.match(second.errors[0], /ran out of output space in the middle of a tool call/)
  assert.deepEqual(second.toolResults, [], 'the half-written file was not saved')
  assert.equal(cut.length, 1, 'nothing but the cut-off call came, so nothing is kept')
})

test('the real Anthropic API gets the newer request fields, and only the models that take them', () => {
  const tools = [{ name: 'save', description: 'saves', parameters: { properties: { path: { type: 'string' } } } }]
  const request = (model: string, effort: Connection['reasoningEffort'] = 'default') => ({
    connection: connection('anthropic', 'https://api.anthropic.com/', { model, reasoningEffort: effort }),
    system: 's',
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools,
    signal: new AbortController().signal,
    onText: () => {},
    onReasoning: () => {}
  })
  const opus = anthropicParams(request('claude-opus-5-5', 'max'), null)
  assert.deepEqual([opus.fallbacks, opus.betas], ['default', ['server-side-fallback-2026-07-01']])
  assert.deepEqual(opus.output_config, { effort: 'max' })
  assert.deepEqual(opus.tools, [{ name: 'save', description: 'saves', input_schema: { properties: { path: { type: 'string' } }, type: 'object' }, eager_input_streaming: true }])

  // No server-side fallback exists for this model; sending the parameter would be wrong.
  const haiku = anthropicParams(request('claude-haiku-5-5'), null)
  assert.deepEqual([haiku.fallbacks, haiku.betas, haiku.output_config], [undefined, undefined, undefined])

  // What the service says about a model decides thinking and effort.
  const old = anthropicParams(request('claude-haiku-4-5', 'high'), { name: 'Old', maxTokens: 64_000, adaptive: false, efforts: [] })
  assert.deepEqual([old.thinking, old.output_config], [undefined, undefined])
  // A level Claude does not have is not sent.
  assert.equal(anthropicParams(request('claude-opus-5-5', 'none'), null).output_config, undefined)
})

test('a conversation written by one provider can be continued by another', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: 'Looking.',
      reasoning_content: 'deepseek thinking',
      tool_calls: [
        { id: 'call:1/a', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { id: 'call_2', name: 'run_command', arguments: 'not json' }
      ],
      origin: { provider: 'deepseek', kind: 'openai-chat', model: 'deepseek-flash' }
    },
    { role: 'tool', tool_call_id: 'call:1/a', content: 'file text' },
    { role: 'tool', tool_call_id: 'call_2', content: 'The user denied this tool call.' },
    {
      role: 'assistant',
      content: 'Done.',
      reasoning_content: 'claude thinking',
      origin: { provider: 'claude', kind: 'anthropic', model: 'claude-opus-5-5', replay: [{ type: 'thinking', thinking: 'claude thinking', signature: 'S' }, { type: 'fallback', from: {}, to: {} }, { type: 'text', text: 'Done.' }] }
    },
    { role: 'user', content: 'and now?' }
  ]
  const base = { messages, system: 's', tools: [], signal: new AbortController().signal, onText: () => {}, onReasoning: () => {} }

  // Claude: the other service's call is rebuilt (ids made acceptable, results grouped and failures
  // marked); its own message is replayed, without the hand-over marker this model does not use.
  const claude = anthropicParams({ ...base, connection: connection('anthropic', 'https://api.anthropic.com', { provider: 'claude', model: 'claude-haiku-5-5' }) }, null)
  assert.deepEqual(claude.messages, [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'call_1_a', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'call_2', name: 'run_command', input: {} }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1_a', content: 'file text' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'The user denied this tool call.', is_error: true }
      ]
    },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'claude thinking', signature: 'S' }, { type: 'text', text: 'Done.' }] },
    { role: 'user', content: 'and now?' }
  ])

  // DeepSeek: its own reasoning goes back, Claude's does not.
  const deepseek = chatMessages({ ...base, connection: connection('openai-chat', 'https://api.deepseek.com', { provider: 'deepseek' }) })
  assert.deepEqual(
    deepseek.map((m) => [m.role, (m as { reasoning_content?: string }).reasoning_content]),
    [['system', undefined], ['user', undefined], ['assistant', 'deepseek thinking'], ['tool', undefined], ['tool', undefined], ['assistant', undefined], ['user', undefined]]
  )

  // OpenAI: everything is rebuilt from the plain parts.
  const openai = responsesInput({ ...base, connection: connection('openai-responses', 'https://api.openai.com/v1', { provider: 'openai' }) })
  assert.deepEqual(openai, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'Looking.' },
    { type: 'function_call', call_id: 'call:1/a', name: 'read_file', arguments: '{"path":"a.txt"}' },
    { type: 'function_call', call_id: 'call_2', name: 'run_command', arguments: 'not json' },
    { type: 'function_call_output', call_id: 'call:1/a', output: 'file text' },
    { type: 'function_call_output', call_id: 'call_2', output: 'The user denied this tool call.' },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'and now?' }
  ])
})

test("faster answers are asked for in each service's own way, and given up when there is no room for them", async () => {
  // OpenAI: a service tier, named in the request.
  const openai = await fakeService(() => ({
    body: sse([{ type: 'response.output_text.delta', delta: 'ok' } as never, { type: 'response.completed', response: { status: 'completed' } } as never])
  }))
  await turn(connection('openai-responses', openai.baseURL), [{ role: 'user', content: 'hi' }])
  await turn(connection('openai-responses', openai.baseURL, { fast: true }), [{ role: 'user', content: 'hi' }])
  assert.deepEqual(openai.posts().map((p) => p.body.service_tier), [undefined, 'priority'])
  // A model without faster answers refuses the tier; the request goes out again without it.
  const picky = await fakeService((seen) =>
    seen.body?.service_tier
      ? { status: 400, type: 'application/json', body: JSON.stringify({ error: { message: 'This model does not support the requested service tier.', type: 'invalid_request_error', param: 'service_tier' } }) }
      : { body: sse([{ type: 'response.output_text.delta', delta: 'ok' } as never, { type: 'response.completed', response: { status: 'completed' } } as never]) }
  )
  const settled = await turn(connection('openai-responses', picky.baseURL, { fast: true }), [{ role: 'user', content: 'hi' }])
  assert.deepEqual([settled.errors, settled.text], [[], 'ok'])
  assert.deepEqual(picky.posts().map((p) => p.body.service_tier), ['priority', undefined])
  assert.equal(settled.events.filter((e) => e.type === 'notice').length, 1)

  // Claude: a speed, which only the real API is sent.
  const params = (baseURL: string, fast: boolean) =>
    anthropicParams(
      {
        connection: connection('anthropic', baseURL, { model: 'claude-opus-5-5', fast }),
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
        onText: () => {},
        onReasoning: () => {}
      },
      null
    )
  assert.equal(params('https://api.anthropic.com', true).speed, 'fast')
  assert.equal(params('https://api.anthropic.com', false).speed, undefined)
  assert.equal(params('https://gateway.example', true).speed, undefined)

  // Faster answers have a limit of their own. Once the SDK's own tries have run into it, the
  // request goes out again at the usual speed instead of failing the turn.
  const noModel = { status: 404, type: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no such model' } }) }
  const tooMany = {
    status: 429,
    type: 'application/json',
    headers: { 'retry-after-ms': '1' },
    body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'The limit for faster answers is used up.' } })
  }
  const busy = await fakeService((seen, count) => {
    if (seen.method === 'GET') return noModel
    return count <= 3 ? tooMany : { body: claudeStream([{ type: 'text', text: 'At the usual speed.' }], { stop_reason: 'end_turn' }) }
  })
  const slowed = await turn(connection('anthropic', busy.baseURL, { fast: true }), [{ role: 'user', content: 'hi' }])
  assert.deepEqual([slowed.errors, slowed.text], [[], 'At the usual speed.'])
  assert.equal(busy.posts().length, 4)

  // Without the switch, a rate limit is what it always was: reported.
  const limited = await fakeService((seen) => (seen.method === 'GET' ? noModel : tooMany))
  const reported = await turn(connection('anthropic', limited.baseURL), [{ role: 'user', content: 'hi' }])
  assert.match(reported.errors[0], /limit for faster answers is used up/)
  assert.equal(limited.posts().length, 3)
})
