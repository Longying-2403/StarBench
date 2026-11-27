// Reading the files a person puts with a message, and judging what each is sent as: a picture, a
// text, or a file whose place is told (any other, and a text or a picture too large to send).
// Files picked in the system dialog are read from the disk; files dropped on the message box or
// pasted into it arrive as their bytes, with where they lie. A file larger than any picture that is
// read whole is read only as far as it takes to tell what it is. Nothing in this file depends on
// Electron.

import { promises as fs } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { HEAD_BYTES, MAX_ATTACHMENTS, MAX_IMAGE_FILE_BYTES, MAX_PDF_BYTES, MAX_TEXT_CHARS, MAX_TEXT_FILE_BYTES, cleanFileName, cleanPath } from '../shared/attachments.ts'
import type { AttachmentProblem, AttachmentsRead, FileAttachment, PdfAttachment, RawImage, TextAttachment } from '../shared/attachments.ts'
import { decodeOutput } from './decode.ts'

const starts = (data: Uint8Array, bytes: readonly number[], at = 0): boolean => bytes.every((byte, i) => data[at + i] === byte)
const ascii = (word: string): number[] => [...word].map((c) => c.charCodeAt(0))

/**
 * What kind of picture some bytes are, told by how they begin and not by the name of the file: a
 * pasted picture has no name worth going by, and a name can say anything. The page turns the
 * kinds no model service takes (BMP, AVIF) into one they do. Undefined for what is no picture
 * the page can draw.
 */
export function imageTypeOf(data: Uint8Array): string | undefined {
  if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(data, ascii('GIF87a')) || starts(data, ascii('GIF89a'))) return 'image/gif'
  if (starts(data, ascii('RIFF')) && starts(data, ascii('WEBP'), 8)) return 'image/webp'
  // After the two letters come the size of the file and four bytes that are always zero.
  if (starts(data, ascii('BM')) && starts(data, [0, 0, 0, 0], 6)) return 'image/bmp'
  if (starts(data, ascii('ftypavif'), 4) || starts(data, ascii('ftypavis'), 4)) return 'image/avif'
  return undefined
}

/**
 * Whether some bytes are a PDF. Its mark (`%PDF-`) stands at its start, or, as the format allows,
 * somewhere in its first 1,024 bytes after something else, where the file then ends as a PDF does
 * (`%%EOF`). Only the beginning is looked at in a file read only at its beginning.
 */
export function isPdf(data: Uint8Array, whole = true): boolean {
  const at = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 1024)).toString('latin1').indexOf('%PDF-')
  if (at === 0) return true
  if (at < 0 || !whole) return false
  const end = data.subarray(Math.max(0, data.byteLength - 1024))
  return Buffer.from(end.buffer, end.byteOffset, end.byteLength).toString('latin1').includes('%%EOF')
}

/**
 * How much of a PDF's packed object streams is unpacked to find its pages: of one stream, of all of
 * them together, and how many streams. Enough for the page tree of any PDF that is sent, and little
 * enough that a stream made to unpack into gigabytes costs a moment and no memory to speak of.
 */
const STREAM_OUT = 4 * 1024 * 1024
const STREAMS_OUT = 16 * 1024 * 1024
const MAX_STREAMS = 200
/**
 * How long the pages of a PDF are looked for, in milliseconds. It is done in the main process, which
 * the page waits on meanwhile; a PDF made to take long is left at what was found of its page tree by then.
 */
const PAGES_MS = 300

/** What the objects of a PDF say of its pages: the count of its page tree, the count of its linearization, and the page objects found. */
interface PagesSaid {
  tree: number
  linearized: number
  objects: number
}

/** Takes in what one object's dictionary says of the pages. */
function readPages(dictionary: string, said: PagesSaid): void {
  if (/\/Type\s*\/Pages(?![A-Za-z])/.test(dictionary)) {
    // Each node of the page tree counts the pages under it: the root's count is the largest.
    const count = /\/Count\s+(\d+)/.exec(dictionary)
    if (count) said.tree = Math.max(said.tree, Number(count[1]))
  } else if (/\/Type\s*\/Page(?![A-Za-z])/.test(dictionary)) said.objects++
  if (/\/Linearized(?![A-Za-z])/.test(dictionary)) {
    const pages = /\/N\s+(\d+)/.exec(dictionary)
    if (pages) said.linearized = Number(pages[1])
  }
}

