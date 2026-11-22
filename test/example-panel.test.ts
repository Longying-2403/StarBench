// Run with: node --test test/example-panel.test.ts
// The example plugin with an interface is what people copy to start their own: it has to work.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createKernel } from '../src/main/kernel.ts'
import { PluginChannel } from '../src/main/plugin-channel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { ToolRegistry } from '../src/main/tools.ts'
import { disposeOf, panelOf, setupOf, slotsOf } from '../src/shared/plugin-ui.ts'
import type { PluginPlaceProps } from '../src/shared/plugin-ui.ts'

const EXAMPLE = path.resolve('examples/plugins/hello-panel')

test('the example plugin with a panel starts, and its two halves talk', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-example-'))
  const dir = path.join(base, 'plugins')
  await cp(EXAMPLE, path.join(dir, 'hello-panel'), { recursive: true })

  const channel = new PluginChannel()
  const told: unknown[] = []
  channel.carryWith((plugin, event, payload) => told.push([plugin, event, payload]))
  const tools = new ToolRegistry()
  const kernel = await createKernel({ tools, channel })
  const manager = new PluginManager({ root: kernel.root, tools, dir, stateFile: path.join(base, 'plugins.json') })
  await manager.init()
  await manager.setEnabled('hello-panel', true)

  const info = (await manager.list()).find((p) => p.id === 'hello-panel')!
  assert.deepEqual([info.status, info.ui, info.uiStyle, info.error], ['active', true, true, undefined])
  // The page is handed the interface and its sheet, and not the types file beside them or the main-process half.
  assert.ok(manager.uiFile('hello-panel', 'index.js'))
  assert.ok(manager.uiFile('hello-panel', 'index.css'))
  assert.equal(manager.uiFile('hello-panel', '../index.js'), null)
  assert.equal(manager.uiFile('hello-panel', '../starbench-plugin.d.ts'), null)

  assert.deepEqual(await channel.call('hello-panel', 'greet', { name: ' 小明 ', loud: true, times: 2 }), { text: '你好，小明！你好，小明！' })
  assert.deepEqual(await channel.call('hello-panel', 'greet', undefined), { text: '你好，朋友。' })
  assert.deepEqual(await channel.call('hello-panel', 'greet', { times: 99 }), { text: '你好，朋友。'.repeat(5) }, 'held to what the slider offers')
  assert.deepEqual(told, [
    ['hello-panel', 'greeted', { count: 1 }],
    ['hello-panel', 'greeted', { count: 2 }],
    ['hello-panel', 'greeted', { count: 3 }]
  ])
  await kernel.dispose()
})

test("the example's interface gives a panel that draws with what the app hands it", async () => {
  const module: unknown = await import(pathToFileURL(path.join(EXAMPLE, 'ui', 'index.js')).href)
  const setup = setupOf(module)
  assert.ok(setup, 'ui/index.js exports a setup function')

  // Stand-ins for what the page hands over: the real React, controls that only say their label, and a line that records.
  const asked: unknown[] = []
  const listening: string[] = []
  let stopped = 0
  const control = (kind: string) => (props: { label: string }) => React.createElement('label', { 'data-control': kind }, props.label)
  const given = await setup({
    apiVersion: 1,
    id: 'hello-panel',
    React,
    controls: { Slider: control('slider'), Switch: control('switch'), Field: control('field') },
    backend: {
      call: async (name: string, payload: unknown) => (asked.push([name, payload]), { text: 'hi' }),
      on: (event: string) => (listening.push(event), () => void stopped++)
    }
  })

  assert.deepEqual(slotsOf(given), {}, 'it has a panel and nothing in the row')
  const panel = panelOf(given)
  assert.equal(panel?.title, '示例面板')
  assert.deepEqual(listening, ['greeted'], 'it listens for its own main-process half from the moment it is loaded')

  const place: PluginPlaceProps = {
    conversation: { id: null, workspace: 'D:\\work', running: true },
    model: { id: 'qwen3.5:9b', effort: 'default', provider: { id: 'p1', name: '我的 Ollama', kind: 'openai-chat', local: true } }
  }
  const drawn = renderToStaticMarkup(React.createElement(panel!.component as React.FunctionComponent<PluginPlaceProps>, place))
  for (const expected of ['class="hello-panel"', 'data-control="field"', 'data-control="switch"', 'data-control="slider"', '打个招呼', '后台已经打过 0 次招呼', '当前模型：qwen3.5:9b（我的 Ollama，本地）', '模型正在回答']) {
    assert.ok(drawn.includes(expected), `the panel shows ${expected}`)
  }
  assert.ok(renderToStaticMarkup(React.createElement(panel!.component as React.FunctionComponent<PluginPlaceProps>, { ...place, model: null })).includes('还没有选模型'))
  assert.deepEqual(asked, [], 'nothing is asked of the main-process half before the button is pressed')

  // Taken off the page, it stops listening.
  const dispose = disposeOf(given)
  assert.ok(dispose)
  dispose()
  assert.equal(stopped, 1)
})

test('the types file in the example is the one the app holds itself to', async () => {
  const [own, copy] = await Promise.all([readFile(path.resolve('types/starbench-plugin.d.ts'), 'utf8'), readFile(path.join(EXAMPLE, 'starbench-plugin.d.ts'), 'utf8')])
  assert.equal(copy.replace(/\r\n/g, '\n'), own.replace(/\r\n/g, '\n'), 'copy types/starbench-plugin.d.ts into examples/plugins/hello-panel after changing it')
})
