// The services' own web search: which services have one, the switch for it, how each format asks
// for it and tells of it, what goes back to the service, and what the page shows. The shapes of
// the replies are those the real services sent on 2026-11-23 (DeepSeek, xAI, Claude).
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { itemsFromMessages, itemsReducer } from '../src/renderer/src/items.ts'
import type { Item } from '../src/renderer/src/items.ts'
import { runTurn, systemPrompt } from '../src/main/agent.ts'
import type { TurnOptions } from '../src/main/agent.ts'
import { anthropicParams } from '../src/main/providers/anthropic.ts'
import { chatMessages } from '../src/main/providers/chat.ts'
import type { Connection, ModelRequest } from '../src/main/providers/index.ts'
import { responsesInput, responsesTools } from '../src/main/providers/responses.ts'
import { WebLog, claudeCall, claudeResult, deepSeekActivities, responsesActivity } from '../src/main/providers/web-search.ts'
import * as model from '../src/main/settings-model.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import { PROVIDER_PRESETS, isGemini, searchWorksAt, usualEfforts, webSearchService } from '../src/shared/types.ts'
import type { AgentEvent, ChatMessage, ProviderKind, WebActivity } from '../src/shared/types.ts'

interface Seen {
  method: string
  url: string
  body: any
}

/** A server that records what it is asked and answers with whatever `reply` returns. */
async function fakeService(reply: (seen: Seen, count: number) => { status?: number; type?: string; body: string }) {
  const requests: Seen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const seen: Seen = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null }
      requests.push(seen)
      const { status = 200, type = 'text/event-stream', body } = reply(seen, requests.filter((r) => r.method === 'POST').length)
      res.writeHead(status, { 'content-type': type }).end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  after(() => void server.closeAllConnections?.(), { timeout: 2000 })
  after(() => void server.close())
  return { posts: () => requests.filter((r) => r.method === 'POST'), baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const sse = (events: { type: string }[]): string => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const chatSse = (deltas: Record<string, unknown>[]): string =>
  deltas.map((delta, i) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'model-x', choices: [{ index: 0, delta, finish_reason: i === deltas.length - 1 ? 'stop' : null }] })}\n\n`).join('') +
  'data: [DONE]\n\n'

const connection = (kind: ProviderKind, baseURL: string, extra: Partial<Connection> = {}): Connection => ({
  provider: 'p1',
  kind,
  apiKey: 'test-key',
  baseURL,
  model: 'model-x',
  reasoningEffort: 'default',
  ...extra
})

/** One turn with the built-in tools in a folder of its own; what it told, and the conversation as it was left. */
async function turn(conn: Connection, messages: ChatMessage[], more: Partial<TurnOptions> = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench-web-'))
  await writeFile(path.join(workspace, 'a.txt'), 'hello')
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
    requestPermission: async () => 'allow',
    ...more
  })
  return {
    events,
    activity: events.filter((e): e is Extract<AgentEvent, { type: 'web_activity' }> => e.type === 'web_activity').map((e) => e.activity),
    errors: events.filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error').map((e) => e.message)
  }
}

test('the services whose own search can be switched on, and no others', () => {
  const of = (kind: ProviderKind, baseURL: string, extra: { auth?: 'chatgpt'; model?: string } = {}) => webSearchService({ kind, baseURL, model: 'm', ...extra })
  assert.equal(of('openai-responses', 'https://api.openai.com/v1'), 'openai')
  assert.equal(of('openai-responses', 'https://api.openai.com/v1', { auth: 'chatgpt' }), 'openai')
  assert.equal(of('openai-responses', 'https://api.x.ai/v1'), 'xai')
  assert.equal(of('openai-responses', 'https://us.api.x.ai/v1'), 'xai')
  assert.equal(of('anthropic', 'https://api.anthropic.com'), 'anthropic')
  assert.equal(of('openai-chat', 'https://api.deepseek.com'), 'deepseek')
  // xAI's search is in the Responses format only; a gateway may not know the tools; Gemini's endpoint has none for chat.
  assert.equal(of('openai-chat', 'https://api.x.ai/v1'), undefined)
  assert.equal(of('anthropic', 'https://gateway.example.com'), undefined)
  assert.equal(of('openai-responses', 'https://api.deepseek.com'), undefined)
  assert.equal(of('openai-chat', 'https://generativelanguage.googleapis.com/v1beta/openai'), undefined)
  assert.equal(of('openai-chat', 'http://localhost:11434/v1'), undefined)
  assert.equal(of('openai-chat', 'https://api.deepseek.com', { model: '' }), undefined)
  // Gemini's own API has Google's search, for the models that can have it with the app's tools (Gemini 3 and later).
  assert.equal(of('gemini', 'https://generativelanguage.googleapis.com/v1beta', { model: 'gemini-4-hydrogen' }), 'google')
  assert.equal(of('gemini', 'https://generativelanguage.googleapis.com/v1beta', { model: 'gemini-2.5-flash' }), undefined)
})

test('the switch belongs to a model, is kept with it, and only reaches a service that has a search', () => {
  let settings = model.readSettings({
    providers: [{ id: 'ds', name: 'DeepSeek', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', search: ['deepseek-flash', 'deepseek-flash', 7, ''] }],
    activeProviderId: 'ds'
  })
  assert.deepEqual(settings.providers[0].search, ['deepseek-flash'])
  assert.equal(model.toPublic(settings).webSearch, true)
  settings = model.setSearch(settings, false)
  assert.equal(settings.providers[0].search, undefined)
  assert.equal(model.toPublic(settings).webSearch, false)
  // Another model of the same provider has a switch of its own.
  settings = model.setSearchFor(settings, 'ds', 'deepseek-v4-pro', true)
  assert.equal(model.searchOf(settings.providers[0]), false)
  settings = model.selectModel(settings, 'ds', 'deepseek-v4-pro')
  assert.equal(model.toPublic(settings).webSearch, true)
  // Changing the provider's address or key keeps the choices made for its models.
  settings = model.saveProvider(settings, { id: 'ds', name: 'DeepSeek', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro' })
  assert.deepEqual(settings.providers[0].search, ['deepseek-v4-pro'])
})

test('Gemini can be added from a preset, on its own API, with the thinking levels it takes', () => {
  const gemini = PROVIDER_PRESETS.find((p) => p.id === 'gemini')
  assert.ok(gemini && gemini.kind === 'gemini' && isGemini(gemini.baseURL))
  // Offered before the service has said what the model takes (gemini.ts knows the levels of the models it lists).
  assert.deepEqual(usualEfforts(gemini.baseURL, gemini.kind), ['minimal', 'low', 'medium', 'high'])
  // Its OpenAI-compatible endpoint, which a provider can still be set up with, takes the same.
  assert.deepEqual(usualEfforts('https://generativelanguage.googleapis.com/v1beta/openai', 'openai-chat'), ['minimal', 'low', 'medium', 'high'])
  assert.equal(isGemini('https://generativelanguage.googleapis.com.example.com/v1'), false)
})

test("DeepSeek's account of its searches is read as it came: searches and opened pages, all done", () => {
  const raw = [
    {
      index: 0,
      reasoning_content: 'I need to search.',
      calls: [
        {
          index: 0,
          id: 'srvtoolu_ds_00_a',
          type: 'deepseek_web_search',
          kind: 'deep_search',
          action: { type: 'search', queries: ['Electron latest stable release', 'Electron releases GitHub'] },
          status: 'completed',
          sources: [
            { type: 'url', url: 'https://releases.electronjs.org/release/v45.4.1', title: 'Electron Releases', snippet: '…' },
            { type: 'url', url: 'https://releases.electronjs.org/release/v45.4.1', title: 'again' },
            { type: 'url', url: 'https://electronjs.org/blog' }
          ]
        }
      ]
    },
    { index: 1, calls: [{ index: 0, id: 'srvtoolu_ds_01_b', action: { type: 'open_page', url: 'https://releases.electronjs.org/' }, status: 'completed', page: { url: 'https://releases.electronjs.org/', title: 'Electron Releases' } }] },
    { index: 2, calls: [{ index: 0, id: 'srvtoolu_ds_02_c', action: { type: 'search', queries: ['x'] }, status: 'failed', error: 'rate limited' }] }
  ]
  assert.deepEqual(deepSeekActivities(raw), [
    {
      id: 'srvtoolu_ds_00_a',
      kind: 'search',
      queries: ['Electron latest stable release', 'Electron releases GitHub'],
      status: 'done',
      sources: [{ url: 'https://releases.electronjs.org/release/v45.4.1', title: 'Electron Releases' }, { url: 'https://electronjs.org/blog' }]
    },
    { id: 'srvtoolu_ds_01_b', kind: 'open', url: 'https://releases.electronjs.org/', status: 'done', sources: [{ url: 'https://releases.electronjs.org/', title: 'Electron Releases' }] },
    { id: 'srvtoolu_ds_02_c', kind: 'search', queries: ['x'], status: 'failed', error: 'rate limited' }
  ])
  assert.deepEqual(deepSeekActivities(null), [])
})

test('a search of the Responses API, from announced to done, and its other actions', () => {
  assert.deepEqual(responsesActivity({ id: 'ws_1', type: 'web_search_call', status: 'in_progress', action: { type: 'search', query: '', sources: [] } }), {
    id: 'ws_1',
    kind: 'search',
    status: 'running'
  })
  assert.deepEqual(
    responsesActivity({
      id: 'ws_1',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: 'Electron latest stable version', sources: [{ type: 'url', url: 'https://a.example/x', title: 'https://a.example/x' }, { type: 'url', url: 'https://b.example', title: 'B' }] }
    }),
    { id: 'ws_1', kind: 'search', queries: ['Electron latest stable version'], status: 'done', sources: [{ url: 'https://a.example/x' }, { url: 'https://b.example', title: 'B' }] }
  )
  assert.deepEqual(responsesActivity({ id: 'ws_2', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://c.example' } }), {
    id: 'ws_2',
    kind: 'open',
    url: 'https://c.example',
    status: 'done'
  })
  assert.deepEqual(responsesActivity({ id: 'ws_3', type: 'web_search_call', status: 'failed', action: { type: 'search', queries: ['q1', 'q2'] } }), {
    id: 'ws_3',
    kind: 'search',
    queries: ['q1', 'q2'],
    status: 'failed'
  })
  assert.equal(responsesActivity({ id: 'fc_1', type: 'function_call' }), null)
})

test("Claude's search and page reading: the call, then its results or its error", () => {
  assert.deepEqual(claudeCall({ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }), { id: 'srvtoolu_1', kind: 'search', status: 'running' })
  assert.deepEqual(claudeCall({ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }, { query: 'Electron latest stable release' }), {
    id: 'srvtoolu_1',
    kind: 'search',
    queries: ['Electron latest stable release'],
    status: 'running'
  })
  assert.deepEqual(claudeCall({ type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'https://releases.electronjs.org/' } }), {
    id: 'srvtoolu_2',
    kind: 'open',
    url: 'https://releases.electronjs.org/',
    status: 'running'
  })
  assert.equal(claudeCall({ type: 'server_tool_use', id: 'srvtoolu_3', name: 'code_execution', input: {} }), null)
  assert.deepEqual(
    claudeResult({
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [{ type: 'web_search_result', title: 'Electron Releases', url: 'https://releases.electronjs.org/', encrypted_content: 'E…', page_age: '3 days ago' }]
    }),
    { id: 'srvtoolu_1', kind: 'search', status: 'done', sources: [{ url: 'https://releases.electronjs.org/', title: 'Electron Releases' }] }
  )
  assert.deepEqual(claudeResult({ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }), {
    id: 'srvtoolu_1',
    kind: 'search',
    status: 'failed',
    error: 'max_uses_exceeded'
  })
  assert.deepEqual(
    claudeResult({ type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_fetch_result', url: 'https://releases.electronjs.org/', content: { type: 'document', title: 'Electron Releases', source: {} } } }),
    { id: 'srvtoolu_2', kind: 'open', url: 'https://releases.electronjs.org/', status: 'done', sources: [{ url: 'https://releases.electronjs.org/', title: 'Electron Releases' }] }
  )
  assert.deepEqual(claudeResult({ type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_fetch_tool_error', error_code: 'url_not_accessible' } }), {
    id: 'srvtoolu_2',
    kind: 'open',
    status: 'failed',
    error: 'url_not_accessible'
  })
})

test('what is known of a search is merged as it comes, and a search that ended stays ended', () => {
  const message: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: '' }
  const told: WebActivity[] = []
  const log = new WebLog(message, (a) => told.push(a))
  log.put({ id: 's1', kind: 'search', status: 'running' })
  log.put({ id: 's1', kind: 'search', queries: ['q'], status: 'running' })
  log.put({ id: 's1', kind: 'search', status: 'done', sources: [{ url: 'https://a.example' }] })
  log.put({ id: 's1', kind: 'search', queries: ['q'], status: 'running' })
  assert.deepEqual(message.web, [{ id: 's1', kind: 'search', queries: ['q'], status: 'done', sources: [{ url: 'https://a.example' }] }])
  assert.deepEqual(told.map((a) => a.status), ['running', 'running', 'done', 'done'])
})

test('the Responses API: the search goes out as a tool, is told as it goes, and goes back with the reply', async () => {
  const added = { id: 'ws_1', type: 'web_search_call', status: 'in_progress', action: { type: 'search', query: '', sources: [] } }
  const done = { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'electron latest', sources: [{ type: 'url', url: 'https://releases.electronjs.org/' }] } }
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' }
  const answer = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'v45.4.1', annotations: [] }] }
  const service = await fakeService(() => ({
    body: sse([
      { type: 'response.created' },
      { type: 'response.output_item.done', item: reasoning } as never,
      { type: 'response.output_item.added', item: added } as never,
      { type: 'response.web_search_call.in_progress', item_id: 'ws_1' } as never,
      { type: 'response.web_search_call.completed', item_id: 'ws_1' } as never,
      { type: 'response.output_item.done', item: done } as never,
      { type: 'response.output_text.delta', delta: 'v45.4.1' } as never,
      { type: 'response.output_item.done', item: answer } as never,
      { type: 'response.completed', response: { status: 'completed' } } as never
    ])
  }))
  const conn = connection('openai-responses', service.baseURL, { webSearch: true })
  const messages: ChatMessage[] = [{ role: 'user', content: 'latest electron?' }]
  const result = await turn(conn, messages)
  assert.deepEqual(result.errors, [])
  const [first] = service.posts()
  assert.deepEqual(first.body.tools.at(-1), { type: 'web_search' })
  // The pages found are asked for from OpenAI's own API only; this address is not that.
  assert.deepEqual(first.body.include, ['reasoning.encrypted_content'])
  assert.match(first.body.instructions, /search the web/)
  assert.deepEqual(
    result.activity.map((a) => [a.status, a.queries]),
    [
      ['running', undefined],
      ['done', ['electron latest']]
    ]
  )
  const reply = messages[1] as Extract<ChatMessage, { role: 'assistant' }>
  assert.deepEqual(reply.web, [{ id: 'ws_1', kind: 'search', queries: ['electron latest'], status: 'done', sources: [{ url: 'https://releases.electronjs.org/' }] }])
  assert.deepEqual(reply.origin?.replay, [reasoning, done, answer])

  // Sent on with the search still on, the reply goes back as it came; with it off, as another
  // model's reply would, with the search told in words.
  const next: ChatMessage[] = [...messages, { role: 'user', content: 'and 44?' }]
  assert.deepEqual(responsesInput({ messages: next, connection: conn }).slice(1, 4), [reasoning, done, answer])
  assert.deepEqual(responsesInput({ messages: next, connection: { ...conn, webSearch: false } }).slice(1, 2), [
    {
      role: 'assistant',
      content: '[Earlier you searched the web for "electron latest" and read the results; they are not repeated here. Pages found: <https://releases.electronjs.org/>]\n\nv45.4.1'
    }
  ])
})

test("OpenAI's API is asked for the pages found; a ChatGPT plan keeps its tools grouped, with the search beside them", () => {
  const tools = [{ name: 'read_file', description: 'Reads a file.', parameters: { type: 'object', properties: {} } }]
  const plan = connection('openai-responses', 'https://chatgpt.com/backend-api/codex', { webSearch: true, plan: { token: async () => 't' } })
  const grouped = responsesTools({ tools, connection: plan })
  assert.deepEqual(
    grouped.map((t) => t.type),
    ['namespace', 'web_search']
  )
  assert.deepEqual(responsesTools({ tools, connection: { ...plan, webSearch: false } }).map((t) => t.type), ['namespace'])
})

test("OpenAI's own API is asked for the pages a search found", async () => {
  // The client's address is changed for the request only: what is checked is the field it sends.
  const service = await fakeService(() => ({ body: sse([{ type: 'response.completed', response: { status: 'completed' } } as never]) }))
  const conn = connection('openai-responses', service.baseURL, { webSearch: true })
  const original = conn.baseURL
  // The rule goes by the address; an address of OpenAI's own is pointed at the fake server through fetch.
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    realFetch(String(input instanceof Request ? input.url : input).replace('https://api.openai.com/v1', original), init)) as typeof fetch
  try {
    await turn({ ...conn, baseURL: 'https://api.openai.com/v1' }, [{ role: 'user', content: 'hi' }])
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(service.posts()[0].body.include, ['reasoning.encrypted_content', 'web_search_call.action.sources'])
})

test('a ChatGPT plan is asked for the pages a search found too, and only with the search on', async () => {
  // Tried on the plan route with gpt-6.2-sol on 2026-11-24: the field is taken, and each search came back with its pages.
  const service = await fakeService(() => ({ body: sse([{ type: 'response.completed', response: { status: 'completed' } } as never]) }))
  const plan = connection('openai-responses', service.baseURL, { webSearch: true, plan: { token: async () => 't' } })
  await turn(plan, [{ role: 'user', content: 'hi' }])
  await turn({ ...plan, webSearch: false }, [{ role: 'user', content: 'hi' }])
  assert.deepEqual(
    service.posts().map((p) => p.body.include),
    [['reasoning.encrypted_content', 'web_search_call.action.sources'], ['reasoning.encrypted_content']]
  )
})

/** A stream of Claude's, with server tools among its blocks. */
function claudeStream(blocks: Record<string, any>[]): string {
  const events: { type: string }[] = [
    {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'model-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }
    } as never
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } } as never)
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } } as never)
    } else if (block.type === 'server_tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'server_tool_use', id: block.id, name: block.name, input: {} } } as never)
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.json.slice(0, 5) } } as never)
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.json.slice(5) } } as never)
    } else {
      events.push({ type: 'content_block_start', index, content_block: block } as never)
    }
    events.push({ type: 'content_block_stop', index } as never)
  })
  events.push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9, server_tool_use: { web_search_requests: 1 } } } as never)
  events.push({ type: 'message_stop' })
  return sse(events)
}

test("the Messages API: Claude's search is told as it goes, from the call to its results, and kept with the reply", async () => {
  const result = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 'Electron Releases', url: 'https://releases.electronjs.org/', encrypted_content: 'E', page_age: null }] }
  const service = await fakeService((seen) =>
    seen.method === 'GET'
      ? { status: 404, type: 'application/json', body: '{"type":"error","error":{"type":"not_found_error","message":"no"}}' }
      : { body: claudeStream([{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', json: '{"query": "electron latest"}' }, result, { type: 'text', text: 'v45.4.1' }]) }
  )
  const messages: ChatMessage[] = [{ role: 'user', content: 'latest electron?' }]
  const out = await turn(connection('anthropic', service.baseURL, { webSearch: true }), messages)
  assert.deepEqual(out.errors, [])
  assert.deepEqual(
    out.activity.map((a) => [a.status, a.queries, a.sources?.length]),
    [
      ['running', undefined, undefined],
      ['running', ['electron latest'], undefined],
      ['done', ['electron latest'], 1],
      ['done', ['electron latest'], 1],
      ['done', ['electron latest'], 1]
    ]
  )
  const reply = messages[1] as Extract<ChatMessage, { role: 'assistant' }>
  assert.equal(reply.content, 'v45.4.1')
  assert.deepEqual(reply.web, [{ id: 'srvtoolu_1', kind: 'search', queries: ['electron latest'], status: 'done', sources: [{ url: 'https://releases.electronjs.org/', title: 'Electron Releases' }] }])
  // A gateway is not sent the server tools: this address is not Anthropic's own.
  assert.equal(service.posts()[0].body.tools.some((t: { type?: string }) => t.type?.startsWith('web_')), false)
})

test("Claude's own API gets the search tools, and a reply goes back without its search when they are off", () => {
  const reply: ChatMessage = {
    role: 'assistant',
    content: 'v45.4.1',
    web: [{ id: 'srvtoolu_1', kind: 'search', queries: ['electron'], status: 'done', sources: [{ url: 'https://x', title: 'X' }] }],
    origin: {
      provider: 'p1',
      kind: 'anthropic',
      model: 'model-x',
      replay: [
        { type: 'thinking', thinking: 'Search.', signature: 'SIG' },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'electron' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
        { type: 'text', text: 'v45.4.1', citations: [{ type: 'web_search_result_location', url: 'https://x', title: 'x', cited_text: 'c', encrypted_index: 'E' }] }
      ]
    }
  }
  const request = (webSearch: boolean): ModelRequest => ({
    connection: connection('anthropic', 'https://api.anthropic.com', { webSearch }),
    system: 's',
    messages: [{ role: 'user', content: 'q' }, reply, { role: 'user', content: 'and 44?' }],
    tools: [{ name: 'read_file', description: 'Reads a file.', parameters: { type: 'object', properties: {} } }],
    signal: new AbortController().signal,
    onText: () => {},
    onReasoning: () => {}
  })
  const on = anthropicParams(request(true), null) as any
  assert.deepEqual(
    on.tools.map((t: { type?: string; name: string }) => t.type ?? t.name),
    ['web_search_20250305', 'web_fetch_20250910', 'read_file']
  )
  assert.equal(on.messages[1].content.length, 4)
  const off = anthropicParams(request(false), null) as any
  assert.deepEqual(
    off.tools.map((t: { name: string }) => t.name),
    ['read_file']
  )
  // The search is told in words where it stood, its results and the citations into them go.
  assert.deepEqual(off.messages[1].content, [
    { type: 'thinking', thinking: 'Search.', signature: 'SIG' },
    { type: 'text', text: '[Earlier you searched the web for "electron" and read the results; they are not repeated here. Pages found: X <https://x>]' },
    { type: 'text', text: 'v45.4.1' }
  ])
  // A thinking block whose conversation changed since (as it does when search is switched off) is left out, not refused.
  assert.deepEqual(off.thinking.block_binding, { prefix_mismatch_behavior: 'drop_block' })
  assert.ok(off.betas.includes('thinking-binding-controls-2026-08-01'))
})

test("DeepSeek's reserved tool names: the app's search goes by another name while DeepSeek's own search is on", async () => {
  const service = await fakeService((_seen, count) => ({
    body:
      count === 1
        ? chatSse([{ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_files', arguments: '{"pattern":"hello"}' } }] }, {}])
        : chatSse([{ role: 'assistant', content: 'Found it in a.txt.' }, {}])
  }))
  const messages: ChatMessage[] = [{ role: 'user', content: 'where is hello?' }]
  const out = await turn(connection('openai-chat', service.baseURL, { webSearch: true }), messages)
  assert.deepEqual(out.errors, [])
  const [first, second] = service.posts()
  const names = first.body.tools.map((t: { type: string; function?: { name: string } }) => t.function?.name ?? t.type)
  assert.ok(names.includes('search_files') && !names.includes('search'))
  // The call is the app's search tool, run as such, and goes back under the name the service knows.
  assert.equal((messages[1] as Extract<ChatMessage, { role: 'assistant' }>).tool_calls?.[0].name, 'search')
  assert.match(messages[2].role === 'tool' ? messages[2].content : '', /a\.txt/)
  assert.equal(second.body.messages.find((m: { role: string }) => m.role === 'assistant').tool_calls[0].function.name, 'search_files')
  // Without DeepSeek's search the names are what they are.
  const plain = chatMessages({ messages, system: 's', connection: connection('openai-chat', service.baseURL) })
  assert.equal((plain.find((m) => m.role === 'assistant') as any).tool_calls[0].function.name, 'search')
})

test("chat completions: DeepSeek's search goes out as a tool, and what it found is kept with the reply", async () => {
  const calls = [{ index: 0, calls: [{ index: 0, id: 'srvtoolu_ds_00_a', action: { type: 'search', queries: ['electron latest'] }, status: 'completed', sources: [{ type: 'url', url: 'https://releases.electronjs.org/', title: 'Electron Releases' }] }] }]
  const service = await fakeService(() => ({
    body: chatSse([
      { role: 'assistant', reasoning_content: 'Search first.' },
      { content: 'v45.4.1' },
      { annotations: [{ type: 'url_citation', url_citation: { url: 'https://releases.electronjs.org/', title: 'Electron Releases', start_index: 0, end_index: 7 } }], server_tool_calls: calls },
      {}
    ])
  }))
  const messages: ChatMessage[] = [{ role: 'user', content: 'latest electron?' }]
  const out = await turn(connection('openai-chat', service.baseURL, { webSearch: true }), messages)
  assert.deepEqual(out.errors, [])
  const [first] = service.posts()
  assert.deepEqual(first.body.tools.at(-1), { type: 'deepseek_web_search' })
  assert.ok(first.body.tools.some((t: { type: string; function?: { name: string } }) => t.function?.name === 'read_file'))
  const reply = messages[1] as Extract<ChatMessage, { role: 'assistant' }>
  assert.equal(reply.content, 'v45.4.1')
  assert.deepEqual(reply.web, [{ id: 'srvtoolu_ds_00_a', kind: 'search', queries: ['electron latest'], status: 'done', sources: [{ url: 'https://releases.electronjs.org/', title: 'Electron Releases' }] }])
  assert.deepEqual(out.activity.map((a) => a.status), ['done'])
})

test('a summary of the conversation is never asked for with a search', async () => {
  const service = await fakeService(() => ({ body: chatSse([{ role: 'assistant', content: 'ok' }, {}]) }))
  await turn(connection('openai-chat', service.baseURL, { webSearch: false }), [{ role: 'user', content: 'hi' }])
  assert.equal(service.posts()[0].body.tools.some((t: { type: string }) => t.type === 'deepseek_web_search'), false)
  assert.doesNotMatch(systemPrompt({ workspace: 'w' }), /search the web/)
  assert.match(systemPrompt({ workspace: 'w', webSearch: true }), /search the web and read pages/)
  // Said outright: told only that it could search, DeepSeek at times answered that it had no web access.
  assert.match(systemPrompt({ workspace: 'w', webSearch: true }), /you do have internet access/)
})

test("DeepSeek's search waits while thinking is off, and the switch stays as it was", () => {
  // DeepSeek refuses its search beside the app's tools without thinking: 400 "client tools can
  // only be used together with `deepseek_web_search` in thinking mode" (2026-11-24).
  assert.equal(searchWorksAt('deepseek', 'none'), false)
  for (const effort of ['default', 'low', 'high', 'max'] as const) assert.equal(searchWorksAt('deepseek', effort), true)
  assert.equal(searchWorksAt('anthropic', 'none'), true)
  assert.equal(searchWorksAt('openai', 'none'), true)
  assert.equal(searchWorksAt(undefined, 'high'), false)
  // What the connection is made from (store.ts): the switch is kept, and the search goes out again once thinking is on.
  let settings = model.readSettings({
    providers: [{ id: 'ds', name: 'DeepSeek', kind: 'openai-chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', search: ['deepseek-flash'] }],
    activeProviderId: 'ds'
  })
  const goes = (): boolean => {
    const provider = settings.providers[0]
    return model.searchOf(provider) && searchWorksAt(webSearchService(provider), model.effortOf(provider))
  }
  settings = model.setEffort(settings, 'none')
  assert.equal(model.toPublic(settings).webSearch, true)
  assert.equal(goes(), false)
  settings = model.setEffort(settings, 'high')
  assert.equal(goes(), true)
})

test("Gemini's signatures on its tool calls are kept and go back with them; a call it did not write gets the stand-in", async () => {
  const service = await fakeService((_seen, count) => ({
    body:
      count === 1
        ? chatSse([
            { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' }, extra_content: { google: { thought_signature: 'SIG1' } } }] },
            { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] },
            {}
          ])
        : chatSse([{ role: 'assistant', content: 'It says hello.' }, {}])
  }))
  const messages: ChatMessage[] = [{ role: 'user', content: 'read a.txt' }]
  const out = await turn(connection('openai-chat', service.baseURL), messages)
  assert.deepEqual(out.errors, [])
  const call = messages[1] as Extract<ChatMessage, { role: 'assistant' }>
  assert.deepEqual(call.origin?.replay, { signatures: { call_1: 'SIG1' } })
  const second = service.posts()[1].body.messages.find((m: { role: string }) => m.role === 'assistant')
  assert.deepEqual(second.tool_calls[0].extra_content, { google: { thought_signature: 'SIG1' } })

  // A conversation another model began: Gemini is given the stand-in on the first call of each reply, and no one else is given anything.
  const other: ChatMessage[] = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_a', name: 'read_file', arguments: '{}' },
        { id: 'call_b', name: 'list_dir', arguments: '{}' }
      ],
      origin: { provider: 'other', kind: 'openai-chat', model: 'm' }
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'x' },
    { role: 'tool', tool_call_id: 'call_b', content: 'y' }
  ]
  const toGemini = chatMessages({ messages: other, system: 's', connection: connection('openai-chat', 'https://generativelanguage.googleapis.com/v1beta/openai') })
  const sent = toGemini.find((m) => m.role === 'assistant') as any
  assert.deepEqual(
    sent.tool_calls.map((c: { extra_content?: unknown }) => c.extra_content),
    [{ google: { thought_signature: 'skip_thought_signature_validator' } }, undefined]
  )
  const toOthers = chatMessages({ messages: other, system: 's', connection: connection('openai-chat', 'https://api.deepseek.com') })
  assert.ok((toOthers.find((m) => m.role === 'assistant') as any).tool_calls.every((c: object) => !('extra_content' in c)))
})

test('the page shows searches above the reply they belong to, while it is written and once it is kept', () => {
  const running: WebActivity = { id: 's1', kind: 'search', status: 'running' }
  const finished: WebActivity = { id: 's1', kind: 'search', queries: ['q'], status: 'done', sources: [{ url: 'https://a.example' }] }
  let items: Item[] = [{ kind: 'user', text: 'q' }]
  items = itemsReducer(items, { type: 'event', event: { type: 'reasoning_delta', text: 'Let me look.' } })
  items = itemsReducer(items, { type: 'event', event: { type: 'web_activity', activity: running } })
  items = itemsReducer(items, { type: 'event', event: { type: 'web_activity', activity: finished } })
  items = itemsReducer(items, { type: 'event', event: { type: 'text_delta', text: 'Found it.' } })
  items = itemsReducer(items, { type: 'event', event: { type: 'assistant_done' } })
  assert.deepEqual(items, [
    { kind: 'user', text: 'q' },
    { kind: 'web', activity: finished },
    { kind: 'assistant', reasoning: 'Let me look.', text: 'Found it.', open: false }
  ])
  // The same conversation loaded again looks the same.
  const loaded = itemsFromMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'Found it.', reasoning_content: 'Let me look.', web: [finished] }
  ])
  assert.deepEqual(loaded.slice(1), items.slice(1))
})
