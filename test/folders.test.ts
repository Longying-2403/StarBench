import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKSPACE_NAME_LIMIT, cleanWorkspaceName, folderKey, folderName, groupByWorkspace, workspaceName } from '../src/shared/folders.ts'
import type { SessionSummary } from '../src/shared/types.ts'

const session = (id: string, workspace: string, updatedAt: number): SessionSummary => ({ id, title: id, workspace, updatedAt })

test('folderName is the last part of a path', () => {
  assert.equal(folderName('D:\\Work\\My App'), 'My App')
  assert.equal(folderName('/home/me/app/'), 'app')
  assert.equal(folderName('app'), 'app')
})

test('groupByWorkspace sorts sessions into their folders, most recent first', () => {
  // As the store lists them: most recent first.
  const sessions = [
    session('c', 'D:\\Notes', 30),
    session('b', 'd:/work/app/', 20),
    session('a', 'D:\\Work\\App', 10),
    session('z', 'D:\\Notes', 5)
  ]
  const groups = groupByWorkspace(sessions, true)
  assert.deepEqual(
    groups.map((g) => [g.name, g.sessions.map((s) => s.id)]),
    [
      ['Notes', ['c', 'z']],
      // Two spellings of one folder on Windows; the group takes the spelling of its newest session.
      ['app', ['b', 'a']]
    ]
  )
  assert.equal(groups[1].workspace, 'd:/work/app/')
  assert.notEqual(groups[0].key, groups[1].key)
})

test('groupByWorkspace keeps folders apart that differ only by case where case matters', () => {
  const sessions = [session('a', '/home/me/App', 2), session('b', '/home/me/app', 1)]
  assert.equal(groupByWorkspace(sessions, false).length, 2)
  assert.equal(groupByWorkspace(sessions, true).length, 1)
  assert.deepEqual(groupByWorkspace([], true), [])
})

test('a workspace goes by the name it was given, and by that of its folder without one', () => {
  const names = { [folderKey('D:\\Work\\App', true)]: '主项目' }
  // Every spelling of the folder finds the name, as every spelling is the same workspace.
  assert.equal(workspaceName('D:\\Work\\App', names, true), '主项目')
  assert.equal(workspaceName('d:/work/app/', names, true), '主项目')
  assert.equal(workspaceName('D:\\Notes', names, true), 'Notes')
  assert.equal(workspaceName('D:\\Notes', undefined, true), 'Notes')
  // Where case tells folders apart, a name given to one is not the other's.
  const posix = { [folderKey('/home/me/App', false)]: 'Mine' }
  assert.equal(workspaceName('/home/me/App', posix, false), 'Mine')
  assert.equal(workspaceName('/home/me/app', posix, false), 'app')
  // What every object has under such a name is not a name someone gave.
  assert.equal(workspaceName('constructor', {}, false), 'constructor')
  assert.equal(workspaceName('__proto__', {}, false), '__proto__')

  const sessions = [session('c', 'D:\\Notes', 30), session('b', 'd:/work/app/', 20), session('a', 'D:\\Work\\App', 10)]
  const groups = groupByWorkspace(sessions, true, names)
  assert.deepEqual(
    groups.map((g) => [g.name, g.workspace]),
    [
      ['Notes', 'D:\\Notes'],
      // The folder is the one it was; only what the group is called has changed.
      ['主项目', 'd:/work/app/']
    ]
  )
})

test('a name typed for a workspace is kept on one line and within its length', () => {
  assert.equal(cleanWorkspaceName('  主 \n 项目\t'), '主 项目')
  assert.equal(cleanWorkspaceName(' \n '), '')
  const long = cleanWorkspaceName(`${'a'.repeat(WORKSPACE_NAME_LIMIT - 1)} b c`)
  assert.equal(long.length, WORKSPACE_NAME_LIMIT - 1, 'cut at the limit, and the space left at the end goes too')
})