/**
 * How many pages a PDF has, as far as its bytes tell: the count of its page tree's root, else the
 * count a linearized PDF gives at its start, else its page objects counted. Objects packed into
 * streams (PDF 1.5 and later, as most programs write them now) are unpacked to be read, within
 * limits (`STREAM_OUT`); a stream that cannot be unpacked is passed over. Undefined where nothing
 * says (an encrypted PDF, one packed in another way); the size is then the guess (`pdfTokens`).
 * Looked for no longer than `budget` milliseconds: cut short, only a count the PDF gives for the
 * whole is taken, since the page objects counted by then are too few.
 */
export function pageCount(data: Uint8Array, budget = PAGES_MS): number | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  // Byte for character, so that a place in the text is the same place in the bytes.
  const text = bytes.toString('latin1')
  const said: PagesSaid = { tree: 0, linearized: 0, objects: 0 }
  const until = Date.now() + budget
  let looked = 0
  /** Whether the time is up, asked every so many objects; once it is, it stays up. */
  let late = false
  const timeUp = (): boolean => (late ||= ++looked % 256 === 0 && Date.now() > until)
  let streams = 0
  let unpacked = 0
  // The objects are found by looking ahead and never back, so that no file, however it is made,
  // costs more than a few looks at each of its bytes: the keyword `obj`, after a blank, with the
  // object's two numbers just before it, then the `endobj` after it.
  for (let from = 0; !late; ) {
    const begin = text.indexOf('obj', from)
    if (begin < 0) break
    from = begin + 3
    if (!/\s/.test(text[begin - 1] ?? '') || /[A-Za-z]/.test(text[begin + 3] ?? '') || !/\d+\s+\d+\s+$/.test(text.slice(Math.max(0, begin - 24), begin))) continue
    const close = text.indexOf('endobj', from)
    // No object is finished after this one: there are no more to read.
    if (close < 0) break
    if (timeUp()) break
    const at = from
    const body = text.slice(at, close)
    from = close + 6
    const opened = />>\s*stream(?:\r\n|\n|\r)/.exec(body)
    const dictionary = opened ? body.slice(0, opened.index + 2) : body
    readPages(dictionary, said)
    if (!opened || !/\/Type\s*\/ObjStm(?![A-Za-z])/.test(dictionary) || !/\/FlateDecode(?![A-Za-z])/.test(dictionary)) continue
    if (streams >= MAX_STREAMS || unpacked >= STREAMS_OUT) continue
    streams++
    const room = Math.min(STREAM_OUT, STREAMS_OUT - unpacked)
    const end = body.lastIndexOf('endstream')
    let inner: string
    try {
      const out = inflateSync(bytes.subarray(at + opened.index + opened[0].length, at + (end > 0 ? end : body.length)), { maxOutputLength: room })
      unpacked += out.length
      inner = out.toString('latin1')
    } catch {
      // Damaged, or larger than there is room for: what it cost counts against the room all the same.
      unpacked += room
      continue
    }
    // The stream begins with the number and the place of each object in it, the objects from `/First` on.
    const first = Number(/\/First\s+(\d+)/.exec(dictionary)?.[1] ?? NaN)
    if (!Number.isSafeInteger(first) || first > inner.length) continue
    const places = inner.slice(0, first).trim().split(/\s+/).map(Number).filter((_, i) => i % 2 === 1)
    // Each object is read from where the one before it ended, so that no part of the stream is read
    // twice: places that go back, or stand still, are no object of a stream that was written right.
    let read = 0
    for (let i = 0; i < places.length && !timeUp(); i++) {
      const place = places[i]
      const next = Math.min(i + 1 < places.length ? places[i + 1] : inner.length - first, inner.length - first)
      if (!Number.isSafeInteger(place) || place < read || !(next > place)) continue
      readPages(inner.slice(first + place, first + next), said)
      read = next
    }
  }
  // Cut short by the time, the page objects counted so far are too few to go by: only a count the PDF gives for the whole is.
  const pages = late ? said.tree || said.linearized : said.tree || said.linearized || said.objects
  return pages > 0 ? pages : undefined
}

/** How much of a text is looked at to tell whether it is one. */
const LOOKED_AT = HEAD_BYTES

/**
 * What some bytes say, when they are a text: UTF-8, UTF-16 with its mark, or the code page of
 * this computer, which is what older programs on Windows write. Null for what is no text: bytes
 * that decode into characters no text is made of.
 */
