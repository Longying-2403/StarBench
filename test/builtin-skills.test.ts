// Run with: node --test test/builtin-skills.test.ts
// The skills that come with the app, in skills/. Each has to be found under the name it is written
// with (a name StarBench cannot use hides a skill without a word), say in few words when it is for
// (every request carries the descriptions), and name each file it carries (the model reads no file
// it is not told of). What they carry are copies of the repository's own documents and example
// skill, and have to stay word for word. Any skill of the same name, the person's own or a plugin's,
// takes the place of one that comes with the app.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { BUILTIN_SKILLS, SkillStore, parseSkill, skillsPrompt } from '../src/main/skills.ts'

const BUILTIN = path.resolve('skills')
/** What one description may take, in characters: well under the 600 StarBench cuts at. */
const DESCRIPTION_MAX = 200

/** The files under a folder, relative to it, with forward slashes. */
async function filesIn(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await filesIn(path.join(dir, entry.name), relative)))
    else files.push(relative)
  }
  return files
}

async function writeSkill(root: string, folder: string, description: string, body: string): Promise<void> {
  await mkdir(path.join(root, folder), { recursive: true })
  await writeFile(path.join(root, folder, 'SKILL.md'), `---\ndescription: ${description}\n---\n${body}`)
}

test('every skill that comes with the app is found under its name, says briefly when it is for, and names the files it carries', async () => {
  const folders = await readdir(BUILTIN)
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-builtin-skills-'))
  // Wired as the app wires it: the person's own folder (empty here) first, the app's last.
  const listed = await new SkillStore(path.join(base, 'skills'), BUILTIN).list()
  assert.deepEqual(listed.map((s) => s.name).sort(), [...folders].sort(), 'each folder is a skill, found under the name of the folder')
  assert.ok(listed.length >= 2, 'create-skill and create-plugin are among them')
  for (const skill of listed) {
    assert.equal(skill.source, BUILTIN_SKILLS)
    const dir = path.join(BUILTIN, skill.name)
    const parsed = parseSkill(await readFile(path.join(dir, 'SKILL.md'), 'utf8'))
    assert.equal(parsed.name, skill.name, `${skill.name}: the front matter gives the name the folder has`)
    const length = skill.description.length
    assert.ok(length >= 20 && length <= DESCRIPTION_MAX, `${skill.name}: a description of 20 to ${DESCRIPTION_MAX} characters, not ${length}`)
    for (const file of (await filesIn(dir)).filter((f) => f !== 'SKILL.md')) {
      assert.ok(parsed.body.includes(`\`${file}\``), `${skill.name}: the instructions say what ${file} is for`)
    }
  }
})

test("what the skills that come with the app carry is the repository's own documents and example skill, word for word", async () => {
  const copies = [
    ['create-plugin/reference/plugins.md', 'docs/plugins.md'],
    ['create-plugin/reference/plugin-ui.md', 'docs/plugin-ui.md'],
    ['create-plugin/reference/starbench-plugin.d.ts', 'types/starbench-plugin.d.ts'],
    ['create-skill/example.md', 'examples/skills/commit-message/SKILL.md']
  ]
  for (const [copy, own] of copies) {
    const [carried, original] = await Promise.all([readFile(path.join(BUILTIN, copy), 'utf8'), readFile(path.resolve(own), 'utf8')])
    assert.equal(carried.replace(/\r\n/g, '\n'), original.replace(/\r\n/g, '\n'), `copy ${own} to skills/${copy} after changing it`)
  }
})

test("the app's skills are listed and loaded like any other, and give way to the person's and a plugin's of the same name", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench-builtin-skills-'))
  const userDir = path.join(base, 'skills')
  const appDir = path.join(base, 'app-skills')
  const pluginDir = path.join(base, 'plugin-skills')
  await writeSkill(appDir, 'review', 'The app version', 'app body')
  await writeSkill(appDir, 'plan', 'Plan the work', 'app plan body')
  await writeSkill(appDir, 'notes', 'Take notes', 'app notes body')
  await writeSkill(userDir, 'review', 'My version', 'my body')
  await writeSkill(pluginDir, 'plan', 'The plugin version', 'plugin plan body')

  const store = new SkillStore(userDir, appDir)
  const remove = store.addRoot(pluginDir, 'planner')
  assert.deepEqual(await store.list(), [
    { name: 'review', description: 'My version', source: 'user' },
    { name: 'plan', description: 'The plugin version', source: 'planner' },
    { name: 'notes', description: 'Take notes', source: BUILTIN_SKILLS }
  ])
  assert.ok((await store.load('review')).endsWith('my body'))
  assert.ok((await store.load('notes')).endsWith('app notes body'))
  assert.match(skillsPrompt(await store.list()), /- notes: Take notes/)

  // Once the plugin is switched off, the app's own comes back.
  remove()
  assert.deepEqual((await store.list()).find((s) => s.name === 'plan'), { name: 'plan', description: 'Plan the work', source: BUILTIN_SKILLS })
  assert.ok((await store.load('plan')).endsWith('app plan body'))
  assert.equal(store.userDir, userDir, 'the folder the settings page opens is still the person\'s own')
})
