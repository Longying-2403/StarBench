import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readJson, writeJson } from '../src/main/json-file.ts'

test('writes succeed while the file is being read', async () => {
  // On Windows, replacing a file that another handle has open fails with EPERM.
  // The session list is read while a turn is saving, so this happens in normal use.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench-json-'))
  const file = path.join(dir, 'session.json')
  await writeJson(file, { n: -1, padding: 'x'.repeat(200_000) })

  let reading = true
  const readers = Array.from({ length: 4 }, async () => {
    while (reading) await readJson(file)
  })
  try {
    for (let n = 0; n < 150; n++) await writeJson(file, { n, padding: 'x'.repeat(200_000) })
  } finally {
    // Without this a failed write would leave the readers spinning and hang the test run.
    reading = false
    await Promise.all(readers)
  }

  assert.equal((await readJson<{ n: number }>(file))?.n, 149)
  assert.deepEqual(await readdir(dir), ['session.json'], 'no temp files are left behind')
})

test('concurrent writers of one file do not trip over each other', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench-json-'))
  const file = path.join(dir, 'state.json')
  await Promise.all(Array.from({ length: 20 }, (_, n) => writeJson(file, { n })))
  const final = await readJson<{ n: number }>(file)
  assert.ok(final !== null && final.n >= 0 && final.n < 20)
  assert.deepEqual(await readdir(dir), ['state.json'])
})

test('readJson returns null for a missing or broken file', async () => {
  assert.equal(await readJson(path.join(os.tmpdir(), 'starbench-no-such-file.json')), null)
})
