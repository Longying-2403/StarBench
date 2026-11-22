// Run with: node --test test/plugin-channel.test.ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createKernel } from '../src/main/kernel.ts'
import { PluginChannel } from '../src/main/plugin-channel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { ToolRegistry } from '../src/main/tools.ts'

test('a question reaches the plugin it is asked of, and the answer comes back', async () => {
  const channel = new PluginChannel()
  const remove = channel.handle('debug', 'add', (payload) => {
    const { a, b } = payload as { a: number; b: number }
    return a + b
  })
  channel.handle('debug', 'later', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return 'in its own time'
  })
  channel.handle('debug', 'boom', () => {
    throw new Error('the plugin said no')
  })
  channel.handle('other', 'add', () => 'the other plugin')

  assert.equal(await channel.call('debug', 'add', { a: 2, b: 3 }), 5)
  assert.equal(await channel.call('debug', 'later', undefined), 'in its own time')
  assert.equal(await channel.call('other', 'add', { a: 2, b: 3 }), 'the other plugin', 'each plugin answers under its own name')
  await assert.rejects(channel.call('debug', 'boom', undefined), /the plugin said no/)
  // Nobody to answer: no such handler, no such plugin.
  await assert.rejects(channel.call('debug', 'nothing', undefined), /The plugin "debug" has no handler named "nothing"/)
  await assert.rejects(channel.call('nobody', 'add', undefined), /The plugin "nobody" has no handler named "add"/)

  // A name is answered once; taken away, it can be given again.
  assert.throws(() => channel.handle('debug', 'add', () => 0), /already registered/)
  remove()
  await assert.rejects(channel.call('debug', 'add', { a: 1, b: 1 }), /no handler named "add"/)
  remove() // a second time changes nothing
  channel.handle('debug', 'add', () => 'again')
  assert.equal(await channel.call('debug', 'add', undefined), 'again')

  // Names are short and plain; what is to answer is a function.
  for (const bad of ['', ' ', 'has space', 'x'.repeat(65), '../up', 'a/b']) assert.throws(() => channel.handle('debug', bad, () => 0), /Invalid handler name/, JSON.stringify(bad))
  assert.throws(() => channel.handle('debug', 42 as never, () => 0), /Invalid handler name/)
  assert.throws(() => channel.handle('debug', 'fine', 'not a function' as never), /must be a function/)
})

test('what a plugin tells its interface is carried to the page, and dropped when nothing carries it', () => {
  const channel = new PluginChannel()
  channel.send('debug', 'request', { n: 1 }) // nobody carries yet: no error, nothing kept

  const carried: unknown[] = []
  channel.carryWith((plugin, event, payload) => carried.push([plugin, event, payload]))
  channel.send('debug', 'request', { n: 2 })
  channel.send('other', 'tick', undefined)
  assert.deepEqual(carried, [
    ['debug', 'request', { n: 2 }],
    ['other', 'tick', undefined]
  ])
  assert.throws(() => channel.send('debug', 'has space', 1), /Invalid event name/)

  channel.carryWith(null)
  channel.send('debug', 'request', { n: 3 })
  assert.equal(carried.length, 2)
})

test('a plugin reaches its interface through ctx.ui, for as long as it is switched on', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-plugin-channel-'))
  const dir = path.join(base, 'plugins')
  const plugin = async (id: string, code: string): Promise<void> => {
    await mkdir(path.join(dir, id), { recursive: true })
    await writeFile(path.join(dir, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }))
    await writeFile(path.join(dir, id, 'index.js'), code)
  }
  await plugin(
    'talker',
    `export const inject = ['ui']
export function apply(ctx) {
  let asked = 0
  ctx.ui.handle('count', () => ++asked)
  ctx.ui.handle('shout', (text) => { ctx.ui.send('shouted', String(text).toUpperCase()); return 'sent' })
}
`
  )
  await plugin('twice', `export const inject = ['ui']\nexport function apply(ctx) { ctx.ui.handle('same', () => 1); ctx.ui.handle('same', () => 2) }\n`)

  const channel = new PluginChannel()
  const carried: unknown[] = []
  channel.carryWith((from, event, payload) => carried.push([from, event, payload]))
  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools, channel })
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile: path.join(base, 'plugins.json') })
  await manager.init()

  await assert.rejects(channel.call('talker', 'count', undefined), /Is it switched on\?/, 'off: nobody answers')
  await manager.setEnabled('talker', true)
  assert.equal(await channel.call('talker', 'count', undefined), 1)
  assert.equal(await channel.call('talker', 'count', undefined), 2)
  assert.equal(await channel.call('talker', 'shout', 'hello'), 'sent')
  assert.deepEqual(carried, [['talker', 'shouted', 'HELLO']], 'told under the name of the plugin that told it')

  // Switched off, its handlers go with it; switched on, it starts anew.
  await manager.setEnabled('talker', false)
  await assert.rejects(channel.call('talker', 'count', undefined), /no handler named "count"/)
  await manager.setEnabled('talker', true)
  assert.equal(await channel.call('talker', 'count', undefined), 1)

  // A plugin that registers one name twice fails to start, and leaves nothing half done behind.
  await manager.setEnabled('twice', true)
  const twice = (await manager.list()).find((p) => p.id === 'twice')!
  assert.equal(twice.status, 'error')
  assert.match(twice.error ?? '', /already registered/)
  await assert.rejects(channel.call('twice', 'same', undefined), /no handler named "same"/, 'the first registration did not outlive the failure')
  await kernel.dispose()
})
