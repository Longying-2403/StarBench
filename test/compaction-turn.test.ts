// Drives the real agent loop against a fake OpenAI-compatible server, with a context small
// enough to fill: what is cut, cleared and summed up on the way, and what the model is sent then.
// Run with: node --test test/compaction-turn.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { compactConversation, runTurn } from '../src/main/agent.ts'
import type { TurnOptions } from '../src/main/agent.ts'
import { sendable } from '../src/main/compaction.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { ToolRegistry } from '../src/main/tools.ts'
import { COMPACTION_DEFAULTS, SUMMARY_CLOSE, SUMMARY_OPEN } from '../src/shared/compaction.ts'
import { addCompaction, addStep, emptyStats, estimateTokens } from '../src/shared/stats.ts'
import type { CompactionDone, StepMeasure } from '../src/shared/stats.ts'
import type { AgentEvent, ChatMessage, CompactionMark, StoredMessage } from '../src/shared/types.ts'

const chunk = (delta: object): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`
/** What the service says a request cost, as the last piece of a streamed reply. */
const cost = (prompt: number, completion: number): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\n`
const call = (id: string, name: string, args: object = {}): string => chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

/** A request the service turns down instead of answering. */
interface Refusal {
  status: number
  message: string
}
interface Asked {
  messages: { role: string; content: string; tool_calls?: unknown[] }[]
  tools?: unknown[]
}

