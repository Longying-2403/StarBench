// Run with: node --test test/plugin-ui.test.ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createKernel } from '../src/main/kernel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { ToolRegistry } from '../src/main/tools.ts'
import {
  PANEL_TITLE_LIMIT,
  PLUGIN_STYLE,
  PLUGIN_UI_ENTRY,
  decimalsOf,
  disposeOf,
  onSliderStep,
  panelOf,
  parsePluginUiUrl,
  pluginModel,
  pluginUiType,
  pluginUiUrl,
  setupOf,
  slotsOf
} from '../src/shared/plugin-ui.ts'

test('the address of a file of a plugin interface is read back as it was written', () => {
  assert.equal(pluginUiUrl('debug'), 'starbench-plugin://ui/debug/index.js')
  assert.equal(PLUGIN_UI_ENTRY, 'index.js')
  assert.deepEqual(parsePluginUiUrl(pluginUiUrl('debug')), { id: 'debug', file: 'index.js' })
  // A plugin is named by its folder, and a folder may be called anything.
  for (const [id, file] of [
    ['My Plugin', 'panels/Sliders.js'],
    ['调试', '面板.js'],
    ['a.b_c-d', 'style.css'],
    ['UPPER', 'img/logo 1.png'],
    ['odd#name?', 'x%y.js']
  ]) {
    assert.deepEqual(parsePluginUiUrl(pluginUiUrl(id, file)), { id, file }, `${id} / ${file}`)
  }
  // An import of the file next door is an address of the same kind.
  assert.deepEqual(parsePluginUiUrl(new URL('./parts/chart.js', pluginUiUrl('debug')).href), { id: 'debug', file: 'parts/chart.js' })

  // The number of a load is part of the path and names no folder: the same file under every number,
  // and the file next door keeps the number, which is what gets it read anew along with the entry.
  assert.equal(pluginUiUrl('debug', 'index.js', 7), 'starbench-plugin://ui/debug/%407/index.js')
  assert.deepEqual(parsePluginUiUrl(pluginUiUrl('debug', 'index.js', 7)), { id: 'debug', file: 'index.js' })
  assert.deepEqual(parsePluginUiUrl(pluginUiUrl('调试', 'parts/chart.js', 12)), { id: '调试', file: 'parts/chart.js' })
  const nextDoor = new URL('./parts/chart.js', pluginUiUrl('debug', 'index.js', 7)).href
  assert.equal(nextDoor, 'starbench-plugin://ui/debug/%407/parts/chart.js')
  assert.deepEqual(parsePluginUiUrl(nextDoor), { id: 'debug', file: 'parts/chart.js' })
  assert.deepEqual(parsePluginUiUrl('starbench-plugin://ui/debug/@7/index.js'), { id: 'debug', file: 'index.js' }, 'written plainly as well')
  // A number and nothing after it asks for no file; a folder further in that looks like a number is a folder.
  assert.equal(parsePluginUiUrl('starbench-plugin://ui/debug/@7'), null)
  assert.deepEqual(parsePluginUiUrl('starbench-plugin://ui/debug/@7/@8/x.js'), { id: 'debug', file: '@8/x.js' })
  // Going up from under the number does not get out of the plugin's folder.
  assert.equal(parsePluginUiUrl(new URL('../../../settings.json', pluginUiUrl('debug', 'index.js', 7)).href), null)
  assert.deepEqual(parsePluginUiUrl(new URL('../other/index.js', pluginUiUrl('debug', 'index.js', 7)).href), { id: 'debug', file: 'other/index.js' })
})

test('an address that is not of that kind, or that tries a way round, asks for nothing', () => {
  for (const address of [
    '',
    'not an address',
    'https://ui/debug/index.js',
    'file:///C:/plugins/debug/ui/index.js',
    'starbench-plugin://elsewhere/debug/index.js',
    'starbench-plugin://ui/',
    'starbench-plugin://ui/debug',
    'starbench-plugin://ui/debug/',
    'starbench-plugin://ui//index.js',
    // The slash, the backslash and the two dots, hidden where the address itself would not take them for what they are.
    'starbench-plugin://ui/debug/%2e%2e%2fsecret.js',
    'starbench-plugin://ui/debug/..%2f..%2fsettings.json',
    'starbench-plugin://ui/debug/..%5c..%5csettings.json',
    'starbench-plugin://ui/debug/a%2fb.js',
    'starbench-plugin://ui/debug/%2e%2e/index.js',
    'starbench-plugin://ui/debug%2fui/index.js',
    'starbench-plugin://ui/debug/bad%zz.js',
    'starbench-plugin://ui/debug/nul%00.js'
  ]) {
    assert.equal(parsePluginUiUrl(address), null, address)
  }
  // Two dots written plainly are folded away by the address before anyone reads it: what is left names a file within the scheme, or nothing.
  assert.deepEqual(parsePluginUiUrl('starbench-plugin://ui/debug/a/../index.js'), { id: 'debug', file: 'index.js' })
  assert.equal(parsePluginUiUrl('starbench-plugin://ui/debug/../../../settings.json'), null)
})

