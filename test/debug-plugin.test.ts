// Run with: node --test test/debug-plugin.test.ts
// The debug panel comes with the app (plugins/debug): its settings, what it shows of a request,
// and its two halves working through the same kernel and the same interfaces as any plugin.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createKernel } from '../src/main/kernel.ts'
import { PluginChannel } from '../src/main/plugin-channel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { RESERVED as APP_RESERVED, SamplingRegistry } from '../src/main/sampling.ts'
import type { SamplingTarget } from '../src/main/sampling.ts'
import { ToolRegistry } from '../src/main/tools.ts'
import { TraceRegistry } from '../src/main/trace.ts'
import type { ExchangeDraft } from '../src/main/trace.ts'
import { panelOf, pluginUiType, setupOf, slotsOf } from '../src/shared/plugin-ui.ts'
import type { PluginPlaceProps } from '../src/shared/plugin-ui.ts'
import type { Exchange } from '../types/starbench-plugin'

const BUILTIN = path.resolve('plugins')
const at = (file: string): string => pathToFileURL(path.join(BUILTIN, 'debug', file)).href

// The plugin is plain JavaScript, as every plugin is: what its modules give is said here.
type Item<T> = { on: boolean; value: T }
interface Config {
  enabled: boolean
  localOnly: boolean
  plain: boolean
  temperature: Item<number>
  top_p: Item<number>
  max_tokens: Item<number>
  seed: Item<string>
  stop: Item<string>
  extra: Item<string>
  record: boolean
}
type Reach = { kind: string; local: boolean }
const params = (await import(at('ui/params.js'))) as {
  DEFAULTS: Config
  RESERVED: string[]
  normalize(saved: unknown): Config
  readExtra(text: string): { fields: Record<string, unknown>; ignored: string[] } | { problem: string }
  readSeed(text: string): number | undefined
  readStop(text: string): string[]
  appliesTo(config: Config, target: Reach): { applies: boolean; why?: string }
  fieldsFor(config: Config, target: Reach): Record<string, unknown> | undefined
  plainFor(config: Config, target: { local: boolean }): { plain: boolean; why?: string }
}
const format = (await import(at('ui/format.js'))) as {
  seconds(ms: number): string
  tokensOf(usage: unknown): { input?: number; output?: number }
  speedOf(exchange: Exchange): { perSecond: number; estimated: boolean } | undefined
  settingsOf(body: unknown): Record<string, unknown>
  messageCount(body: unknown): number | undefined
  messagesText(body: unknown): string
  pretty(value: unknown): string
  headline(exchange: Exchange): string[]
  replyText(reply: Exchange['reply']): string
}

const local: Reach = { kind: 'openai-chat', local: true }
const remote: Reach = { kind: 'openai-chat', local: false }
const on = <T>(value: T): Item<T> => ({ on: true, value })

/** An exchange as the app hands it to those who watch, with what a test wants different. */
const exchange = (over: Partial<Exchange> = {}): Exchange => ({
  id: 1,
  conversation: 'c1',
  at: new Date(2026, 10, 22, 14, 2, 11).getTime(),
  provider: { id: 'p1', name: '我的 Ollama', kind: 'openai-chat', local: true },
  model: 'qwen3.5:9b',
  request: { wire: true, body: { model: 'qwen3.5:9b', stream: true, temperature: 0.2, messages: [{ role: 'user', content: '你好' }], tools: [] } },
  attempts: 1,
  reply: { text: '你好！', reasoning: '', toolCalls: [] },
  finish: 'stop',
  usage: { prompt_tokens: 812, completion_tokens: 96, total_tokens: 908 },
  timing: { first: 600, total: 4600 },
  pieces: 90,
  ...over
})

