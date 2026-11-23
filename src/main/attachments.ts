// Reading the files a person puts with a message, and judging what each can be sent as: a
// picture, a text, or nothing. Files picked in the system dialog are read from the disk; files
// dropped on the message box or pasted into it arrive as their bytes. Nothing in this file
// depends on Electron.

import { promises as fs } from 'node:fs'
import { MAX_ATTACHMENTS, MAX_IMAGE_FILE_BYTES, MAX_TEXT_CHARS, MAX_TEXT_FILE_BYTES, cleanFileName } from '../shared/attachments.ts'
import type { AttachmentProblem, AttachmentsRead, RawImage, TextAttachment } from '../shared/attachments.ts'
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

/** How much of a text is looked at to tell whether it is one. */
const LOOKED_AT = 8000

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

/** What a file can be attached as, or why it cannot. */
export function judge(name: string, data: Uint8Array): RawImage | TextAttachment | AttachmentProblem {
  const clean = cleanFileName(name)
  const type = imageTypeOf(data)
  if (type) {
    if (data.byteLength > MAX_IMAGE_FILE_BYTES) return 'too-large'
    return { kind: 'image', name: clean, type, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') }
  }
  // Told from its beginning, so that a large file that is no text is not called too large.
  const text = textOf(data.byteLength > MAX_TEXT_FILE_BYTES ? data.subarray(0, LOOKED_AT) : data)
  if (text === null) return 'unsupported'
  if (data.byteLength > MAX_TEXT_FILE_BYTES || text.length > MAX_TEXT_CHARS) return 'too-large'
  return { kind: 'text', name: clean, text }
}

/** Judges files that arrived as their bytes. Beyond the number a message may carry, they are left out and said to be too many. */
export function attachData(given: readonly { name: string; data: Uint8Array }[]): AttachmentsRead {
  const read: AttachmentsRead = { files: [], problems: [] }
  for (const { name, data } of given) {
    const judged = read.files.length >= MAX_ATTACHMENTS ? 'too-many' : judge(name, data)
    if (typeof judged === 'string') read.problems.push({ name: cleanFileName(name), reason: judged })
    else read.files.push(judged)
  }
  return read
}

/** Reads files from the disk and judges them. A file too large to be anything that is sent is not read at all. */
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
      if (!stat.isFile()) fail('unsupported')
      else if (stat.size > MAX_IMAGE_FILE_BYTES) fail('too-large')
      else {
        const judged = judge(name, await fs.readFile(file))
        if (typeof judged === 'string') fail(judged)
        else read.files.push(judged)
      }
    } catch {
      fail('unreadable')
    }
  }
  return read
}
