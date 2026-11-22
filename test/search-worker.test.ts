// Run with: node --test test/search-worker.test.ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { ToolRegistry, registerBuiltinTools, searchInWorker } from '../src/main/tools.ts'

async function folder(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench search '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function searchIn(workspace: string): (args: Record<string, unknown>) => Promise<string> {
  const tools = new ToolRegistry()
  registerBuiltinTools(tools)
  return (args) => tools.execute('search', JSON.stringify(args), { workspace, signal: new AbortController().signal })
}

/** How often the main thread gets to run something else while `work` runs. */
async function ticksDuring(work: () => Promise<unknown>): Promise<number> {
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  try {
    await work()
  } finally {
    clearInterval(timer)
  }
  return ticks
}

test('the app keeps going while a search with a slow pattern runs', async (t) => {
  const dir = await folder(t)
  // Nested repetition against a line that almost matches: the time doubles with every letter.
  await writeFile(path.join(dir, 'slow.txt'), `${'a'.repeat(25)}!\n`)
  const search = searchIn(dir)
  let output = ''
  const ticks = await ticksDuring(async () => {
    output = await search({ pattern: '^(a+)+$' })
  })
  assert.equal(output, 'No matches')
  assert.ok(ticks >= 3, `the main thread ran ${ticks} times meanwhile`)
})

test('a search that would run for ever is stopped when its time is up', async (t) => {
  const dir = await folder(t)
  await writeFile(path.join(dir, 'slow.txt'), `${'a'.repeat(40)}!\n`)
  const started = Date.now()
  await assert.rejects(
    searchInWorker({ start: dir, directory: true, workspace: dir, pattern: '^(a+)+$', flags: '' }, new AbortController().signal, 300),
    /took longer than 0\.3 seconds/
  )
  assert.ok(Date.now() - started < 5000, 'stopped soon after its time was up')
})

test('a search ends with the turn', async (t) => {
  const dir = await folder(t)
  await writeFile(path.join(dir, 'slow.txt'), `${'a'.repeat(40)}!\n`)
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 100)
  assert.equal(await searchInWorker({ start: dir, directory: true, workspace: dir, pattern: '^(a+)+$', flags: '' }, stop.signal, 10_000), 'cancelled')
})

test('an ordinary search finds what it did before, and leaves out what it did before', async (t) => {
  const dir = await folder(t)
  await mkdir(path.join(dir, 'src'))
  await mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'a.ts'), 'const needle = 1\nother\n  needle again  \n')
  await writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'needle')
  await writeFile(path.join(dir, 'blob.bin'), Buffer.from('needle\u0000'))
  await writeFile(path.join(dir, 'many.txt'), 'hit\n'.repeat(250))
  const search = searchIn(dir)
  assert.equal(await search({ pattern: 'needle' }), 'src/a.ts:1: const needle = 1\nsrc/a.ts:3: needle again')
  assert.equal(await search({ pattern: 'NEEDLE', case_insensitive: true, path: 'src/a.ts' }), 'src/a.ts:1: const needle = 1\nsrc/a.ts:3: needle again')
  const many = await search({ pattern: '^hit$', path: 'many.txt' })
  assert.equal(many.split('\n').length, 201)
  assert.match(many, /… \[stopped at 200 matches\]$/)
  assert.match(await search({ pattern: '(' }), /^Error: Invalid regular expression/)
  assert.match(await search({ pattern: 'x', path: 'nowhere' }), /^Error: ENOENT/)
})
