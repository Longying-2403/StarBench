import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderName, groupByWorkspace } from '../src/shared/folders.ts'
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
