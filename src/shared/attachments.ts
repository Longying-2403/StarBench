// The files a person puts with a message: pictures, which go to a model that can see, and text
// files, whose content is put in front of what was typed. Used by the main process, which reads
// and checks them, and by the page, which shows them.

/** The kinds of picture every model service that takes pictures takes. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]
export const isImageType = (value: unknown): value is ImageType => (IMAGE_TYPES as readonly unknown[]).includes(value)

/** A picture, as it is sent: its bytes in base64. */
export interface ImageAttachment {
  kind: 'image'
  name: string
  type: ImageType
  data: string
}

/** A text file, as it is sent: what it says. */
export interface TextAttachment {
  kind: 'text'
  name: string
  text: string
}

export type Attachment = ImageAttachment | TextAttachment

/** How many files one message may carry. */
export const MAX_ATTACHMENTS = 10
/**
 * The most a picture may weigh as it is sent, in bytes. The services draw the line in different
 * places; this is under the lowest of them (5 MB at Anthropic).
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** The longest side a picture is sent with, in pixels. A larger one is made smaller first: the services do the same, and count the tokens of the large one. */
export const MAX_IMAGE_SIDE = 2000
/** The largest picture file that is read at all, to be made smaller. */
export const MAX_IMAGE_FILE_BYTES = 30 * 1024 * 1024
/** The longest text file that is attached whole, in characters. A longer one is better read by the model with its tools, piece by piece. */
export const MAX_TEXT_CHARS = 200_000
/** The largest text file that is read at all, in bytes. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024

/**
 * A picture as the page was handed it, which may be of a kind or a size that is not sent as it is
 * (`fitImage` in the page makes it one that is).
 */
export interface RawImage {
  kind: 'image'
  name: string
  /** What the bytes are, such as `image/bmp`. */
  type: string
  data: string
}

/** Why a file was not attached. */
export type AttachmentProblem = 'too-large' | 'unsupported' | 'unreadable' | 'too-many'

/** What came of reading files to attach: those that can be, and of the others why not. */
export interface AttachmentsRead {
  files: (RawImage | TextAttachment)[]
  problems: { name: string; reason: AttachmentProblem }[]
}

/** How many bytes a base64 text stands for. */
export const base64Bytes = (data: string): number => Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

const text = (value: unknown, limit: number): string | null => (typeof value === 'string' && value.length <= limit ? value : null)

/** A name of a file as it is kept and shown: the last part of a path, on one line, of a length that can be shown. */
export function cleanFileName(name: unknown): string {
  const last = typeof name === 'string' ? (name.split(/[\\/]/).pop() ?? '') : ''
  return [...last.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()].slice(0, 120).join('') || 'file'
}

/**
 * The attachments of a message, out of what arrived from the page: each checked to be what it
 * says it is and within the limits, and none beyond the number a message may carry. Throws with
 * what is wrong, so that a message is not sent without a file the person meant to send.
 */
export function readAttachments(raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('The attachments of a message must be a list.')
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`A message can carry ${MAX_ATTACHMENTS} files at most.`)
  return raw.map((entry: unknown): Attachment => {
    const file = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
    const name = cleanFileName(file.name)
    if (file.kind === 'text') {
      const said = text(file.text, MAX_TEXT_CHARS)
      if (said === null) throw new Error(`"${name}" is too long to attach as text.`)
      return { kind: 'text', name, text: said }
    }
    if (file.kind === 'image' && isImageType(file.type)) {
      const data = typeof file.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(file.data) ? file.data : null
      if (data === null) throw new Error(`"${name}" is not a picture that can be sent.`)
      if (base64Bytes(data) > MAX_IMAGE_BYTES) throw new Error(`"${name}" is too large to send.`)
      return { kind: 'image', name, type: file.type, data }
    }
    throw new Error(`"${name}" is not a kind of file that can be attached.`)
  })
}

/** A text file as the model reads it: its content under its name. */
export function fileBlock(file: TextAttachment): string {
  // The name stands inside a tag: nothing in it may end the tag.
  const name = file.name.replace(/["<>]/g, '_')
  return `<attached-file name="${name}">\n${file.text}\n</attached-file>`
}

/**
 * What a model that takes no pictures is told of one, in its place: that there was one, and that
 * it cannot see it. Without a word of it, the person's "what is in this picture?" asks about nothing.
 */
export function imageNote(file: ImageAttachment): string {
  return `[The user attached the picture "${file.name.replace(/["\]]/g, '_')}". This model cannot be shown pictures, so it is not included.]`
}

/** A guess at what a picture weighs in a request, in tokens. The services count by its size in pixels; this is about what one of the largest size comes to. */
export const IMAGE_TOKENS = 1500
