import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createKernel } from '../src/main/kernel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'

const signal = new AbortController().signal

async function setup(plugins: Record<string, Record<string, string>> = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-plugins-'))
  const dir = path.join(base, 'plugins')
  for (const [id, files] of Object.entries(plugins)) {
    await mkdir(path.join(dir, id), { recursive: true })
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, id, name), content)
  }
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  const kernel = await createKernel({ tools })
  const stateFile = path.join(base, 'plugins.json')
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile })
  await manager.init()
  return { base, dir, tools, kernel, manager, stateFile }
}

const manifest = (extra: object = {}): string => JSON.stringify({ name: 'p', version: '1.0.0', type: 'module', ...extra })
const only = async (manager: PluginManager, id: string) => {
  const info = (await manager.list()).find((p) => p.id === id)
  assert.ok(info, `plugin ${id} is listed`)
  return info
}

test('registry rejects invalid and duplicate tools', () => {
  const tools = new ToolRegistry()
  const spec = { name: 'ok', description: 'd', run: () => 'x' }
  assert.throws(() => tools.register({ ...spec, name: 'has space' }, 't'), /Invalid tool name/)
  assert.throws(() => tools.register({ ...spec, description: '' }, 't'), /description/)
  assert.throws(() => tools.register({ ...spec, run: undefined as never }, 't'), /run function/)
  const remove = tools.register(spec, 'first')
  assert.throws(() => tools.register(spec, 'second'), /already registered by first/)
  remove()
  assert.deepEqual(tools.list(), [])
})

test('registry coerces results and defaults to asking permission', async () => {
  const tools = new ToolRegistry()
  tools.register({ name: 'obj', description: 'd', run: () => ({ a: 1 }) }, 't')
  tools.register({ name: 'nothing', description: 'd', needsPermission: false, run: () => undefined }, 't')
  tools.register({ name: 'boom', description: 'd', run: () => Promise.reject(new Error('nope')) }, 't')
  assert.equal(await tools.execute('obj', '{}', { workspace: '.', signal }), '{\n  "a": 1\n}')
  assert.equal(await tools.execute('nothing', '', { workspace: '.', signal }), '(no output)')
  assert.equal(await tools.execute('boom', '{}', { workspace: '.', signal }), 'Error: nope')
  assert.equal(await tools.execute('missing', '{}', { workspace: '.', signal }), 'Error: unknown tool "missing"')
  assert.equal(tools.needsPermission('obj'), true)
  assert.equal(tools.needsPermission('nothing'), false)
  assert.deepEqual(tools.definitions()[0].function.parameters, { type: 'object', properties: {} })
})

test('the example plugin can be enabled, used, disabled and re-enabled', async () => {
  const { dir, tools, manager, stateFile, kernel } = await setup()
  await cp(path.resolve('examples/plugins/hello-tool'), path.join(dir, 'hello-tool'), { recursive: true })

  let info = await only(manager, 'hello-tool')
  assert.equal(info.status, 'disabled', 'new plugins start disabled')
  assert.equal(tools.list().some((t) => t.name === 'current_time'), false)

  await manager.setEnabled('hello-tool', true)
  info = await only(manager, 'hello-tool')
  assert.equal(info.status, 'active')
  assert.deepEqual(info.tools, ['current_time'])
  assert.equal(tools.needsPermission('current_time'), false)
  const output = await tools.execute('current_time', '{"timeZone":"Asia/Shanghai"}', { workspace: '.', signal })
  assert.match(output, /\d{4}年/)
  assert.match(await tools.execute('current_time', '{"timeZone":"Not/AZone"}', { workspace: '.', signal }), /^Error: /)
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { 'hello-tool': { enabled: true } })

  await manager.setEnabled('hello-tool', false)
  assert.equal((await only(manager, 'hello-tool')).status, 'disabled')
  assert.equal(tools.list().some((t) => t.name === 'current_time'), false, 'tool removed on disable')

  await manager.setEnabled('hello-tool', true)
  assert.deepEqual((await only(manager, 'hello-tool')).tools, ['current_time'])
  await kernel.dispose()
  assert.equal(tools.list().some((t) => t.name === 'current_time'), false, 'tool removed on shutdown')
})

test('enabled plugins start again on the next launch and receive their config', async () => {
  const first = await setup({
    conf: {
      'package.json': manifest(),
      'index.js': `export const inject = ['tools']
        export function apply(ctx, config) {
          ctx.tools.register({ name: 'echo_config', description: 'd', run: () => config.word })
        }`
    }
  })
  await writeFile(first.stateFile, JSON.stringify({ conf: { enabled: true, config: { word: 'hi' } } }))
  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools })
  const manager = new PluginManager({ root: kernel.root, tools, dir: first.dir, stateFile: first.stateFile })
  await manager.init()
  assert.equal((await only(manager, 'conf')).status, 'active')
  assert.equal(await tools.execute('echo_config', '{}', { workspace: '.', signal }), 'hi')
})

test('a broken plugin reports its error without affecting others', async () => {
  const { manager, tools } = await setup({
    throws: { 'package.json': manifest(), 'index.js': `export function apply() { throw new Error('boom') }` },
    syntax: { 'package.json': manifest(), 'index.js': `export function apply( {` },
    noapply: { 'package.json': manifest(), 'index.js': `export const x = 1` },
    escape: { 'package.json': manifest({ main: '../throws/index.js' }), 'index.js': '' },
    clash: {
      'package.json': manifest(),
      'index.js': `export const inject = ['tools']
        export function apply(ctx) { ctx.tools.register({ name: 'read_file', description: 'd', run: () => '' }) }`
    },
    good: {
      'package.json': manifest({ name: 'Good One', description: 'works' }),
      'index.js': `export default { inject: ['tools'], apply(ctx) {
        ctx.effect(() => ctx.tools.register({ name: 'good_tool', description: 'd', run: () => 'ok' }))
      } }`
    }
  })
  for (const id of ['throws', 'syntax', 'noapply', 'escape', 'clash', 'good']) await manager.setEnabled(id, true)

  assert.match((await only(manager, 'throws')).error ?? '', /boom/)
  assert.equal((await only(manager, 'syntax')).status, 'error')
  assert.match((await only(manager, 'noapply')).error ?? '', /apply\(ctx, config\)/)
  assert.match((await only(manager, 'escape')).error ?? '', /outside the plugin folder/)
  assert.match((await only(manager, 'clash')).error ?? '', /already registered by builtin/)
  const good = await only(manager, 'good')
  assert.equal(good.status, 'active')
  assert.equal(good.name, 'Good One')
  assert.equal(await tools.execute('good_tool', '{}', { workspace: '.', signal }), 'ok')
  // The built-in tool the clashing plugin tried to replace is untouched.
  assert.equal(tools.list().find((t) => t.name === 'read_file')?.source, 'builtin')
  await assert.rejects(manager.setEnabled('ghost', true), /Unknown plugin/)
})

test('a plugin waiting for a missing service is reported as waiting', async () => {
  const { manager } = await setup({
    waits: {
      'package.json': manifest(),
      'index.js': `export const inject = ['tools', 'terminal']
        export function apply() {}`
    }
  })
  await manager.setEnabled('waits', true)
  const info = await only(manager, 'waits')
  assert.equal(info.status, 'waiting')
  assert.match(info.error ?? '', /terminal/)
  assert.doesNotMatch(info.error ?? '', /tools/)
  await manager.dispose()
})
