// Run with: node --test test/skill-links.test.ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SkillStore } from '../src/main/skills.ts'

test('a skill folder does not lead out of itself through a link', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench skill links '))
  t.after(() => rm(base, { recursive: true, force: true }))
  const skillsDir = path.join(base, 'skills')
  const skillDir = path.join(skillsDir, 'linked')
  const outside = path.join(base, 'outside')
  await mkdir(path.join(skillDir, 'docs'), { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: linked\ndescription: A skill with links in its folder\n---\nBody')
  await writeFile(path.join(skillDir, 'docs', 'guide.md'), 'inside')
  await writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET')
  // A junction needs no privilege on Windows; elsewhere the same call makes a symbolic link.
  await symlink(outside, path.join(skillDir, 'elsewhere'), 'junction')
  await symlink(path.join(skillDir, 'docs'), path.join(skillDir, 'alias'), 'junction')

  const store = new SkillStore(skillsDir)
  await assert.rejects(store.readFile('linked', 'elsewhere/secret.txt'), /outside the skill folder/)
  assert.equal(await store.readFile('linked', 'docs/guide.md'), 'inside')
  assert.equal(await store.readFile('linked', 'alias/guide.md'), 'inside', 'a link that stays inside is followed')
})