test('only the kinds of file an interface is made of are served', () => {
  assert.equal(pluginUiType('index.js'), 'text/javascript')
  assert.equal(pluginUiType('parts/Chart.MJS'), 'text/javascript')
  assert.equal(pluginUiType('style.css'), 'text/css')
  assert.equal(pluginUiType('logo.svg'), 'image/svg+xml')
  // No page of its own, no program, nothing without an ending.
  for (const refused of ['page.html', 'tool.exe', 'notes.txt', 'index', '.env', 'index.js.bak']) assert.equal(pluginUiType(refused), null, refused)
})

test("a plugin's interface is a setup function, and what it gives back is held to the places the app has", () => {
  const setup = (): object => ({})
  assert.equal(setupOf({ default: setup }), setup)
  assert.equal(setupOf({ setup }), setup)
  assert.equal(setupOf({ setup, default: () => 'other' }), setup, 'the name says what is meant; the default is the fallback')
  for (const none of [null, undefined, 'text', 42, {}, { default: {} }, { setup: 'not a function' }, { apply: setup }]) {
    assert.equal(setupOf(none), null, JSON.stringify(none))
  }

  const Button = (): null => null
  assert.deepEqual(slotsOf({ slots: { 'composer.actions': Button } }), { 'composer.actions': Button })
  // A place this app does not have, and a component that is none, are left out and break nothing.
  assert.deepEqual(slotsOf({ slots: { 'composer.actions': Button, 'sidebar.footer': Button, 'panel.right': 'text' } }), { 'composer.actions': Button })
  assert.deepEqual(slotsOf({ slots: { 'composer.actions': { not: 'a function' } } }), {})
  for (const nothing of [undefined, null, 'text', [], {}, { slots: null }, { slots: 'text' }, { slot: { 'composer.actions': Button } }]) {
    assert.deepEqual(slotsOf(nothing), {}, JSON.stringify(nothing))
  }
  // Names that every object has are not places.
  assert.deepEqual(Object.keys(slotsOf({ slots: { constructor: Button, toString: Button, __proto__: Button } })), [])
})

test('what a plugin wants done at the end is taken from what its setup gave back', () => {
  const dispose = (): void => {}
  assert.equal(disposeOf({ dispose }), dispose)
  assert.equal(disposeOf({ slots: {}, dispose }), dispose)
  for (const none of [undefined, null, 'text', {}, { dispose: 'later' }, { dispose: null }, { cleanup: dispose }]) assert.equal(disposeOf(none), null, JSON.stringify(none))
})

test('a plugin started again is told apart from one that kept running', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-plugin-ui-'))
  const dir = path.join(base, 'plugins')
  for (const id of ['one', 'two']) {
    await mkdir(path.join(dir, id, 'ui'), { recursive: true })
    await writeFile(path.join(dir, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }))
    await writeFile(path.join(dir, id, 'index.js'), `export const inject = ['tools']\nlet starts = 0\nexport function apply(ctx) { ctx.tools.register({ name: 'starts_of_${id}', description: 'd', needsPermission: false, run: () => 'started' }) }\n`)
    await writeFile(path.join(dir, id, 'ui', 'index.js'), 'export default () => ({})\n')
  }
  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools })
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile: path.join(base, 'plugins.json') })
  await manager.init()
  const run = async (id: string): Promise<number> => (await manager.list()).find((p) => p.id === id)!.run

  assert.equal(await run('one'), 0, 'not running: no start to speak of')
  await manager.setEnabled('one', true)
  await manager.setEnabled('two', true)
  const [first, other] = [await run('one'), await run('two')]
  assert.ok(first > 0 && other > 0 && first !== other)

  // Started again, it has another number; the one beside it keeps its own.
  await manager.reload('one')
  const second = await run('one')
  assert.ok(second > first)
  assert.equal(await run('two'), other)
  assert.equal((await manager.list()).find((p) => p.id === 'one')!.status, 'active')
  assert.equal(tools.list().filter((t) => t.name === 'starts_of_one').length, 1, 'its tool is there once, not twice')

  // Off and on is a new start too.
  await manager.setEnabled('one', false)
  assert.equal(await run('one'), 0)
  await manager.setEnabled('one', true)
  assert.ok((await run('one')) > second)

  // There is nothing to start again in a plugin that is off, or not there.
  await manager.setEnabled('two', false)
  await assert.rejects(manager.reload('two'), /switched off/)
  await assert.rejects(manager.reload('nobody'), /Unknown plugin/)
  assert.equal(await run('two'), 0)
  await kernel.dispose()
})

