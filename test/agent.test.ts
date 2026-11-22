// Drives the real agent loop against a fake OpenAI-compatible streaming server.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import OpenAI from 'openai'
import { runTurn, today } from '../src/main/agent.ts'
import { cannotStream, chatMessages, refusesTools } from '../src/main/providers/chat.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import type { AgentEvent, ChatMessage, ReasoningEffort } from '../src/shared/types.ts'

/** A chat-completions provider at the fake server. */
const connectionTo = (baseURL: string, reasoningEffort: ReasoningEffort = 'default'): Connection => ({
  provider: 'test',
  kind: 'openai-chat',
  apiKey: 'test',
  baseURL,
  model: 'fake',
  reasoningEffort
})

const chunk = (delta: object): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`

/** One streamed tool call, with the arguments split across chunks as real streams do. */
const call = (index: number, id: string, name: string, args: object): string[] => {
  const json = JSON.stringify(args)
  return [
    chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }),
    chunk({ tool_calls: [{ index, function: { arguments: json.slice(0, 5) } }] }),
    chunk({ tool_calls: [{ index, function: { arguments: json.slice(5) } }] })
  ]
}

/** A request the service turns down instead of answering. `raw` is the answer's whole body, for a server with a shape of its own. */
interface Refusal {
  status: number
  message: string
  raw?: object
}

/** Serves one scripted response per request, a stream or a refusal, and records the request bodies. */
async function fakeModel(scripts: (string[] | Refusal)[]) {
  const requests: {
    messages: Record<string, any>[]
    tools?: { function: { name: string } }[]
    reasoning_effort?: string
  }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const script = scripts[requests.length - 1] ?? []
      if (!Array.isArray(script)) {
        res.writeHead(script.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(script.raw ?? { error: { message: script.message, type: 'invalid_request_error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of script) res.write(part)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { requests, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('a turn streams, runs tools with permission checks and feeds results back', async () => {
  const model = await fakeModel([
    [
      chunk({ role: 'assistant', reasoning_content: 'thinking ' }),
      chunk({ reasoning_content: 'hard' }),
      ...call(0, 'c1', 'write_file', { path: 'sub/a.txt', content: 'line1\r\nprice $1\r\n' }),
      ...call(1, 'c2', 'write_file', { path: '../escape.txt', content: 'x' }),
      ...call(2, 'c3', 'run_command', { command: 'echo hi' })
    ],
    [
      ...call(0, 'c4', 'edit_file', { path: 'sub/a.txt', old_string: 'line1\nprice $1', new_string: 'line1\ncost $& $2' }),
      ...call(1, 'c5', 'search', { pattern: 'cost' }),
      ...call(2, 'c6', 'read_file', { path: 'sub/a.txt' }),
      ...call(3, 'c7', 'plugin_tool', { word: 'hey' })
    ],
    [chunk({ content: 'All ' }), chunk({ content: 'done.' })]
  ])

  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  tools.register({ name: 'plugin_tool', description: 'from a plugin', run: (args) => `got ${String(args.word)}` }, 'demo')

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench-agent-'))
  const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
  const events: AgentEvent[] = []
  const asked: string[] = []
  await runTurn({
    connection: connectionTo(model.baseURL),
    workspace,
    messages,
    signal: new AbortController().signal,
    tools,
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    // "always" for file tools, deny commands
    requestPermission: async (c) => {
      asked.push(c.name)
      return c.name === 'run_command' ? 'deny' : 'always'
    }
  })
  await model.close()

  const results = Object.fromEntries(
    messages.flatMap((m) => (m.role === 'tool' ? [[m.tool_call_id, m.content]] : []))
  ) as Record<string, string>

  assert.equal(model.requests.length, 3)
  assert.equal(model.requests[0].messages[0].role, 'system')
  assert.ok(model.requests[0].tools?.some((t) => t.function.name === 'plugin_tool'), 'registered tools are offered to the model')
  assert.equal(model.requests[1].messages[2].reasoning_content, 'thinking hard', 'reasoning is passed back')
  assert.equal(model.requests[1].messages[2].tool_calls[0].function.name, 'write_file', 'tool calls are wrapped for the API')

  assert.match(results.c1, /^Wrote/)
  assert.match(results.c2, /outside the workspace/)
  assert.equal(results.c3, 'The user denied this tool call.')
  assert.match(results.c5, /sub\/a\.txt:2/)
  assert.equal(results.c6, '1\tline1\n2\tcost $& $2\n3\t', 'read_file numbers lines and strips CR')
  assert.equal(results.c7, 'got hey')
  // write_file was allowed "always", so its second call did not ask again.
  assert.deepEqual(asked, ['write_file', 'run_command', 'edit_file', 'plugin_tool'])
  assert.equal(await readFile(path.join(workspace, 'sub/a.txt'), 'utf8'), 'line1\r\ncost $& $2\r\n', 'edit keeps CRLF and literal $')

  assert.deepEqual(messages.at(-1), {
    role: 'assistant',
    content: 'All done.',
    origin: { provider: 'test', kind: 'openai-chat', model: 'fake' }
  })
  assert.equal(events.at(-1)?.type, 'turn_end')
  assert.equal(events.some((e) => e.type === 'error'), false)
})

test('stopping while a permission prompt is open cancels the remaining calls', async () => {
  const model = await fakeModel([
    [
      ...call(0, 'c1', 'write_file', { path: 'a.txt', content: 'x' }),
      ...call(1, 'c2', 'list_dir', {}),
      ...call(2, 'c3', 'run_command', { command: 'echo hi' })
    ],
    [chunk({ content: 'should never be requested' })]
  ])
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench-agent-'))
  const controller = new AbortController()
  const alwaysAllowed = new Set<string>()
  const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
  const events: AgentEvent[] = []
  await runTurn({
    connection: connectionTo(model.baseURL),
    workspace,
    messages,
    signal: controller.signal,
    tools,
    alwaysAllowed,
    emit: (e) => events.push(e),
    checkpoint: () => {},
    // What the app does on Stop: abort, then release the open prompt with "deny".
    requestPermission: async () => {
      controller.abort()
      return 'deny'
    }
  })
  await model.close()

  const results = messages.flatMap((m) => (m.role === 'tool' ? [m.content] : []))
  assert.deepEqual(results, ['Cancelled by user', 'Cancelled by user', 'Cancelled by user'])
  assert.equal(model.requests.length, 1, 'no further request is made after a stop')
  assert.deepEqual(await readdir(workspace), [], 'nothing was written')
  assert.equal(alwaysAllowed.size, 0)
  assert.equal(events.at(-1)?.type, 'turn_end')
  assert.equal(events.some((e) => e.type === 'error'), false)
})

test('a picked skill and the skills list reach the model', async () => {
  const model = await fakeModel([[chunk({ content: 'ok' })]])
  const stored: ChatMessage = { role: 'user', content: 'do it', skill: { name: 'style', prompt: 'SKILL TEXT' } }
  const messages: ChatMessage[] = [stored]
  await runTurn({
    connection: connectionTo(model.baseURL),
    workspace: os.tmpdir(),
    messages,
    systemExtra: 'Skills:\n- style: House style',
    signal: new AbortController().signal,
    tools: new ToolRegistry(),
    alwaysAllowed: new Set(),
    emit: () => {},
    checkpoint: () => {},
    requestPermission: async () => 'deny'
  })
  await model.close()

  const [system, user] = model.requests[0].messages
  assert.ok(system.content.endsWith('\n\nSkills:\n- style: House style'))
  // The skill text goes in front of what the user typed, and the internal field is not sent.
  assert.deepEqual(user, { role: 'user', content: 'SKILL TEXT\n\ndo it' })
  assert.equal(model.requests[0].tools, undefined, 'no tools parameter when nothing is registered')
  assert.equal(messages[0], stored, 'the stored message keeps its skill field')
})

test('the chosen reasoning effort is sent, and nothing is sent by default', async () => {
  const model = await fakeModel([[chunk({ content: 'a' })], [chunk({ content: 'b' })], [chunk({ content: 'c' })], [chunk({ content: 'd' })]])
  const efforts = ['default', 'none', 'max', 'xhigh'] as const
  for (const reasoningEffort of efforts) {
    await runTurn({
      connection: connectionTo(model.baseURL, reasoningEffort),
      workspace: os.tmpdir(),
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      tools: new ToolRegistry(),
      alwaysAllowed: new Set(),
      emit: () => {},
      checkpoint: () => {},
      requestPermission: async () => 'deny'
    })
  }
  await model.close()

  assert.deepEqual(
    model.requests.map((r) => ('reasoning_effort' in r ? r.reasoning_effort : '(absent)')),
    ['(absent)', 'none', 'max', 'xhigh']
  )
})

/** Runs one turn with the built-in tools, every permission granted, and returns what happened. */
async function plainTurn(baseURL: string, messages: ChatMessage[], extra: { withoutTools?: boolean; wholeReplies?: boolean } = {}) {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const events: AgentEvent[] = []
  let refusals = 0
  let streamRefusals = 0
  const { wholeReplies, ...options } = extra
  await runTurn({
    connection: { ...connectionTo(baseURL), ...(wholeReplies ? { wholeReplies } : {}) },
    workspace: await mkdtemp(path.join(os.tmpdir(), 'starbench-agent-')),
    messages,
    signal: new AbortController().signal,
    tools,
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    requestPermission: async () => 'allow',
    onToolsRefused: () => refusals++,
    onStreamRefused: () => streamRefusals++,
    ...options
  })
  const streamed = (type: 'reasoning_delta' | 'text_delta'): string => events.flatMap((e) => (e.type === type ? [e.text] : [])).join('')
  const said = (type: 'notice' | 'error'): string[] => events.flatMap((e) => (e.type === type ? [e.type === 'notice' ? e.code : e.message] : []))
  return { events, refusals, streamRefusals, reasoning: streamed('reasoning_delta'), text: streamed('text_delta'), notices: said('notice'), errors: said('error') }
}

/**
 * A stand-in for LLaMA-Factory's API, with what sets it apart from the other servers. It cannot
 * stream once tools are offered and notices only after it began to answer, so all the client
 * sees is the line going dead. Its messages have to take strict turns. Its errors come as
 * `{"detail": "..."}`. `replies` are the messages it answers with, one for each request it accepts.
 */
async function fakeFactory(replies: Record<string, unknown>[]) {
  const requests: { stream: boolean; tools?: unknown[]; messages: Record<string, any>[] }[] = []
  let answered = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push(body)
      const turns: { role: string }[] = body.messages[0]?.role === 'system' ? body.messages.slice(1) : body.messages
      const taken = turns.length % 2 === 1 && turns.every((m, i) => (i % 2 === 0 ? ['user', 'tool'] : ['assistant', 'function']).includes(m.role))
      if (!taken) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'Only supports u/a/u/a/u...' }))
        return
      }
      if (body.stream && body.tools) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
        setImmediate(() => req.socket.destroy())
        return
      }
      const message = replies[answered++] ?? { role: 'assistant', content: '' }
      const finish_reason = message.tool_calls ? 'tool_calls' : 'stop'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message, finish_reason }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { requests, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

const wholeCall = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

test('a server that cannot stream once tools are offered is asked for whole replies, in strict turns', async () => {
  const factory = await fakeFactory([
    // Two calls at once: strict turns have room for the result of one.
    { role: 'assistant', content: null, tool_calls: [wholeCall('call_a', 'list_dir', {}), wholeCall('call_b', 'list_dir', { path: 'sub' })] },
    { role: 'assistant', content: '<think>\nIt is empty.\n</think>\n\nNothing here.' },
    { role: 'assistant', content: 'Still nothing.' }
  ])
  // The first message got no answer, as after the failure this is about.
  const messages: ChatMessage[] = [
    { role: 'user', content: 'ping' },
    { role: 'user', content: 'what is here?' }
  ]
  const first = await plainTurn(factory.baseURL, messages)

  assert.deepEqual(first.errors, [])
  assert.deepEqual(factory.requests.map((r) => r.stream), [true, false, false], 'streaming was tried once, and given up for the rest of the turn')
  assert.deepEqual(first.notices, ['stream-refused'], 'the person is told once why nothing moves while a reply is written')
  assert.equal(first.streamRefusals, 1)
  assert.deepEqual(
    factory.requests[1].messages.map((m) => [m.role, m.role === 'system' ? '' : m.content]),
    [['system', ''], ['user', 'ping\n\nwhat is here?']],
    'two user messages in a row go out as one'
  )
  assert.match(factory.requests[1].messages[0].content, new RegExp(`Today's date: ${today()}`))
  assert.deepEqual(factory.requests[2].messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.deepEqual(factory.requests[2].messages[2].tool_calls.map((c: { id: string }) => c.id), ['call_a'], 'one call at a time')
  assert.equal(messages.filter((m) => m.role === 'tool').length, 1)
  assert.equal(first.reasoning, 'It is empty.\n')
  assert.equal(first.text, 'Nothing here.')

  // What was found out is used from the start of the next turn: no failed attempt, nothing said again.
  messages.push({ role: 'user', content: 'and now?' })
  const second = await plainTurn(factory.baseURL, messages, { wholeReplies: true })
  await factory.close()
  assert.deepEqual(factory.requests.slice(3).map((r) => r.stream), [false])
  assert.deepEqual([second.text, second.notices.length, second.streamRefusals, second.errors.length], ['Still nothing.', 0, 0, 0])
})