test('fresh from the box the panel changes nothing, and a saved config is brought into shape', () => {
  const fresh = params.normalize(undefined)
  assert.deepEqual(fresh, params.DEFAULTS)
  assert.equal(params.fieldsFor(fresh, local), undefined, 'every item is off until it is switched on')

  for (const junk of [null, 'text', 42, [], { temperature: 'hot', top_p: { on: 'yes', value: null }, seed: { on: true, value: 7 } }]) {
    const tidy = params.normalize(junk)
    assert.deepEqual([tidy.enabled, tidy.localOnly, tidy.record, tidy.temperature, tidy.top_p], [true, true, true, { on: false, value: 0.7 }, { on: false, value: 0.9 }], JSON.stringify(junk))
  }
  assert.deepEqual(params.normalize({ seed: { on: true, value: 7 } }).seed, { on: true, value: '42' }, 'a value of the wrong kind gives way to the default, the switch stays')
  // Numbers are held to what the sliders offer, and text to what the config may hold.
  const held = params.normalize({ temperature: on(9), top_p: on(-1), max_tokens: on(1), extra: on('x'.repeat(9000)), enabled: false, localOnly: false, record: false })
  assert.deepEqual([held.temperature.value, held.top_p.value, held.max_tokens.value, held.extra.value.length], [2, 0, 16, 8000])
  assert.deepEqual([held.enabled, held.localOnly, held.record], [false, false, false])
  // The plain chat takes the tools away, so it is on only where it was switched on: nothing else reads as a yes.
  assert.equal(fresh.plain, false)
  assert.deepEqual(
    [undefined, null, 'true', 1, {}, false, true].map((plain) => params.normalize({ plain }).plain),
    [false, false, false, false, false, false, true]
  )
  // Whatever is typed, the whole config fits what the app keeps for a plugin (64 KB).
  const most = params.normalize({ extra: on('\u0001'.repeat(9000)), stop: on('字'.repeat(5000)), seed: on('9'.repeat(99)) })
  assert.ok(Buffer.byteLength(JSON.stringify(most)) < 64 * 1024)
})

test('what is switched on becomes fields of the request, for the models it is meant for', () => {
  const config = params.normalize({ temperature: on(0.2), max_tokens: on(512) })
  assert.deepEqual(params.fieldsFor(config, local), { temperature: 0.2, max_tokens: 512 })

  // Only a model server of the person's own, unless they say otherwise.
  assert.deepEqual(params.appliesTo(config, remote), { applies: false, why: 'remote' })
  assert.equal(params.fieldsFor(config, remote), undefined)
  assert.deepEqual(params.fieldsFor({ ...config, localOnly: false }, remote), { temperature: 0.2, max_tokens: 512 })
  // Only where the app can put them into a request at all.
  for (const kind of ['openai-responses', 'anthropic']) assert.deepEqual(params.appliesTo(config, { kind, local: true }), { applies: false, why: 'kind' })
  // The one switch over all of them.
  assert.deepEqual(params.appliesTo({ ...config, enabled: false }, local), { applies: false, why: 'off' })
  assert.equal(params.fieldsFor({ ...config, enabled: false }, local), undefined)
  assert.deepEqual(params.appliesTo(config, local), { applies: true })
})

test('the plain chat is a switch of its own: for the person\'s own model servers unless they say otherwise, and in every format', () => {
  const off = params.normalize(undefined)
  const plain = params.normalize({ plain: true })
  assert.deepEqual(params.plainFor(off, local), { plain: false, why: 'off' })
  assert.deepEqual(params.plainFor(plain, local), { plain: true })
  assert.deepEqual(params.plainFor(plain, remote), { plain: false, why: 'remote' })
  assert.deepEqual(params.plainFor({ ...plain, localOnly: false }, remote), { plain: true })
  // It is not one of the sampling fields: their switch does not turn it off, and it adds none.
  assert.deepEqual(params.plainFor({ ...plain, enabled: false }, local), { plain: true })
  assert.equal(params.fieldsFor(plain, local), undefined)
  // Whether a server is one's own has to be said outright.
  assert.deepEqual(params.plainFor(plain, {} as never), { plain: false, why: 'remote' })
})