export function textOf(data: Uint8Array): string | null {
  let text: string
  if (starts(data, [0xff, 0xfe])) text = new TextDecoder('utf-16le').decode(data.subarray(2))
  else if (starts(data, [0xfe, 0xff])) text = new TextDecoder('utf-16be').decode(data.subarray(2))
  else {
    // No text in the other encodings holds a zero byte, and next to every other kind of file does.
    if (data.includes(0)) return null
    text = decodeOutput(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).replace(/^﻿/, '')
  }
  const looked = Math.min(text.length, LOOKED_AT)
  let odd = 0
  for (let i = 0; i < looked; i++) {
    const code = text.charCodeAt(i)
    // Control characters other than the ones texts have (tab, line ends, form feed, escape), and the mark of what could not be decoded.
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 27) || code === 0xfffd) odd++
  }
  return looked > 0 && odd / looked > 0.02 ? null : text
}

/**
 * What a file is attached as. `data` is the whole file, or only its beginning when `size` says it
 * is larger; `path` is where it lies, already checked (`cleanPath`). Any file can be attached: one
 * that is neither a picture nor a text, or is one too large to send, goes as a file whose place is
 * told, and the model reads it with its tools if it can. A PDF goes as it is, to the services that
 * read PDFs, up to its own size (`MAX_PDF_BYTES`).
 */
export function judge(name: string, data: Uint8Array, size = data.byteLength, path = ''): RawImage | TextAttachment | FileAttachment | PdfAttachment {
  const clean = cleanFileName(name)
  const whole = data.byteLength >= size
  const file = (tooLarge?: FileAttachment['tooLarge']): FileAttachment => ({ kind: 'file', name: clean, size, path, ...(tooLarge ? { tooLarge } : {}) })
  const base64 = (): string => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
  const type = imageTypeOf(data)
  if (type) {
    if (!whole || size > MAX_IMAGE_FILE_BYTES) return file('image')
    return { kind: 'image', name: clean, type, data: base64(), ...(path ? { path } : {}) }
  }
  if (isPdf(data, whole)) {
    if (!whole || size > MAX_PDF_BYTES) return file('pdf')
    const pages = pageCount(data)
    return { kind: 'pdf', name: clean, type: 'application/pdf', data: base64(), size, path, ...(pages ? { pages } : {}) }
  }
  // Told from its beginning, so that a large file that is no text is not called a text too large to send.
  const text = textOf(!whole || size > MAX_TEXT_FILE_BYTES ? data.subarray(0, LOOKED_AT) : data)
  if (text === null) return file()
  if (!whole || size > MAX_TEXT_FILE_BYTES || text.length > MAX_TEXT_CHARS) return file('text')
  return { kind: 'text', name: clean, text }
}

/** A file dropped on the message box or pasted into it, as the page hands it over. */
export interface GivenFile {
  name: string
  /** The whole file, or only its beginning when it is larger than any picture that is read whole. */
  data: Uint8Array
  /** How large the file is, as the page says; taken where it is a size at all, and no less than the bytes that came. */
  size?: unknown
  /** Where it lies, as the page says; checked here (`cleanPath`). */
  path?: unknown
}

/** Judges files that arrived as their bytes. Beyond the number a message may carry, they are left out and said to be too many. */
export function attachData(given: readonly GivenFile[]): AttachmentsRead {
  const read: AttachmentsRead = { files: [], problems: [] }
  for (const { name, data, size, path } of given) {
    if (read.files.length >= MAX_ATTACHMENTS) {
      read.problems.push({ name: cleanFileName(name), reason: 'too-many' })
      continue
    }
    const told = typeof size === 'number' && Number.isSafeInteger(size) && size >= data.byteLength ? size : data.byteLength
    read.files.push(judge(name, data, told, cleanPath(path)))
  }
  return read
}

/** The first bytes of a file, enough to tell what it is, without reading the rest. */
async function headOf(file: string): Promise<Uint8Array> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Reads files from the disk and judges them. A file larger than any picture that is read whole is read only at its beginning. */
export async function attachFiles(paths: readonly string[]): Promise<AttachmentsRead> {
  const read: AttachmentsRead = { files: [], problems: [] }
  for (const file of paths) {
    const name = cleanFileName(file)
    const fail = (reason: AttachmentProblem): number => read.problems.push({ name, reason })
    if (read.files.length >= MAX_ATTACHMENTS) {
      fail('too-many')
      continue
    }
    try {
      const stat = await fs.stat(file)
      if (stat.isDirectory()) fail('folder')
      else if (!stat.isFile()) fail('unsupported')
      else read.files.push(judge(name, stat.size > MAX_IMAGE_FILE_BYTES ? await headOf(file) : await fs.readFile(file), stat.size, cleanPath(file)))
    } catch {
      fail('unreadable')
    }
  }
  return read
}