test('strict turns are kept where the stored conversation has none', () => {
  const origin = { provider: 'test', kind: 'openai-chat' as const, model: 'fake' }
  const twoCalls = [
    { id: 'c1', name: 'list_dir', arguments: '{}' },
    { id: 'c2', name: 'list_dir', arguments: '{"path":"sub"}' }
  ]
  const messages: ChatMessage[] = [
    { role: 'user', content: 'look around' },
    // Written while another server was in use: two results in a row.
    { role: 'assistant', content: '', tool_calls: twoCalls, origin },
    { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
    { role: 'tool', tool_call_id: 'c2', content: 'b.txt' },
    // The turn was stopped before the model answered, and the person wrote again.
    { role: 'user', content: 'never mind' }
  ]
  const shape = (turns: boolean): [string, unknown][] =>
    chatMessages({ messages, system: 'S', connection: connectionTo('http://127.0.0.1:1') }, turns).map((m) => [m.role, m.content])

  assert.deepEqual(shape(true), [
    ['system', 'S'],
    ['user', 'look around'],
    ['assistant', ''],
    ['tool', 'a.txt\n\nb.txt'],
    ['assistant', '(No reply: the turn was stopped here.)'],
    ['user', 'never mind']
  ])
  // Other servers get the conversation as it is: every call needs its own result there.
  assert.deepEqual(shape(false).map(([role]) => role), ['system', 'user', 'assistant', 'tool', 'tool', 'user'])
})

test('a stream that breaks off is taken for "cannot stream" only where that is the likely cause', () => {
  const said = (status: number, message: string): unknown => new OpenAI.APIError(status, { message }, undefined, new Headers())
  const broken = new TypeError('terminated')
  const local = { baseURL: 'http://localhost:8000/v1' }
  const far = { baseURL: 'https://api.example.com/v1' }
  assert.equal(cannotStream(broken, true, local), true, 'the stream of a server of one\'s own broke off before its first piece')
  assert.equal(cannotStream(broken, true, far), false, 'on the internet a broken line is the likelier cause')
  assert.equal(cannotStream(broken, false, local), false, 'a request that never got through is not a stream that broke off')
  assert.equal(cannotStream(said(400, 'Cannot stream function calls.'), false, far), true, 'a server that says so is believed anywhere')
  assert.equal(cannotStream(said(400, 'Streaming is not supported with tools'), false, far), true)
  assert.equal(cannotStream(said(400, 'Invalid role'), false, local), false)
  assert.equal(cannotStream(said(429, 'Rate limit reached'), false, local), false)
})

test("an error in a server's own shape is shown in the server's words", async () => {
  // LLaMA-Factory after a conversation it cannot place: a plain 400 with {"detail": ...}.
  const model = await fakeModel([{ status: 400, message: '', raw: { detail: 'Only supports u/a/u/a/u...' } }])
  const turn = await plainTurn(model.baseURL, [{ role: 'user', content: 'go' }])
  await model.close()
  assert.deepEqual(turn.errors, ['400 Only supports u/a/u/a/u...'])
})

test('the model is told the date on the calendar of the person, not the one in Greenwich', () => {
  // Seven in the morning east of Greenwich is still the day before there.
  assert.equal(today(new Date(2026, 10, 22, 7, 19)), '2026-11-22')
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})

test('thinking that a local server sends as "reasoning" is shown, and handed back under that name', async () => {
  // What Ollama streams for a thinking model: `reasoning`, then a tool call, then the answer.
  const model = await fakeModel([
    [chunk({ role: 'assistant', reasoning: 'look ' }), chunk({ reasoning: 'first' }), ...call(0, 'call_1', 'list_dir', {})],
    [chunk({ content: 'Empty.' })]
  ])
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is here?' }]
  const turn = await plainTurn(model.baseURL, messages)
  await model.close()

  assert.equal(turn.reasoning, 'look first')
  assert.equal(turn.text, 'Empty.')
  const again = model.requests[1].messages[2]
  assert.equal(again.reasoning, 'look first', 'the server gets its thinking back as it named it')
  assert.equal('reasoning_content' in again, false)
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: '',
    reasoning_content: 'look first',
    tool_calls: [{ id: 'call_1', name: 'list_dir', arguments: '{}' }],
    origin: { provider: 'test', kind: 'openai-chat', model: 'fake', replay: { thinking: 'reasoning' } }
  })
})