test('seed, stop words and the free fields are read from what was typed', () => {
  assert.deepEqual([params.readSeed(' 42 '), params.readSeed('-7'), params.readSeed('4.2'), params.readSeed(''), params.readSeed('abc'), params.readSeed('9'.repeat(20))], [42, -7, undefined, undefined, undefined, undefined])
  assert.deepEqual(params.readStop(' </s> \r\n\n用户：\n3\n4\n5'), ['</s>', '用户：', '3', '4'], 'one to a line, four at the most')

  assert.deepEqual(params.readExtra('  '), { fields: {}, ignored: [] })
  assert.deepEqual(params.readExtra('{"top_k": 40, "repetition_penalty": 1.1}'), { fields: { top_k: 40, repetition_penalty: 1.1 }, ignored: [] })
  assert.match((params.readExtra('{top_k: 40}') as { problem: string }).problem, /^不是合法的 JSON：/)
  for (const notAnObject of ['[1]', '"text"', '3', 'null']) assert.match((params.readExtra(notAnObject) as { problem: string }).problem, /JSON 对象/, notAnObject)
  // What the app decides by itself cannot be set from here, and the person is told which those are.
  assert.deepEqual(params.readExtra('{"model": "other", "stream": false, "top_k": 5}'), { fields: { top_k: 5 }, ignored: ['model', 'stream'] })
  assert.deepEqual([...params.RESERVED].sort(), [...APP_RESERVED].sort(), 'the panel names the same fields as the app keeps to itself (src/main/sampling.ts)')

  const config = params.normalize({ temperature: on(0.2), seed: on('7'), stop: on('</s>\n###'), extra: on('{"temperature": 1.5, "top_k": 40, "n": 3}') })
  assert.deepEqual(params.fieldsFor(config, local), { temperature: 0.2, top_k: 40, seed: 7, stop: ['</s>', '###'] }, 'an item of the panel wins over the same field typed below')
  // What cannot be read is left out, and the rest still goes.
  const broken = params.normalize({ top_p: on(0.5), seed: on('abc'), stop: on(' \n '), extra: on('{oops') })
  assert.deepEqual(params.fieldsFor(broken, local), { top_p: 0.5 })
  assert.equal(params.fieldsFor(params.normalize({ seed: on('abc'), extra: on('{oops') }), local), undefined)
})

