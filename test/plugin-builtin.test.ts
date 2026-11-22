// Run with: node --test test/plugin-builtin.test.ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createKernel } from '../src/main/kernel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { ToolRegistry } from '../src/main/tools.ts'

const signal = new AbortController().signal

/** A plugins folder of the person's own, a folder of plugins that come with the app, and a manager over both, wired as the app wires it. */
async function setup(state?: object) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-builtin-'))
  const dir = path.join(base, 'plugins')
  const builtinDir = path.join(base, 'app', 'plugins')
  const stateFile = path.join(base, 'plugins.json')
  if (state) await writeFile(stateFile, JSON.stringify(state))
  const plugin = async (root: string, id: string, files: Record<string, string>): Promise<void> => {
    for (const [name, content] of Object.entries({ 'package.json': JSON.stringify({ name: id, version: '1.0.0', type: 'module' }), ...files })) {
      await mkdir(path.dirname(path.join(root, id, name)), { recursive: true })
      await writeFile(path.join(root, id, name), content)
    }
  }
  const tools = new ToolRegistry()
  let manager: PluginManager | undefined
  const kernel = await createKernel({
    tools,
    configs: { get: (id) => manager?.configOf(id) ?? {}, set: (id, value) => manager!.setConfig(id, value) }
  })
  const start = async (): Promise<PluginManager> => {
    manager = new PluginManager({ root: kernel.root, tools, dir, builtinDir, stateFile })
    await manager.init()
    return manager
  }
  const saved = async (): Promise<unknown> => JSON.parse(await readFile(stateFile, 'utf8'))
  return { dir, builtinDir, tools, kernel, plugin, start, saved }
}

/** A plugin whose one tool says where it was loaded from. */
const says = (what: string): Record<string, string> => ({
  'index.js': `export const inject = ['tools']\nexport function apply(ctx) { ctx.tools.register({ name: 'whoami', description: 'd', needsPermission: false, run: () => ${JSON.stringify(what)} }) }\n`,
  'ui/index.js': 'export default () => ({})\n'
})

test('a plugin that comes with the app is found like any other, says so, and starts switched off', async () => {
  const { dir, builtinDir, tools, kernel, plugin, start } = await setup()
  await plugin(builtinDir, 'debug', says('the one that came with the app'))
  await plugin(dir, 'mine', says('my own'))
  const manager = await start()
  const about = async (id: string) => (await manager.list()).find((p) => p.id === id)

  assert.equal(manager.dir, dir, 'the folder the settings page opens is the person\'s own')
  assert.deepEqual([(await about('debug'))!.builtin, (await about('debug'))!.enabled, (await about('debug'))!.status], [true, false, 'disabled'])
  assert.equal((await about('mine'))!.builtin, false)
  assert.deepEqual(tools.list(), [], 'nothing of it runs until it is switched on')

  await manager.setEnabled('debug', true)
  assert.equal((await about('debug'))!.status, 'active')
  assert.equal(await tools.execute('whoami', '{}', { workspace: '.', signal }), 'the one that came with the app')
  // Its interface is handed to the page from where it is, and from nowhere else.
  assert.equal(manager.uiFile('debug', 'index.js'), path.join(builtinDir, 'debug', 'ui', 'index.js'))
  assert.equal(manager.uiFile('debug', '../index.js'), null)
  await kernel.dispose()
})

test("a plugin of the person's own stands in front of the built-in one of the same name", async () => {
  const { dir, builtinDir, tools, kernel, plugin, start } = await setup({ debug: { enabled: true } })
  await plugin(builtinDir, 'debug', says('the one that came with the app'))
  await plugin(builtinDir, 'other', says('another built-in'))
  await plugin(dir, 'debug', says('my changed copy'))
  const manager = await start()
  const list = await manager.list()

  assert.deepEqual(list.map((p) => `${p.id}:${p.builtin ? 'builtin' : 'own'}`).sort(), ['debug:own', 'other:builtin'], 'listed once')
  assert.equal(await tools.execute('whoami', '{}', { workspace: '.', signal }), 'my changed copy')
  assert.equal(manager.uiFile('debug', 'index.js'), path.join(dir, 'debug', 'ui', 'index.js'))
  await kernel.dispose()
})

test('a manager without a folder of built-in plugins works as before', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-builtin-'))
  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools })
  const manager = new PluginManager({ root: kernel.root, tools, dir: path.join(base, 'plugins'), builtinDir: path.join(base, 'not', 'there'), stateFile: path.join(base, 'plugins.json') })
  await manager.init()
  assert.deepEqual(await manager.list(), [], 'a folder that is not there holds no plugins')
  await kernel.dispose()
})