test('thinking inside the answer is taken out of it, and not sent back', async () => {
  // What a server streams that passes on the model's text as it is.
  const model = await fakeModel([
    [chunk({ role: 'assistant', content: '<th' }), chunk({ content: 'ink>\nlook first' }), chunk({ content: '\n</think>\n\n' }), ...call(0, 'call_1', 'list_dir', {})],
    [chunk({ content: '<think>done</think>' }), chunk({ content: 'Empty.' })]
  ])
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is here?' }]
  const turn = await plainTurn(model.baseURL, messages)
  await model.close()

  assert.equal(turn.reasoning, 'look first\ndone')
  assert.equal(turn.text, 'Empty.')
  const again = model.requests[1].messages[2]
  assert.deepEqual(Object.keys(again).sort(), ['content', 'role', 'tool_calls'], 'a server without a field for thinking is not sent one')
  assert.equal(again.content, '')
  assert.deepEqual(messages.at(-1), {
    role: 'assistant',
    content: 'Empty.',
    reasoning_content: 'done',
    origin: { provider: 'test', kind: 'openai-chat', model: 'fake', replay: { thinking: 'inline' } }
  })
})

test('a model that takes no tools is talked to without them', async () => {
  const model = await fakeModel([
    { status: 400, message: 'registry.ollama.ai/library/tiny:latest does not support tools' },
    [chunk({ content: 'I can only chat.' })],
    [chunk({ content: 'Still chatting.' })]
  ])
  const messages: ChatMessage[] = [{ role: 'user', content: 'list the files' }]
  const first = await plainTurn(model.baseURL, messages)

  assert.equal(model.requests.length, 2, 'the message went out again')
  assert.ok(model.requests[0].tools?.length, 'tools were offered at first')
  assert.equal(model.requests[1].tools, undefined, 'and left out the second time')
  assert.match(model.requests[0].messages[0].content, /Workspace root/)
  assert.match(model.requests[1].messages[0].content, /cannot call tools/, 'the model is told that it has none')
  assert.equal(first.text, 'I can only chat.')
  assert.equal(first.refusals, 1)
  const notices = first.events.flatMap((e) => (e.type === 'notice' ? [e] : []))
  assert.deepEqual(notices.map((n) => n.code), ['tools-refused'])
  assert.match(notices[0].detail ?? '', /does not support tools/, "the service's own words go along")
  assert.equal(first.events.some((e) => e.type === 'error'), false)

  // Once that is known, the next message goes out without tools at once, and nothing is said again.
  messages.push({ role: 'user', content: 'and now?' })
  const second = await plainTurn(model.baseURL, messages, { withoutTools: true })
  await model.close()
  assert.equal(model.requests.length, 3)
  assert.equal(model.requests[2].tools, undefined)
  assert.equal(second.text, 'Still chatting.')
  assert.deepEqual([second.refusals, second.events.filter((e) => e.type === 'notice').length], [0, 0])
})

