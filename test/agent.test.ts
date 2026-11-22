// Drives the real agent loop against a fake OpenAI-compatible streaming server.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import OpenAI from 'openai'
import { builtinPrompt, runTurn, systemPrompt, today } from '../src/main/agent.ts'
import type { TurnOptions } from '../src/main/agent.ts'
import { cannotStream, chatMessages, refusesStreamOptions, refusesTools } from '../src/main/providers/chat.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import type { ExchangeDraft } from '../src/main/trace.ts'
import type { StepMeasure } from '../src/shared/stats.ts'
import type { AgentEvent, ChatMessage, CustomPrompt, ReasoningEffort } from '../src/shared/types.ts'

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
async function plainTurn(
  baseURL: string,
  messages: ChatMessage[],
  extra: { textTools?: boolean; wholeReplies?: boolean; prompt?: CustomPrompt; trace?: TurnOptions['trace']; sampling?: TurnOptions['sampling']; stats?: TurnOptions['stats'] } = {}
) {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const events: AgentEvent[] = []
  let refusals = 0
  let streamRefusals = 0
  const { wholeReplies, textTools, prompt, ...options } = extra
  await runTurn({
    connection: { ...connectionTo(baseURL), ...(wholeReplies ? { wholeReplies } : {}), ...(textTools ? { textTools } : {}), ...(prompt ? { prompt } : {}) },
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

test("the app's prompt describes a job, not a name, and the person's own prompt follows it or stands in its place", async () => {
  const skills = 'Skills:\n- style: House style'
  const own = systemPrompt({ workspace: 'D:\\work', extra: skills })
  assert.ok(own.startsWith('You are working as a coding agent inside StarBench'))
  // "You are a coding agent" is what models took for their name.
  assert.doesNotMatch(own, /You are a coding agent/)
  assert.match(own, /not who you are\. When asked who you are or which model you are, say what model you are/)
  assert.match(own, /Workspace root: D:\\work\n/)
  assert.ok(own.endsWith(`\n\n${skills}`))

  // Left to its memory a model names another one, or says it was not told: it is told which one the settings name.
  const told = systemPrompt({ workspace: 'D:\\work', model: { id: 'deepseek-flash', provider: 'DeepSeek' } })
  assert.match(told, /\n\nModel in use: deepseek-flash \(provider: DeepSeek\)\nWorkspace root: /)
  assert.match(told, /which model you are, name the model in use given above instead of answering from memory/)
  assert.match(systemPrompt({ workspace: 'w', model: { id: 'm' } }), /\nModel in use: m\n/)
  assert.equal(
    builtinPrompt(),
    systemPrompt({
      workspace: '<the workspace folder of the conversation>',
      model: { id: '<the model chosen>', provider: '<its provider>' },
      language: '<the language of the conversation>'
    }),
    'what the page shows is what is sent'
  )

  // After the app's instructions, before the skills.
  const added = systemPrompt({ workspace: 'D:\\work', custom: { text: '  Always answer in French.  ', replace: false }, extra: skills })
  assert.ok(added.startsWith('You are working as a coding agent'))
  assert.ok(added.endsWith(`\n\nAlways answer in French.\n\n${skills}`))

  // In their place: nothing of the app's is left but what the tools depend on.
  const replaced = systemPrompt({
    workspace: 'D:\\work',
    model: { id: 'qwen 3.5 9b', provider: 'Local' },
    custom: { text: 'You are Mei, a helpful assistant.', replace: true },
    extra: skills
  })
  assert.ok(replaced.startsWith('You are Mei, a helpful assistant.\n\nWorkspace root: D:\\work\n'))
  // Not even the model's name: a prompt written for a model of one's own says who it is.
  assert.doesNotMatch(replaced, /coding agent|Guidelines|StarBench|Model in use|qwen/)
  assert.match(replaced, /Shell used by run_command: .+\nToday's date: /)
  assert.ok(replaced.endsWith(`\n\n${skills}`))
  assert.equal(systemPrompt({ workspace: 'w', custom: { text: '   ', replace: true } }), systemPrompt({ workspace: 'w' }), 'a prompt without text is none')

  // The prompt kept with the provider is the one that goes out.
  const model = await fakeModel([[chunk({ content: 'Bonjour.' })]])
  await plainTurn(model.baseURL, [{ role: 'user', content: 'hi' }], { prompt: { text: 'Always answer in French.', replace: false } })
  await model.close()
  assert.ok(model.requests[0].messages[0].content.endsWith('\n\nAlways answer in French.'))
  assert.match(model.requests[0].messages[0].content, /\nModel in use: fake\n/, 'with the name of the model the turn talks to')
})

test('the model is told which language the person writes in, so that it thinks in it', async () => {
  // The wording that real models followed: the language as a fact, the thinking by name, and weight.
  const line = 'IMPORTANT: The user writes in Chinese. Write your reasoning (your thinking before the answer) in Chinese as well, never in English.'
  const skills = 'Skills:\n- style: House style'

  // Last of the app's own instructions, before the person's, which may say otherwise.
  assert.ok(systemPrompt({ workspace: 'w', language: 'Chinese', extra: skills }).endsWith(`in StarBench.\n\n${line}\n\n${skills}`))
  assert.ok(systemPrompt({ workspace: 'w', language: 'Chinese', custom: { text: 'Think in English.', replace: false } }).endsWith(`\n\n${line}\n\nThink in English.`))
  // Where the person's prompt stands in place of the app's, the language to think in is theirs to say.
  assert.doesNotMatch(systemPrompt({ workspace: 'w', language: 'Chinese', custom: { text: 'You are Mei.', replace: true } }), /IMPORTANT|reasoning/)
  // No language shown, nothing said.
  assert.doesNotMatch(systemPrompt({ workspace: 'w' }), /IMPORTANT|reasoning/)
  assert.match(builtinPrompt(), /\n\nIMPORTANT: The user writes in <the language of the conversation>\. Write your reasoning .+ in <the language of the conversation> as well, never in English\.$/)

  // What goes out: the language of the conversation, at every step of a turn and after a word that shows none.
  const model = await fakeModel([[...call(0, 'c1', 'list_dir', {})], [chunk({ content: '是空的。' })], [chunk({ content: '好。' })], [chunk({ content: 'Hi.' })]])
  const messages: ChatMessage[] = [{ role: 'user', content: '这个文件夹里有什么？' }]
  await plainTurn(model.baseURL, messages)
  messages.push({ role: 'user', content: 'ok' })
  await plainTurn(model.baseURL, messages)
  await plainTurn(model.baseURL, [{ role: 'user', content: 'hi' }])
  await model.close()
  const systems = model.requests.map((r) => String(r.messages[0].content))
  assert.equal(systems.length, 4)
  for (const system of systems.slice(0, 3)) assert.ok(system.endsWith(`\n\n${line}`))
  assert.equal(systems[1], systems[0], 'the same words at each step, so what the service keeps of them stays good')
  assert.doesNotMatch(systems[3], /IMPORTANT/)
})

test('while someone watches, each request and its reply are written down as they went over the wire', async (t) => {
  /** A piece of a stream as the service sends it, for the pieces that carry more than text. */
  const piece = (body: object): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', ...body })}\n\n`
  const ending = (reason: string, usage: object): string[] => [piece({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }), piece({ choices: [], usage })]
  const model = await fakeModel([
    [chunk({ role: 'assistant', reasoning_content: 'look first' }), ...call(0, 'c1', 'list_dir', {}), ...ending('tool_calls', { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 })],
    [chunk({ content: 'It is ' }), chunk({ content: 'empty.' }), ...ending('stop', { prompt_tokens: 60, completion_tokens: 4, total_tokens: 64 })],
    // Not a status the client tries again by itself.
    { status: 400, message: 'This model does not take that field' }
  ])
  // Closed whatever a check below finds, or the run would wait for it without end.
  t.after(() => model.close())
  const seen: ExchangeDraft[] = []
  const trace = { active: true, record: (exchange: ExchangeDraft) => void seen.push(exchange) }
  const sampling = { paramsFor: () => ({ temperature: 0.3, top_p: 0.9 }) }
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is in here?' }]

  const before = Date.now()
  await plainTurn(model.baseURL, messages, { trace, sampling })
  assert.equal(seen.length, 2, 'one for each request: the model called a tool and was asked again')

  const [first, second] = seen
  // Who it went to. No address and no key among it.
  assert.deepEqual(first.provider, { id: 'test', name: 'test', kind: 'openai-chat', local: true })
  assert.equal(first.model, 'fake')
  assert.ok(first.at >= before && first.at <= Date.now())
  assert.doesNotMatch(JSON.stringify(seen), /"apiKey"|authorization|Bearer/i)

  // The request, field for field as it was sent: what the fake server received is what the record holds.
  assert.equal(first.request.wire, true)
  assert.deepEqual(first.request.body, model.requests[0])
  assert.deepEqual(second.request.body, model.requests[1])
  const sent = first.request.body as { model: string; stream: boolean; temperature: number; top_p: number; stream_options: unknown; messages: { role: string }[]; tools: unknown[] }
  assert.deepEqual([sent.model, sent.stream, sent.temperature, sent.top_p], ['fake', true, 0.3, 0.9], 'with what plugins added to it')
  assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user'])
  assert.equal(sent.tools.length, 6)
  assert.deepEqual((second.request.body as { messages: { role: string }[] }).messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool'])
  // What a streamed reply cost is asked for, since it is told only then.
  assert.deepEqual(sent.stream_options, { include_usage: true })

  // The reply as it came, why it ended, what it cost and how it arrived.
  assert.deepEqual(first.reply, { text: '', reasoning: 'look first', toolCalls: [{ name: 'list_dir', arguments: '{}' }] })
  assert.deepEqual([first.finish, first.usage, first.attempts], ['tool_calls', { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 }, 1])
  assert.deepEqual(second.reply, { text: 'It is empty.', reasoning: '', toolCalls: [] })
  assert.deepEqual([second.finish, second.usage, second.pieces], ['stop', { prompt_tokens: 60, completion_tokens: 4, total_tokens: 64 }, 2])
  assert.equal(first.pieces, 1, 'the pieces of text and thinking; the pieces of a tool call are not the reply being read')
  assert.ok(typeof first.timing.first === 'number' && first.timing.first <= first.timing.total)
  assert.equal(first.error, undefined)

  // The record is a copy: changing it changes neither the conversation nor what is sent next.
  ;(first.request.body as { messages: { content: string }[] }).messages[1].content = 'CHANGED'
  assert.equal(messages[0].role === 'user' && messages[0].content, 'what is in here?')

  // A request the service turns down is written down too, with what it said.
  messages.push({ role: 'user', content: 'again' })
  const failed = await plainTurn(model.baseURL, messages, { trace })
  assert.equal(seen.length, 3)
  assert.match(seen[2].error ?? '', /400.*does not take that field/)
  assert.deepEqual(seen[2].reply, { text: '', reasoning: '', toolCalls: [] })
  assert.deepEqual(failed.errors.length, 1, 'and the person is told as before')
})

test('while nobody watches, nothing is written down and nothing more is asked of the service', async () => {
  const model = await fakeModel([[chunk({ content: 'Hi.' })], [chunk({ content: 'Hi again.' })]])
  // Not there at all, and there but not watching.
  await plainTurn(model.baseURL, [{ role: 'user', content: 'hi' }])
  let records = 0
  const idle = { active: false, record: () => void records++ }
  await plainTurn(model.baseURL, [{ role: 'user', content: 'hi' }], { trace: idle })
  await model.close()
  assert.equal(records, 0)
  for (const request of model.requests) assert.equal('stream_options' in request, false, 'a server that does not know the field is never sent it')
})

test('a server that refuses the field the cost is asked with is asked again without it, and not sent it again', async (t) => {
  // The way a FastAPI server with a strict schema turns it down.
  const refusal = { status: 422, message: '', raw: { detail: [{ type: 'extra_forbidden', loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted' }] } }
  const model = await fakeModel([refusal, [chunk({ content: 'Hello.' })], [chunk({ content: 'Hello again.' })], { status: 400, message: 'Unknown parameter: frequency' }])
  t.after(() => model.close())
  const seen: ExchangeDraft[] = []
  const trace = { active: true, record: (exchange: ExchangeDraft) => void seen.push(exchange) }
  const hi: ChatMessage[] = [{ role: 'user', content: 'hi' }]

  const first = await plainTurn(model.baseURL, hi, { trace })
  assert.deepEqual([first.text, first.errors], ['Hello.', []], 'the watching does not break the conversation')
  assert.deepEqual(model.requests.map((request) => 'stream_options' in request), [true, false])
  assert.equal(seen.length, 1, 'one exchange, though it took two requests')
  assert.deepEqual([seen[0].attempts, seen[0].error, seen[0].usage, seen[0].reply.text], [2, undefined, undefined, 'Hello.'])
  assert.deepEqual(seen[0].request.body, model.requests[1], 'the record holds the request that was answered')

  // The next request to that server leaves the field out from the start.
  await plainTurn(model.baseURL, hi, { trace })
  assert.equal(model.requests.length, 3)
  assert.equal('stream_options' in model.requests[2], false)
  assert.equal(seen[1].attempts, 1)

  // A refusal over something else is not taken for it: it is reported, and not tried again.
  const other = await plainTurn(model.baseURL, hi, { trace })
  assert.equal(model.requests.length, 4)
  assert.equal(other.errors.length, 1)

  const said = (status: number, message: string): unknown => new OpenAI.APIError(status, { message }, undefined, new Headers())
  for (const [status, message] of [
    [422, '[{"type":"extra_forbidden","loc":["body","stream_options"],"msg":"Extra inputs are not permitted"}]'],
    [400, 'Unrecognized request argument supplied: stream_options'],
    [400, 'json: unknown field "stream_options"'],
    [400, "Unsupported parameter: 'stream_options.include_usage'"]
  ] as const) {
    assert.equal(refusesStreamOptions(said(status, message)), true, message)
  }
  assert.equal(refusesStreamOptions(said(400, 'Only supports u/a/u/a/u...')), false)
  assert.equal(refusesStreamOptions(said(500, 'stream_options: internal error')), false, 'a server that broke down did not turn the field down')
  assert.equal(refusesStreamOptions(new Error('stream_options')), false, 'only what a service answered counts')
})

test('while the app keeps count, every request is measured and the service is asked what it cost', async (t) => {
  const piece = (body: object): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', ...body })}

`
  const ending = (reason: string, usage: object): string[] => [piece({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }), piece({ choices: [], usage })]
  const model = await fakeModel([
    // The way OpenAI tells how much of the input came from its cache, and the way DeepSeek does.
    [chunk({ role: 'assistant', reasoning_content: 'look first' }), ...call(0, 'c1', 'list_dir', {}), ...ending('tool_calls', { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } })],
    [chunk({ content: 'It is ' }), chunk({ content: 'empty.' }), ...ending('stop', { prompt_tokens: 1100, completion_tokens: 6, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 100 })],
    [chunk({ content: 'Still empty.' }), ...ending('stop', { prompt_tokens: 1200, completion_tokens: 3 })]
  ])
  t.after(() => model.close())
  const steps: StepMeasure[] = []
  const toolTimes: number[] = []
  const stats = { step: (measure: StepMeasure) => void steps.push(measure), tool: (ms: number) => void toolTimes.push(ms) }
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is in here?' }]

  await plainTurn(model.baseURL, messages, { stats })
  assert.equal(steps.length, 2, 'one for each request: the model called a tool and was asked again')
  assert.deepEqual(steps.map((s) => s.usage), [{ input: 200, cacheRead: 800, output: 20 }, { input: 100, cacheRead: 1000, output: 6 }])
  // Nobody watches, and the cost is asked for all the same: the counting needs it.
  assert.deepEqual(model.requests.map((request) => 'stream_options' in request), [true, true])
  assert.ok(steps.every((s) => typeof s.firstMs === 'number' && s.firstMs <= s.ms), 'when the first piece came, and how long the whole took')
  assert.deepEqual(steps.map((s) => s.pieces), [1, 2], 'the pieces of thinking and text; a tool call is not read')
  assert.deepEqual(steps.map((s) => [s.provider, s.model]), [['test', 'fake'], ['test', 'fake']])
  // A guess at what the request weighs, part by part: instructions and tools stay as they are from
  // one request to the next, and the second carries the tool call and what the tool returned.
  const [one, two] = steps.map((s) => s.parts)
  assert.ok((one.system ?? 0) > 100 && (one.tools ?? 0) > 100 && (one.messages ?? 0) > 0)
  assert.deepEqual([two.system, two.tools, two.messages], [one.system, one.tools, one.messages])
  assert.equal(one.toolResults, undefined)
  assert.ok((two.toolResults ?? 0) > 0)
  assert.deepEqual(Object.keys(one).sort(), ['messages', 'system', 'tools'], 'a part that is not in the request is not listed')
  assert.equal(toolTimes.length, 1, 'the one tool call was timed')
  assert.ok(toolTimes[0] >= 0)

  // A plugin that watches at the same time gets its record as before, and the count is kept beside it.
  const seen: ExchangeDraft[] = []
  messages.push({ role: 'user', content: 'and now?' })
  await plainTurn(model.baseURL, messages, { stats, trace: { active: true, record: (exchange) => void seen.push(exchange) } })
  assert.deepEqual(steps[2].usage, { input: 1200, output: 3 }, 'a server that says nothing of a cache leaves that unknown')
  assert.deepEqual([seen.length, seen[0].usage, seen[0].reply.text], [1, { prompt_tokens: 1200, completion_tokens: 3 }, 'Still empty.'])
  assert.deepEqual(seen[0].request.body, model.requests[2])
})

test('a reply that came whole has no first piece to time', async () => {
  // LLaMA-Factory: no stream once tools are offered, so the reply is asked for in one piece.
  const factory = await fakeFactory([{ role: 'assistant', content: 'In one piece.' }])
  const steps: StepMeasure[] = []
  await plainTurn(factory.baseURL, [{ role: 'user', content: 'go' }], { stats: { step: (measure) => void steps.push(measure), tool: () => {} } })
  await factory.close()
  assert.equal(steps.length, 1)
  assert.deepEqual([steps[0].firstMs, steps[0].usage, steps[0].pieces], [undefined, undefined, 1], 'and this stand-in tells no usage either')
  assert.ok(steps[0].ms >= 0)
})

test('a reply that had to be asked for a second way is one exchange, with the request that got it', async () => {
  // LLaMA-Factory: the stream dies at once when tools are offered, and the reply is asked for in one piece.
  const factory = await fakeFactory([{ role: 'assistant', content: 'In one piece.' }])
  const seen: ExchangeDraft[] = []
  await plainTurn(factory.baseURL, [{ role: 'user', content: 'go' }], { trace: { active: true, record: (exchange) => void seen.push(exchange) } })
  await factory.close()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].attempts, 2)
  assert.equal((seen[0].request.body as { stream: boolean }).stream, false, 'the request that was answered')
  assert.equal('stream_options' in (seen[0].request.body as object), false, 'a reply in one piece says what it cost unasked')
  assert.equal(seen[0].reply.text, 'In one piece.')
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

/** The piece of a stream that says why the reply ended. */
const ended = (reason: string): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`

test('a server that takes no tool definitions has the tools described to the model, and the calls read from its answers', async () => {
  const model = await fakeModel([
    // vLLM that was started without the two flags that make it hand tool calls over.
    { status: 400, message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' },
    // The call as Qwen 3.5 writes it, cut up by the stream in the middle of its tags.
    [
      chunk({ role: 'assistant', content: 'Let me save that.\n\n<tool' }),
      chunk({ content: '_call>\n<function=write_file>\n<parameter=path>\nnotes.txt\n</parameter>\n<parameter=content>\nline one\nline "two"\n</para' }),
      chunk({ content: 'meter>\n</function>\n</tool_call>' })
    ],
    // Two at once, in the form Hermes and the older Qwen models write.
    [chunk({ content: '<tool_call>\n{"name": "read_file", "arguments": {"path": "notes.txt"}}\n</tool_call>\n<tool_call>\n{"name": "list_dir", "arguments": {}}\n</tool_call>' })],
    [chunk({ content: 'Saved and checked.' })],
    [chunk({ content: 'Still here.' })]
  ])
  const messages: ChatMessage[] = [{ role: 'user', content: 'save my notes' }]
  const first = await plainTurn(model.baseURL, messages)

  assert.deepEqual(first.errors, [])
  assert.equal(model.requests.length, 4, 'the refused message went out again, and the turn went on from there')
  assert.ok(model.requests[0].tools?.length, 'the tools were handed over at first')
  assert.deepEqual(model.requests.slice(1).map((r) => r.tools), [undefined, undefined, undefined], 'and not again')
  // The instructions are the same ones, with the tools at their end.
  const [asked, told] = model.requests.map((r) => String(r.messages[0].content))
  assert.match(asked, /coding agent/)
  assert.ok(told.startsWith(`${asked}\n\n# Tools\n\nYou have access to the following functions:\n\n<tools>\n{"type":"function","function":{"name":"read_file",`))
  assert.match(told, /\n\{"type":"function","function":\{"name":"run_command",.+\}\n<\/tools>\n/)
  assert.match(told, /<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>/)

  // The person is told once what that means, with the server's own words.
  const notices = first.events.flatMap((e) => (e.type === 'notice' ? [e] : []))
  assert.deepEqual(notices.map((n) => n.code), ['tools-as-text'])
  assert.match(notices[0].detail ?? '', /--enable-auto-tool-choice/, "the service's own words go along")
  assert.equal(first.refusals, 1)

  // Of the answers, what was said is shown; the calls are run.
  assert.equal(first.text, 'Let me save that.\n\nSaved and checked.')
  const [saved, looked] = messages.flatMap((m) => (m.role === 'assistant' ? [m] : []))
  assert.equal(saved.content, 'Let me save that.')
  assert.deepEqual(saved.tool_calls?.map((c) => [c.name, JSON.parse(c.arguments)]), [['write_file', { path: 'notes.txt', content: 'line one\nline "two"' }]])
  assert.deepEqual(looked.tool_calls?.map((c) => [c.name, c.arguments]), [['read_file', '{"path":"notes.txt"}'], ['list_dir', '{}']])
  for (const made of [...(saved.tool_calls ?? []), ...(looked.tool_calls ?? [])]) assert.match(made.id, /^[A-Za-z0-9]{9}$/, 'a call that came without an id is given one')
  assert.deepEqual(messages.flatMap((m) => (m.role === 'tool' ? [m.content] : [])), ['Wrote 19 characters to notes.txt', '1\tline one\n2\tline "two"', 'notes.txt'])

  // What goes back is written the same way: the call in the reply that made it, the results as the user's.
  const written = '<tool_call>\n<function=write_file>\n<parameter=path>\nnotes.txt\n</parameter>\n<parameter=content>\nline one\nline "two"\n</parameter>\n</function>\n</tool_call>'
  assert.deepEqual(model.requests[2].messages.slice(1), [
    { role: 'user', content: 'save my notes' },
    { role: 'assistant', content: `Let me save that.\n\n${written}` },
    { role: 'user', content: '<tool_response>\nWrote 19 characters to notes.txt\n</tool_response>' }
  ])
  assert.deepEqual(model.requests[3].messages.slice(3), [
    { role: 'user', content: '<tool_response>\nWrote 19 characters to notes.txt\n</tool_response>' },
    { role: 'assistant', content: '<tool_call>\n<function=read_file>\n<parameter=path>\nnotes.txt\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=list_dir>\n</function>\n</tool_call>' },
    { role: 'user', content: '<tool_response>\n1\tline one\n2\tline "two"\n</tool_response>\n<tool_response>\nnotes.txt\n</tool_response>' }
  ])

  // Once that is known, the next message goes out that way at once, and nothing is said again.
  messages.push({ role: 'user', content: 'and now?' })
  const second = await plainTurn(model.baseURL, messages, { textTools: true })
  await model.close()
  assert.equal(model.requests.length, 5)
  assert.equal(model.requests[4].tools, undefined)
  assert.match(String(model.requests[4].messages[0].content), /\n\n# Tools\n/)
  assert.equal(second.text, 'Still here.')
  assert.deepEqual([second.refusals, second.events.filter((e) => e.type === 'notice').length], [0, 0])
})

test('a model whose template knows no tools is told of them the same way', async () => {
  const model = await fakeModel([{ status: 400, message: 'registry.ollama.ai/library/tiny:latest does not support tools' }, [chunk({ content: 'I would rather just talk.' })]])
  const turn = await plainTurn(model.baseURL, [{ role: 'user', content: 'list the files' }])
  await model.close()
  assert.equal(model.requests.length, 2)
  assert.equal(model.requests[1].tools, undefined)
  assert.match(String(model.requests[1].messages[0].content), /Workspace root: .+\n\n# Tools\n/s)
  // A model that does not take them up answers as it would have: what it writes is shown as it is.
  assert.deepEqual([turn.text, turn.notices, turn.errors, turn.refusals], ['I would rather just talk.', ['tools-as-text'], [], 1])
})

test('a call that a server left in the answer is run like one it handed over', async () => {
  const model = await fakeModel([
    // The server took the tools, and has no parser for the form this model writes its calls in.
    [chunk({ role: 'assistant', content: 'I will look.\n\n' }), chunk({ content: '<tool_call>\n<function=list_dir>\n</function>\n</tool_call>' })],
    // No tags around it at all: the server took them off and made no call of it.
    [chunk({ content: 'Now the file.\n\n{"name": "read_file", ' }), chunk({ content: '"arguments": {"path": "missing.txt"}}' })],
    [chunk({ content: 'Nothing there.' })]
  ])
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is here?' }]
  const turn = await plainTurn(model.baseURL, messages)
  await model.close()

  assert.deepEqual([turn.errors, turn.notices], [[], []])
  assert.equal(model.requests.length, 3)
  assert.ok(model.requests.every((r) => r.tools?.length), 'the tools go on being handed over')
  // Sent back the way any call is, under an id of its own, for the server to write out as its template has it.
  const [listed, listing] = model.requests[1].messages.slice(2)
  assert.equal(listed.content, 'I will look.')
  assert.deepEqual(listed.tool_calls.map((c: { type: string; function: object }) => [c.type, c.function]), [['function', { name: 'list_dir', arguments: '{}' }]])
  assert.match(listed.tool_calls[0].id, /^[A-Za-z0-9]{9}$/)
  assert.deepEqual(listing, { role: 'tool', tool_call_id: listed.tool_calls[0].id, content: '(empty directory)' })
  const [read, missing] = model.requests[2].messages.slice(4)
  assert.equal(read.content, 'Now the file.')
  assert.deepEqual(read.tool_calls[0].function, { name: 'read_file', arguments: '{"path":"missing.txt"}' })
  assert.match(missing.content, /^Error: /)

  // The call between tags never reached the page. The one without was shown as it came, so the page is told the text anew.
  assert.equal(turn.text, 'I will look.\n\nNow the file.\n\n{"name": "read_file", "arguments": {"path": "missing.txt"}}Nothing there.')
  assert.deepEqual(turn.events.filter((e) => e.type === 'assistant_rewrite'), [{ type: 'assistant_rewrite', text: 'Now the file.', reasoning: '' }])
})

test('thinking that comes without its opening tag is taken out of the answer', async () => {
  // What a server passes on of a model whose template wrote the opening tag for it (Qwen 3.5 on
  // a server without a parser for its thinking): the thinking, a closing tag, the answer.
  const model = await fakeModel([
    [chunk({ role: 'assistant', content: 'The user wants the list' }), chunk({ content: '.\n</thi' }), chunk({ content: 'nk>\n\n' }), ...call(0, 'call_1', 'list_dir', {})],
    [chunk({ content: 'It is empty, so ' }), chunk({ content: 'I say so.\n</think>\n\nNothing ' }), chunk({ content: 'here.' })],
    // This time the model did not think.
    [chunk({ content: 'Still ' }), chunk({ content: 'nothing.' })],
    [chunk({ content: 'Once more.\n</think>\n\nAnd again nothing.' })]
  ])
  const origin = { provider: 'test', kind: 'openai-chat', model: 'fake', replay: { thinking: 'inline' } }
  const rewrites = (events: AgentEvent[]) => events.filter((e) => e.type === 'assistant_rewrite')
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is here?' }]

  // The first answer is shown as it comes, since nothing says yet that it is thinking. When the
  // tag comes, the page is told that what it has was the thinking.
  const first = await plainTurn(model.baseURL, messages)
  assert.deepEqual(first.errors, [])
  assert.deepEqual(rewrites(first.events), [{ type: 'assistant_rewrite', text: '', reasoning: 'The user wants the list.\n' }])
  assert.deepEqual(messages[1], { role: 'assistant', content: '', reasoning_content: 'The user wants the list.\n', tool_calls: [{ id: 'call_1', name: 'list_dir', arguments: '{}' }], origin })
  // From then on this model's answers are read as thinking from their first word.
  assert.equal(first.text, 'The user wants the list.\nNothing here.')
  assert.equal(first.reasoning, 'It is empty, so I say so.\n')
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'Nothing here.', reasoning_content: 'It is empty, so I say so.\n', origin })
  // The thinking is not sent back: such a server has no field for it.
  const again = model.requests[1].messages[2]
  assert.deepEqual([Object.keys(again).sort(), again.content], [['content', 'role', 'tool_calls'], ''])

  // An answer without thinking was taken for thinking: the page is told so, and gets it as the answer.
  messages.push({ role: 'user', content: 'and now?' })
  const second = await plainTurn(model.baseURL, messages)
  assert.deepEqual(
    second.events.map((e) => (e.type === 'reasoning_delta' || e.type === 'text_delta' ? `${e.type} ${e.text}` : e.type === 'assistant_rewrite' ? `rewrite ${JSON.stringify([e.text, e.reasoning])}` : e.type)),
    ['reasoning_delta Still ', 'reasoning_delta nothing.', 'rewrite ["",""]', 'text_delta Still nothing.', 'assistant_done', 'turn_end']
  )
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'Still nothing.', origin: { provider: 'test', kind: 'openai-chat', model: 'fake' } })

  // After that, the next one is no longer taken for thinking unasked: it is watched again.
  messages.push({ role: 'user', content: 'and now?' })
  const third = await plainTurn(model.baseURL, messages)
  await model.close()
  assert.deepEqual([third.reasoning, third.text, rewrites(third.events)], ['Once more.\n', 'And again nothing.', []])
})

test('a tool call that the model only thought about is not run', async () => {
  const thought = 'Maybe I call it like this:\n<tool_call>\n<function=run_command>\n<parameter=command>\necho no\n</parameter>\n</function>\n</tool_call>\nNo, listing is enough.\n'
  const model = await fakeModel([
    // The first answer of this model: its thinking comes as text, and the call in it is held back like any call.
    [chunk({ content: thought.slice(0, 40) }), chunk({ content: thought.slice(40) }), chunk({ content: '</think>\n\nLooking.\n\n<tool_call>\n<function=list_dir>\n</function>\n</tool_call>' })],
    // The second: its thinking is known for what it is, and never looked through for calls.
    [chunk({ content: `${thought}</think>\n\nEmpty.` })]
  ])
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is here?' }]
  const turn = await plainTurn(model.baseURL, messages)
  await model.close()

  assert.deepEqual(turn.errors, [])
  assert.deepEqual(turn.events.flatMap((e) => (e.type === 'tool_start' ? [e.call.name] : [])), ['list_dir'], 'only the call in the answer was run')
  const [looked, answered] = messages.flatMap((m) => (m.role === 'assistant' ? [m] : []))
  assert.deepEqual([looked.reasoning_content, looked.content, looked.tool_calls?.map((c) => c.name)], [thought, 'Looking.', ['list_dir']])
  assert.deepEqual([answered.reasoning_content, answered.content, answered.tool_calls], [thought, 'Empty.', undefined])
  // What had been shown of the thinking before the call in it was held back, and then all of it as thinking.
  assert.equal(turn.text, 'Maybe I call it like this:\nLooking.\n\nEmpty.')
  assert.deepEqual(turn.events.filter((e) => e.type === 'assistant_rewrite'), [{ type: 'assistant_rewrite', text: '', reasoning: thought }])
})

test('a call left in a reply that came whole is read as well, one at a time', async () => {
  // LLaMA-Factory takes the calls out of the text itself; what its own reading misses comes back as text.
  const both = '<tool_call>\n<function=list_dir>\n<parameter=path>\n.\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=list_dir>\n</function>\n</tool_call>'
  const factory = await fakeFactory([
    { role: 'assistant', content: `<think>\nLook first.\n</think>\n\n${both}` },
    { role: 'assistant', content: 'Empty.' }
  ])
  const turn = await plainTurn(factory.baseURL, [{ role: 'user', content: 'what is here?' }])
  await factory.close()

  assert.deepEqual(turn.errors, [])
  assert.deepEqual(factory.requests.map((r) => r.stream), [true, false, false])
  assert.deepEqual([turn.reasoning, turn.text], ['Look first.\n', 'Empty.'])
  const sent = factory.requests[2].messages
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.deepEqual(sent[2].tool_calls.map((c: { function: object }) => c.function), [{ name: 'list_dir', arguments: '{"path":"."}' }], 'strict turns have room for one result')
})

test('what only looks like a call in an answer stays text', async () => {
  // A tool that is not there, written by a model that was handed its tools and never told to write calls out.
  const unknown = '<tool_call>\n{"name": "open_file", "arguments": {"path": "a.txt"}}\n</tool_call>'
  const real = '<tool_call>\n{"name": "list_dir", "arguments": {}}\n</tool_call>'
  const model = await fakeModel([[chunk({ content: `Other apps have this: ${unknown}` })], [chunk({ content: real })]])
  const turn = await plainTurn(model.baseURL, [{ role: 'user', content: 'how do other apps open a file?' }])
  assert.equal(model.requests.length, 1, 'nothing was run')
  assert.deepEqual([turn.text, turn.errors], [`Other apps have this: ${unknown}`, []])

  // Where there are no tools, an answer is not looked through for calls at all.
  const events: AgentEvent[] = []
  await runTurn({
    connection: connectionTo(model.baseURL),
    workspace: os.tmpdir(),
    messages: [{ role: 'user', content: 'show me what a call looks like' }],
    signal: new AbortController().signal,
    tools: new ToolRegistry(),
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    requestPermission: async () => 'deny'
  })
  assert.equal(model.requests.length, 2)
  assert.equal(events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join(''), real)
  await model.close()
})

test('with a service on the internet, a call in the text of an answer is text', async (t) => {
  // Such a service hands its calls over. What stands in its answers is what the model said: here
  // a file it was asked to show, which holds a call of a tool that is there.
  const quoted = 'The file reads:\n\n<tool_call>\n{"name": "run_command", "arguments": {"command": "echo gotcha"}}\n</tool_call>'
  const bare = '{"name": "list_dir", "arguments": {}}'
  // Nor is a line that begins with the tag that closes thinking anything but a line of the answer.
  const closing = 'The raw output ends its thinking so:\n</think>\nand the answer follows.'
  const model = await fakeModel([[chunk({ content: quoted })], [chunk({ content: bare })], [chunk({ content: closing })], [chunk({ content: 'never asked for' })]])
  t.after(() => model.close())
  // The fake server stands in for an address out there.
  const far = 'https://api.example.com/v1'
  const real = globalThis.fetch
  t.after(() => void (globalThis.fetch = real))
  globalThis.fetch = (input, init) => real(typeof input === 'string' && input.startsWith(far) ? model.baseURL + input.slice(far.length) : input, init)

  let asked = 0
  for (const text of [quoted, bare, closing]) {
    const tools = new ToolRegistry()
    registerBuiltinTools(tools)
    const events: AgentEvent[] = []
    await runTurn({
      connection: connectionTo(far),
      workspace: os.tmpdir(),
      messages: [{ role: 'user', content: 'show me the file' }],
      signal: new AbortController().signal,
      tools,
      alwaysAllowed: new Set(),
      emit: (e) => events.push(e),
      checkpoint: () => {},
      requestPermission: async () => (asked++, 'allow')
    })
    assert.deepEqual(events.flatMap((e) => (e.type === 'error' ? [e.message] : [])), [])
    assert.equal(events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join(''), text)
    assert.equal(events.some((e) => e.type === 'tool_start' || e.type === 'reasoning_delta' || e.type === 'assistant_rewrite'), false, 'nothing was run, and nothing taken for thinking')
  }
  assert.deepEqual([model.requests.length, asked], [3, 0])
  assert.ok(model.requests.every((r) => r.tools?.length), 'the tools were handed over, as to any service')
})

test('an answer that was cut short in the middle of a written call is not acted on', async () => {
  const model = await fakeModel([
    [chunk({ content: 'Saving. <tool_call>\n<function=write_file>\n<parameter=path>\na.txt\n</parameter>\n<parameter=content>\nhalf of the fi' }), ended('length')],
    [chunk({ content: 'should never be requested' })]
  ])
  const messages: ChatMessage[] = [{ role: 'user', content: 'save it' }]
  const turn = await plainTurn(model.baseURL, messages)
  await model.close()

  assert.equal(model.requests.length, 1)
  assert.match(turn.errors[0], /ran out of output space in the middle of a tool call/)
  assert.equal(turn.text, 'Saving. ', 'half a call is not shown')
  assert.deepEqual(messages[1], { role: 'assistant', content: 'Saving. ', origin: { provider: 'test', kind: 'openai-chat', model: 'fake' } })
})

test('for a server without tool definitions the whole conversation is written out', () => {
  const origin = { provider: 'test', kind: 'openai-chat' as const, model: 'fake' }
  const messages: ChatMessage[] = [
    { role: 'user', content: 'look around' },
    // Written while a service that takes tools was in use: two calls, with ids of that service.
    {
      role: 'assistant',
      content: 'Looking.',
      reasoning_content: 'two places',
      tool_calls: [
        { id: 'call_1', name: 'list_dir', arguments: '{}' },
        { id: 'call_2', name: 'read_file', arguments: '{"path":"a.txt","limit":5}' }
      ],
      origin
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
    { role: 'tool', tool_call_id: 'call_2', content: '1\thello' },
    // The turn was stopped before the model answered, and the person wrote again.
    { role: 'user', content: 'never mind' }
  ]
  const tools = [{ name: 'list_dir', description: 'Lists a folder.', parameters: { type: 'object', properties: {} } }]
  const connection = { ...connectionTo('http://127.0.0.1:1'), textTools: true }
  const sent = chatMessages({ messages, system: 'S', tools, connection })

  const listed = '{"type":"function","function":{"name":"list_dir","description":"Lists a folder.","parameters":{"type":"object","properties":{}}}}'
  assert.ok(String(sent[0].content).startsWith(`S\n\n# Tools\n\nYou have access to the following functions:\n\n<tools>\n${listed}\n</tools>\n\nTo call a function, reply with a block in exactly this format:\n\n<tool_call>\n`))
  const calls = '<tool_call>\n<function=list_dir>\n</function>\n</tool_call>\n<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n<parameter=limit>\n5\n</parameter>\n</function>\n</tool_call>'
  assert.deepEqual(sent.slice(1), [
    { role: 'user', content: 'look around' },
    // Its thinking goes back under the name the service has for it, as ever.
    { role: 'assistant', content: `Looking.\n\n${calls}`, reasoning_content: 'two places' },
    { role: 'user', content: '<tool_response>\na.txt\n</tool_response>\n<tool_response>\n1\thello\n</tool_response>\n\nnever mind' }
  ])
  // Nothing but turns taken, which is all that the strictest server asks for.
  assert.deepEqual(chatMessages({ messages, system: 'S', tools, connection }, true), sent)

  // A request without tools, as when a summary is asked for, describes none; the conversation is written out all the same.
  const bare = chatMessages({ messages, system: 'S', connection })
  assert.deepEqual([bare[0].content, bare.slice(1)], ['S', sent.slice(1)])
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