test('a record is put into words: what it cost, how fast it came, which settings went out', () => {
  assert.deepEqual(format.tokensOf({ prompt_tokens: 812, completion_tokens: 96 }), { input: 812, output: 96 })
  assert.deepEqual(format.tokensOf({ input_tokens: 5, output_tokens: 7 }), { input: 5, output: 7 }, 'the names the other interfaces use')
  assert.deepEqual([format.tokensOf(undefined), format.tokensOf('12'), format.tokensOf({ prompt_tokens: '12' })], [{}, {}, {}])
  assert.deepEqual([format.seconds(600), format.seconds(4123), format.seconds(61_234)], ['0.60 秒', '4.12 秒', '61.2 秒'])

  // 96 tokens in the four seconds after the first piece came.
  assert.deepEqual(format.speedOf(exchange()), { perSecond: 24, estimated: false })
  // Nothing reported: counted by the pieces the reply came in, and said to be a guess.
  assert.deepEqual(format.speedOf(exchange({ usage: undefined })), { perSecond: 22.5, estimated: true })
  // A reply that came whole is timed from when it was asked for.
  // A reply that came whole has no moment at which its first piece came: the whole time counts.
  assert.deepEqual(format.speedOf(exchange({ pieces: 1, timing: { total: 4600 }, usage: { completion_tokens: 46 } })), { perSecond: 10, estimated: false })
  // One that came whole with thinking and an answer was handed on in two pieces, which says nothing of how fast it was written.
  assert.equal(format.speedOf(exchange({ pieces: 2, timing: { total: 4000 }, usage: undefined })), undefined)
  // A streamed reply that is one tool call has no pieces of text to count, and is timed from its first piece like any other.
  assert.deepEqual(format.speedOf(exchange({ pieces: 0, timing: { first: 500, total: 2500 }, usage: { completion_tokens: 40 } })), { perSecond: 20, estimated: false })
  assert.equal(format.speedOf(exchange({ pieces: 0, timing: { first: 500, total: 2500 }, usage: undefined })), undefined)
  assert.equal(format.speedOf(exchange({ pieces: 1, timing: { total: 4600 }, usage: undefined })), undefined, 'nothing to go by')
  assert.equal(format.speedOf(exchange({ pieces: 0, timing: { total: 0 }, usage: { completion_tokens: 0 } })), undefined)

  assert.deepEqual(format.settingsOf(exchange().request.body), { model: 'qwen3.5:9b', stream: true, temperature: 0.2 })
  assert.deepEqual(format.settingsOf({ system: 's', input: [], instructions: 'i', max_output_tokens: 9 }), { max_output_tokens: 9 })
  assert.deepEqual([format.settingsOf(undefined), format.settingsOf('text')], [{}, {}])
  assert.deepEqual([format.messageCount(exchange().request.body), format.messageCount({ input: [1, 2] }), format.messageCount({}), format.messageCount(undefined)], [1, 2, undefined, undefined])
  assert.equal(format.pretty({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}')
  assert.equal(format.pretty(undefined), '')
  // The conversation as the model read it, with line breaks as line breaks.
  assert.equal(
    format.messagesText({
      messages: [
        { role: 'system', content: '第一行\n第二行' },
        { role: 'user', content: [{ type: 'text', text: '看图' }] },
        { role: 'assistant', content: null, reasoning_content: '先列目录', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' }
      ]
    }),
    ['【system】', '第一行', '第二行', '', '【user】', '[', '  {', '    "type": "text",', '    "text": "看图"', '  }', ']', '', '【assistant】', '（思考）先列目录', '（调用工具 call_1）list_dir {}', '', '【tool，回应 call_1】', 'a.txt'].join('\n')
  )
  assert.deepEqual([format.messagesText({ input: [] }), format.messagesText(undefined), format.messagesText({ messages: 'none' })], ['', '', ''])
  // The Responses format keeps them under another name, and a reply there is several items: its
  // reasoning (readable as a summary, the rest encrypted), its answer, and each of its tool calls.
  assert.equal(
    format.messagesText({
      instructions: 'i',
      input: [
        { role: 'user', content: '读一下' },
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '要先读文件' }], encrypted_content: 'ENCRYPTED' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '第一行\n第二行' },
        { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '写的是', annotations: [] }, { type: 'output_text', text: '两行字。' }] },
        { type: 'reasoning', id: 'rs_2', summary: [], content: [{ type: 'reasoning_text', text: '明文的思考' }] },
        { type: 'reasoning', id: 'rs_3', summary: [] },
        { type: 'compaction', encrypted_content: 'X' },
        'bare'
      ]
    }),
    [
      // What stands outside the list comes first, as the system message does in a chat request.
      '【instructions】',
      'i',
      '',
      '【user】',
      '读一下',
      '',
      '【reasoning】',
      '（思考摘要）要先读文件',
      '（加密的思考原文，9 个字符）',
      '',
      '【assistant】',
      '（调用工具 call_1）read_file {"path":"a.txt"}',
      '',
      '【tool，回应 call_1】',
      '第一行',
      '第二行',
      '',
      '【assistant】',
      '写的是两行字。',
      '',
      // Thinking a server hands over in clear is shown as that.
      '【reasoning】',
      '（思考）明文的思考',
      '',
      // An item with nothing to read in it is shown as it is, not as an empty heading.
      '【reasoning】',
      '{',
      '  "type": "reasoning",',
      '  "id": "rs_3",',
      '  "summary": []',
      '}',
      '',
      '【compaction】',
      '{',
      '  "type": "compaction",',
      '  "encrypted_content": "X"',
      '}',
      '',
      '"bare"'
    ].join('\n')
  )
  // The instructions count as one of what the model read, so that a conversation counts alike in either format.
  assert.deepEqual([format.messageCount({ instructions: 'i', input: [1, 2] }), format.messageCount({ system: 's', messages: [1] }), format.messageCount({ instructions: '', input: [1] }), format.messageCount({ instructions: 'i' })], [3, 2, 1, undefined])
  // The app's own account of a request (the Anthropic format, or one that failed before it was
  // sent) names a tool call's name and arguments on the call itself.
  assert.equal(
    format.messagesText({
      system: '系统提示',
      messages: [
        { role: 'user', content: '读一下' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] }
      ],
      tools: ['read_file']
    }),
    ['【system】', '系统提示', '', '【user】', '读一下', '', '【assistant】', '（调用工具 toolu_1）read_file {"path":"a.txt"}'].join('\n')
  )

  assert.deepEqual(format.headline(exchange()), ['14:02:11', 'qwen3.5:9b', 'stop', '812 → 96 tokens', '24.0 tok/s'])
  assert.deepEqual(format.headline(exchange({ usage: undefined, finish: undefined })), ['14:02:11', 'qwen3.5:9b', '约 22.5 tok/s'])
  assert.deepEqual(format.headline(exchange({ error: 'HTTP 400', usage: undefined, pieces: 0, timing: { total: 40 } })), ['14:02:11', 'qwen3.5:9b', '失败'])

  assert.equal(format.replyText({ text: '你好！', reasoning: '', toolCalls: [] }), '你好！')
  assert.equal(
    format.replyText({ text: '好的', reasoning: '先想一想', toolCalls: [{ name: 'read_file', arguments: '{"path":"a.txt"}' }] }),
    '【思考】\n先想一想\n\n【回答】\n好的\n\n【工具调用】read_file\n{"path":"a.txt"}'
  )
  assert.equal(format.replyText({ text: '', reasoning: '', toolCalls: [] }), '')
})

