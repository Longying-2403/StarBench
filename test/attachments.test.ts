// The files a person puts with a message: how they are read and judged, how each provider's
// format carries them, and what happens with a model that takes no pictures.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runTurn } from '../src/main/agent.ts'
import { attachData, attachFiles, imageTypeOf, judge, textOf } from '../src/main/attachments.ts'
import { sendable } from '../src/main/compaction.ts'
import { messageWeight } from '../src/main/meter.ts'
import { anthropicParams } from '../src/main/providers/anthropic.ts'
import { ImagesRefused, carriesImages, refusesImages, userImages } from '../src/main/providers/attachments.ts'
import { chatMessages } from '../src/main/providers/chat.ts'
import { userText } from '../src/main/providers/history.ts'
import type { Connection } from '../src/main/providers/index.ts'
import { responsesInput } from '../src/main/providers/responses.ts'
import { ToolRegistry } from '../src/main/tools.ts'
import { withoutPictures } from '../src/main/trace.ts'
import { IMAGE_TOKENS, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_CHARS, MAX_TEXT_FILE_BYTES, base64Bytes, cleanFileName, readAttachments } from '../src/shared/attachments.ts'
import type { Attachment } from '../src/shared/attachments.ts'
import { estimateTokens } from '../src/shared/stats.ts'
import type { AgentEvent, ChatMessage, StoredMessage } from '../src/shared/types.ts'

