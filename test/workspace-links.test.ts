// Run with: node --test test/workspace-links.test.ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { ToolRegistry, registerBuiltinTools } from '../src/main/tools.ts'
import { findNamed, readImage } from '../src/main/workspace-files.ts'

// The smallest PNG there is: one transparent pixel.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/**
 * A workspace with links in it: `docs` leads to a folder outside, `alias` to a folder inside, and
 * `gone` to a folder that has been deleted since. A junction needs no privilege on Windows, where
 * anything a command ran can make one; elsewhere the same call makes a symbolic link, which a
 * cloned repository can bring along.
 */
async function linkedWorkspace(t: TestContext): Promise<{ base: string; workspace: string; outside: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench links '))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspace = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET\n')
  await writeFile(path.join(outside, 'secret.png'), PIXEL)
  await writeFile(path.join(workspace, 'src', 'a.txt'), 'inside\n')
  await symlink(outside, path.join(workspace, 'docs'), 'junction')
  await symlink(path.join(workspace, 'src'), path.join(workspace, 'alias'), 'junction')
  await mkdir(path.join(base, 'was-here'))
  await symlink(path.join(base, 'was-here'), path.join(workspace, 'gone'), 'junction')
  await rm(path.join(base, 'was-here'), { recursive: true })
  return { base, workspace, outside }
}

function toolsIn(workspace: string): (name: string, args: Record<string, unknown>) => Promise<string> {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  return (name, args) => tools.execute(name, JSON.stringify(args), { workspace, signal: new AbortController().signal })
}

test('the file tools do not follow a link out of the workspace', async (t) => {
  const { workspace, outside } = await linkedWorkspace(t)
  const run = toolsIn(workspace)
  const refused: [string, Record<string, unknown>][] = [
    ['read_file', { path: 'docs/secret.txt' }],
    ['list_dir', { path: 'docs' }],
    ['search', { pattern: 'TOP-SECRET', path: 'docs' }],
    ['write_file', { path: 'docs/planted.txt', content: 'x' }],
    ['write_file', { path: 'docs/new/deeper.txt', content: 'x' }],
    ['edit_file', { path: 'docs/secret.txt', old_string: 'TOP', new_string: 'BOTTOM' }]
  ]
  for (const [name, args] of refused) {
    assert.match(await run(name, args), /^Error: .*outside the workspace/, `${name} ${JSON.stringify(args)}`)
  }
  // Nothing was made or changed out there.
  assert.deepEqual((await readdir(outside)).sort(), ['secret.png', 'secret.txt'])
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'TOP-SECRET\n')
  // A search of the whole workspace passes the link by.
  assert.equal(await run('search', { pattern: 'TOP-SECRET' }), 'No matches')
})

test('a link that leads nowhere is not written through', async (t) => {
  const { base, workspace } = await linkedWorkspace(t)
  const run = toolsIn(workspace)
  assert.match(await run('write_file', { path: 'gone/made.txt', content: 'x' }), /^Error: /)
  assert.match(await run('write_file', { path: 'gone/deeper/made.txt', content: 'x' }), /^Error: /)
  assert.deepEqual((await readdir(base)).sort(), ['outside', 'workspace'], 'the folder the link pointed to was not made again')
})

test('links that stay inside the workspace, and files not made yet, work as before', async (t) => {
  const { workspace } = await linkedWorkspace(t)
  const run = toolsIn(workspace)
  assert.equal(await run('read_file', { path: 'alias/a.txt' }), '1\tinside\n2\t')
  assert.match(await run('list_dir', { path: 'alias' }), /^a\.txt$/)
  assert.match(await run('edit_file', { path: 'alias/a.txt', old_string: 'inside', new_string: 'changed' }), /^Replaced 1 occurrence/)
  assert.equal(await readFile(path.join(workspace, 'src', 'a.txt'), 'utf8'), 'changed\n')
  assert.equal(await run('search', { pattern: 'changed', path: 'alias' }), 'alias/a.txt:1: changed')
  assert.match(await run('write_file', { path: 'new/deeper/file.txt', content: 'made' }), /^Wrote 4 characters/)
  assert.equal(await readFile(path.join(workspace, 'new', 'deeper', 'file.txt'), 'utf8'), 'made')
  assert.match(await run('read_file', { path: '../outside/secret.txt' }), /^Error: Path is outside the workspace/)
})

test('links and pictures in answers do not lead out of the workspace through a link', async (t) => {
  const { workspace } = await linkedWorkspace(t)
  assert.equal(await findNamed(workspace, 'docs/secret.txt'), 'outside')
  assert.equal(await findNamed(workspace, 'gone/made.txt'), 'outside')
  assert.deepEqual(await readImage(workspace, 'docs/secret.png'), { ok: false, reason: 'outside' })
  const inside = await findNamed(workspace, 'alias/a.txt')
  assert.ok(typeof inside !== 'string', 'a link that stays inside is followed')
  assert.equal(await realpath(inside.full), await realpath(path.join(workspace, 'src', 'a.txt')))
})