/** The app's side of the plugin, wired as the app wires it, with the folder of built-in plugins being the real one. */
async function app() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-debug-'))
  const stateFile = path.join(base, 'plugins.json')
  const channel = new PluginChannel()
  const told: [string, string, unknown][] = []
  channel.carryWith((plugin, event, payload) => told.push([plugin, event, payload]))
  const tools = new ToolRegistry()
  const sampling = new SamplingRegistry()
  const trace = new TraceRegistry()
  let manager: PluginManager | undefined
  const kernel = await createKernel({
    tools,
    sampling,
    channel,
    trace,
    configs: { get: (id) => manager?.configOf(id) ?? {}, set: (id, value) => manager!.setConfig(id, value) }
  })
  const start = async (): Promise<PluginManager> => {
    manager = new PluginManager({ root: kernel.root, tools, dir: path.join(base, 'plugins'), builtinDir: BUILTIN, stateFile })
    await manager.init()
    return manager
  }
  const saved = async (): Promise<{ debug?: { enabled?: boolean; config?: Config } }> => JSON.parse(await readFile(stateFile, 'utf8'))
  const call = (name: string, payload?: unknown): Promise<unknown> => channel.call('debug', name, payload)
  const state = async (): Promise<{ config: Config; exchanges: Exchange[] }> => (await call('state')) as { config: Config; exchanges: Exchange[] }
  return { kernel, sampling, trace, told, start, saved, call, state }
}

const ollama: SamplingTarget = { provider: 'p1', kind: 'openai-chat', baseURL: 'http://localhost:11434/v1', local: true, model: 'qwen3.5:9b' }
const cloud: SamplingTarget = { provider: 'p2', kind: 'openai-chat', baseURL: 'https://api.example.com/v1', local: false, model: 'big' }
const draft = (over: Partial<ExchangeDraft> = {}): ExchangeDraft => {
  const { id: _id, conversation: _conversation, ...rest } = exchange(over)
  return rest
}

