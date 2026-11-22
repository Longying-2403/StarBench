// The sampling fields plugins add to model requests: the registry, the way through the kernel,
// and the request that goes out in the end.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runTurn } from '../src/main/agent.ts'
import { createKernel } from '../src/main/kernel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { SamplingRegistry } from '../src/main/sampling.ts'
import type { SamplingTarget } from '../src/main/sampling.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import type { AgentEvent, ChatMessage } from '../src/shared/types.ts'

const target: SamplingTarget = { provider: 'local', kind: 'openai-chat', baseURL: 'http://localhost:11434/v1', local: true, model: 'qwen' }

const chunk = (delta: object): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`

/** Serves one scripted stream per request and records the request bodies. */
async function fakeModel(scripts: string[][]) {
  const requests: Record<string, any>[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of scripts[requests.length - 1] ?? []) res.write(part)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { requests, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** Runs one turn against the fake model and resolves with what the agent reported. */
async function turn(baseURL: string, sampling: SamplingRegistry | undefined, onEvent: (e: AgentEvent) => void = () => {}) {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
  const events: AgentEvent[] = []
  await runTurn({
    connection: { provider: 'local', kind: 'openai-chat', apiKey: 'test', baseURL, model: 'fake', reasoningEffort: 'default' },
    workspace: await mkdtemp(path.join(os.tmpdir(), 'starbench-sampling-')),
    messages,
    signal: new AbortController().signal,
    tools,
    sampling,
    alwaysAllowed: new Set(),
    emit: (e) => (events.push(e), onEvent(e)),
    checkpoint: () => {},
    requestPermission: async () => 'allow'
  })
  return events
}

test('sources are merged in order and cannot set what belongs to the app', (t) => {
  const complaints = t.mock.method(console, 'error', () => {})
  const registry = new SamplingRegistry()
  const asked: SamplingTarget[] = []
  const removeFirst = registry.register((to) => {
    asked.push(to)
    return { temperature: 0.2, top_p: 0.9, seed: undefined, model: 'other', stream: false, n: 3, tools: [] }
  }, 'first')
  registry.register(() => ({ temperature: 0.7 }), 'second')
  registry.register(() => null, 'silent')
  registry.register(() => {
    throw new Error('boom')
  }, 'broken')
  registry.register((async () => ({ top_k: 1 })) as never, 'late')

  assert.deepEqual(registry.paramsFor(target), { temperature: 0.7, top_p: 0.9 })
  assert.deepEqual(asked, [target])
  assert.deepEqual(
    complaints.mock.calls.map((c) => String(c.arguments[0])),
    ['[sampling] broken failed: boom', '[sampling] late returned a promise; a sampling source has to answer at once']
  )

  removeFirst()
  assert.deepEqual(registry.paramsFor(target), { temperature: 0.7 })
  assert.throws(() => registry.register('not a function' as never, 'bad'), /must be a function/)
})

test('a turn sends the fields with every request, as they are at that moment', async () => {
  const model = await fakeModel([
    [chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] })],
    [chunk({ content: 'done' })]
  ])
  const registry = new SamplingRegistry()
  let temperature = 0.2
  const asked: SamplingTarget[] = []
  registry.register((to) => {
    asked.push(to)
    return { temperature, top_k: 40, model: 'other', stream: false }
  }, 'tuner')

  // The setting changes while the tool runs: the second request of the turn already has the new one.
  const events = await turn(model.baseURL, registry, (e) => {
    if (e.type === 'tool_start') temperature = 0.9
  })
  await model.close()

  assert.deepEqual(events.filter((e) => e.type === 'error'), [])
  assert.equal(model.requests.length, 2)
  assert.deepEqual(
    model.requests.map((r) => [r.temperature, r.top_k]),
    [
      [0.2, 40],
      [0.9, 40]
    ]
  )
  for (const request of model.requests) {
    assert.equal(request.model, 'fake', 'the model stays the one the person chose')
    assert.equal(request.stream, true)
    assert.ok(request.tools.length > 0, 'the tools stay the app\'s own')
  }
  assert.deepEqual(asked[0], { provider: 'local', kind: 'openai-chat', baseURL: model.baseURL, local: true, model: 'fake' })
})

test('without sources a request has no fields beyond the usual ones', async () => {
  const model = await fakeModel([[chunk({ content: 'hi' })], [chunk({ content: 'hi' })]])
  await turn(model.baseURL, new SamplingRegistry())
  await turn(model.baseURL, undefined)
  await model.close()
  for (const request of model.requests) assert.deepEqual(Object.keys(request).sort(), ['messages', 'model', 'stream', 'tools'])
})

test('a plugin sets sampling fields for as long as it is enabled', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-sampling-'))
  const dir = path.join(base, 'plugins')
  await mkdir(path.join(dir, 'tuner'), { recursive: true })
  await writeFile(path.join(dir, 'tuner', 'package.json'), JSON.stringify({ name: 'tuner', version: '1.0.0', type: 'module' }))
  await writeFile(
    path.join(dir, 'tuner', 'index.js'),
    `export const inject = ['sampling']
     export function apply(ctx, config) {
       ctx.sampling.provide((target) => (target.model === config.model ? { temperature: config.temperature } : undefined))
     }`
  )
  const stateFile = path.join(base, 'plugins.json')
  await writeFile(stateFile, JSON.stringify({ tuner: { enabled: true, config: { model: 'qwen', temperature: 0.3 } } }))

  const tools = new ToolRegistry()
  const sampling = new SamplingRegistry()
  const kernel = await createKernel({ tools, sampling })
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile })
  await manager.init()

  assert.equal((await manager.list())[0].status, 'active')
  assert.deepEqual(sampling.paramsFor(target), { temperature: 0.3 })
  assert.deepEqual(sampling.paramsFor({ ...target, model: 'another' }), {})

  await manager.setEnabled('tuner', false)
  assert.deepEqual(sampling.paramsFor(target), {}, 'gone when the plugin is switched off')
  await manager.setEnabled('tuner', true)
  assert.deepEqual(sampling.paramsFor(target), { temperature: 0.3 })
  await kernel.dispose()
  assert.deepEqual(sampling.paramsFor(target), {}, 'gone on shutdown')
})