test('a panel needs a title for its button and a component to draw, and has nothing without both', () => {
  const Panel = (): null => null
  assert.deepEqual(panelOf({ panel: { title: '调试', component: Panel } }), { title: '调试', component: Panel })
  // The title is the label of a button in a row with others: one line, and not too long.
  assert.equal(panelOf({ panel: { title: '  调试 \n 面板  ', component: Panel } })?.title, '调试 面板')
  assert.equal(panelOf({ panel: { title: 'a'.repeat(40), component: Panel } })?.title.length, PANEL_TITLE_LIMIT)
  assert.equal(panelOf({ panel: { title: '调试参数与请求记录以及更多更多更多的字', component: Panel } })?.title, '调试参数与请求记录以及更多更多更')
  assert.equal(panelOf({ panel: { title: '😀'.repeat(20), component: Panel } })?.title, '😀'.repeat(PANEL_TITLE_LIMIT), 'cut between characters, not inside one')
  for (const none of [
    undefined,
    null,
    {},
    { panel: null },
    { panel: Panel },
    { panel: { title: '调试' } },
    { panel: { component: Panel } },
    { panel: { title: '   ', component: Panel } },
    { panel: { title: 42, component: Panel } },
    { panel: { title: '调试', component: 'Panel' } },
    { slots: { panel: Panel } }
  ]) {
    assert.equal(panelOf(none), null, JSON.stringify(none))
  }
})