test('a plugin keeps settings of its own, which hold at once and are there at the next start', async () => {
  const { dir, tools, kernel, plugin, start, saved } = await setup({ tuner: { enabled: true, config: { temperature: 0.7, note: '原来的' } }, other: { enabled: true } })
  // What the plugin does with its settings is told through tools, which is how a test reaches into it.
  const body = `export const inject = ['tools', 'config']
export function apply(ctx, config) {
  const mine = ctx.fiber.name
  ctx.tools.register({ name: mine + '_started_with', description: 'd', needsPermission: false, run: () => config })
  ctx.tools.register({ name: mine + '_get', description: 'd', needsPermission: false, run: () => ctx.config.get() })
  ctx.tools.register({ name: mine + '_set', description: 'd', needsPermission: false, run: async (args) => { await ctx.config.set(args.value); return 'saved' } })
  ctx.tools.register({ name: mine + '_set_bad', description: 'd', needsPermission: false, run: async (args) => {
    const loop = {}; loop.self = loop
    const tries = { list: [1, 2], text: 'text', nothing: null, loop, big: { text: 'x'.repeat(70000) } }
    try { await ctx.config.set(tries[args.which]); return 'SAVED' } catch (err) { return 'refused: ' + err.message }
  } })
}
`
  await plugin(dir, 'tuner', { 'index.js': body })
  await plugin(dir, 'other', { 'index.js': body })
  const manager = await start()
  const run = async (name: string, args: object = {}): Promise<unknown> => {
    const out = await tools.execute(name, JSON.stringify(args), { workspace: '.', signal })
    try {
      return JSON.parse(out)
    } catch {
      return out
    }
  }

  // What was saved before is what it starts with, and what it reads.
  assert.deepEqual(await run('tuner_started_with'), { temperature: 0.7, note: '原来的' })
  assert.deepEqual(await run('tuner_get'), { temperature: 0.7, note: '原来的' })
  assert.deepEqual(await run('other_get'), {}, 'a plugin that has saved nothing has an empty one, and not its neighbour\'s')

  // Saved in place of what was there: it reads the new one at once, the file has it, and the switch beside it is untouched.
  assert.equal(await run('tuner_set', { value: { temperature: 1.2, stop: ['</s>'] } }), 'saved')
  assert.deepEqual(await run('tuner_get'), { temperature: 1.2, stop: ['</s>'] })
  assert.deepEqual(await saved(), { tuner: { enabled: true, config: { temperature: 1.2, stop: ['</s>'] } }, other: { enabled: true } })
  assert.equal(await run('other_set', { value: { mine: true } }), 'saved')
  assert.deepEqual(await run('tuner_get'), { temperature: 1.2, stop: ['</s>'] }, 'each plugin has its own')
  assert.deepEqual(manager.configOf('other'), { mine: true })

  // A copy is handed out: changing it changes nothing that is kept.
  const copy = manager.configOf('tuner')
  copy.temperature = 99
  assert.deepEqual(manager.configOf('tuner'), { temperature: 1.2, stop: ['</s>'] })

  // Only an object of plain data, and not more of it than the file should hold.
  for (const which of ['list', 'text', 'nothing']) assert.match(String(await run('tuner_set_bad', { which })), /refused: A plugin config has to be an object of plain data/, which)
  assert.match(String(await run('tuner_set_bad', { which: 'loop' })), /refused: A plugin config has to be an object of plain data/)
  assert.match(String(await run('tuner_set_bad', { which: 'big' })), /refused: A plugin config can be at most 64 KB/)
  assert.deepEqual(manager.configOf('tuner'), { temperature: 1.2, stop: ['</s>'] }, 'what was refused changed nothing')

  // Started again, it is handed what it saved.
  await manager.reload('tuner')
  assert.deepEqual(await run('tuner_started_with'), { temperature: 1.2, stop: ['</s>'] })
  // Switched off and on, the settings are still there.
  await manager.setEnabled('tuner', false)
  await manager.setEnabled('tuner', true)
  assert.deepEqual(await run('tuner_get'), { temperature: 1.2, stop: ['</s>'] })
  assert.deepEqual((await saved() as { tuner: unknown }).tuner, { enabled: true, config: { temperature: 1.2, stop: ['</s>'] } })
  await kernel.dispose()
})