/** The smallest PNG there is: one see-through pixel. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const png = (name = 'shot.png'): Attachment => ({ kind: 'image', name, type: 'image/png', data: PNG.toString('base64') })
const note = (name = 'notes.md', text = '# Notes\nline two'): Attachment => ({ kind: 'text', name, text })

const connection = (kind: Connection['kind'], more: Partial<Connection> = {}): Connection => ({
  provider: 'p',
  kind,
  apiKey: 'k',
  baseURL: kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://example.test/v1',
  model: 'm',
  reasoningEffort: 'default',
  ...more
})

test('a picture is told by how its bytes begin, whatever the file is called', () => {
  assert.equal(imageTypeOf(PNG), 'image/png')
  assert.equal(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'image/jpeg')
  assert.equal(imageTypeOf(Buffer.from('GIF89a....')), 'image/gif')
  assert.equal(imageTypeOf(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp')
  assert.equal(imageTypeOf(Buffer.from('BM\x36\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00', 'latin1')), 'image/bmp')
  assert.equal(imageTypeOf(Buffer.from('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00', 'latin1')), 'image/avif')
  // A text that happens to begin with the two letters of a bitmap is a text.
  assert.equal(imageTypeOf(Buffer.from('BMW and other cars')), undefined)
  assert.equal(imageTypeOf(Buffer.from('%PDF-1.7')), undefined)

  const judged = judge('C:\\somewhere\\called.txt', PNG)
  assert.deepEqual(judged, { kind: 'image', name: 'called.txt', type: 'image/png', data: PNG.toString('base64') })
})

test('a text is read in the encoding it is in, and what is no text is not taken for one', () => {
  assert.equal(textOf(Buffer.from('plain 文字 ✓')), 'plain 文字 ✓')
  // The mark at the start of a file is not part of what it says.
  assert.equal(textOf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('with a mark')])), 'with a mark')
  assert.equal(textOf(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('sixteen 位', 'utf16le')])), 'sixteen 位')
  assert.equal(textOf(Buffer.from('')), '')
  // A zero byte, or a run of control characters: a program, an archive, a document of an office suite.
  assert.equal(textOf(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08])), null)
  assert.equal(textOf(Buffer.from(Array.from({ length: 400 }, (_, i) => 1 + (i % 8)))), null)

  assert.deepEqual(judge('a.md', Buffer.from('# Title')), { kind: 'text', name: 'a.md', text: '# Title' })
  assert.equal(judge('a.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), 'unsupported')
  // Too long to go whole: said as that, and not as a kind of file that cannot be attached.
  assert.equal(judge('long.log', Buffer.from('x'.repeat(MAX_TEXT_FILE_BYTES + 1))), 'too-large')
  assert.equal(judge('wide.txt', Buffer.from('字'.repeat(MAX_TEXT_CHARS + 1))), 'too-large')
  // And a large file that is no text is still said to be no kind that can be attached.
  assert.equal(judge('big.bin', Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.alloc(MAX_TEXT_FILE_BYTES)])), 'unsupported')
})

test('files are read from the disk or taken as their bytes, and no more of them than a message carries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'starbench-attach-'))
  await writeFile(path.join(dir, 'a.txt'), 'hello')
  await writeFile(path.join(dir, 'p.png'), PNG)
  const read = await attachFiles([path.join(dir, 'a.txt'), path.join(dir, 'p.png'), path.join(dir, 'missing.txt'), dir])
  assert.deepEqual(
    read.files.map((f) => [f.kind, f.name]),
    [
      ['text', 'a.txt'],
      ['image', 'p.png']
    ]
  )
  assert.deepEqual(read.problems, [
    { name: 'missing.txt', reason: 'unreadable' },
    { name: path.basename(dir), reason: 'unsupported' }
  ])

  const many = attachData(Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from(`file ${i}`) })))
  assert.equal(many.files.length, MAX_ATTACHMENTS)
  assert.deepEqual(many.problems.map((p) => p.reason), ['too-many', 'too-many'])
})

test('what arrives from the page as the attachments of a message is checked', () => {
  assert.deepEqual(readAttachments(undefined), [])
  assert.deepEqual(readAttachments([png('C:\\x\\a.png'), note()]), [png('a.png'), note()])
  // What a message keeps of a file is what it is made of, and nothing else that came along.
  assert.deepEqual(readAttachments([{ ...note(), text: 'x', extra: 1 }]), [{ kind: 'text', name: 'notes.md', text: 'x' }])
  assert.throws(() => readAttachments('nope'), /must be a list/)
  assert.throws(() => readAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => note())), /at most/)
  assert.throws(() => readAttachments([{ kind: 'image', name: 'a.svg', type: 'image/svg+xml', data: 'AAAA' }]), /not a kind of file/)
  assert.throws(() => readAttachments([{ kind: 'image', name: 'a.png', type: 'image/png', data: 'not base64!' }]), /not a picture/)
  assert.throws(() => readAttachments([{ kind: 'image', name: 'a.png', type: 'image/png', data: 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) }]), /too large/)
  assert.throws(() => readAttachments([{ kind: 'text', name: 'a.txt', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }]), /too long/)
  assert.throws(() => readAttachments([{ kind: 'video', name: 'a.mp4' }]), /not a kind of file/)

  assert.equal(base64Bytes(PNG.toString('base64')), PNG.length)
  assert.equal(cleanFileName('C:\\Users\\someone\\Desktop\\a\tb.txt'), 'a b.txt')
  assert.equal(cleanFileName('/home/someone/notes.md'), 'notes.md')
  assert.equal(cleanFileName(''), 'file')
  assert.equal(cleanFileName(42), 'file')
})

test('the text of a message: the text files in front, then the skill, then what was typed', () => {
  const plain: ChatMessage = { role: 'user', content: 'hi' }
  assert.equal(userText(plain), 'hi')
  // As it was before there were attachments, to the letter: a conversation kept from then reads the same.
  assert.equal(userText({ role: 'user', content: 'hi', skill: { name: 's', prompt: 'SKILL' } }), 'SKILL\n\nhi')

  const withFile: ChatMessage = { role: 'user', content: 'sum it up', skill: { name: 's', prompt: 'SKILL' }, attachments: [note('a "b".md', 'one\ntwo'), png()] }
  assert.equal(userText(withFile), '<attached-file name="a _b_.md">\none\ntwo\n</attached-file>\n\nSKILL\n\nsum it up')
  // Files and no words.
  assert.equal(userText({ role: 'user', content: '', attachments: [note('a.md', 'x')] }), '<attached-file name="a.md">\nx\n</attached-file>')
  assert.equal(userText({ role: 'user', content: '', attachments: [png()] }), '')

  // A model that takes no pictures is told that there was one.
  const blind = userText({ role: 'user', content: 'what is this?', attachments: [png('cat.png')] }, { noImages: true })
  assert.match(blind, /^\[The user attached the picture "cat\.png"\. This model cannot be shown pictures/)
  assert.ok(blind.endsWith('\n\nwhat is this?'))
  assert.deepEqual(userImages({ role: 'user', content: '', attachments: [png(), note()] }, {}), [png()])
  assert.deepEqual(userImages({ role: 'user', content: '', attachments: [png()] }, { noImages: true }), [])
})

test("each format carries pictures its own way, and a text file's content as text", () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'look', attachments: [note('n.txt', 'N'), png('one.png')] }]
  const url = `data:image/png;base64,${PNG.toString('base64')}`
  const text = '<attached-file name="n.txt">\nN\n</attached-file>\n\nlook'

  const chat = chatMessages({ messages, connection: connection('openai-chat'), system: 's' })
  assert.deepEqual(chat[1], { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url } }] })

  const responses = responsesInput({ messages, connection: connection('openai-responses') })
  assert.deepEqual(responses, [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: url, detail: 'auto' }] }])

  const base = { messages, system: 's', tools: [], signal: new AbortController().signal, onText: () => {}, onReasoning: () => {} }
  const claude = anthropicParams({ ...base, connection: connection('anthropic') }, null)
  assert.deepEqual(claude.messages, [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
        { type: 'text', text }
      ]
    }
  ])

  // A picture and no words: no empty part of text beside it.
  const bare: ChatMessage[] = [{ role: 'user', content: '', attachments: [png()] }]
  assert.deepEqual(chatMessages({ messages: bare, connection: connection('openai-chat'), system: 's' })[1].content, [{ type: 'image_url', image_url: { url } }])
  assert.deepEqual((responsesInput({ messages: bare, connection: connection('openai-responses') })[0] as { content: unknown[] }).content, [{ type: 'input_image', image_url: url, detail: 'auto' }])
  assert.equal((anthropicParams({ ...base, messages: bare, connection: connection('anthropic') }, null).messages[0].content as unknown[]).length, 1)

  // Without pictures a message is the plain text it always was.
  const plain: ChatMessage[] = [{ role: 'user', content: 'read', attachments: [note('n.txt', 'N')] }]
  const said = '<attached-file name="n.txt">\nN\n</attached-file>\n\nread'
  assert.equal(chatMessages({ messages: plain, connection: connection('openai-chat'), system: 's' })[1].content, said)
  assert.deepEqual(responsesInput({ messages: plain, connection: connection('openai-responses') }), [{ role: 'user', content: said }])
  assert.equal(anthropicParams({ ...base, messages: plain, connection: connection('anthropic') }, null).messages[0].content, said)

  // To a model that takes none, every format sends the words about the picture and no picture.
  for (const kind of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
    const blind = connection(kind, { noImages: true })
    assert.equal(carriesImages({ messages, connection: blind }), false)
    const sent = JSON.stringify(
      kind === 'openai-chat' ? chatMessages({ messages, connection: blind, system: 's' }) : kind === 'openai-responses' ? responsesInput({ messages, connection: blind }) : anthropicParams({ ...base, connection: blind }, null).messages
    )
    assert.ok(!sent.includes(PNG.toString('base64')), kind)
    assert.match(sent, /The user attached the picture \\"one\.png\\"/, kind)
  }
  assert.equal(carriesImages({ messages, connection: connection('openai-chat') }), true)
  assert.equal(carriesImages({ messages: plain, connection: connection('openai-chat') }), false)
})

test('two user messages in a row go out as one in chat completions, with their pictures', () => {
  const url = `data:image/png;base64,${PNG.toString('base64')}`
  const messages: ChatMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second', attachments: [png()] },
    { role: 'user', content: 'third' }
  ]
  const out = chatMessages({ messages, connection: connection('openai-chat'), system: 's' })
  assert.equal(out.length, 2)
  assert.deepEqual(out[1].content, [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
    { type: 'image_url', image_url: { url } },
    { type: 'text', text: 'third' }
  ])
  // And without any picture as the one text it always was.
  const plain = chatMessages({ messages: [messages[0], messages[2]], connection: connection('openai-chat'), system: 's' })
  assert.equal(plain[1].content, 'first\n\nthird')
})

test('a summary that goes into the message after it leaves that message its pictures', () => {
  const stored: StoredMessage[] = [
    { role: 'user', content: 'old' },
    { role: 'compaction', at: 1, before: 10, after: 5, summary: { text: 'T', sent: 'SUMMARY', covers: 1, said: 0, files: 0 } },
    { role: 'user', content: 'now', attachments: [note('n.txt', 'N'), png()] }
  ]
  const [first] = sendable(stored)
  assert.deepEqual(first, { role: 'user', content: 'SUMMARY\n\n<attached-file name="n.txt">\nN\n</attached-file>\n\nnow', attachments: [png()] })
  // The text file is in the text by now, once: the builders do not put it there again.
  assert.equal(userText(first as Extract<ChatMessage, { role: 'user' }>), first.content)
})

test('files count towards what a message weighs, and a picture about the same whatever it shows', () => {
  const typed = estimateTokens('hi')
  assert.equal(messageWeight({ role: 'user', content: 'hi', attachments: [png(), png()] }).said, typed + 2 * IMAGE_TOKENS)
  assert.equal(messageWeight({ role: 'user', content: 'hi', attachments: [note('a.txt', 'x'.repeat(400))] }).said, typed + 100)
})

test('an error is taken for a refusal of pictures only when it says the request was at fault and speaks of pictures', () => {
  const error = (status: number | undefined, message: string): unknown => Object.assign(new Error(message), status === undefined ? {} : { status })
  assert.ok(refusesImages(error(400, 'Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text`')))
  assert.ok(refusesImages(error(400, 'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj')))
  assert.ok(refusesImages(error(422, 'This model does not support vision.')))
  assert.ok(refusesImages(error(400, 'this model is not multimodal')))
  // A wrong key, a limit, a server at fault, a line that broke: none of them is about the pictures.
  assert.equal(refusesImages(error(401, 'Invalid API key for image model')), false)
  assert.equal(refusesImages(error(429, 'Rate limit reached for images')), false)
  assert.equal(refusesImages(error(500, 'image worker crashed')), false)
  assert.equal(refusesImages(error(undefined, 'image upload: connection reset')), false)
  assert.equal(refusesImages(error(400, 'max_tokens is too large')), false)
  assert.equal(refusesImages('image'), false)
})

test('a record of a request leaves the pictures out and keeps everything else', () => {
  const data = 'A'.repeat(4000)
  const body = {
    model: 'm',
    encrypted_content: 'B'.repeat(4000),
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] },
      { role: 'user', content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${data}` }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] },
      { role: 'user', content: 'x', attachments: [{ kind: 'image', name: 'a.png', type: 'image/png', data }, { kind: 'text', name: 'a.txt', text: 'C'.repeat(4000) }] }
    ]
  }
  const kept = withoutPictures(body) as typeof body
  const text = JSON.stringify(kept)
  assert.ok(!text.includes(data))
  assert.equal(text.match(/4000 characters of picture data, left out of this record/g)?.length, 5)
  // What kind of picture it was still shows.
  assert.match(text, /data:image\/png;base64,\[4000 characters/)
  // Long things that are no pictures are all there, and the original is as it was.
  assert.equal(kept.encrypted_content, body.encrypted_content)
  assert.equal(kept.messages[4].attachments?.[1].text, 'C'.repeat(4000))
  assert.equal((body.messages[2].content as { source: { data: string } }[])[0].source.data, data)
  // A small picture is not worth leaving out, and what is not a plain value passes through.
  assert.deepEqual(withoutPictures({ kind: 'image', data: 'AAAA' }), { kind: 'image', data: 'AAAA' })
  assert.deepEqual(withoutPictures([1, 'a', null, undefined, true]), [1, 'a', null, undefined, true])
})

/** A chat-completions server that answers each request as scripted: with a stream, or with a refusal. */
async function fakeModel(scripts: (string[] | { status: number; message: string })[]) {
  const requests: { messages: Record<string, any>[] }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const script = scripts[requests.length - 1] ?? []
      if (!Array.isArray(script)) {
        res.writeHead(script.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: script.message, type: 'invalid_request_error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of script) res.write(part)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { requests, baseURL, close: () => new Promise((resolve) => server.close(resolve)) }
}
const chunk = (delta: object): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`

test('a model that turns pictures down gets the message again with the pictures told in words, and the person is told', async () => {
  const refusal = 'Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text`'
  const model = await fakeModel([{ status: 400, message: refusal }, [chunk({ content: 'I cannot see it.' })], [chunk({ content: 'Still not.' })]])
  const events: AgentEvent[] = []
  let learned = 0
  const messages: ChatMessage[] = [{ role: 'user', content: 'what is this?', attachments: [png('cat.png')] }]
  const turn = (connection: Connection) =>
    runTurn({
      connection,
      workspace: os.tmpdir(),
      messages,
      signal: new AbortController().signal,
      tools: new ToolRegistry(),
      alwaysAllowed: new Set(),
      emit: (e) => events.push(e),
      checkpoint: () => {},
      onImagesRefused: () => learned++,
      requestPermission: async () => 'allow'
    })
  const reached: Connection = { provider: 'test', kind: 'openai-chat', apiKey: 'test', baseURL: model.baseURL, model: 'fake', reasoningEffort: 'default' }
  try {
    await turn(reached)
    assert.equal(model.requests.length, 2)
    // First with the picture, as a part of the message.
    assert.equal(model.requests[0].messages[1].content[1].type, 'image_url')
    // Then as text alone, which says that there was a picture.
    assert.equal(typeof model.requests[1].messages[1].content, 'string')
    assert.match(model.requests[1].messages[1].content, /attached the picture "cat\.png"[\s\S]*what is this\?$/)
    assert.equal(learned, 1)
    const notice = events.find((e) => e.type === 'notice')
    assert.deepEqual(notice && notice.type === 'notice' ? [notice.code, notice.detail] : null, ['images-refused', `400 ${refusal}`])
    assert.equal(events.filter((e) => e.type === 'error').length, 0)
    assert.equal(messages.at(-1)?.content, 'I cannot see it.')
    // The picture stays with the conversation: a model that can see is sent it.
    assert.deepEqual(messages[0].role === 'user' ? messages[0].attachments : null, [png('cat.png')])

    // The next turn starts that way, told by whoever keeps what was learned: nothing is refused first.
    messages.push({ role: 'user', content: 'and now?' })
    await turn({ ...reached, noImages: true })
    assert.equal(model.requests.length, 3)
    assert.ok(!JSON.stringify(model.requests[2]).includes('image_url'))
    assert.equal(learned, 1)
  } finally {
    await model.close()
  }
})

test('an error that is not about the pictures is shown as it is, also for a message with a picture', async () => {
  const model = await fakeModel([{ status: 400, message: 'max_tokens is too large' }])
  const events: AgentEvent[] = []
  const messages: ChatMessage[] = [{ role: 'user', content: 'look', attachments: [png()] }]
  try {
    await runTurn({
      connection: { provider: 'test', kind: 'openai-chat', apiKey: 'test', baseURL: model.baseURL, model: 'fake', reasoningEffort: 'default' },
      workspace: os.tmpdir(),
      messages,
      signal: new AbortController().signal,
      tools: new ToolRegistry(),
      alwaysAllowed: new Set(),
      emit: (e) => events.push(e),
      checkpoint: () => {},
      requestPermission: async () => 'allow'
    })
    assert.equal(model.requests.length, 1)
    assert.equal(events.filter((e) => e.type === 'notice').length, 0)
    const error = events.find((e) => e.type === 'error')
    assert.match(error && error.type === 'error' ? error.message : '', /max_tokens is too large/)
  } finally {
    await model.close()
  }
  assert.ok(new ImagesRefused('x') instanceof Error)
})