test('the debug panel comes with the app, off until it is switched on, and then tunes requests', async () => {
  const { kernel, sampling, trace, start, call, state } = await app()
  const manager = await start()
  const about = async () => (await manager.list()).find((p) => p.id === 'debug')!

  assert.deepEqual([(await about()).name, (await about()).builtin, (await about()).enabled, (await about()).status], ['调试面板', true, false, 'disabled'])
  assert.equal(trace.active, false, 'switched off, it watches nothing')

  await manager.setEnabled('debug', true)
  const info = await about()
  assert.deepEqual([info.status, info.ui, info.uiStyle, info.error], ['active', true, true, undefined])
  // Everything its interface imports is in the folder the page is allowed to read, under a type the page is served.
  for (const file of ['index.js', 'index.css', 'params.js', 'format.js']) {
    assert.ok(manager.uiFile('debug', file), file)
    assert.ok(pluginUiType(file), file)
  }

  assert.deepEqual((await state()).config, params.DEFAULTS)
  assert.deepEqual(sampling.paramsFor(ollama), {}, 'switched on, it still changes nothing until an item is')

  // What the panel sets counts for the very next request.
  const next = params.normalize({ temperature: on(0.2), stop: on('</s>'), extra: on('{"top_k": 40, "stream": false}') })
  assert.deepEqual(await call('configure', next), next)
  assert.deepEqual(sampling.paramsFor(ollama), { top_k: 40, temperature: 0.2, stop: ['</s>'] })
  assert.deepEqual(sampling.paramsFor(cloud), {}, 'not for a service that is not the person\'s own')
  assert.deepEqual(sampling.paramsFor({ ...ollama, kind: 'anthropic' }), {})
  await call('configure', { ...next, localOnly: false })
  assert.deepEqual(sampling.paramsFor(cloud), { top_k: 40, temperature: 0.2, stop: ['</s>'] })
  // What the page sends is not trusted to be in shape.
  await call('configure', { temperature: { on: true, value: 99 }, nonsense: true })
  assert.deepEqual(sampling.paramsFor(ollama), { temperature: 2 })
  assert.deepEqual(Object.keys((await state()).config).sort(), Object.keys(params.DEFAULTS).sort())

  assert.deepEqual(await call('reset'), params.DEFAULTS)
  assert.deepEqual(sampling.paramsFor(ollama), {})

  // The plain chat: off as it comes, and from the panel's switch on for the next message.
  const claude: SamplingTarget = { ...cloud, kind: 'anthropic' }
  assert.deepEqual([sampling.plainFor(ollama), sampling.plainFor(cloud)], [false, false])
  await call('configure', params.normalize({ plain: true }))
  assert.deepEqual([sampling.plainFor(ollama), sampling.plainFor(cloud), sampling.plainFor(claude)], [true, false, false], 'for a model server of the person\'s own')
  assert.deepEqual(sampling.paramsFor(ollama), {}, 'and it adds no field to a request')
  await call('configure', params.normalize({ plain: true, localOnly: false, enabled: false }))
  assert.deepEqual([sampling.plainFor(ollama), sampling.plainFor(cloud), sampling.plainFor(claude)], [true, true, true], 'or for every service, in every format, when they say so')
  // What the page sends is not trusted to be in shape here either.
  await call('configure', { plain: 'yes' })
  assert.equal(sampling.plainFor(ollama), false)
  await call('configure', params.normalize({ plain: true }))
  assert.deepEqual(await call('reset'), params.DEFAULTS)
  assert.equal(sampling.plainFor(ollama), false, 'back to how it came')

  await call('configure', params.normalize({ plain: true }))
  await manager.setEnabled('debug', false)
  assert.deepEqual(sampling.paramsFor(ollama), {})
  assert.equal(sampling.plainFor(ollama), false, 'the plugin switched off, a message goes out with its tools again')
  await kernel.dispose()
})

test('the debug panel keeps the latest requests, and stops the recording when told to', async () => {
  const { kernel, trace, told, start, call, state } = await app()
  const manager = await start()
  await manager.setEnabled('debug', true)
  assert.equal(trace.active, true, 'it records from the start')

  trace.emit(draft(), 'c1')
  assert.equal(told.length, 1)
  const [plugin, event, sent] = told[0]
  assert.deepEqual([plugin, event], ['debug', 'exchange'], 'the interface is told at once, and only the plugin\'s own')
  assert.deepEqual(sent, exchange({ id: 1 }))
  assert.deepEqual((await state()).exchanges, [exchange({ id: 1 })])

  // Only the latest are kept: each carries a whole request.
  for (let n = 0; n < 14; n++) trace.emit(draft({ model: `m${n}` }), 'c2')
  const kept = (await state()).exchanges
  assert.equal(kept.length, 12)
  assert.deepEqual([kept[0].id, kept[0].model, kept[11].id, kept[11].model, kept[11].conversation], [4, 'm2', 15, 'm13', 'c2'])

  await call('clear')
  assert.deepEqual((await state()).exchanges, [])

  // With the recording off nobody watches, so the app makes no records and asks the service for nothing more.
  await call('configure', { record: false })
  assert.equal(trace.active, false)
  told.length = 0
  trace.emit(draft(), 'c1')
  assert.deepEqual([told, (await state()).exchanges], [[], []])
  await call('configure', { record: true })
  assert.equal(trace.active, true)
  trace.emit(draft(), 'c1')
  assert.equal((await state()).exchanges.length, 1)

  await manager.setEnabled('debug', false)
  assert.equal(trace.active, false, 'switched off, it lets go')
  await kernel.dispose()
})

