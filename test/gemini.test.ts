// Gemini's own API (generateContent), against a stand-in that speaks its format. The shapes are
// those of Google's documentation of that API, read on 2026-11-23: streaming, thought signatures,
// function calling, Grounding with Google Search, URL context and the combination of the service's
// own tools with the app's (tool-combination).
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { compactConversation, runTurn } from '../src/main/agent.ts'
import type { TurnOptions } from '../src/main/agent.ts'
import { sendable } from '../src/main/compaction.ts'
import { geminiBody, geminiContents, geminiLevels, keepPart } from '../src/main/providers/gemini.ts'
import type { Part } from '../src/main/providers/gemini.ts'
import { searchNote } from '../src/main/providers/history.ts'
import type { Connection, ModelRequest } from '../src/main/providers/index.ts'
import { adapterFor } from '../src/main/providers/index.ts'
import { geminiActivity, geminiGrounding, geminiPagesRead } from '../src/main/providers/web-search.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import { COMPACTION_DEFAULTS, SUMMARY_OPEN } from '../src/shared/compaction.ts'
import { normalizeUsage } from '../src/shared/stats.ts'
import { PROVIDER_PRESETS, geminiSearchesWithTools, webSearchService } from '../src/shared/types.ts'
import type { AgentEvent, ChatMessage, CompactionMark, StoredMessage, ToolCall, WebActivity } from '../src/shared/types.ts'

type Assistant = Extract<ChatMessage, { role: 'assistant' }>

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: any
}

interface Answer {
  status?: number
  type?: string
  body: string
}

/**
 * A stand-in for the Gemini API that records what it is asked. `reply` answers the requests for a
 * reply (POST), numbered from 1; `get` answers the others (the model and the list of models).
 */
async function fakeGemini(reply: (seen: Seen, count: number) => Answer, get: (seen: Seen) => Answer = () => notFound) {
  const requests: Seen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const seen: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null }
      requests.push(seen)
      const posts = requests.filter((r) => r.method === 'POST').length
      const { status = 200, type = 'text/event-stream', body } = seen.method === 'POST' ? reply(seen, posts) : get(seen)
      res.writeHead(status, { 'content-type': type }).end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // Closed when the run ends, whether the tests passed or not: an open server keeps the process alive.
  after(() => void server.closeAllConnections?.(), { timeout: 2000 })
  after(() => void server.close())
  return {
    requests,
    posts: (): Seen[] => requests.filter((r) => r.method === 'POST'),
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
}

const json = (body: unknown, status = 200): Answer => ({ status, type: 'application/json', body: JSON.stringify(body) })
const notFound = json({ error: { code: 404, message: 'Model not found.', status: 'NOT_FOUND' } }, 404)

/** A stream as the API sends it: one event per response, each ending with an empty line (CRLF, as Google writes them). */
const geminiSse = (chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('')
/** One response of a stream, with the parts it brings and whatever else the candidate says. */
const piece = (parts: unknown[], extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { role: 'model', parts }, index: 0, ...extra }] })

const connection = (extra: Partial<Connection> = {}, baseURL = 'http://127.0.0.1:1'): Connection => ({
  provider: 'g1',
  kind: 'gemini',
  apiKey: 'test-key',
  baseURL,
  model: 'model-x',
  reasoningEffort: 'default',
  ...extra
})

/** Runs one turn with the built-in tools in a folder that holds a.txt, and reports what happened. */
async function turn(conn: Connection, messages: ChatMessage[], more: Partial<TurnOptions> = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'starbench-gemini-'))
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
    requestPermission: async () => 'allow',
    ...more
  })
  const ofType = <T extends AgentEvent['type']>(type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
  return {
    events,
    text: ofType('text_delta').map((e) => e.text).join(''),
    reasoning: ofType('reasoning_delta').map((e) => e.text).join(''),
    errors: ofType('error').map((e) => e.message),
    toolResults: ofType('tool_result').map((e) => e.output),
    activity: ofType('web_activity').map((e) => e.activity)
  }
}

const request = (conn: Connection, messages: ChatMessage[], tools: ModelRequest['tools'] = []): ModelRequest => ({
  connection: conn,
  system: 'sys',
  messages,
  tools,
  signal: new AbortController().signal,
  onText: () => {},
  onReasoning: () => {}
})

