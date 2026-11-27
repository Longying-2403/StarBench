// Run with: node --test test/session-files.test.ts
//
// The pictures of a conversation are kept in files of their own beside it (src/main/session-files.ts):
// written once, named in the session's file, read back when the session is loaded. A session file
// written at every step of a turn then holds no picture bytes.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { userImages } from '../src/main/providers/attachments.ts'
import { userText } from '../src/main/providers/history.ts'
import { dropPictures, fillPictures, keepPictures, picturesDir, sessionText } from '../src/main/session-files.ts'
import type { Session } from '../src/shared/types.ts'

// The smallest PNG there is: one transparent pixel.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function root(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench pictures '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const session = (): Session => ({
  id: 'abc-123',
  title: 'pictures',
  workspace: 'D:\\w',
  updatedAt: 1,
  messages: [
    {
      role: 'user',
      content: 'two of the same picture, and a file',
      attachments: [
        { kind: 'image', name: 'a.png', type: 'image/png', data: PIXEL },
        { kind: 'image', name: 'b.png', type: 'image/png', data: PIXEL },
        { kind: 'text', name: 'notes.txt', text: 'hello' }
      ]
    },
    { role: 'assistant', content: 'I see a pixel.' }
  ]
})

test('a picture is written once into a file of its own, and the session file names it', async (t) => {
  const dir = await root(t)
  const live = session()
  await keepPictures(live, dir)
  const files = await readdir(picturesDir(dir, live.id))
  // The same picture twice is one file.
  assert.equal(files.length, 1)
  assert.match(files[0], /^[0-9a-f]{64}\.png$/)
  // In memory the bytes stay, for the requests and the page.
  const pictures = live.messages[0].role === 'user' ? live.messages[0].attachments! : []
  assert.equal(pictures[0].kind === 'image' && pictures[0].data, PIXEL)
  // In the file: the name of the picture's file, and no bytes.
  const text = sessionText(live)
  assert.ok(!text.includes(PIXEL), 'no picture bytes in the session file')
  const saved = JSON.parse(text) as Session
  const kept = saved.messages[0].role === 'user' ? saved.messages[0].attachments! : []
  assert.deepEqual(kept[0], { kind: 'image', name: 'a.png', type: 'image/png', file: files[0] })
  assert.deepEqual(kept[2], { kind: 'text', name: 'notes.txt', text: 'hello' })
  // Kept again, nothing is written again.
  const before = (await stat(path.join(picturesDir(dir, live.id), files[0]))).mtimeMs
  await keepPictures(live, dir)
  assert.equal((await stat(path.join(picturesDir(dir, live.id), files[0]))).mtimeMs, before)

  // Loaded, the session has its pictures back.
  await fillPictures(saved, dir)
  assert.deepEqual(saved.messages[0], live.messages[0])
})

test('a session written before keeps its pictures in itself until they are moved out', () => {
  const old = session()
  assert.ok(sessionText(old).includes(PIXEL))
})

test('a picture whose file is gone is told of in words, and nothing is sent for it', async (t) => {
  const dir = await root(t)
  const live = session()
  await keepPictures(live, dir)
  const saved = JSON.parse(sessionText(live)) as Session
  await dropPictures(live.id, dir)
  await assert.rejects(readdir(picturesDir(dir, live.id)))
  await fillPictures(saved, dir)
  const message = saved.messages[0]
  assert.equal(message.role, 'user')
  if (message.role !== 'user') return
  assert.deepEqual(userImages(message, {}), [])
  assert.match(userText(message), /\[The user attached the picture "a\.png" here\. Its file is no longer kept, so it is not included\.\]/)
  assert.match(userText(message), /<attached-file name="notes\.txt">/)
})

test('a PDF is kept the way a picture is: once, in a file of its own that the session file names', async (t) => {
  const dir = await root(t)
  const data = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n').toString('base64')
  const pdf = { kind: 'pdf' as const, name: 'plan.pdf', type: 'application/pdf' as const, data, size: 44, path: 'D:\\in\\plan.pdf', pages: 1 }
  const kept: Session = { id: 'pdf-1', title: 'pdf', workspace: 'D:\\w', updatedAt: 1, messages: [{ role: 'user', content: 'read it', attachments: [pdf, { ...pdf, name: 'again.pdf' }] }] }
  await keepPictures(kept, dir)
  const files = await readdir(picturesDir(dir, kept.id))
  assert.equal(files.length, 1)
  assert.match(files[0], /^[0-9a-f]{64}\.pdf$/)
  const text = sessionText(kept)
  assert.ok(!text.includes(data))
  const back = JSON.parse(text) as Session
  const named = back.messages[0].role === 'user' ? back.messages[0].attachments ?? [] : []
  assert.deepEqual(
    named.map((a) => [a.kind, (a as { file?: string }).file, (a as { data?: string }).data]),
    [
      ['pdf', files[0], undefined],
      ['pdf', files[0], undefined]
    ]
  )
  await fillPictures(back, dir)
  assert.equal(back.messages[0].role === 'user' ? (back.messages[0].attachments?.[0] as { data: string }).data : null, data)

  // Its file gone, it is told of to the model by where it lay, to one that reads PDFs as well.
  await rm(path.join(picturesDir(dir, kept.id), files[0]))
  const again = JSON.parse(text) as Session
  await fillPictures(again, dir)
  const message = again.messages[0]
  assert.ok(message.role === 'user')
  assert.match(userText(message, { pdfs: true }), /"plan\.pdf" \(44 B\)\. The copy of this PDF kept with the conversation is gone[\s\S]*Its path, as a JSON string: "D:\\\\in\\\\plan\.pdf"/)
  await dropPictures(kept.id, dir)
  await assert.rejects(stat(picturesDir(dir, kept.id)))
})

test('a session id that is no plain name makes no folder', () => {
  assert.throws(() => picturesDir('C:\\data', '..\\other'), /Invalid session id/)
  assert.throws(() => picturesDir('C:\\data', 'a/b'), /Invalid session id/)
})