test('an error about one tool is reported, not taken for a model without tools', async () => {
  const model = await fakeModel([{ status: 400, message: "Invalid schema for function 'list_dir': 'object' is not of type 'array'" }])
  const turn = await plainTurn(model.baseURL, [{ role: 'user', content: 'go' }])
  await model.close()

  assert.equal(model.requests.length, 1, 'nothing is sent again')
  assert.equal(turn.refusals, 0)
  assert.match(turn.events.flatMap((e) => (e.type === 'error' ? [e.message] : [])).join(), /Invalid schema/)
})

test('a local model server that is not running is named as the problem', async () => {
  // An address nothing listens at: a server is started to learn a free port, and closed again.
  const model = await fakeModel([])
  await model.close()
  const turn = await plainTurn(model.baseURL, [{ role: 'user', content: 'anyone there?' }])

  const errors = turn.events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
  assert.deepEqual(errors, [`Could not reach the model server at ${model.baseURL}. Is it running?`])
  assert.equal(turn.events.at(-1)?.type, 'turn_end')
})

test('every server has its own words for taking no tools', () => {
  const said = (status: number, message: string): unknown => new OpenAI.APIError(status, { message }, undefined, new Headers())
  for (const [status, message] of [
    [400, 'registry.ollama.ai/library/gemma3:latest does not support tools'],
    [500, 'tools param requires --jinja flag'],
    [400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set'],
    [404, 'No endpoints found that support tool use.'],
    [400, "This model doesn't support function calling"],
    [400, 'Tool calling is not supported for this model']
  ] as const) {
    assert.equal(refusesTools(said(status, message)), true, message)
  }
  for (const [status, message] of [
    [400, "Invalid schema for function 'list_dir': 'object' is not of type 'array'"],
    [400, 'This model does not support images. Use tools to describe them instead.'],
    [401, 'Incorrect API key provided'],
    [429, 'Rate limit reached for requests']
  ] as const) {
    assert.equal(refusesTools(said(status, message)), false, message)
  }
  assert.equal(refusesTools(new Error('does not support tools')), false, 'only what a service answered counts')
})
