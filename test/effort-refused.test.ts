// A level of thinking the service will not take. The two OpenAI formats send the level the person
// chose as it is; a model that takes none refuses every request that names one. The request is
// then made again without it, the person is told, and the choice is taken back.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import OpenAI from 'openai'
import { runTurn } from '../src/main/agent.ts'
import { refusesEffort } from '../src/main/providers/effort.ts'
import type { Connection } from '../src/main/providers/index.ts'
import * as model from '../src/main/settings-model.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import { itemsReducer } from '../src/renderer/src/items.ts'
import type { AgentEvent, ChatMessage } from '../src/shared/types.ts'

/** What xAI answered a request that named a level for a model that takes none (seen 2026-11-25). Its `error` is the text itself. */
const XAI_SAID = 'Model grok-4.20-0309-non-reasoning does not support parameter reasoningEffort.'
const xaiRefusal = { status: 400, body: { error: XAI_SAID } }
/** The same as the app words it: the client puts the status before what the service said, as it came. */
const XAI_SHOWN = `400 ${JSON.stringify(XAI_SAID)}`

type Script = { status: number; body: object } | { stream: string[] } | { whole: Record<string, unknown> }

const chunk = (delta: object): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`
const toolCall = (id: string, name: string, args: object): string =>
  chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

/** A chat-completions server that answers each request with the next script, and keeps what it was sent. */
async function fakeChat(scripts: Script[]) {
  const requests: Record<string, any>[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push(body)
      const script = scripts[requests.length - 1] ?? { stream: [] }
      if ('status' in script) return void res.writeHead(script.status, { 'content-type': 'application/json' }).end(JSON.stringify(script.body))
      if ('whole' in script) {
        const reply = { id: 'c', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: script.whole, finish_reason: 'stop' }] }
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of script.stream) res.write(part)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { requests, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** The level each request named, in the format of the connection. */
const levels = (requests: Record<string, any>[]): string[] => requests.map((r) => r.reasoning_effort ?? r.reasoning?.effort ?? '(none)')

/** One turn with the built-in tools, every permission granted, and what came of it. */
async function turn(connection: Connection, messages: ChatMessage[]) {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const events: AgentEvent[] = []
  let takenBack = 0
  await runTurn({
    connection,
    workspace: await mkdtemp(path.join(os.tmpdir(), 'starbench-effort-')),
    messages,
    signal: new AbortController().signal,
    tools,
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    requestPermission: async () => 'allow',
    onEffortRefused: () => takenBack++
  })
  return {
    events,
    takenBack,
    text: events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join(''),
    notices: events.flatMap((e) => (e.type === 'notice' ? [[e.code, e.detail]] : [])),
    errors: events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
  }
}

const chat = (baseURL: string, more: Partial<Connection> = {}): Connection => ({ provider: 'xai', kind: 'openai-chat', apiKey: 'test', baseURL, model: 'grok-4.20-0309-non-reasoning', reasoningEffort: 'high', ...more })
const hi = (): ChatMessage[] => [{ role: 'user', content: 'hi' }]

test('a refusal counts as one of the level when it names the parameter, however the service spells it', () => {
  const said = (status: number, message: string, param?: string): unknown => new OpenAI.APIError(status, { message, ...(param ? { param } : {}) }, undefined, new Headers())
  for (const [status, message, param] of [
    [400, XAI_SAID],
    // The name in chat completions, and the one in the Responses format.
    [400, "Unsupported parameter: 'reasoning_effort' is not supported with this model."],
    [400, "Unsupported parameter: 'reasoning.effort' is not supported with this model."],
    // A server that knows no such field, and one with a strict schema.
    [400, 'Unrecognized request argument supplied: reasoning_effort'],
    [422, '[{"type":"extra_forbidden","loc":["body","reasoning_effort"],"msg":"Extra inputs are not permitted"}]'],
    // Named beside the message and not in it.
    [400, "Unsupported value: 'xhigh' is not supported with this model.", 'reasoning.effort']
  ] as const) {
    assert.equal(refusesEffort(said(status, message, param)), true, message)
  }
  assert.equal(refusesEffort(said(400, 'This model does not support tools.')), false, 'a refusal over something else')
  assert.equal(refusesEffort(said(400, 'The reasoning of this request took too much effort.')), false, 'the two words apart name no parameter')
  for (const status of [401, 403, 404, 408, 429, 500, 503]) {
    assert.equal(refusesEffort(said(status, 'reasoning_effort')), false, `${status} does not say the request was at fault`)
  }
  assert.equal(refusesEffort(new Error('reasoning_effort')), false, 'only what a service answered counts')
  assert.equal(refusesEffort(null), false)
})

test('a level the model does not take is left out, the person is told once, and the turn goes on without it', async (t) => {
  const service = await fakeChat([xaiRefusal, { stream: [toolCall('c1', 'list_dir', {})] }, { stream: [chunk({ content: 'Nothing in here.' })] }])
  t.after(() => service.close())

  const done = await turn(chat(service.baseURL), hi())
  assert.deepEqual(done.errors, [], 'the refusal does not stop the conversation')
  assert.equal(done.text, 'Nothing in here.')
  // Asked again without the level, and the next request of the turn does not name it either.
  assert.deepEqual(levels(service.requests), ['high', '(none)', '(none)'])
  const [refused, taken] = service.requests
  const { reasoning_effort: _level, ...rest } = refused
  assert.deepEqual(rest, taken, 'the request is the same one, less the level')
  // Told once, with what the service said, before anything of the reply.
  assert.deepEqual(done.notices, [['effort-refused', XAI_SHOWN]])
  assert.equal(done.events.findIndex((e) => e.type === 'notice') < done.events.findIndex((e) => e.type === 'tool_start'), true)
  assert.equal(done.takenBack, 1, 'and whoever keeps the choice is told to take it back, once')
})

test('nothing is taken back when the request fails without the level too, or named none', async (t) => {
  // The second answer is no better: it was not only the level, so the choice stays and the error is shown.
  const broken = await fakeChat([xaiRefusal, { status: 400, body: { error: { message: 'The messages are not in an order this server takes.' } } }])
  t.after(() => broken.close())
  const failed = await turn(chat(broken.baseURL), hi())
  assert.deepEqual(levels(broken.requests), ['high', '(none)'])
  assert.equal(failed.errors.length, 1)
  assert.match(failed.errors[0], /not in an order/)
  assert.deepEqual([failed.notices, failed.takenBack], [[], 0])

  // Nothing was chosen, so there is nothing to leave out: the refusal is shown as it is, and not tried again.
  const unasked = await fakeChat([xaiRefusal])
  t.after(() => unasked.close())
  const shown = await turn(chat(unasked.baseURL, { reasoningEffort: 'default' }), hi())
  assert.equal(unasked.requests.length, 1)
  assert.deepEqual([shown.errors.length, shown.notices, shown.takenBack], [1, [], 0])

  // A refusal over something else is not taken for one of the level.
  const other = await fakeChat([{ status: 400, body: { error: { message: 'Unknown parameter: frequency' } } }])
  t.after(() => other.close())
  const reported = await turn(chat(other.baseURL), hi())
  assert.deepEqual([other.requests.length, reported.errors.length, reported.takenBack], [1, 1, 0])
})

test('a server asked for whole replies is asked again without the level in the same way', async (t) => {
  const service = await fakeChat([xaiRefusal, { whole: { role: 'assistant', content: 'Hello.' } }])
  t.after(() => service.close())
  const done = await turn(chat(service.baseURL, { wholeReplies: true }), hi())
  assert.deepEqual(service.requests.map((r) => r.stream), [false, false])
  assert.deepEqual(levels(service.requests), ['high', '(none)'])
  assert.deepEqual([done.text, done.errors, done.notices, done.takenBack], ['Hello.', [], [['effort-refused', XAI_SHOWN]], 1])
})

test('the Responses format does the same, and beside the faster answers a model may not have either', async (t) => {
  const sse = (events: object[]): string => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const requests: Record<string, any>[] = []
  const refuse = (res: http.ServerResponse, message: string, param: string): void =>
    void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type: 'invalid_request_error', param } }))
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push(body)
      // One thing at a time, as a service does that checks its fields in turn.
      if (body.service_tier) return refuse(res, 'This model does not support the requested service tier.', 'service_tier')
      if (body.reasoning?.effort) return refuse(res, 'This model takes no level.', 'reasoning.effort')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { status: 'completed' } }]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const responses = (more: Partial<Connection>): Connection => ({ provider: 'openai', kind: 'openai-responses', apiKey: 'test', baseURL, model: 'model-x', reasoningEffort: 'high', ...more })

  const done = await turn(responses({}), hi())
  assert.deepEqual(levels(requests), ['high', '(none)'])
  assert.deepEqual([done.text, done.errors, done.takenBack], ['ok', [], 1])
  assert.deepEqual(done.notices, [['effort-refused', '400 This model takes no level.']], 'the parameter was named beside the message')

  requests.length = 0
  const both = await turn(responses({ fast: true }), hi())
  assert.deepEqual(requests.map((r) => [r.service_tier ?? '(none)', r.reasoning?.effort ?? '(none)']), [['priority', 'high'], ['(none)', 'high'], ['(none)', '(none)']])
  assert.deepEqual([both.text, both.errors, both.takenBack], ['ok', [], 1])
  assert.deepEqual(both.notices.map(([code]) => code), ['fast-mode-refused', 'effort-refused'])
})

test('the choice that was refused is taken back for that model alone', () => {
  let settings = model.readSettings({
    providers: [
      { id: 'xai', name: 'xAI', kind: 'openai-chat', baseURL: 'https://api.x.ai/v1', model: 'grok-4.20-0309-non-reasoning', efforts: { 'grok-4.7': 'xhigh', 'grok-4.20-0309-non-reasoning': 'high' } },
      { id: 'deepseek', name: 'DeepSeek', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', efforts: { 'deepseek-flash': 'max' } }
    ],
    activeProviderId: 'deepseek'
  })
  const before = settings
  // Not the provider in use: the turn that found out may be one that was sent before another model was picked.
  settings = model.dropEffortFor(settings, 'xai', 'grok-4.20-0309-non-reasoning')
  const [xai, deepseek] = settings.providers
  assert.deepEqual(xai.efforts, { 'grok-4.7': 'xhigh' }, 'the choices for its other models stay')
  assert.equal(model.effortOf(xai), 'default', 'a model that is not a well-known one is back at "nothing chosen": nothing is sent')
  assert.equal(deepseek, before.providers[1], 'another provider is left as it is')
  assert.equal(model.toPublic(settings).reasoningEffort, 'max')

  // The last choice of a provider goes with its list.
  settings = model.dropEffortFor(settings, 'deepseek', 'deepseek-flash')
  assert.equal('efforts' in settings.providers[1], false)
  // A well-known model is then at the level it starts at, like after taking a choice back by hand.
  assert.equal(model.toPublic(settings).reasoningEffort, 'high')

  // Nothing chosen, a model that is not there, a provider that is not there: nothing changes.
  for (const [provider, name] of [['xai', 'grok-4.20-0309-non-reasoning'], ['xai', 'toString'], ['gone', 'grok-4.7']] as const) {
    assert.equal(model.dropEffortFor(settings, provider, name), settings, `${provider} ${name}`)
  }
})

test('the notice says what happened, with what the service said', () => {
  const told = itemsReducer([], { type: 'event', event: { type: 'notice', code: 'effort-refused', message: 'The service does not take the level.', detail: XAI_SHOWN } })
  assert.equal(told.length, 1)
  const [item] = told
  assert.equal(item.kind, 'notice')
  assert.match(item.kind === 'notice' ? item.text : '', /不接受给这个模型选的思考档位.*没有带档位发出.*已经取消/)
  assert.ok(item.kind === 'notice' && item.text.endsWith(`（服务返回：${XAI_SHOWN}）`))
})
