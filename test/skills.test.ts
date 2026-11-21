import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createKernel } from '../src/main/kernel.ts'
import { PluginManager } from '../src/main/plugins.ts'
import { SkillStore, loadSkillTool, parseSkill, skillsPrompt } from '../src/main/skills.ts'
import { ToolRegistry } from '../src/main/tools.ts'

const signal = new AbortController().signal

async function writeSkill(root: string, folder: string, content: string, extra: Record<string, string> = {}) {
  const dir = path.join(root, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), content)
  for (const [name, text] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), text)
  }
  return dir
}

test('parseSkill reads the front matter forms skills use', () => {
  assert.deepEqual(parseSkill('---\nname: a\ndescription: plain text: with a colon\n---\n\nBody here\n'), {
    name: 'a',
    description: 'plain text: with a colon',
    body: 'Body here'
  })
  assert.equal(parseSkill('---\r\nname: "quoted"\r\ndescription: \'single\'\r\n---\r\nB').name, 'quoted')
  assert.equal(parseSkill('﻿---\nname: bom\n---\nB').name, 'bom')
  assert.equal(parseSkill('---\ndescription: >\n  folded over\n  two lines\nname: x\n---\nB').description, 'folded over two lines')
  assert.equal(parseSkill('---\ndescription: |\n  kept\n  apart\n---\nB').description, 'kept\napart')
  assert.equal(parseSkill('---\ndescription: starts here\n  and continues\n---\nB').description, 'starts here and continues')
  assert.deepEqual(parseSkill('No front matter at all'), { body: 'No front matter at all' })
  assert.deepEqual(parseSkill('---\nname: only-header\n---'), { name: 'only-header', description: undefined, body: '' })
})

test('the store lists, loads and guards skills', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-skills-'))
  const userDir = path.join(base, 'skills')
  const pluginDir = path.join(base, 'plugin-skills')
  const reviewDir = await writeSkill(userDir, 'review', '---\nname: code-review\ndescription: Review a diff\n---\nCheck the diff.', {
    'checklist.md': 'item one',
    'scripts/run.sh': 'echo hi'
  })
  await writeSkill(userDir, 'no-front-matter', 'Just instructions.')
  await writeSkill(userDir, 'bad name here', '---\nname: has spaces\n---\nx')
  await writeSkill(pluginDir, 'code-review', '---\ndescription: plugin copy\n---\nplugin body')
  await writeSkill(pluginDir, 'deploy', '---\ndescription: Deploy the app\n---\nShip it.')
  await mkdir(path.join(userDir, 'empty-folder'))
  await writeFile(path.join(base, 'secret.txt'), 'top secret')

  const store = new SkillStore(userDir)
  const remove = store.addRoot(pluginDir, 'my-plugin')

  assert.deepEqual(await store.list(), [
    // folder name used when there is no usable name; the invalid folder is skipped entirely
    { name: 'no-front-matter', description: '', source: 'user' },
    { name: 'code-review', description: 'Review a diff', source: 'user' },
    // the user's code-review wins over the plugin's
    { name: 'deploy', description: 'Deploy the app', source: 'my-plugin' }
  ])

  const loaded = await store.load('code-review')
  assert.match(loaded, /^Skill: code-review\n/)
  assert.ok(loaded.includes(`Directory: ${reviewDir}`))
  assert.match(loaded, /checklist\.md, scripts\/run\.sh/)
  assert.ok(loaded.endsWith('Check the diff.'))
  assert.equal(await store.readFile('code-review', 'checklist.md'), 'item one')
  await assert.rejects(store.readFile('code-review', '../../secret.txt'), /outside the skill folder/)
  await assert.rejects(store.load('nope'), /Unknown skill "nope"\. Available skills: no-front-matter, code-review, deploy/)

  const tools = new ToolRegistry()
  tools.register(loadSkillTool(store), 'builtin')
  assert.equal(tools.needsPermission('load_skill'), false)
  assert.ok((await tools.execute('load_skill', '{"name":"deploy"}', { workspace: '.', signal })).endsWith('Ship it.'))
  assert.equal(await tools.execute('load_skill', '{"name":"code-review","file":"scripts/run.sh"}', { workspace: '.', signal }), 'echo hi')
  assert.match(await tools.execute('load_skill', '{"name":"nope"}', { workspace: '.', signal }), /^Error: Unknown skill/)

  const prompt = skillsPrompt(await store.list())
  assert.match(prompt, /- code-review: Review a diff/)
  assert.match(prompt, /- no-front-matter: \(no description\)/)
  assert.equal(skillsPrompt([]), '')

  remove()
  assert.deepEqual((await store.list()).map((s) => s.name), ['no-front-matter', 'code-review'])
})

test('the example skill is valid', async () => {
  const store = new SkillStore(path.resolve('examples/skills'))
  const [skill] = await store.list()
  assert.equal(skill.name, 'commit-message')
  assert.ok(skill.description.length > 20)
  assert.match(await store.load('commit-message'), /## 步骤/)
})

test('a plugin contributes its skills folder while it is enabled', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-skills-'))
  const dir = path.join(base, 'plugins')
  // One plugin with code and skills, one with skills only.
  await cp(path.resolve('examples/plugins/hello-tool'), path.join(dir, 'with-code'), { recursive: true })
  await writeSkill(path.join(dir, 'with-code', 'skills'), 'timing', '---\ndescription: About time\n---\nUse current_time.')
  await mkdir(path.join(dir, 'skills-only'), { recursive: true })
  await writeFile(path.join(dir, 'skills-only', 'package.json'), JSON.stringify({ name: 'skills-only', version: '1.0.0' }))
  await writeSkill(path.join(dir, 'skills-only', 'skills'), 'style', '---\ndescription: House style\n---\nBe brief.')
  await mkdir(path.join(dir, 'nothing'), { recursive: true })
  await writeFile(path.join(dir, 'nothing', 'package.json'), JSON.stringify({ name: 'nothing' }))

  const tools = new ToolRegistry()
  const skills = new SkillStore(path.join(base, 'skills'))
  const kernel = await createKernel({ tools })
  const manager = new PluginManager({ root: kernel.root, tools, skills, dir, stateFile: path.join(base, 'plugins.json') })
  await manager.init()
  assert.deepEqual(await skills.list(), [], 'disabled plugins contribute nothing')

  for (const id of ['with-code', 'skills-only', 'nothing']) await manager.setEnabled(id, true)
  const byId = Object.fromEntries((await manager.list()).map((p) => [p.id, p]))
  assert.deepEqual([byId['with-code'].status, byId['with-code'].tools, byId['with-code'].skills], ['active', ['current_time'], ['timing']])
  assert.deepEqual([byId['skills-only'].status, byId['skills-only'].skills], ['active', ['style']])
  assert.equal(byId.nothing.status, 'error')
  assert.match(byId.nothing.error ?? '', /Entry file not found/)
  assert.deepEqual((await skills.list()).map((s) => `${s.source}/${s.name}`).sort(), ['skills-only/style', 'with-code/timing'])

  await manager.setEnabled('skills-only', false)
  await manager.setEnabled('with-code', false)
  assert.deepEqual(await skills.list(), [])
  await kernel.dispose()
})
