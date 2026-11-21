import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_RECENT_FOLDERS, folderKey, mergeFolders } from '../src/main/workspaces.ts'

test('folderKey treats spellings of one folder alike', () => {
  // Windows: case, separator and a trailing separator do not matter.
  assert.equal(folderKey('D:\\Work\\App\\', true), folderKey('d:/work/app', true))
  assert.notEqual(folderKey('D:\\Work\\App', true), folderKey('D:\\Work\\App2', true))
  // Elsewhere only the trailing separator is ignored.
  assert.equal(folderKey('/home/me/app/', false), folderKey('/home/me/app', false))
  assert.notEqual(folderKey('/home/me/App', false), folderKey('/home/me/app', false))
  assert.equal(folderKey('   ', true), '')
})

test('mergeFolders keeps the most recent spelling first and drops repeats', () => {
  const recent = ['D:\\Work\\App', 'D:\\Notes']
  // Using a folder again moves it to the front without listing it twice.
  assert.deepEqual(mergeFolders([['d:\\notes\\'], recent], MAX_RECENT_FOLDERS, true), ['d:\\notes\\', 'D:\\Work\\App'])
  // Folders of saved sessions come after the remembered ones.
  assert.deepEqual(mergeFolders([recent, ['D:\\Notes', 'D:\\Old']], MAX_RECENT_FOLDERS, true), ['D:\\Work\\App', 'D:\\Notes', 'D:\\Old'])
  // Empty and non-text entries, as a hand-edited settings file could hold, are ignored.
  assert.deepEqual(mergeFolders([['', '  ', 5 as unknown as string, '/a']], MAX_RECENT_FOLDERS, false), ['/a'])
})

test('mergeFolders stops at the limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => `/projects/p${i}`)
  assert.equal(mergeFolders([many], MAX_RECENT_FOLDERS, false).length, MAX_RECENT_FOLDERS)
  assert.deepEqual(mergeFolders([many], 2, false), ['/projects/p0', '/projects/p1'])
  assert.equal(mergeFolders([many], Infinity, false).length, 20)
})