test('Gemini: the summary of its thinking, a call with its signature, the result, and the answer', async () => {
  const service = await fakeGemini((_seen, count) => ({
    body:
      count === 1
        ? geminiSse([
            piece([{ text: '**Reading**\n\nI need', thought: true }]),
            piece([{ text: ' the file.', thought: true }]),
            piece([{ functionCall: { id: 'fc1', name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'SIG1' }], { finishReason: 'STOP' })
          ])
        : geminiSse([
            piece([{ text: 'It says ' }]),
            piece([{ text: 'hello.' }]),
            // The signature of a reply without a call comes in a part of its own, with no text.
            { ...piece([{ text: '', thoughtSignature: 'SIG2' }], { finishReason: 'STOP' }), usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 4, thoughtsTokenCount: 9 } }
          ])
  }))
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is in a.txt?' }]
  const out = await turn(connection({ reasoningEffort: 'high' }, service.baseURL), messages)
  assert.deepEqual(out.errors, [])
  assert.equal(out.reasoning, '**Reading**\n\nI need the file.')
  assert.equal(out.text, 'It says hello.')
  assert.deepEqual(out.toolResults, ['1\thello from the file'])

  const [first, second] = service.posts()
  assert.equal(first.url, '/models/model-x:streamGenerateContent?alt=sse')
  assert.equal(first.headers['x-goog-api-key'], 'test-key')
  assert.match(first.body.systemInstruction.parts[0].text, /StarBench/)
  assert.deepEqual(first.body.generationConfig, { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } })
  // No search: neither the service's tools nor the setting that goes with them.
  assert.equal(first.body.toolConfig, undefined)
  assert.equal(first.body.tools.length, 1)
  const read = first.body.tools[0].functionDeclarations.find((d: { name: string }) => d.name === 'read_file')
  assert.equal(read.parametersJsonSchema.type, 'object')
  assert.equal('parameters' in read, false)

  // The reply goes back as it came; the result goes with the name and the id of its call.
  assert.deepEqual(second.body.contents, [
    { role: 'user', parts: [{ text: 'what is in a.txt?' }] },
    {
      role: 'model',
      parts: [
        { text: '**Reading**\n\nI need the file.', thought: true },
        { functionCall: { id: 'fc1', name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'SIG1' }
      ]
    },
    { role: 'user', parts: [{ functionResponse: { name: 'read_file', id: 'fc1', response: { output: '1\thello from the file' } } }] }
  ])
  const call = messages[1] as Assistant
  assert.deepEqual(call.tool_calls, [{ id: 'fc1', name: 'read_file', arguments: '{"path":"a.txt"}' }])
  assert.equal(call.reasoning_content, '**Reading**\n\nI need the file.')
  const answer = messages[3] as Assistant
  assert.equal(answer.content, 'It says hello.')
  assert.deepEqual(answer.origin, { provider: 'g1', kind: 'gemini', model: 'model-x', replay: { parts: [{ text: 'It says hello.' }, { text: '', thoughtSignature: 'SIG2' }], calls: [] } })
})

test('parts that stream in are joined only where neither carries anything but text of the same kind', () => {
  const parts: Part[] = []
  for (const part of [
    { text: 'Hel', thought: true },
    { text: 'lo', thought: true },
    { text: '' },
    { text: 'An' },
    { text: 'swer' },
    { text: '', thoughtSignature: 'S1' },
    { text: 'more' },
    { text: 'signed', thoughtSignature: 'S2' },
    { text: 'again', thoughtSignature: 'S3' },
    { functionCall: { name: 'f', args: {} }, thoughtSignature: 'S4' },
    { functionCall: { name: 'g', args: {} } }
  ] as Part[])
    keepPart(parts, part)
  assert.deepEqual(parts, [
    { text: 'Hello', thought: true },
    { text: 'Answer' },
    { text: '', thoughtSignature: 'S1' },
    { text: 'more' },
    { text: 'signed', thoughtSignature: 'S2' },
    { text: 'again', thoughtSignature: 'S3' },
    { functionCall: { name: 'f', args: {} }, thoughtSignature: 'S4' },
    { functionCall: { name: 'g', args: {} } }
  ])
})

