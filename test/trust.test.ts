// The folders a person said a model may read: how the list is kept in the settings.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as model from '../src/main/settings-model.ts'

const windows = true

test('a settings file from before the app asked about folders has no list, and says so by having none', () => {
  const old = model.readSettings({ recentWorkspaces: ['D:\\Work\\App'] })
  assert.equal('trustedFolders' in old, false)
  // The page is given a list either way.
  assert.deepEqual(model.toPublic(old).trustedFolders, [])
  assert.equal(model.isTrusted(old, 'D:\\Work\\App', windows), false)

  // The folders in use by then are written down as trusted, once; an empty list is a list too.
  const seeded = model.trustFolders(old, old.recentWorkspaces ?? [], windows)
  assert.deepEqual(seeded.trustedFolders, ['D:\\Work\\App'])
  assert.deepEqual(model.trustFolders(model.readSettings({}), [], windows).trustedFolders, [])
  assert.deepEqual(model.readSettings(JSON.parse(JSON.stringify(model.trustFolders(model.readSettings({}), [], windows)))).trustedFolders, [])
})

test('a folder is trusted once, however it is spelled, and what is no folder is not kept', () => {
  let settings = model.trustFolders(model.readSettings({}), ['D:\\Work\\App'], windows)
  settings = model.trustFolders(settings, ['d:/work/app/', 'D:\\Work\\APP', ' D:\\Notes ', '', '   '], windows)
  assert.deepEqual(settings.trustedFolders, ['D:\\Work\\App', 'D:\\Notes'])
  assert.deepEqual(model.toPublic(settings).trustedFolders, ['D:\\Work\\App', 'D:\\Notes'])
  assert.ok(model.isTrusted(settings, 'd:/work/app', windows))
  assert.ok(model.isTrusted(settings, 'D:\\Notes\\', windows))
  // A folder inside a trusted one was not asked about, and neither was the one around it.
  assert.equal(model.isTrusted(settings, 'D:\\Work\\App\\sub', windows), false)
  assert.equal(model.isTrusted(settings, 'D:\\Work', windows), false)
  assert.equal(model.isTrusted(settings, '', windows), false)

  // Where the case of a name counts, two spellings are two folders.
  const posix = model.trustFolders(model.readSettings({}), ['/home/me/App', '/home/me/app', '/home/me/App/'], false)
  assert.deepEqual(posix.trustedFolders, ['/home/me/App', '/home/me/app'])
  assert.equal(model.isTrusted(posix, '/home/me/APP', false), false)
})

test('a workspace taken out of the app loses the yes it was given', () => {
  const settings = model.trustFolders(model.readSettings({ recentWorkspaces: ['D:\\Work\\App', 'D:\\Notes'] }), ['D:\\Work\\App', 'D:\\Notes'], windows)
  const gone = model.forgetWorkspace(settings, 'd:\\work\\app\\', windows)
  assert.deepEqual(gone.trustedFolders, ['D:\\Notes'])
  assert.deepEqual(gone.recentWorkspaces, ['D:\\Notes'])
  // The last one leaves an empty list, not none: the folders from before are not seen to a second time.
  assert.deepEqual(model.forgetWorkspace(gone, 'D:\\Notes', windows).trustedFolders, [])
  // In a file that has no list yet, there is still none afterwards.
  const old = model.readSettings({ recentWorkspaces: ['D:\\Work\\App'] })
  assert.equal('trustedFolders' in model.forgetWorkspace(old, 'D:\\Work\\App', windows), false)
})

test('what the file holds as the list is cleaned of what is no folder', () => {
  const read = model.readSettings({ trustedFolders: ['D:\\A', 5, null, '', '  ', { dir: 'x' }, 'D:\\B'] })
  assert.deepEqual(read.trustedFolders, ['D:\\A', 'D:\\B'])
  for (const odd of ['D:\\A', 5, null, {}]) assert.equal('trustedFolders' in model.readSettings({ trustedFolders: odd }), false, String(odd))
})