test('a plugin is told which model is in use, and nothing that would open the service', () => {
  const provider = { id: 'p1', name: 'My Ollama', kind: 'openai-chat' as const, baseURL: 'http://localhost:11434/v1', model: 'qwen3.5:9b', ready: true, hasApiKey: false }
  const far = { ...provider, id: 'p2', name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', hasApiKey: true }
  const settings = { providers: [provider, far], activeProviderId: 'p1', model: 'qwen3.5:9b', reasoningEffort: 'high' as const }

  assert.deepEqual(pluginModel(settings), { id: 'qwen3.5:9b', effort: 'high', provider: { id: 'p1', name: 'My Ollama', kind: 'openai-chat', local: true } })
  assert.deepEqual(pluginModel({ ...settings, activeProviderId: 'p2', model: 'deepseek-flash', reasoningEffort: 'default' }), {
    id: 'deepseek-flash',
    effort: 'default',
    provider: { id: 'p2', name: 'DeepSeek', kind: 'openai-chat', local: false }
  })
  // Neither the address nor anything about a key is among what is told.
  assert.doesNotMatch(JSON.stringify(pluginModel(settings)), /localhost|11434|baseURL|key|ready/i)
  // No model chosen, a service that is not there, settings not read yet.
  assert.equal(pluginModel({ ...settings, model: '' }), null)
  assert.equal(pluginModel({ ...settings, activeProviderId: 'gone' }), null)
  assert.equal(pluginModel(null), null)
})

test('a slider stands on its steps, between its ends, on numbers as they are written', () => {
  assert.equal(onSliderStep(0.7, 0, 2, 0.01), 0.7)
  assert.equal(onSliderStep(0.1 + 0.2, 0, 2, 0.01), 0.3, 'without the crumbs of the sum')
  assert.equal(onSliderStep(0.704, 0, 2, 0.01), 0.7)
  assert.equal(onSliderStep(0.706, 0, 2, 0.01), 0.71)
  assert.equal(onSliderStep(5, 0, 2, 0.01), 2)
  assert.equal(onSliderStep(-5, 0, 2, 0.01), 0)
  // Steps are counted from the lower end, not from zero.
  assert.equal(onSliderStep(1000, 8, 8192, 8), 1000)
  assert.equal(onSliderStep(1003, 8, 8192, 8), 1000)
  assert.equal(onSliderStep(13, 8, 8192, 8), 16)
  assert.equal(onSliderStep(0.5, 0.01, 1.5, 0.01), 0.5)
  // Where the steps do not land on the upper end, the last step below it is as far as it goes, as with the browser's own slider.
  assert.equal(onSliderStep(10, 0, 10, 3), 9)
  assert.equal(onSliderStep(Number.NaN, 1, 9, 1), 1)
  assert.equal(onSliderStep(Number.POSITIVE_INFINITY, 1, 9, 1), 1)

  assert.equal(decimalsOf(1), 0)
  assert.equal(decimalsOf(0.01), 2)
  assert.equal(decimalsOf(0.5, 0.25), 2)
  assert.equal(decimalsOf(8, 8), 0)
  assert.equal(decimalsOf(1e-7), 7)
  assert.equal(decimalsOf(1e-20), 10, 'no more places than a number is shown with')
})

test('the names of the app\'s look that plugins lean on are there in the style sheet', async () => {
  const css = await readFile(path.resolve('src/renderer/src/styles.css'), 'utf8')
  const dark = /:root \{([^}]*)\}/.exec(css)?.[1] ?? ''
  for (const variable of PLUGIN_STYLE.variables) {
    assert.match(dark, new RegExp(`\\n\\s*${variable}:\\s*\\S`), `${variable} is defined for the whole window`)
  }
  for (const name of PLUGIN_STYLE.classes) {
    assert.match(css, new RegExp(`^\\.${name}(?:,| \\{)`, 'm'), `.${name} has a rule of its own`)
  }
  // The colours are given for the light setting as well; what stays the same in both is not repeated there.
  const light = /@media \(prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? ''
  for (const colour of ['--bg', '--panel', '--raised', '--border', '--text', '--muted', '--accent', '--danger', '--warn', '--ok']) {
    assert.match(light, new RegExp(`\\n\\s*${colour}:\\s*\\S`), `${colour} has a light value`)
  }
})

test('a plugin may be an interface and nothing else, and the list says which plugins have one', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-plugin-ui-'))
  const dir = path.join(base, 'plugins')
  const plugin = async (id: string, files: Record<string, string>): Promise<void> => {
    for (const [name, content] of Object.entries({ 'package.json': JSON.stringify({ name: id, version: '1.0.0', type: 'module' }), ...files })) {
      await mkdir(path.dirname(path.join(dir, id, name)), { recursive: true })
      await writeFile(path.join(dir, id, name), content)
    }
  }
  await plugin('only-ui', { 'ui/index.js': 'export default () => ({})\n', 'ui/index.css': '.mine { color: red }\n' })
  await plugin('code-and-ui', { 'index.js': 'export function apply() {}\n', 'ui/index.js': 'export default () => ({})\n' })
  await plugin('only-code', { 'index.js': 'export function apply() {}\n' })
  await plugin('ui-without-entry', { 'ui/other.js': 'export const x = 1\n' })
  await plugin('nothing', {})

  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools })
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile: path.join(base, 'plugins.json') })
  await manager.init()
  const about = async (id: string) => (await manager.list()).find((p) => p.id === id)!

  // Off: nothing is said to have an interface, since nothing of it would be handed to the page.
  assert.equal((await about('only-ui')).ui, false)

  for (const id of ['only-ui', 'code-and-ui', 'only-code', 'ui-without-entry', 'nothing']) await manager.setEnabled(id, true)
  assert.deepEqual([(await about('only-ui')).status, (await about('only-ui')).ui], ['active', true])
  assert.deepEqual([(await about('code-and-ui')).status, (await about('code-and-ui')).ui], ['active', true])
  // A style sheet beside the entry is told of, so that the page asks for it only where there is one.
  assert.equal((await about('only-ui')).uiStyle, true)
  assert.equal((await about('code-and-ui')).uiStyle, false)
  assert.equal(manager.uiFile('only-ui', 'index.css'), path.join(dir, 'only-ui', 'ui', 'index.css'))
  assert.deepEqual([(await about('only-code')).status, (await about('only-code')).ui], ['active', false])
  // A ui folder without the file an interface starts from is no interface, and with nothing else there is no plugin.
  assert.equal((await about('ui-without-entry')).status, 'error')
  assert.match((await about('ui-without-entry')).error ?? '', /Entry file not found/)
  assert.equal((await about('nothing')).status, 'error')

  await manager.setEnabled('only-ui', false)
  assert.equal((await about('only-ui')).ui, false)
  await kernel.dispose()
})