const SEARCH_PARTS = [
  { toolCall: { toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['electron latest'] }, id: 's1' }, thoughtSignature: 'T1' },
  { toolResponse: { toolType: 'GOOGLE_SEARCH_WEB', response: { search_suggestions: '<div>chips</div>' }, id: 's1' }, thoughtSignature: 'T2' },
  { toolCall: { toolType: 'URL_CONTEXT', args: { urls: ['https://releases.electronjs.org/'] }, id: 'u1' }, thoughtSignature: 'T3' },
  {
    toolResponse: {
      toolType: 'URL_CONTEXT',
      response: { url_metadata: [{ retrieved_url: 'https://releases.electronjs.org/', url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' }] },
      id: 'u1'
    },
    thoughtSignature: 'T4'
  }
]
const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC1'
const GROUNDING = {
  webSearchQueries: ['electron latest'],
  searchEntryPoint: { renderedContent: '<style>.container{}</style><div class="container">…</div>' },
  groundingChunks: [{ web: { uri: REDIRECT, title: 'electronjs.org' } }],
  groundingSupports: [{ segment: { startIndex: 0, endIndex: 7, text: 'v45.4.1' }, groundingChunkIndices: [0] }]
}

test("Gemini's own search: asked for with the app's tools, told as it goes, kept with the reply, and sent back", async () => {
  const service = await fakeGemini(() => ({
    body: geminiSse([
      piece([SEARCH_PARTS[0]]),
      piece([SEARCH_PARTS[1]]),
      piece([SEARCH_PARTS[2], SEARCH_PARTS[3]]),
      piece([{ text: 'v45.4.1' }]),
      piece([{ text: '', thoughtSignature: 'T5' }], { finishReason: 'STOP', groundingMetadata: GROUNDING })
    ])
  }))
  const conn = connection({ webSearch: true, model: 'gemini-4-hydrogen' }, service.baseURL)
  const messages: ChatMessage[] = [{ role: 'user', content: 'latest electron?' }]
  const out = await turn(conn, messages)
  assert.deepEqual(out.errors, [])

  const [first] = service.posts()
  assert.deepEqual(first.body.tools.slice(1), [{ googleSearch: {} }, { urlContext: {} }])
  assert.ok(first.body.tools[0].functionDeclarations.length > 0)
  assert.deepEqual(first.body.toolConfig, { includeServerSideToolInvocations: true })
  assert.match(first.body.systemInstruction.parts[0].text, /search the web/)

  assert.deepEqual(
    out.activity.map((a) => [a.id, a.status, a.sources?.length ?? 0]),
    [
      ['s1', 'running', 0],
      ['s1', 'done', 0],
      ['u1', 'running', 0],
      ['u1', 'done', 1],
      // The pages the reply rests on go with the search, once they are told at the end.
      ['s1', 'done', 1]
    ]
  )
  const reply = messages[1] as Assistant
  assert.equal(reply.content, 'v45.4.1')
  // The search keeps the suggestions that came with it, not those told for the whole reply at the end.
  assert.deepEqual(reply.web, [
    { id: 's1', kind: 'search', queries: ['electron latest'], status: 'done', sources: [{ url: REDIRECT, title: 'electronjs.org' }], suggestions: '<div>chips</div>' },
    { id: 'u1', kind: 'open', url: 'https://releases.electronjs.org/', status: 'done', sources: [{ url: 'https://releases.electronjs.org/' }] }
  ])
  const replayed = [...SEARCH_PARTS, { text: 'v45.4.1' }, { text: '', thoughtSignature: 'T5' }]
  assert.deepEqual(reply.origin?.replay, { parts: replayed, calls: [] })

  // With the search still on, the reply goes back part for part, the service's own calls among them.
  const next: ChatMessage[] = [...messages, { role: 'user', content: 'and 44?' }]
  assert.deepEqual(geminiContents({ messages: next, connection: conn })[1], { role: 'model', parts: replayed })
  // Switched off, its searches go as notes in front of it, and their parts are left out.
  const notes = reply.web!.map(searchNote).join('\n')
  assert.match(notes, /searched the web for "electron latest"/)
  assert.deepEqual(geminiContents({ messages: next, connection: { ...conn, webSearch: false } })[1], {
    role: 'model',
    parts: [{ text: notes }, { text: 'v45.4.1' }, { text: '', thoughtSignature: 'T5' }]
  })
})

test('page reads as Gemini 4 Hydrogen made them: a read that failed lists no page, and a page read through Google gets its title', async () => {
  // The shapes of a real reply (2026-11-24): two pages that could not be fetched, then a page read
  // at the address the search found it at, and at the end the pages with their titles, a URL
  // context record beside the parts, and no queries.
  const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF1'
  const service = await fakeGemini(() => ({
    body: geminiSse([
      piece([{ toolCall: { toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['typescript latest stable version npm'] }, id: 's1' }, thoughtSignature: 'A' }]),
      piece([{ toolResponse: { toolType: 'GOOGLE_SEARCH_WEB', response: { search_suggestions: '<div/>' }, id: 's1' }, thoughtSignature: 'B' }]),
      piece([{ toolCall: { toolType: 'URL_CONTEXT', args: { urls: ['https://github.com/microsoft/TypeScript/releases', 'https://devblogs.microsoft.com/typescript/'] }, id: 'u1' }, thoughtSignature: 'C' }]),
      piece([
        {
          toolResponse: {
            toolType: 'URL_CONTEXT',
            response: {
              url_metadata: [
                { retrieved_url: 'https://devblogs.microsoft.com/typescript/', url_retrieval_status: 'URL_RETRIEVAL_STATUS_ERROR' },
                { url_retrieval_status: 'URL_RETRIEVAL_STATUS_ERROR', retrieved_url: 'https://github.com/microsoft/TypeScript/releases' }
              ]
            },
            id: 'u1'
          },
          thoughtSignature: 'D'
        }
      ]),
      piece([{ toolCall: { toolType: 'URL_CONTEXT', args: { urls: [redirect] }, id: 'u2' }, thoughtSignature: 'E' }]),
      piece([{ toolResponse: { toolType: 'URL_CONTEXT', response: { url_metadata: [{ url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS', retrieved_url: redirect }] }, id: 'u2' }, thoughtSignature: 'F' }]),
      piece([{ text: 'TypeScript 7.0.2.' }]),
      piece([{ text: '', thoughtSignature: 'G' }], {
        finishReason: 'STOP',
        groundingMetadata: { groundingChunks: [{ web: { uri: redirect, title: 'typescript - npm' } }], groundingSupports: [] },
        urlContextMetadata: { urlMetadata: [{ retrievedUrl: redirect, urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] }
      })
    ])
  }))
  const messages: ChatMessage[] = [{ role: 'user', content: 'latest typescript?' }]
  const out = await turn(connection({ webSearch: true, model: 'gemini-4-hydrogen' }, service.baseURL), messages)
  assert.deepEqual(out.errors, [])
  assert.deepEqual((messages[1] as Assistant).web, [
    { id: 's1', kind: 'search', queries: ['typescript latest stable version npm'], status: 'done', sources: [{ url: redirect, title: 'typescript - npm' }], suggestions: '<div/>' },
    { id: 'u1', kind: 'open', url: 'https://github.com/microsoft/TypeScript/releases', status: 'failed', error: 'url_not_accessible', sources: [] },
    { id: 'u2', kind: 'open', url: redirect, status: 'done', sources: [{ url: redirect, title: 'typescript - npm' }] }
  ])
})

test('a search told only at the end of the reply is one search of its own, with its pages', async () => {
  const service = await fakeGemini(() => ({
    body: geminiSse([piece([{ text: 'Spain won.' }]), piece([], { finishReason: 'STOP', groundingMetadata: GROUNDING })])
  }))
  const messages: ChatMessage[] = [{ role: 'user', content: 'who won euro 2024?' }]
  const out = await turn(connection({ webSearch: true }, service.baseURL), messages)
  assert.deepEqual(out.errors, [])
  const reply = messages[1] as Assistant
  assert.equal(reply.web?.length, 1)
  const [search] = reply.web!
  assert.match(search.id, /^gemini-\w+-search$/)
  assert.deepEqual(
    { ...search, id: '' },
    { id: '', kind: 'search', queries: ['electron latest'], status: 'done', sources: [{ url: REDIRECT, title: 'electronjs.org' }], suggestions: GROUNDING.searchEntryPoint.renderedContent }
  )
})

test("Gemini's parts of its own search, its pages and what it read, as the page is told them", () => {
  assert.deepEqual(geminiActivity(SEARCH_PARTS[0]), { id: 's1', kind: 'search', queries: ['electron latest'], status: 'running' })
  assert.deepEqual(geminiActivity(SEARCH_PARTS[1]), { id: 's1', kind: 'search', status: 'done', suggestions: '<div>chips</div>' })
  assert.deepEqual(geminiActivity({ toolCall: { toolType: 'URL_CONTEXT', args: { urls: ['https://a.example', 'https://b.example'] }, id: 'u2' } }), {
    id: 'u2',
    kind: 'open',
    url: 'https://a.example',
    status: 'running'
  })
  // The fields come in either spelling; a page that could not be read is not among the pages read.
  assert.deepEqual(
    geminiActivity({
      toolResponse: {
        toolType: 'URL_CONTEXT',
        id: 'u2',
        response: {
          urlMetadata: [
            { retrievedUrl: 'https://a.example', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_PAYWALL' },
            { retrievedUrl: 'https://b.example', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }
          ]
        }
      }
    }),
    { id: 'u2', kind: 'open', status: 'done', sources: [{ url: 'https://b.example' }] }
  )
  assert.deepEqual(
    geminiActivity({ toolResponse: { toolType: 'URL_CONTEXT', id: 'u3', response: { url_metadata: [{ retrieved_url: 'https://c.example', url_retrieval_status: 'URL_RETRIEVAL_STATUS_UNSAFE' }] } } }),
    { id: 'u3', kind: 'open', status: 'failed', error: 'url_not_allowed', sources: [] }
  )
  assert.equal(geminiActivity({ toolCall: { toolType: 'GOOGLE_MAPS', id: 'm1', args: {} } }), null)
  assert.equal(geminiActivity({ text: 'hi' }), null)
  // Suggestions alone are worth telling: they are to be shown with the answer.
  assert.deepEqual(geminiGrounding({ searchEntryPoint: { renderedContent: '<div/>' } }, 'x'), { id: 'x', kind: 'search', status: 'done', suggestions: '<div/>' })
  assert.equal(geminiGrounding({ groundingSupports: [] }, 'x'), null)
  assert.deepEqual(
    geminiPagesRead({ urlMetadata: [{ retrievedUrl: 'https://d.example', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' }, { retrievedUrl: 'https://e.example', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] }, 'p'),
    [
      { id: 'p-0', kind: 'open', url: 'https://d.example', status: 'failed', error: 'url_not_accessible' },
      { id: 'p-1', kind: 'open', url: 'https://e.example', status: 'done', sources: [{ url: 'https://e.example' }] }
    ]
  )
})

test('a conversation another model began: its calls go with the stand-in for a signature, its thinking stays behind', () => {
  const other: ChatMessage[] = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: 'Looking.',
      reasoning_content: 'Another service thought this.',
      tool_calls: [
        { id: 'call_a', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { id: 'call_b', name: 'list_dir', arguments: 'not json' }
      ],
      web: [{ id: 'ws_1', kind: 'search', queries: ['x'], status: 'done' }],
      origin: { provider: 'other', kind: 'openai-chat', model: 'm' }
    },
    { role: 'tool', tool_call_id: 'call_b', content: 'Error: no such folder' },
    { role: 'tool', tool_call_id: 'call_a', content: 'text' },
    { role: 'user', content: 'next' },
    { role: 'user', content: 'and more' }
  ]
  assert.deepEqual(geminiContents({ messages: other, connection: connection() }), [
    { role: 'user', parts: [{ text: 'q' }] },
    {
      role: 'model',
      parts: [
        { text: '[Earlier you searched the web for "x" and read the results; they are not repeated here.]\n\nLooking.' },
        { functionCall: { id: 'call_a', name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'skip_thought_signature_validator' },
        { functionCall: { id: 'call_b', name: 'list_dir', args: {} } }
      ]
    },
    // In the order of the calls, a failure marked as one.
    {
      role: 'user',
      parts: [
        { functionResponse: { name: 'read_file', id: 'call_a', response: { output: 'text' } } },
        { functionResponse: { name: 'list_dir', id: 'call_b', response: { error: 'Error: no such folder' } } }
      ]
    },
    // What the person wrote next stands apart from the results; two messages of theirs go as one.
    { role: 'user', parts: [{ text: 'next' }, { text: 'and more' }] }
  ])
})

test('a call Gemini gave no id keeps the one the app gave it, and its result goes back without an id', async () => {
  const service = await fakeGemini((_seen, count) => ({
    body:
      count === 1
        ? geminiSse([piece([{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }], { finishReason: 'STOP' })])
        : geminiSse([piece([{ text: 'Done.' }], { finishReason: 'STOP' })])
  }))
  const messages: ChatMessage[] = [{ role: 'user', content: 'read a.txt' }]
  const out = await turn(connection({ model: 'gemini-2.5-flash' }, service.baseURL), messages)
  assert.deepEqual(out.errors, [])
  const call = messages[1] as Assistant
  const id = call.tool_calls![0].id
  assert.ok(id)
  assert.deepEqual(call.origin?.replay, { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.txt' } } }], calls: [id] })
  assert.deepEqual(service.posts()[1].body.contents.at(-1), { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: '1\thello from the file' } } }] })
})

test('how hard the model thinks: a level by name from Gemini 3 on, a number of tokens before; nothing for one that does not think', () => {
  const body = (extra: Partial<Connection>, facts: Parameters<typeof geminiBody>[1] = null) =>
    geminiBody({ connection: connection(extra), system: '', messages: [{ role: 'user', content: 'hi' }], tools: [] }, facts)
  assert.deepEqual(body({ model: 'gemini-4-neon', reasoningEffort: 'xhigh' }).generationConfig, { thinkingConfig: { includeThoughts: true, thinkingLevel: 'xhigh' } })
  assert.deepEqual(body({ model: 'gemini-3.6-flash' }).generationConfig, { thinkingConfig: { includeThoughts: true } })
  assert.deepEqual(body({ model: 'gemini-2.5-flash', reasoningEffort: 'none' }).generationConfig, { thinkingConfig: { includeThoughts: true, thinkingBudget: 0 } })
  assert.deepEqual(body({ model: 'models/gemini-2.5-pro', reasoningEffort: 'medium' }).generationConfig, { thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } })
  assert.deepEqual(body({ model: 'gemini-2.5-pro', reasoningEffort: 'xhigh' }).generationConfig, { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } })
  assert.equal(body({ model: 'gemma-4-31b-it', reasoningEffort: 'low' }, { thinking: false }).generationConfig, undefined)
  // Without instructions there is nothing to send for them, and no tools means no tools field.
  const bare = body({})
  assert.equal(bare.systemInstruction, undefined)
  assert.equal(bare.tools, undefined)

  assert.deepEqual(geminiLevels('gemini-4-hydrogen'), { efforts: ['low', 'medium', 'high', 'xhigh'], usual: 'high' })
  assert.deepEqual(geminiLevels('models/Gemini-3.5-Flash-Lite-preview-09-2026'), { efforts: ['minimal', 'low', 'medium', 'high'], usual: 'minimal' })
  assert.deepEqual(geminiLevels('gemini-2.5-flash-lite'), { efforts: ['none', 'low', 'medium', 'high'], usual: 'none' })
  assert.deepEqual(geminiLevels('gemini-2.5-pro'), { efforts: ['low', 'medium', 'high'] })
  assert.equal(geminiLevels('gemini-9-flash'), undefined)
})

test("tool schemas go as JSON Schema, without the `$schema` an MCP server puts at the top", () => {
  const sent = geminiBody({
    connection: connection(),
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'mcp__x__y', description: '', parameters: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } }]
  })
  assert.deepEqual(sent.tools, [
    { functionDeclarations: [{ name: 'mcp__x__y', description: 'mcp__x__y', parametersJsonSchema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } }] }
  ])
})

test('pictures go before the text of a message, and not at all to a model known to take none', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is this?', attachments: [{ kind: 'image', name: 'a.png', type: 'image/png', data: 'iVBOR' }] }]
  assert.deepEqual(geminiContents({ messages, connection: connection() }), [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBOR' } }, { text: 'what is this?' }] }
  ])
  const blind = geminiContents({ messages, connection: connection({ noImages: true }) })
  assert.equal(blind[0].parts.length, 1)
  assert.equal(blind[0].parts.some((part) => part.inlineData), false)
})

test("the service's errors are shown in its words; a busy service is asked again, and a pause it names is kept", async () => {
  const refused = await fakeGemini(() =>
    json(
      {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]
        }
      },
      400
    )
  )
  const bad = await turn(connection({}, refused.baseURL), [{ role: 'user', content: 'hi' }])
  assert.deepEqual(bad.errors, ['API key not valid. Please pass a valid API key. (HTTP 400 INVALID_ARGUMENT)'])
  assert.equal(refused.posts().length, 1)

  const busy = await fakeGemini((_seen, count) =>
    count === 1 ? json({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }, 503) : { body: geminiSse([piece([{ text: 'ok' }], { finishReason: 'STOP' })]) }
  )
  const later = await turn(connection({}, busy.baseURL), [{ role: 'user', content: 'hi' }])
  assert.deepEqual(later.errors, [])
  assert.equal(later.text, 'ok')
  assert.equal(busy.posts().length, 2)

  const quota = { code: 429, message: 'You exceeded your current quota.', status: 'RESOURCE_EXHAUSTED' }
  const paced = await fakeGemini((_seen, count) =>
    count === 1
      ? json({ error: { ...quota, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.05s' }] } }, 429)
      : { body: geminiSse([piece([{ text: 'ok' }], { finishReason: 'STOP' })]) }
  )
  assert.deepEqual((await turn(connection({}, paced.baseURL), [{ role: 'user', content: 'hi' }])).errors, [])
  assert.equal(paced.posts().length, 2)
  // Without a pause it names, a limit is not tried again: the quota is the person's to see to.
  const spent = await fakeGemini(() => json({ error: quota }, 429))
  assert.deepEqual((await turn(connection({}, spent.baseURL), [{ role: 'user', content: 'hi' }])).errors, ['You exceeded your current quota. (HTTP 429 RESOURCE_EXHAUSTED)'])
  assert.equal(spent.posts().length, 1)
  // With the search asked for, what a free-tier key gets for it every time is said for what it may be.
  const [searched] = (await turn(connection({ webSearch: true }, spent.baseURL), [{ role: 'user', content: 'hi' }])).errors
  assert.match(searched, /^You exceeded your current quota\. \(HTTP 429 RESOURCE_EXHAUSTED\) If this key is on Google's free tier: .*Switch web search off/)
})

test('a reply cut short, stopped by the service, a request it declined, and a stream that broke off', async () => {
  const cases: [unknown[], string][] = [
    [[piece([{ functionCall: { id: 'f', name: 'read_file', args: {} }, thoughtSignature: 'S' }], { finishReason: 'MAX_TOKENS' })], 'The model ran out of output space in the middle of a tool call, so the call was not run.'],
    [[piece([{ text: 'Part of' }], { finishReason: 'MAX_TOKENS' })], 'The model ran out of output space before it finished.'],
    [[piece([{ text: 'Hm' }], { finishReason: 'SAFETY' })], 'The service ended the reply early (SAFETY).'],
    [[piece([], { finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Malformed function call: read_file(' })], 'The service ended the reply early (MALFORMED_FUNCTION_CALL: Malformed function call: read_file().'],
    [[{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }], 'The service declined this request (PROHIBITED_CONTENT).'],
    [[piece([{ text: 'Half' }])], 'The connection to the service ended before the reply was complete.'],
    [[piece([{ text: 'x' }]), { error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }], 'Internal error encountered. (HTTP 500 INTERNAL)']
  ]
  for (const [chunks, said] of cases) {
    const service = await fakeGemini(() => ({ body: geminiSse(chunks) }))
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const out = await turn(connection({}, service.baseURL), messages)
    assert.deepEqual(out.errors, [said])
    assert.deepEqual(out.toolResults, [], 'nothing in such a reply is run')
    assert.equal(service.posts().length, 1)
    const reply = messages.find((m): m is Assistant => m.role === 'assistant')
    assert.equal(reply?.tool_calls, undefined)
    assert.equal(reply?.origin?.replay, undefined)
  }
})

test('a reply stopped while it comes keeps what was shown, and nothing of what was on its way', async () => {
  const service = await fakeGemini(() => ({
    body: geminiSse([
      piece([{ text: 'First' }]),
      piece([{ text: ' and second' }]),
      piece([{ functionCall: { id: 'f', name: 'read_file', args: {} }, thoughtSignature: 'S' }], { finishReason: 'STOP' })
    ])
  }))
  const stop = new AbortController()
  const conn = connection({}, service.baseURL)
  const reply = await adapterFor('gemini').complete({ ...request(conn, [{ role: 'user', content: 'go' }]), signal: stop.signal, onText: () => stop.abort() })
  assert.equal(reply.message.content, 'First')
  assert.equal(reply.message.tool_calls, undefined)
  assert.equal(reply.message.origin?.replay, undefined)
  assert.equal(reply.stopped, undefined)
})

test("the address of Gemini's OpenAI-compatible endpoint is taken for its own API", async () => {
  const service = await fakeGemini(() => ({ body: geminiSse([piece([{ text: 'ok' }], { finishReason: 'STOP' })]) }))
  const official = 'https://generativelanguage.googleapis.com/v1beta'
  const realFetch = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    asked.push(url)
    return realFetch(url.replace(official, service.baseURL), init)
  }) as typeof fetch
  try {
    const out = await turn(connection({ model: 'gemini-3.8-flash' }, `${official}/openai/`), [{ role: 'user', content: 'hi' }])
    assert.deepEqual(out.errors, [])
  } finally {
    globalThis.fetch = realFetch
  }
  assert.ok(asked.includes(`${official}/models/gemini-3.8-flash:streamGenerateContent?alt=sse`))
  assert.ok(asked.every((url) => !url.includes('/openai')))
})

test('the list of models holds those that hold a conversation, across pages; a model is told with its levels and its context', async () => {
  const service = await fakeGemini(
    () => ({ body: '' }),
    (seen) => {
      if (seen.url === '/models?pageSize=1000') {
        return json({
          models: [
            { name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            { name: 'models/gemini-embedding-2', displayName: 'Gemini Embedding 2', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] }
          ],
          nextPageToken: 'p2'
        })
      }
      if (seen.url === '/models?pageSize=1000&pageToken=p2') return json({ models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }] })
      if (seen.url === '/models/gemini-4-hydrogen') {
        return json({ name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true })
      }
      return notFound
    }
  )
  const gemini = adapterFor('gemini')
  const conn = connection({ model: 'gemini-4-hydrogen' }, service.baseURL)
  assert.deepEqual(await gemini.listModels(conn), [{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }, { id: 'gemini-3.6-flash' }])
  assert.equal(service.requests[0].headers['x-goog-api-key'], 'test-key')
  assert.deepEqual(await gemini.modelInfo(conn), { name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', contextWindow: 1048576 })
  await assert.rejects(gemini.modelInfo({ ...conn, model: 'gemini-nothing' }), /Model not found\. \(HTTP 404 NOT_FOUND\)/)
})

test("what Gemini counts: the whole input with what came from the cache, and the reply with the thinking it counts apart", () => {
  assert.deepEqual(
    normalizeUsage('gemini', { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5, toolUsePromptTokenCount: 7, totalTokenCount: 122 }),
    { input: 60, cacheRead: 40, output: 15, reasoning: 5 }
  )
  assert.deepEqual(normalizeUsage('gemini', { promptTokenCount: 12, candidatesTokenCount: 3 }), { input: 12, output: 3 })
  assert.equal(normalizeUsage('gemini', {}), undefined)
})

test('Gemini can search on its own API from Gemini 3 on, and its preset speaks that API', () => {
  const of = (model: string, kind: 'gemini' | 'openai-chat' = 'gemini', baseURL = 'https://generativelanguage.googleapis.com/v1beta') => webSearchService({ kind, baseURL, model })
  assert.equal(of('gemini-4-hydrogen'), 'google')
  assert.equal(of('gemini-3.1-flash-lite'), 'google')
  assert.equal(of('gemini-flash-latest'), 'google')
  // Gemini 2.5 cannot search while it has the app's tools; the compatible endpoint has no search; another address is a gateway.
  assert.equal(of('gemini-2.5-flash'), undefined)
  assert.equal(of('models/gemini-2.5-pro'), undefined)
  assert.equal(of('gemini-4-hydrogen', 'openai-chat', 'https://generativelanguage.googleapis.com/v1beta/openai'), undefined)
  assert.equal(of('gemini-4-hydrogen', 'gemini', 'https://gateway.example.com/v1beta'), undefined)
  assert.equal(of(''), undefined)
  assert.equal(geminiSearchesWithTools('gemma-4-31b-it'), false)

  const preset = PROVIDER_PRESETS.find((p) => p.id === 'gemini')
  assert.deepEqual(preset && { kind: preset.kind, baseURL: preset.baseURL }, { kind: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta' })
})

// Compaction (main/compaction.ts) with Gemini: the summary is asked for in Gemini's format, and
// what is kept of the conversation goes back to Gemini as it was, signatures and all.

/** A text of that many tokens, as the app guesses: four Latin letters to a token. */
const words = (tokens: number, start = ''): string => start + 'x'.repeat(tokens * 4 - start.length)

/** A reply of Gemini's as the adapter keeps it: its parts with their signatures, and the app's ids of its calls. */
function geminiReply(content: string, parts: Part[], calls: ToolCall[] = [], web?: WebActivity[]): ChatMessage {
  return {
    role: 'assistant',
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(web ? { web } : {}),
    origin: { provider: 'g1', kind: 'gemini', model: 'model-x', replay: { parts, calls: calls.map((c) => c.id) } }
  }
}

/**
 * Five turns of talk with Gemini, 2750 tokens, each reply with the signature its last part came
 * with; then a turn in which it searched and read a file, and answered.
 */
function geminiTalk(): StoredMessage[] {
  const out: StoredMessage[] = []
  for (let i = 1; i <= 5; i++) {
    const text = words(500, `a${i} `)
    out.push({ role: 'user', content: words(50, `u${i} `) }, geminiReply(text, [{ text }, { text: '', thoughtSignature: `SIG-a${i}` }]))
  }
  out.push(
    { role: 'user', content: words(50, 'u6 ') },
    geminiReply(
      '',
      [
        { toolCall: { toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['q6'] }, id: 's6' }, thoughtSignature: 'SIG-s6a' },
        { toolResponse: { toolType: 'GOOGLE_SEARCH_WEB', response: { search_suggestions: '<div>chips</div>' }, id: 's6' }, thoughtSignature: 'SIG-s6b' },
        { functionCall: { id: 'fc6', name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'SIG-f6' }
      ],
      [{ id: 'fc6', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      [{ id: 's6', kind: 'search', queries: ['q6'], status: 'done', suggestions: '<div>chips</div>' }]
    ),
    { role: 'tool', tool_call_id: 'fc6', content: 'hello' },
    geminiReply('It says hello.', [{ text: 'It says hello.' }, { text: '', thoughtSignature: 'SIG-a6' }])
  )
  return out
}

/** What a turn or a compaction of these tests is run with, but for what a test wants different. */
async function compactionOptions(conn: Connection, messages: StoredMessage[], events: AgentEvent[], more: Partial<TurnOptions> = {}): Promise<TurnOptions> {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  return {
    connection: conn,
    workspace: await mkdtemp(path.join(os.tmpdir(), 'starbench-gemini-compact-')),
    messages,
    signal: new AbortController().signal,
    tools,
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    requestPermission: async () => 'allow',
    room: { window: 4000, settings: COMPACTION_DEFAULTS },
    ...more
  }
}

/** Every call among Gemini's parts is answered by the result that follows it, by its id, and keeps the signature it was stored with. */
function assertPaired(contents: { role: string; parts: Part[] }[], stored: readonly StoredMessage[]): void {
  const signatures = new Map<string, unknown>()
  for (const message of stored) {
    const parts = message.role === 'assistant' ? ((message.origin?.replay as { parts?: Part[] } | undefined)?.parts ?? []) : []
    for (const part of parts) if (part.functionCall?.id) signatures.set(part.functionCall.id, part.thoughtSignature)
  }
  contents.forEach((content, i) => {
    for (const part of content.parts) {
      if (!part.functionCall) continue
      assert.equal(part.thoughtSignature, signatures.get(part.functionCall.id!), `the call ${part.functionCall.id} keeps its signature`)
      const answered = contents[i + 1]?.parts.some((p) => p.functionResponse?.id === part.functionCall!.id)
      assert.ok(answered, `the call ${part.functionCall.id} is answered right after it`)
    }
  })
}

test("a Gemini conversation compacted at the person's asking: the summary is asked for plainly, and what is kept goes back with its signatures", async () => {
  const service = await fakeGemini(() => ({
    body: geminiSse([piece([{ text: 'Weighing what to keep.', thought: true }]), piece([{ text: 'The gist ' }]), piece([{ text: 'of it.' }], { finishReason: 'STOP' })])
  }))
  const conn = connection({ webSearch: true }, service.baseURL)
  const messages = geminiTalk()
  const events: AgentEvent[] = []
  assert.deepEqual(await compactConversation(await compactionOptions(conn, messages, events)), { done: true })

  // Asked for in Gemini's format with nothing of the conversation's own: no tools, no search, one message with the record.
  const [asked] = service.posts()
  assert.equal(service.posts().length, 1)
  assert.equal(asked.url, '/models/model-x:streamGenerateContent?alt=sse')
  assert.equal(asked.body.tools, undefined)
  assert.equal(asked.body.toolConfig, undefined)
  assert.match(asked.body.systemInstruction.parts[0].text, /^You write the summary/)
  assert.equal(asked.body.contents.length, 1)
  assert.equal(asked.body.contents[0].role, 'user')
  assert.match(asked.body.contents[0].parts[0].text, /^<record>\n\[user\]\nu1 x/)
  // The model's thinking before the summary is not taken for the summary.
  const mark = messages.find((m): m is CompactionMark => m.role === 'compaction')
  assert.equal(mark?.summary?.text, 'The gist of it.')

  // What goes to Gemini from now on: the summary in front of the turn that was kept, which goes as it was.
  // (The last two turns are kept here: the summary goes in front of the first thing the person wrote in them.)
  const kept = sendable(messages)
  const sent = geminiContents({ messages: kept, connection: conn })
  const replayed = (message: StoredMessage): Part[] => ((message as Assistant).origin!.replay as { parts: Part[] }).parts
  assert.deepEqual(
    sent.map((c) => c.role),
    ['user', 'model', 'user', 'model', 'user', 'model']
  )
  assert.ok(sent[0].parts[0].text?.startsWith(SUMMARY_OPEN))
  assert.ok(sent[0].parts[0].text?.endsWith(words(50, 'u5 ')))
  assert.deepEqual(sent[1].parts, replayed(messages.at(-5)!), 'a reply goes with the signature its last part came with')
  assert.deepEqual(sent[3].parts, replayed(messages.at(-3)!), 'the search and the call, as Gemini wrote them')
  assertPaired(sent, messages)
  // With the search off by now, the search goes as a note in front, and the call keeps its signature.
  const plain = geminiContents({ messages: kept, connection: { ...conn, webSearch: false } })
  assert.match(plain[3].parts[0].text ?? '', /searched the web for "q6"/)
  assert.deepEqual(plain[3].parts.slice(1), [{ functionCall: { id: 'fc6', name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'SIG-f6' }])
  assertPaired(plain, messages)
  assert.deepEqual(
    events.map((e) => e.type),
    ['compacting', 'compacting', 'compacted']
  )
})

test("Gemini's refusal of a conversation as too long is recognized: it is compacted and sent once more", async () => {
  // In the words of Gemini's own API; the number of tokens the model takes is in it, though not in a form the app reads.
  const tooLong = json({ error: { code: 400, message: 'The input token count (1048590) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } }, 400)
  const service = await fakeGemini((_seen, count) =>
    count === 1 ? tooLong : count === 2 ? { body: geminiSse([piece([{ text: 'The gist.' }], { finishReason: 'STOP' })]) } : { body: geminiSse([piece([{ text: 'ok' }], { finishReason: 'STOP' })]) }
  )
  const conn = connection({}, service.baseURL)
  const messages: StoredMessage[] = [...geminiTalk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  // Nothing is known of the size of the model's context, so nothing is compacted beforehand.
  await runTurn(await compactionOptions(conn, messages, events, { room: { settings: COMPACTION_DEFAULTS } }))

  const [first, summary, again] = service.posts()
  assert.equal(service.posts().length, 3, 'a refusal is not asked again as it was')
  assert.equal(first.body.contents.length, 15, 'the whole conversation at first')
  assert.equal(summary.body.tools, undefined, 'then the summary is asked for')
  assert.ok(again.body.contents[0].parts[0].text.startsWith(SUMMARY_OPEN), 'and the conversation goes again from it')
  assert.ok(again.body.contents.length < first.body.contents.length)
  assert.deepEqual(
    events.filter((e) => e.type === 'error'),
    []
  )
  assert.equal((messages.at(-1) as Assistant).content, 'ok')
})

test('a Gemini conversation compacted between two steps of a turn keeps the call of the turn with its signature', async () => {
  // A tool that returns more than fits beside the conversation: after it, there is no room left for the next step.
  const tools = new ToolRegistry()
  tools.register({ name: 'big', description: 'returns a lot', needsPermission: false, run: () => 'y'.repeat(8000) }, 'builtin')
  const service = await fakeGemini((_seen, count) =>
    count === 1
      ? { body: geminiSse([piece([{ functionCall: { id: 'fcB', name: 'big', args: {} }, thoughtSignature: 'SIG-B' }], { finishReason: 'STOP' })]) }
      : count === 2
        ? { body: geminiSse([piece([{ text: 'The gist.' }], { finishReason: 'STOP' })]) }
        : { body: geminiSse([piece([{ text: 'done' }], { finishReason: 'STOP' })]) }
  )
  const conn = connection({}, service.baseURL)
  const messages: StoredMessage[] = [...geminiTalk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  await runTurn(await compactionOptions(conn, messages, events, { tools, room: { window: 5000, settings: COMPACTION_DEFAULTS } }))

  const [step1, summary, step2] = service.posts()
  assert.equal(service.posts().length, 3)
  assert.ok(step1.body.contents.length >= 15, 'nothing was compacted before the first step')
  assert.equal(summary.body.tools, undefined, 'the summary was asked for between the steps')
  // The next step goes from the summary, with the call of this turn as Gemini wrote it, and its result.
  const sent: { role: string; parts: Part[] }[] = step2.body.contents
  assert.ok(sent[0].parts[0].text?.startsWith(SUMMARY_OPEN))
  const call = sent.findIndex((c) => c.parts.some((p) => p.functionCall?.id === 'fcB'))
  assert.ok(call > 0)
  assert.deepEqual(sent[call].parts, [{ functionCall: { id: 'fcB', name: 'big', args: {} }, thoughtSignature: 'SIG-B' }])
  assert.equal(sent[call + 1].parts[0].functionResponse?.id, 'fcB')
  assertPaired(sent, messages)
  assert.deepEqual(
    events.filter((e) => e.type === 'error'),
    []
  )
  assert.equal((messages.at(-1) as Assistant).content, 'done')
})
