// Run with: node --test test/trace.test.ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createKernel } from '../src/main/kernel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { ToolRegistry } from '../src/main/tools.ts'
import { TraceRegistry } from '../src/main/trace.ts'
import type { Exchange, ExchangeDraft } from '../src/main/trace.ts'

const draft = (text: string): ExchangeDraft => ({
  at: 1,
  provider: { id: 'p', name: 'P', kind: 'openai-chat', local: true },
  model: 'm',
  request: { wire: true, body: { messages: [{ role: 'user', content: 'hi' }] } },
  attempts: 1,
  reply: { text, reasoning: '', toolCalls: [] },
  timing: { total: 5 },
  pieces: 1
})

test('everyone who watches is told of each exchange, each with a copy of their own', () => {
  const trace = new TraceRegistry()
  assert.equal(trace.active, false)
  trace.emit(draft('nobody sees this'), 'c1') // no error, nothing kept

  const one: Exchange[] = []
  const two: Exchange[] = []
  const stopOne = trace.observe((exchange) => {
    // What one watcher does to its copy is not seen by the next.
    one.push(exchange)
    exchange.reply.text = 'CHANGED'
    ;(exchange.request.body as { messages: unknown[] }).messages.length = 0
  }, 'one')
  trace.observe(() => {
    throw new Error('this watcher fails')
  }, 'broken')
  trace.observe((exchange) => void two.push(exchange), 'two')
  assert.equal(trace.active, true)

  trace.emit(draft('first'), 'c1')
  trace.emit(draft('second'), 'c2')
  assert.deepEqual(two.map((x) => [x.id, x.conversation, x.reply.text]), [[1, 'c1', 'first'], [2, 'c2', 'second']], 'numbered in order, with the conversation each belongs to')
  assert.deepEqual((two[0].request.body as { messages: unknown[] }).messages.length, 1, 'whole, whatever the watcher before did, and although one in between threw')
  assert.equal(one.length, 2)

  stopOne()
  stopOne() // a second time changes nothing
  trace.emit(draft('third'), 'c1')
  assert.equal(one.length, 2)
  assert.equal(two.length, 3)
  assert.throws(() => trace.observe('not a function' as never, 'x'), /must be a function/)
})

test('a plugin watches through ctx.trace, for as long as it is switched on', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-trace-'))
  const dir = path.join(base, 'plugins')
  await mkdir(path.join(dir, 'watcher'), { recursive: true })
  await writeFile(path.join(dir, 'watcher', 'package.json'), JSON.stringify({ name: 'watcher', version: '1.0.0', type: 'module' }))
  await writeFile(
    path.join(dir, 'watcher', 'index.js'),
    `export const inject = ['trace', 'tools']
export function apply(ctx) {
  const seen = []
  ctx.trace.observe((exchange) => seen.push(exchange.reply.text))
  ctx.tools.register({ name: 'seen', description: 'd', needsPermission: false, run: () => seen })
}
`
  )
  const trace = new TraceRegistry()
  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools, trace })
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile: path.join(base, 'plugins.json') })
  await manager.init()
  const seen = async (): Promise<unknown> => JSON.parse(await tools.execute('seen', '{}', { workspace: '.', signal: new AbortController().signal }))

  assert.equal(trace.active, false, 'nobody watches until a plugin that does is switched on')
  await manager.setEnabled('watcher', true)
  assert.equal(trace.active, true)
  trace.emit(draft('one'), 'c')
  trace.emit(draft('two'), 'c')
  assert.deepEqual(await seen(), ['one', 'two'])

  // Switched off, it watches no more, and the app goes back to writing nothing down.
  await manager.setEnabled('watcher', false)
  assert.equal(trace.active, false)
  trace.emit(draft('three'), 'c')
  await manager.setEnabled('watcher', true)
  assert.deepEqual(await seen(), [], 'started anew, it has seen nothing yet')
  await kernel.dispose()
})