test('the debug panel has its settings back at the next start, also those changed a moment before it stopped', async () => {
  const first = await app()
  const manager = await first.start()
  await manager.setEnabled('debug', true)

  const chosen = params.normalize({ temperature: on(1.3), max_tokens: on(256), record: false })
  await first.call('configure', chosen)
  // The file is written once the hand has come to rest, not for every step of a slider.
  assert.equal((await first.saved()).debug?.config, undefined)
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual((await first.saved()).debug, { enabled: true, config: chosen })

  // Changed and stopped at once: kept all the same, when it is switched off…
  const changed = { ...chosen, temperature: on(0.4) }
  await first.call('configure', changed)
  await manager.setEnabled('debug', false)
  assert.deepEqual(manager.configOf('debug'), changed)
  await manager.setEnabled('debug', true)
  assert.deepEqual((await first.saved()).debug, { enabled: true, config: changed })
  assert.deepEqual((await first.state()).config, changed, 'and it starts with what it saved')

  // …and when the app closes.
  const last = { ...changed, seed: on('7') }
  await first.call('configure', last)
  await manager.dispose()
  assert.deepEqual((await first.saved()).debug, { enabled: true, config: last })
  await first.kernel.dispose()
})

test("the debug panel's interface draws the settings, what they do for the model at hand, and the records", async () => {
  const setup = setupOf(await import(at('ui/index.js')))
  assert.ok(setup, 'ui/index.js exports a setup function')

  const config = params.normalize({ temperature: on(0.2), seed: on('abc'), extra: on('{"top_k": 40, "model": "x"}') })
  const asked: [string, unknown][] = []
  const listening: string[] = []
  // Stand-ins for the app's controls, which say what they were given.
  const control = (kind: string) => (props: { label: string; labelHidden?: boolean; checked?: boolean; value?: unknown }) =>
    React.createElement('label', { 'data-control': kind, 'data-unseen': props.labelHidden ? 'yes' : undefined }, `${props.label}=${String(props.checked ?? props.value)}`)
  const given = await setup({
    apiVersion: 1,
    id: 'debug',
    React,
    controls: { Slider: control('slider'), Switch: control('switch'), Field: control('field') },
    backend: {
      call: async (name: string, payload?: unknown) => (asked.push([name, payload]), name === 'state' ? { config, exchanges: [exchange({ id: 1 }), exchange({ id: 2, conversation: 'c2' }), exchange({ id: 3, error: 'HTTP 400', usage: undefined })] } : undefined),
      on: (event: string) => (listening.push(event), () => {})
    }
  })
  const panel = panelOf(given)
  const Readout = slotsOf(given)['composer.actions']
  assert.equal(panel?.title, '调试')
  assert.ok(Readout, 'it has a readout on the bar above the message box')
  assert.deepEqual(listening.sort(), ['exchange', 'problem'])
  assert.deepEqual(asked, [['state', undefined]], 'it asks for what its main-process half knows as soon as it is loaded')

  const draw = (component: unknown, place: PluginPlaceProps): string => renderToStaticMarkup(React.createElement(component as React.FunctionComponent<PluginPlaceProps>, place))
  const place = (provider: Partial<NonNullable<PluginPlaceProps['model']>['provider']> = {}, conversation = 'c1'): PluginPlaceProps => ({
    conversation: { id: conversation, workspace: 'D:\\work', running: false },
    model: { id: 'qwen3.5:9b', effort: 'default', provider: { id: 'p1', name: '我的 Ollama', kind: 'openai-chat', local: true, ...provider } }
  })
  // What the main-process half said has arrived by now.
  await new Promise((resolve) => setImmediate(resolve))

  const drawn = draw(panel!.component, place())
  for (const expected of [
    '发给 qwen3.5:9b 的请求会带上：top_k、temperature',
    '调整采样参数=true',
    '只用于本地模型=true',
    '纯对话（不带工具）=false',
    '关着：消息照常发出，带着工具和 StarBench 的提示词。',
    '温度=true',
    // The slider under a switch does not say the name a second time.
    'data-control="slider" data-unseen="yes">温度=0.2',
    'Top-p=false',
    '最大输出长度=false',
    '随机种子=true',
    '要写成一个整数，否则不会发出去。',
    '停止词=false',
    '其他字段=true',
    'model 由 StarBench 自己决定，写在这里不会生效。',
    '记录每次请求=true',
    '<span>14:02:11</span><span>qwen3.5:9b</span><span>stop</span><span>812 → 96 tokens</span><span>24.0 tok/s</span>',
    'debug-exchange debug-exchange-failed',
    '<span>失败</span>',
    '另有 1 条是别的对话的'
  ]) {
    assert.ok(drawn.includes(expected), `the panel shows ${expected}`)
  }
  assert.equal(drawn.split('data-control="slider"').length - 1, 1, 'only an item that is switched on has its control drawn')
  assert.ok(!drawn.includes('你好'), 'a record is one line until it is opened: the request itself is not drawn')

  // The same settings, for models they do not reach.
  assert.ok(draw(panel!.component, place({ local: false, name: '云端' })).includes('云端 不是本机或局域网里的模型服务'))
  assert.ok(draw(panel!.component, place({ kind: 'anthropic', name: 'Claude' })).includes('Claude 用的不是 OpenAI 兼容'))
  assert.ok(draw(panel!.component, { ...place(), model: null }).includes('还没有选模型'))
  assert.ok(draw(panel!.component, place({}, 'c3')).includes('这个对话还没有记录'))

  // The readout on the bar above the message box: there while fields are being added for this model, and gone otherwise.
  assert.match(draw(Readout, place()), /已调 2 项参数/)
  assert.ok(draw(Readout, place()).includes('temperature = 0.2'))
  assert.equal(draw(Readout, place({ local: false })), '')
  assert.equal(draw(Readout, { ...place(), model: null }), '')
  assert.ok(!draw(Readout, place()).includes('纯对话'), 'nothing of the plain chat while it is off')
  // A tip in the app's own look, not the system's.
  assert.ok(draw(Readout, place()).includes('data-tip=') && !draw(Readout, place()).includes('title='))

  // With the plain chat switched on, the panel says for which model it holds, and the bar says so while it does.
  const plainly = await setup({
    apiVersion: 1,
    id: 'debug',
    React,
    controls: { Slider: control('slider'), Switch: control('switch'), Field: control('field') },
    backend: { call: async (name: string) => (name === 'state' ? { config: params.normalize({ plain: true }), exchanges: [] } : undefined), on: () => () => {} }
  })
  await new Promise((resolve) => setImmediate(resolve))
  const plainPanel = panelOf(plainly)!.component
  const PlainReadout = slotsOf(plainly)['composer.actions']
  const here = draw(plainPanel, place())
  assert.ok(here.includes('纯对话（不带工具）=true'))
  assert.ok(here.includes('发给 qwen3.5:9b 的消息会以纯对话发出：不带任何工具'))
  assert.ok(draw(plainPanel, place({ local: false, name: '云端' })).includes('云端 不是本机或局域网里的模型服务，发给它的消息照常带着工具。'))
  // In a format the sampling fields do not reach, the plain chat still holds.
  assert.ok(draw(plainPanel, place({ kind: 'anthropic', name: '本机网关' })).includes('的消息会以纯对话发出'))
  assert.match(draw(PlainReadout, place()), /<span class="hint debug-readout debug-readout-plain" data-tip="[^"]*不带任何工具[^"]*">纯对话<\/span>$/)
  assert.equal(draw(PlainReadout, place({ local: false })), '', 'not for a service it does not hold for')
  assert.equal(draw(PlainReadout, { ...place(), model: null }), '')
})
