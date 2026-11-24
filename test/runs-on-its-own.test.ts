// Run with: node --test test/runs-on-its-own.test.ts
//
// Writes into folders whose files git or an editor run commands from by themselves (.git,
// .vscode, .idea) are asked about, also in a conversation that lets files be changed without
// asking: a hook or a line of git's configuration is a command waiting for the next `git status`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { MemoryService } from '../src/main/memory.ts'
import { ToolRegistry, registerBuiltinTools, runsOnItsOwn } from '../src/main/tools.ts'
import { rulingFor, runsOnItsOwnPart } from '../src/shared/permissions.ts'

/** A workspace that is a git repository, as most are. */
async function repository(t: TestContext): Promise<{ base: string; workspace: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'starbench runs '))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspace = path.join(base, 'workspace')
  await mkdir(path.join(workspace, '.git', 'hooks'), { recursive: true })
  await mkdir(path.join(workspace, 'src'))
  await writeFile(path.join(workspace, '.git', 'config'), '[core]\n')
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'export {}\n')
  return { base, workspace }
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  return tools
}

test('the folders are told as Windows reads the parts of a path', () => {
  const ws = 'C:\\Users\\me\\repo'
  for (const target of [
    '.git/config',
    '.GIT\\hooks\\pre-commit',
    '.git./config',
    '.git /config',
    '.git::$INDEX_ALLOCATION/config',
    'sub/.git',
    'a/b/.vscode/tasks.json',
    '.idea/workspace.xml',
    'C:\\Users\\me\\repo\\.git\\config',
    'c:/users/me/repo/.Git/config'
  ]) {
    assert.ok(runsOnItsOwnPart(ws, target), target)
  }
  for (const target of ['src/a.ts', '.github/workflows/ci.yml', '.gitignore', '.gitattributes', 'git/config', '...git/x', 'docs/.git-notes.md']) {
    assert.equal(runsOnItsOwnPart(ws, target), null, target)
  }
  // Only what lies inside the workspace counts.
  assert.equal(runsOnItsOwnPart('C:\\work\\.vscode\\project', 'C:\\work\\.vscode\\project\\src\\a.ts'), null)
})

test('a write into .git, .vscode or .idea is asked about where other edits are not', async (t) => {
  const { workspace } = await repository(t)
  const tools = registry()
  const access = (name: string, args: Record<string, unknown>) => tools.accessFor(name, JSON.stringify(args), workspace)
  assert.equal(await access('write_file', { path: 'src/b.ts', content: '' }), 'edit')
  assert.equal(await access('edit_file', { path: 'src/a.ts', old_string: 'export', new_string: 'export' }), 'edit')
  assert.equal(await access('write_file', { path: '.git/config', content: '' }), 'other')
  assert.equal(await access('edit_file', { path: '.git/hooks/pre-commit', old_string: 'a', new_string: 'b' }), 'other')
  assert.equal(await access('write_file', { path: '.vscode/tasks.json', content: '{}' }), 'other')
  assert.equal(await access('write_file', { path: path.join(workspace, '.IDEA', 'workspace.xml'), content: '' }), 'other')
  // Reading is no change, and a command is asked about anyway.
  assert.equal(await access('read_file', { path: '.git/config' }), 'read')
  assert.equal(await access('run_command', { command: 'git status' }), 'other')
  // What the modes make of that: asked where edits run unasked, run where everything does, refused when view-only.
  assert.equal(rulingFor('edit', 'edit'), 'run')
  assert.equal(rulingFor('edit', 'other'), 'ask')
  assert.equal(rulingFor('full', 'other'), 'run')
  assert.equal(rulingFor('view', 'other'), 'refuse')
})

test('a link to .git, or a second name of a file in it, is seen through', async (t) => {
  const { workspace } = await repository(t)
  await symlink(path.join(workspace, '.git'), path.join(workspace, 'meta'), 'junction')
  assert.equal(await runsOnItsOwn(workspace, 'meta/config'), true)
  // Not made yet, under the link.
  assert.equal(await runsOnItsOwn(workspace, 'meta/hooks/post-checkout'), true)
  // A hard link: the same file under another name.
  await link(path.join(workspace, '.git', 'config'), path.join(workspace, 'notes.txt'))
  assert.equal(await runsOnItsOwn(workspace, 'notes.txt'), true)
  assert.equal(await registry().accessFor('write_file', JSON.stringify({ path: 'notes.txt', content: '' }), workspace), 'other')
  // Everything else is an edit as before.
  assert.equal(await runsOnItsOwn(workspace, 'src/a.ts'), false)
  assert.equal(await runsOnItsOwn(workspace, 'src/new/file.ts'), false)
  // Outside the workspace the write tool refuses the path itself.
  assert.equal(await runsOnItsOwn(workspace, '../elsewhere/x.txt'), false)
})

test('a short name of .git is seen through', { skip: process.platform !== 'win32' }, async (t) => {
  const { workspace } = await repository(t)
  const listing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/a:d', workspace], { encoding: 'latin1' })
  const short = /\s(\S+~\d+)\s+\.git\s*$/m.exec(listing)?.[1]
  if (!short) {
    t.skip('this volume makes no short names')
    return
  }
  assert.equal(runsOnItsOwnPart(workspace, `${short}/config`), null)
  assert.equal(await runsOnItsOwn(workspace, `${short}/config`), true)
  assert.equal(await runsOnItsOwn(workspace, `${short}/hooks/post-checkout`), true)
})

test('the memory leaves the judging of a write to the tools', async (t) => {
  const { base, workspace } = await repository(t)
  const memory = new MemoryService({ dir: path.join(base, 'memory'), windows: process.platform === 'win32', emit: () => {} })
  const turn = { session: 's1', workspace, provider: { id: 'p', local: false }, model: 'm' }
  const { tools } = await memory.forTurn(turn, registry())
  assert.equal(await tools.accessFor?.('write_file', JSON.stringify({ path: '.git/config', content: '' }), workspace), 'other')
  assert.equal(await tools.accessFor?.('write_file', JSON.stringify({ path: 'src/b.ts', content: '' }), workspace), 'edit')
  assert.equal(await tools.accessFor?.('remember', JSON.stringify({ text: 'x', kind: 'user' }), workspace), 'read')
})