test('started without plugins, none runs, and the switches still count for the next start', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-plugin-ui-'))
  const dir = path.join(base, 'plugins')
  const stateFile = path.join(base, 'plugins.json')
  for (const id of ['was-on', 'was-off']) {
    await mkdir(path.join(dir, id, 'ui'), { recursive: true })
    await writeFile(path.join(dir, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }))
    await writeFile(path.join(dir, id, 'index.js'), `export const inject = ['tools']\nexport function apply(ctx) { ctx.tools.register({ name: '${id.replace('-', '_')}', description: 'd', run: () => 'ran' }) }\n`)
    await writeFile(path.join(dir, id, 'ui', 'index.js'), 'export default () => ({})\n')
  }
  await writeFile(stateFile, JSON.stringify({ 'was-on': { enabled: true, config: { kept: true } } }))

  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools })
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile, held: true })
  await manager.init()
  const about = async (id: string) => (await manager.list()).find((p) => p.id === id)!

  assert.equal(manager.held, true)
  assert.deepEqual([(await about('was-on')).enabled, (await about('was-on')).status, (await about('was-on')).ui], [true, 'held', false])
  assert.equal((await about('was-off')).status, 'disabled')
  assert.deepEqual(tools.list(), [], 'no code of a plugin has run')
  assert.equal(manager.uiFile('was-on', 'index.js'), null, 'and none of its interface is handed to the page')

  // Switching one on does not start it now. Switching the other off is what the start without plugins is for.
  await manager.setEnabled('was-off', true)
  await manager.setEnabled('was-on', false)
  assert.equal((await about('was-off')).status, 'held')
  assert.equal((await about('was-on')).status, 'disabled')
  assert.deepEqual(tools.list(), [])
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { 'was-on': { enabled: false, config: { kept: true } }, 'was-off': { enabled: true } })
  await kernel.dispose()
})

test('the page is handed files from the ui folder of a plugin that is on, and nothing else', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-plugin-ui-'))
  const dir = path.join(base, 'plugins')
  const plugin = async (id: string): Promise<void> => {
    await mkdir(path.join(dir, id, 'ui', 'parts'), { recursive: true })
    await writeFile(path.join(dir, id, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }))
    await writeFile(path.join(dir, id, 'index.js'), 'export function apply() {}\n')
    await writeFile(path.join(dir, id, 'ui', 'index.js'), 'export const hello = 1\n')
    await writeFile(path.join(dir, id, 'ui', 'parts', 'chart.js'), 'export const chart = 1\n')
  }
  await plugin('on')
  await plugin('off')
  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools })
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile: path.join(base, 'plugins.json') })
  await manager.init()
  await manager.setEnabled('on', true)

  assert.equal(manager.uiFile('on', 'index.js'), path.join(dir, 'on', 'ui', 'index.js'))
  assert.equal(manager.uiFile('on', 'parts/chart.js'), path.join(dir, 'on', 'ui', 'parts', 'chart.js'))
  // A plugin that is off, and one that is not there.
  assert.equal(manager.uiFile('off', 'index.js'), null)
  assert.equal(manager.uiFile('nobody', 'index.js'), null)
  // Not the plugin's code for the main process, not its folder, not anything further out.
  for (const outside of ['../index.js', '../package.json', '..', '', '.', '../../off/ui/index.js', '../../../plugins.json', path.join(dir, 'on', 'index.js'), 'C:\\Windows\\win.ini', '/etc/passwd']) {
    assert.equal(manager.uiFile('on', outside), null, outside)
  }

  // Switched off again, its files are no longer handed out; switched on, the other's are.
  await manager.setEnabled('on', false)
  assert.equal(manager.uiFile('on', 'index.js'), null)
  await manager.setEnabled('off', true)
  assert.equal(manager.uiFile('off', 'index.js'), path.join(dir, 'off', 'ui', 'index.js'))
  await kernel.dispose()
})
