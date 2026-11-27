// The pictures of a conversation, kept in files of their own beside it (B20 in KNOWN_ISSUES.md).
//
// A session file used to hold each picture as base64 text, and a turn writes the whole session at
// every step: a picture of 4 MB was written twice a step, some hundreds of megabytes over a long
// turn. Now a picture is written once, into `attachments/<session id>/<sha256>.<ext>` in the data
// folder, and the session file names it. In memory a session keeps the bytes as before, so the
// page and the request builders see no difference: they are read back when a session is loaded,
// and left out when it is written. A session written before this holds its pictures in itself
// until a turn of it runs again, which moves them out. The PDFs of a conversation are kept the same
// way, as `<sha256>.pdf`; "picture" below stands for them too.
//
// Nothing in this file depends on Electron.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ImageAttachment, PdfAttachment } from '../shared/attachments.ts'
import type { Session } from '../shared/types.ts'

/** What is kept in a file of its own beside its conversation: pictures, and PDFs, which are kept the same way. */
type Kept = ImageAttachment | PdfAttachment

const EXTENSIONS: Record<Kept['type'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' }

/** What a picture's file is called: the hash of its bytes, so that the same picture is kept once. A PDF's likewise. */
const FILE_NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp|pdf)$/

/** The folder of one session's pictures. Session ids arrive over IPC, so they are checked like their file names. */
export function picturesDir(root: string, sessionId: string): string {
  if (!/^[a-z0-9-]+$/i.test(sessionId)) throw new Error('Invalid session id')
  return path.join(root, sessionId)
}

/** The pictures and the PDFs of a session: what is kept in files of their own. */
function* picturesOf(session: Pick<Session, 'messages'>): Generator<Kept> {
  for (const message of session.messages) {
    if (message.role !== 'user') continue
    for (const file of message.attachments ?? []) if (file.kind === 'image' || file.kind === 'pdf') yield file
  }
}

/**
 * Writes each picture of the session that has no file of its own yet into the session's folder,
 * and names the file on the picture. The bytes stay in memory; `sessionText` leaves them out.
 */
export async function keepPictures(session: Pick<Session, 'id' | 'messages'>, root: string): Promise<void> {
  for (const picture of picturesOf(session)) {
    if (picture.file || !picture.data) continue
    const bytes = Buffer.from(picture.data, 'base64')
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${EXTENSIONS[picture.type] ?? 'png'}`
    const dir = picturesDir(root, session.id)
    const file = path.join(dir, name)
    if (!(await fs.stat(file).then(() => true, () => false))) {
      await fs.mkdir(dir, { recursive: true })
      // Written whole or not at all: a reader never finds half a picture under its name.
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(tmp, bytes)
      await fs.rename(tmp, file)
    }
    picture.file = name
  }
}

const keptPicture = (value: unknown): value is Kept =>
  typeof value === 'object' &&
  value !== null &&
  ((value as { kind?: unknown }).kind === 'image' || (value as { kind?: unknown }).kind === 'pdf') &&
  typeof (value as { file?: unknown }).file === 'string' &&
  FILE_NAME.test((value as { file: string }).file)

/** A session as its file holds it: a picture that has a file of its own is named there, and its bytes are left out. */
export function sessionText(session: Session): string {
  return JSON.stringify(
    session,
    (_key, value: unknown) => {
      if (!keptPicture(value)) return value
      const { data: _bytes, ...named } = value
      return named
    },
    2
  )
}

/**
 * Reads back the pictures a session's file names. A picture whose file is gone stays without its
 * bytes (`data` empty): the model is told of it in words, and nothing is sent for it.
 */
export async function fillPictures(session: Pick<Session, 'id' | 'messages'>, root: string): Promise<void> {
  for (const picture of picturesOf(session)) {
    if (picture.data || !picture.file) continue
    const bytes = FILE_NAME.test(picture.file) ? await fs.readFile(path.join(picturesDir(root, session.id), picture.file)).catch(() => null) : null
    picture.data = bytes ? bytes.toString('base64') : ''
  }
}

/** Takes away the pictures of a session that was deleted. */
export async function dropPictures(sessionId: string, root: string): Promise<void> {
  await fs.rm(picturesDir(root, sessionId), { recursive: true, force: true })
}