/** Serves one scripted response per request, a stream or a refusal, and records the request bodies. */
async function fakeModel(scripts: (string[] | Refusal)[]) {
  const requests: Asked[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const script = scripts[requests.length - 1] ?? []
      if (!Array.isArray(script)) {
        res.writeHead(script.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: script.message, type: 'invalid_request_error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of script) res.write(part)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // Closed when the run ends, whether the tests passed or not: a test that fails before it has
  // closed its server would otherwise keep the process waiting, and nothing would be reported.
  after(() => void server.closeAllConnections?.())
  after(() => void server.close())
  return { requests, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

const connectionTo = (baseURL: string): Connection => ({ provider: 'test', kind: 'openai-chat', apiKey: 'test', baseURL, model: 'fake', reasoningEffort: 'default' })
/** A text of that many tokens, as the app guesses: four Latin letters to a token. */
const words = (tokens: number, start = ''): string => start + 'x'.repeat(tokens * 4 - start.length)
/** Six turns of talk, 3300 tokens: the person writes 50, the model answers with 500. */
const talk = (): StoredMessage[] => Array.from({ length: 6 }, (_, i) => [{ role: 'user', content: words(50, `u${i + 1} `) }, { role: 'assistant', content: words(500, `a${i + 1} `) }] as StoredMessage[]).flat()

/** The tools of these tests: one that returns far more than fits, and one that returns next to nothing. */
function someTools(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register({ name: 'big', description: 'returns a lot', needsPermission: false, run: () => 'x'.repeat(8000) }, 'builtin')
  tools.register({ name: 'small', description: 'returns a little', needsPermission: false, run: () => 'fine' }, 'builtin')
  return tools
}

/** What a turn of these tests is run with, but for what a test wants different. */
async function options(baseURL: string, messages: StoredMessage[], events: AgentEvent[], over: Partial<TurnOptions> = {}): Promise<TurnOptions> {
  return {
    connection: connectionTo(baseURL),
    workspace: await mkdtemp(path.join(os.tmpdir(), 'starbench-compact-')),
    messages,
    signal: new AbortController().signal,
    tools: someTools(),
    alwaysAllowed: new Set(),
    emit: (e) => events.push(e),
    checkpoint: () => {},
    requestPermission: async () => 'allow',
    room: { window: 4000, settings: COMPACTION_DEFAULTS },
    ...over
  }
}

const marksIn = (messages: StoredMessage[]): CompactionMark[] => messages.filter((m): m is CompactionMark => m.role === 'compaction')
const typesOf = (events: AgentEvent[]): string[] => events.map((e) => (e.type === 'compacting' ? `compacting ${e.on ? 'on' : 'off'}` : e.type))

test('tool results are cut to fit the context as they come, and the old ones are cleared in one go when it fills up', async () => {
  const model = await fakeModel([[call('c1', 'big')], [call('c2', 'big')], [call('c3', 'big')], [call('c4', 'big')], [chunk({ content: 'done' })]])
  const messages: StoredMessage[] = [{ role: 'user', content: 'go' }]
  const events: AgentEvent[] = []
  await runTurn(await options(model.baseURL, messages, events))
  await model.close()

  // A context of 4000 tokens is compacted from 3200 on, and one step's results may take a quarter of that.
  const results = messages.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool')
  assert.equal(results.length, 4)
  for (const kept of results) {
    assert.ok(estimateTokens(kept.content) <= 800, `${estimateTokens(kept.content)} tokens`)
    assert.match(kept.content, /^x{3040}\n… \[cut here to fit the model's context: 4960 more characters\./)
  }
  assert.deepEqual(events.flatMap((e) => (e.type === 'tool_result' ? [e.output] : [])), results.map((r) => r.content), 'the page is shown what the model is sent')

  // Four results are more than fit: before the fifth request the three old ones are cleared, the latest stays.
  assert.equal(model.requests.length, 5)
  const [mark] = marksIn(messages)
  assert.equal(marksIn(messages).length, 1)
  assert.equal(mark.cleared, 3)
  assert.equal(mark.summary, undefined)
  assert.equal(mark.window, 4000)
  assert.ok(mark.before >= 3200 && mark.after <= 2400, `${mark.before} → ${mark.after}`)
  const line = `[Result cleared to save room in the context: ${results[0].content.length} characters. Read or run it again if it is needed.]`
  assert.deepEqual(results.map((r) => r.cleared), [line, line, line, undefined])
  const toolTexts = (at: number): string[] => model.requests[at].messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.deepEqual(toolTexts(3), results.slice(0, 3).map((r) => r.content), 'nothing is trimmed a little at a time')
  assert.deepEqual(toolTexts(4), [line, line, line, results[3].content])
  // No model was asked for anything but the conversation itself.
  assert.ok(model.requests.every((r) => Array.isArray(r.tools)))
  assert.deepEqual(typesOf(events).filter((t) => t.startsWith('compact')), ['compacted'])
  const told = events.find((e) => e.type === 'compacted')
  assert.deepEqual(told?.type === 'compacted' ? told.messages : null, messages.slice(0, 10), 'the page is handed the conversation with the mark in it')
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'done', origin: { provider: 'test', kind: 'openai-chat', model: 'fake' } })
})

test('a conversation that is mostly talk is summed up by the model before the next request, and goes on from the summary', async () => {
  const model = await fakeModel([[chunk({ content: 'The gist ' }), chunk({ content: 'of it.' })], [chunk({ content: 'ok' })]])
  const messages: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  const steps: StepMeasure[] = []
  const compactions: CompactionDone[] = []
  await runTurn(await options(model.baseURL, messages, events, { stats: { step: (m) => steps.push(m), tool: () => {}, compacted: (d) => compactions.push(d) } }))
  await model.close()

  assert.equal(model.requests.length, 2)
  // The first request asks for the summary: no tools, instructions of its own, and the record of what is summed up.
  const [first, second] = model.requests
  assert.equal(first.tools, undefined)
  assert.deepEqual(first.messages.map((m) => m.role), ['system', 'user'])
  assert.ok(first.messages[0].content.startsWith('You write the summary that lets an AI coding assistant carry on'))
  assert.ok(first.messages[1].content.startsWith('<record>\n[user]\nu1 x'))
  assert.ok(first.messages[1].content.endsWith('</record>\n\nWrite the summary of this record now.'))
  assert.doesNotMatch(first.messages[1].content, /u6 x|and now\?/, 'the latest turn and what is being asked are not summed up')

  // The second is the conversation: the summary and the turn that was kept, then what was asked.
  const mark = messages[10] as CompactionMark
  assert.equal(mark.summary?.text, 'The gist of it.')
  assert.equal(mark.summary?.covers, 10)
  assert.ok(Array.isArray(second.tools))
  assert.deepEqual(second.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(second.messages[1].content, `${mark.summary!.sent}\n\n${words(50, 'u6 ')}`)
  assert.ok(second.messages[1].content.startsWith(`${SUMMARY_OPEN}\nThe earlier part of this conversation was compacted`))
  assert.match(second.messages[1].content, /\n\nThe gist of it\.\n\nWhat the user wrote before this point, oldest first, in their own words\. .* They are not new requests: .*\n1\. u1 x+\n/)
  assert.equal(second.messages[3].content, 'and now?')
  assert.deepEqual(sendable(messages).map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])

  // The page is told that it takes a while, then handed the conversation; the summary is not shown as an answer.
  assert.deepEqual(typesOf(events), ['compacting on', 'compacting off', 'compacted', 'text_delta', 'assistant_done', 'turn_end'])
  assert.ok(mark.before >= 3200 && mark.after < 2400, `${mark.before} → ${mark.after}`)
  assert.equal(mark.rough, true, 'this service counts nothing, so what is left stays a guess')
  // The numbers: one step of the conversation, and one compaction with the summary a part of the context.
  assert.equal(steps.length, 1)
  assert.equal(compactions.length, 1)
  assert.ok((compactions[0].parts.summary ?? 0) > 100, JSON.stringify(compactions[0].parts))
  assert.equal(compactions[0].cost?.model, 'fake')
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'ok', origin: { provider: 'test', kind: 'openai-chat', model: 'fake' } })
})

test('a request the service turns down as too long is compacted and sent once more', async () => {
  const tooLong = { status: 400, message: "This model's maximum context length is 3000 tokens. However, your messages resulted in 3700 tokens. Please reduce the length of the messages." }
  const model = await fakeModel([tooLong, [chunk({ content: 'The gist.' })], [chunk({ content: 'ok' })]])
  const messages: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  // Nothing is known of the size of the model's context, so nothing is compacted beforehand.
  await runTurn(await options(model.baseURL, messages, events, { room: { settings: COMPACTION_DEFAULTS } }))
  await model.close()

  assert.equal(model.requests.length, 3)
  assert.equal(model.requests[0].messages.length, 14, 'the whole conversation at first')
  assert.equal(model.requests[1].tools, undefined, 'then the summary is asked for')
  assert.deepEqual(model.requests[2].messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  const [mark] = marksIn(messages)
  assert.equal(mark.window, 3000, 'the refusal said how much the model takes')
  assert.equal(mark.summary?.text, 'The gist.')
  assert.equal(events.some((e) => e.type === 'error'), false)
  assert.equal((messages.at(-1) as ChatMessage).content, 'ok')

  // Where there is nothing to compact, the refusal is what the person is told.
  const short = await fakeModel([tooLong])
  const hello: StoredMessage[] = [{ role: 'user', content: 'hi' }]
  const told: AgentEvent[] = []
  await runTurn(await options(short.baseURL, hello, told, { room: { settings: COMPACTION_DEFAULTS } }))
  await short.close()
  assert.equal(short.requests.length, 1)
  assert.match(told.find((e) => e.type === 'error')?.type === 'error' ? (told.find((e) => e.type === 'error') as { message: string }).message : '', /maximum context length is 3000 tokens/)
  assert.deepEqual(hello, [{ role: 'user', content: 'hi' }])
})

test('what the service counts decides when the context is full, not what the app guesses', async () => {
  // The app guesses some 3600 tokens for the first request; the service counts 9000 of them.
  const model = await fakeModel([[call('c1', 'small'), cost(9000, 5)], [chunk({ content: 'The gist.' }), cost(900, 20)], [chunk({ content: 'done' }), cost(4000, 3)]])
  const messages: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  const compactions: CompactionDone[] = []
  await runTurn(
    await options(model.baseURL, messages, events, {
      room: { window: 8000, settings: COMPACTION_DEFAULTS },
      stats: { step: () => {}, tool: () => {}, compacted: (d) => compactions.push(d) }
    })
  )
  await model.close()

  assert.equal(model.requests.length, 3)
  assert.equal(model.requests[0].messages.length, 14, 'by the guess, everything still fits in 8000')
  assert.equal(model.requests[1].tools, undefined, 'by the count it does not: a summary is asked for before the second step')
  const fit = compactions[0]?.fit
  assert.ok(fit && fit.said > 2.3 && fit.said < 2.7 && fit.base > 2.3 && fit.base < 2.7, `the guesses are brought to the count: ${JSON.stringify(fit)}`)
  assert.equal(fit?.last, undefined, 'the request before the compaction is not one the next has grown from')
  assert.deepEqual(compactions[0].cost?.usage, { input: 900, output: 20 }, 'what the summary cost is told')
  const [mark] = marksIn(messages)
  assert.ok(mark.before > 6400, String(mark.before))
  // The request after the compaction is the compacted conversation and nothing else: what the
  // service counted of it stands on the mark, in place of the guess, and the page is told.
  assert.equal(mark.after, 4000)
  assert.equal(mark.rough, undefined)
  assert.deepEqual(events.filter((e) => e.type === 'compaction_counted'), [{ type: 'compaction_counted', at: mark.at, after: 4000 }])
  // In the middle of the task: the turn before, what was asked, and the call that was just made with its result are kept.
  const sent = model.requests[2].messages
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant', 'tool'])
  assert.equal(sent[1].content, `${mark.summary!.sent}\n\n${words(50, 'u6 ')}`)
  assert.ok(mark.summary!.sent.endsWith(SUMMARY_CLOSE))
  assert.equal(sent[3].content, 'and now?')
  assert.equal(sent[5].content, 'fine')
})

test('thinking that the service keeps with a reply fills the context like anything else, and is compacted away', async () => {
  // As one real service counts (xAI): the thinking apart from the reply, and all of it again in the next request.
  const thought = (prompt: number, completion: number, reasoning: number): string =>
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion + reasoning, completion_tokens_details: { reasoning_tokens: reasoning } } })}\n\n`
  const model = await fakeModel([
    [chunk({ content: 'A long answer, long thought over.' }), thought(700, 50, 9000)],
    [chunk({ content: 'The gist.' }), thought(400, 10, 0)],
    [chunk({ content: '42' }), thought(900, 2, 30)]
  ])
  const messages: StoredMessage[] = [{ role: 'user', content: 'think hard about this' }]
  const events: AgentEvent[] = []
  let stats = emptyStats()
  const counting: TurnOptions['stats'] = {
    step: (measure) => (stats = addStep(stats, measure)),
    tool: () => {},
    compacted: (done) => (stats = addCompaction(stats, done))
  }
  const room = { window: 8000, settings: COMPACTION_DEFAULTS }
  await runTurn(await options(model.baseURL, messages, events, { room, stats: counting }))

  // What the service counted for the reply is kept with it: 9050 tokens for a sentence.
  const reply = messages[1] as Extract<ChatMessage, { role: 'assistant' }>
  assert.equal(reply.origin?.tokens, 9050)
  assert.equal(stats.usage.output, 9050, 'and counted as what came back, thinking and all')
  // The first request held no reply yet: what the instructions and tools weigh was seen by itself.
  const fit = stats.context?.fit
  assert.ok(fit?.pinned !== undefined && fit.last?.tokens === 9750, JSON.stringify(fit))
  assert.equal(marksIn(messages).length, 0)

  // The next message finds the context at 9750 of 8000, nearly all of it that thinking: by its
  // text the conversation is a few lines. It is summed up all the same, and the reply with it.
  messages.push({ role: 'user', content: 'and the key number?' })
  await runTurn(await options(model.baseURL, messages, events, { room: { ...room, fit }, stats: counting }))
  await model.close()

  assert.equal(model.requests.length, 3)
  assert.equal(model.requests[1].tools, undefined, 'the summary is asked for')
  assert.deepEqual(model.requests[2].messages.map((m) => m.role), ['system', 'user'])
  assert.ok(model.requests[2].messages[1].content.endsWith(`${SUMMARY_CLOSE}\n\nand the key number?`))
  const [mark] = marksIn(messages)
  assert.equal(messages.indexOf(mark), 2)
  assert.ok(mark.before > 9700 && mark.before < 9900, String(mark.before))
  assert.equal(mark.after, 900, 'what the service counted of what was left')
  assert.equal((messages.at(-1) as ChatMessage).content, '42')
  assert.equal(stats.compactions, 1)
})

test('a summary that cannot be had is said, and the turn goes on with the conversation as it is', async () => {
  const model = await fakeModel([{ status: 400, message: 'this server is having a bad day' }, [chunk({ content: 'ok' })]])
  const messages: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  await runTurn(await options(model.baseURL, messages, events))
  await model.close()

  assert.equal(model.requests.length, 2)
  assert.equal(model.requests[1].messages.length, 14, 'everything, as before')
  assert.deepEqual(marksIn(messages), [])
  const notice = events.find((e) => e.type === 'notice')
  assert.deepEqual(notice?.type === 'notice' ? [notice.code, notice.detail] : null, ['compaction-failed', '400 this server is having a bad day'])
  assert.deepEqual(typesOf(events), ['compacting on', 'compacting off', 'notice', 'text_delta', 'assistant_done', 'turn_end'])
})

test('a summary that failed is not asked for again at every step of the turn', async () => {
  const model = await fakeModel([{ status: 400, message: 'no summaries today' }, [call('c1', 'small')], [chunk({ content: 'ok' })]])
  const messages: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  await runTurn(await options(model.baseURL, messages, events))
  await model.close()
  // One request for the summary, and then the two steps of the turn, each with the tools of the conversation.
  assert.equal(model.requests.length, 3)
  assert.deepEqual(model.requests.map((r) => Array.isArray(r.tools)), [false, true, true])
  assert.equal(events.filter((e) => e.type === 'notice').length, 1)
  assert.equal((messages.at(-1) as ChatMessage).content, 'ok')
})

test('the page is handed a compacted conversation without what only the service wants back', async () => {
  const model = await fakeModel([[chunk({ content: 'The gist.' })]])
  const messages = talk()
  const first = messages[1] as Extract<ChatMessage, { role: 'assistant' }>
  first.origin = { provider: 'anthropic', kind: 'anthropic', model: 'claude', replay: [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'text', text: 'a1' }] }
  const events: AgentEvent[] = []
  await compactConversation(await options(model.baseURL, messages, events))
  await model.close()
  const told = events.find((e) => e.type === 'compacted')
  const handed = told?.type === 'compacted' ? told.messages : []
  assert.equal(handed.length, messages.length)
  assert.deepEqual((handed[1] as typeof first).origin, { provider: 'anthropic', kind: 'anthropic', model: 'claude' })
  // What is kept is not touched by that: this message stands before the summary, and keeps what it had.
  assert.equal(Array.isArray(first.origin.replay), true)
})

test('a stop while the summary is written ends the turn and changes nothing', async () => {
  const model = await fakeModel([[chunk({ content: 'half a summ' })], [chunk({ content: 'never asked for' })]])
  const messages: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const before = structuredClone(messages)
  const events: AgentEvent[] = []
  const stopping = new AbortController()
  const opts = await options(model.baseURL, messages, events, { signal: stopping.signal })
  await runTurn({
    ...opts,
    emit: (e) => {
      events.push(e)
      if (e.type === 'compacting' && e.on) stopping.abort()
    }
  })
  await model.close()
  assert.deepEqual(messages, before)
  assert.deepEqual(typesOf(events), ['compacting on', 'compacting off', 'turn_end'])
  assert.ok(model.requests.length <= 1, 'the conversation itself was not sent')
})

test('the person can have a conversation compacted at any time', async () => {
  const model = await fakeModel([[chunk({ content: 'The gist.' })]])
  const messages = talk()
  const events: AgentEvent[] = []
  const saved: number[] = []
  const report = await compactConversation(await options(model.baseURL, messages, events, { checkpoint: () => saved.push(messages.length) }))
  await model.close()

  assert.deepEqual(report, { done: true })
  assert.equal(model.requests.length, 1)
  assert.equal(model.requests[0].tools, undefined)
  // The last turn is kept as it was; the five before it are summed up.
  const mark = messages[10] as CompactionMark
  assert.equal(mark.summary?.text, 'The gist.')
  assert.deepEqual(sendable(messages), [{ role: 'user', content: `${mark.summary!.sent}\n\n${words(50, 'u6 ')}` }, messages[12]])
  assert.deepEqual(typesOf(events), ['compacting on', 'compacting off', 'compacted'])
  assert.deepEqual(saved, [13], 'and saved with the mark in it')

  // A conversation with nothing in it worth compacting is left alone, and no model is asked.
  const quiet = await fakeModel([])
  const short: StoredMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
  assert.deepEqual(await compactConversation(await options(quiet.baseURL, short, [])), { done: false })
  await quiet.close()
  assert.equal(quiet.requests.length, 0)
  assert.equal(short.length, 2)

  // A summary that could not be had is told to whoever asked, and not put into the conversation as a notice.
  const down = await fakeModel([{ status: 400, message: 'no summaries today' }])
  const again = talk()
  const told: AgentEvent[] = []
  assert.deepEqual(await compactConversation(await options(down.baseURL, again, told)), { done: false, problem: '400 no summaries today' })
  await down.close()
  assert.deepEqual(typesOf(told), ['compacting on', 'compacting off'])
  assert.deepEqual(again, talk())
})

test('with compacting switched off nothing is compacted unasked, but results are still cut to fit', async () => {
  const model = await fakeModel([[call('c1', 'big')], [chunk({ content: 'ok' })]])
  const messages: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  await runTurn(await options(model.baseURL, messages, events, { room: { window: 4000, settings: { ...COMPACTION_DEFAULTS, auto: false } } }))
  await model.close()
  assert.equal(model.requests.length, 2)
  assert.deepEqual(marksIn(messages), [])
  const result = messages.find((m) => m.role === 'tool') as Extract<ChatMessage, { role: 'tool' }>
  assert.ok(estimateTokens(result.content) <= 800)

  // And without any word on the context at all, a turn is what it always was.
  const plain = await fakeModel([[call('c1', 'big')], [chunk({ content: 'ok' })]])
  const untouched: StoredMessage[] = [{ role: 'user', content: 'go' }]
  await runTurn(await options(plain.baseURL, untouched, [], { room: undefined }))
  await plain.close()
  assert.equal((untouched[2] as ChatMessage).content, 'x'.repeat(8000))
})

/** The last piece of a streamed reply's text: why the service ended it. */
const ended = (reason: string): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`
const noticeOf = (events: AgentEvent[]): unknown => {
  const notice = events.find((e) => e.type === 'notice')
  return notice?.type === 'notice' ? [notice.code, notice.detail] : null
}

test('a reply to the request for a summary that was cut short is not taken for the summary', async (t) => {
  // A model on a server of one's own, not seen before. Its reply runs out of output space: this
  // may be half a summary, or the thinking before one (the server passes on whatever the model wrote).
  const model = await fakeModel([[chunk({ content: 'Let me go through the record. The user first asked about u1, then' }), ended('length')], [chunk({ content: 'ok' })]])
  // Closed whatever a check below finds, or the run would wait for the server without end.
  t.after(() => model.close())
  const messages: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  await runTurn(await options(model.baseURL, messages, events))

  assert.equal(model.requests[0].tools, undefined, 'the summary was asked for')
  assert.deepEqual(marksIn(messages), [], 'and what came back was not put in the place of the conversation')
  assert.deepEqual(noticeOf(events), ['compaction-failed', 'The model ran out of output space before it finished.'])
  assert.equal(model.requests[1].messages.length, 14, 'the turn goes on with everything, as before')
  assert.equal((messages.at(-1) as ChatMessage).content, 'ok')
})

test('thinking that a model known for it writes in place of the summary is not taken for the summary, and the model stays known for it', async (t) => {
  const thinking = 'Let me go through the record. The user first asked about u1, then u2. I need to keep'
  const model = await fakeModel([
    // 1. An ordinary answer shows how this model writes: its thinking first, without the opening tag.
    [chunk({ content: 'Thinking it over.\n</think>\n\nHello.' })],
    // 2. Asked for a summary, it thinks, and the server ends the reply there, calling it finished.
    [chunk({ content: thinking }), ended('stop')],
    // 3. The turn goes on.
    [chunk({ content: 'More thinking.\n</think>\n\nok' })],
    // 4. Asked again in another conversation, it runs out of output space while thinking.
    [chunk({ content: thinking }), ended('length')],
    [chunk({ content: 'Still thinking.\n</think>\n\nfine' })],
    // 6 and 7. The person asks for a compaction twice in a row, and twice it only thinks.
    [chunk({ content: thinking }), ended('stop')],
    [chunk({ content: thinking }), ended('stop')],
    // 8. And then it writes one.
    [chunk({ content: 'Now for the summary.\n</think>\n\nThe gist.' })]
  ])
  t.after(() => model.close())
  const hello: StoredMessage[] = [{ role: 'user', content: 'hi' }]
  await runTurn(await options(model.baseURL, hello, []))
  assert.deepEqual([(hello[1] as ChatMessage).content, (hello[1] as Extract<ChatMessage, { role: 'assistant' }>).reasoning_content?.trim()], ['Hello.', 'Thinking it over.'])

  // The thinking is not the summary: nothing is put in the place of the conversation, and the person is told.
  const first: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const events: AgentEvent[] = []
  await runTurn(await options(model.baseURL, first, events))
  assert.equal(model.requests[1].tools, undefined, 'the summary was asked for')
  assert.deepEqual(marksIn(first), [])
  assert.deepEqual(noticeOf(events), ['compaction-failed', 'The model returned no summary.'])
  assert.equal(model.requests[2].messages.length, 14)
  // The model is still read as one that thinks first: its next reply is thinking from the first word, with nothing to take back.
  const reply = first.at(-1) as Extract<ChatMessage, { role: 'assistant' }>
  assert.deepEqual([reply.content, reply.reasoning_content?.trim()], ['ok', 'More thinking.'])
  assert.equal(events.some((e) => e.type === 'assistant_rewrite'), false)

  // Cut short while thinking: said as that.
  const second: StoredMessage[] = [...talk(), { role: 'user', content: 'and now?' }]
  const told: AgentEvent[] = []
  await runTurn(await options(model.baseURL, second, told))
  assert.deepEqual(marksIn(second), [])
  assert.deepEqual(noticeOf(told), ['compaction-failed', 'The model ran out of output space before it finished.'])
  assert.equal((second.at(-1) as ChatMessage).content, 'fine')

  // Asked for by hand, twice with nothing in between: refused both times, and then the summary it does write is taken.
  const third = talk()
  assert.deepEqual(await compactConversation(await options(model.baseURL, third, [])), { done: false, problem: 'The model returned no summary.' })
  assert.deepEqual(await compactConversation(await options(model.baseURL, third, [])), { done: false, problem: 'The model returned no summary.' })
  assert.deepEqual(third, talk())
  assert.deepEqual(await compactConversation(await options(model.baseURL, third, [])), { done: true })
  assert.equal(marksIn(third)[0]?.summary?.text, 'The gist.')
  assert.equal(model.requests.length, 8)
})

test('thinking that is not sent back with a reply is not expected in the next request', async (t) => {
  // A server that leaves the thinking in the answer, between tags, and counts as servers do: the
  // thinking is part of what the reply cost, and no part of what the next request holds.
  const model = await fakeModel([[chunk({ content: `<think>${words(800)}</think>The answer.` }), cost(700, 850)], [chunk({ content: '42' }), cost(760, 2)]])
  t.after(() => model.close())
  const messages: StoredMessage[] = [{ role: 'user', content: 'think hard about this' }]
  const events: AgentEvent[] = []
  let stats = emptyStats()
  const counting: TurnOptions['stats'] = { step: (measure) => (stats = addStep(stats, measure)), tool: () => {}, compacted: (done) => (stats = addCompaction(stats, done)) }
  // By what the reply cost, the context would be full: 700 and 850 of 1800, with the line at 1440.
  const room = { window: 1800, settings: COMPACTION_DEFAULTS }
  await runTurn(await options(model.baseURL, messages, events, { room, stats: counting }))

  const reply = messages[1] as Extract<ChatMessage, { role: 'assistant' }>
  assert.deepEqual([reply.content, reply.reasoning_content?.length, reply.origin?.replay], ['The answer.', 3200, { thinking: 'inline' }])
  // Of the 850 tokens the answer is three guessed tokens in 803: that much comes back with it.
  assert.equal(reply.origin?.tokens, 3)
  assert.equal(stats.usage.output, 850, 'what the reply cost is counted whole')
  assert.deepEqual([stats.context?.tokens, stats.context?.fit?.last?.tokens], [703, 703], 'what the context holds after it is the request and the answer')

  // So the next message is sent as it is. Booked whole, 1550 tokens would have been over the line and a summary asked for.
  messages.push({ role: 'user', content: 'and the key number?' })
  await runTurn(await options(model.baseURL, messages, events, { room: { ...room, fit: stats.context?.fit }, stats: counting }))
  assert.equal(model.requests.length, 2)
  assert.ok(Array.isArray(model.requests[1].tools), 'the conversation itself, not a request for a summary')
  assert.deepEqual(model.requests[1].messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(model.requests[1].messages[2].content, 'The answer.', 'without the thinking')
  assert.deepEqual(marksIn(messages), [])
  assert.equal(stats.compactions, undefined)
})
