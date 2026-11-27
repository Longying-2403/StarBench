// The files a person puts with a message, in the page: how they are shown, in the message box
// and in the conversation, and how a picture is made one that can be sent.

import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_SIDE, MAX_PDF_BYTES, MAX_TEXT_CHARS, MAX_TEXT_FILE_BYTES, base64Bytes, isImageType, sizeText } from '../../shared/attachments.ts'
import type { Attachment, AttachmentProblem, AttachmentsRead, FileAttachment, ImageAttachment, ImageType, PdfAttachment, RawImage } from '../../shared/attachments.ts'
import { FileIcon } from './icons.tsx'

/** A picture as an address the page can draw. */
const imageSrc = (image: { type: string; data: string }): string => `data:${image.type};base64,${image.data}`

/** The picture, read by the browser, or null when it cannot read it. */
async function drawn(raw: RawImage): Promise<HTMLImageElement | null> {
  const img = new Image()
  img.src = imageSrc(raw)
  try {
    await img.decode()
  } catch {
    return null
  }
  return img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null
}

/**
 * Makes a picture one that can be sent: of a kind the model services take, no longer on its
 * longer side than they look at, and no heavier than they take. A picture that is all of that
 * goes as it is, byte for byte. Any other is drawn anew, smaller where it has to be: as a JPEG
 * when it was one, and else as a PNG, which keeps what is see-through. Null when the browser
 * cannot read the picture, or it cannot be made small enough.
 */
export async function fitImage(raw: RawImage): Promise<ImageAttachment | null> {
  const img = await drawn(raw)
  if (!img) return null
  const { naturalWidth: width, naturalHeight: height } = img
  const longer = Math.max(width, height)
  if (isImageType(raw.type) && longer <= MAX_IMAGE_SIDE && base64Bytes(raw.data) <= MAX_IMAGE_BYTES) {
    return { kind: 'image', name: raw.name, type: raw.type, data: raw.data }
  }
  const type: ImageType = raw.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  let scale = Math.min(1, MAX_IMAGE_SIDE / longer)
  for (let tries = 0; tries < 6; tries++) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(img, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL(type, 0.9)
    const data = url.slice(url.indexOf(',') + 1)
    if (data && base64Bytes(data) <= MAX_IMAGE_BYTES) return { kind: 'image', name: raw.name, type, data }
    // Still too heavy: smaller again.
    scale *= 0.7
  }
  return null
}

/**
 * What of the files that were read can go with a message that has room for `room` more: the
 * texts and the files whose place is told as they are, the pictures made fit to send. A picture
 * that cannot be made so still goes, as a file whose place is told. Beyond the room, each is told
 * with the reason.
 */
export async function attachable(read: AttachmentsRead, room: number): Promise<{ files: Attachment[]; problems: AttachmentsRead['problems'] }> {
  const files: Attachment[] = []
  const problems = [...read.problems]
  for (const file of read.files) {
    if (files.length >= room) {
      problems.push({ name: file.name, reason: 'too-many' })
      continue
    }
    if (file.kind !== 'image') {
      files.push(file)
      continue
    }
    files.push((await fitImage(file)) ?? { kind: 'file', name: file.name, size: base64Bytes(file.data), path: file.path ?? '' })
  }
  return { files, problems }
}

const PROBLEMS: Record<AttachmentProblem, string> = {
  folder: '是文件夹，目前只能添加文件',
  unsupported: '不是普通的文件',
  unreadable: '读取不了',
  'too-many': `一条消息最多带 ${MAX_ATTACHMENTS} 个文件`
}

/** Why files were not attached, as one line for each. */
export const problemsText = (problems: AttachmentsRead['problems']): string => problems.map((p) => `${p.name}：${PROBLEMS[p.reason]}`).join('\n')

const MB = 1024 * 1024

/** What becomes of a file whose content does not go with the message, in a few words. */
const toldOf = (file: FileAttachment): string => (file.path ? '内容不发送，只告诉模型文件的位置' : '内容不发送，应用也不知道文件在哪里，模型读不到它')

/** The files too large for their content to go with a message, one line for each: how large, past which limit, and what goes instead. */
export const largeText = (files: readonly FileAttachment[]): string =>
  files
    .map((file) => {
      const limit =
        file.tooLarge === 'image'
          ? `超过 ${MAX_IMAGE_FILE_BYTES / MB} MB`
          : file.tooLarge === 'pdf'
            ? `超过 ${MAX_PDF_BYTES / MB} MB`
            : file.size > MAX_TEXT_FILE_BYTES
              ? `超过 ${MAX_TEXT_FILE_BYTES / MB} MB`
              : `超过 ${MAX_TEXT_CHARS / 10_000} 万个字符`
      return `${file.name}（${sizeText(file.size)}）${limit}，${toldOf(file)}`
    })
    .join('\n')

/** What a PDF's chip says when pointed at: how large it is, its pages where known, and which models read it as it is. */
const pdfTip = (file: PdfAttachment): string =>
  `${file.name} · ${sizeText(file.size)}${file.pages ? ` · ${file.pages} 页` : ''} · Claude、Gemini、GPT 的官方接口直接读，其他模型只收到文件的位置`

/**
 * The files of a message in a row: a picture as itself, small; any other file by its name, which
 * for a PDF, and for a file whose content does not go, says what becomes of it when pointed at.
 * With `onRemove` each has a way to take it off again, as in the message box before it is sent.
 */
export function AttachmentRow({ files, onRemove, sent }: { files: readonly Attachment[]; onRemove?: (index: number) => void; sent?: boolean }) {
  if (files.length === 0) return null
  return (
    <div className={`attach-row${sent ? ' attach-row-sent' : ''}`}>
      {files.map((file, index) => (
        <span
          key={index}
          // A PDF and a file whose place is told look like a text file: a name to read, not a picture to look at.
          className={`attach attach-${file.kind === 'file' || file.kind === 'pdf' ? `text attach-${file.kind}` : file.kind}`}
          data-tip={
            file.kind === 'file' ? `${file.name} · ${sizeText(file.size)} · ${file.tooLarge ? '文件过大，' : ''}${toldOf(file)}` : file.kind === 'pdf' ? pdfTip(file) : file.name
          }
        >
          {file.kind === 'image' ? (
            <img src={imageSrc(file)} alt={file.name} draggable={false} />
          ) : (
            <>
              <FileIcon />
              <span className="attach-name">{file.name}</span>
            </>
          )}
          {onRemove && (
            <button type="button" className="attach-remove" onClick={() => onRemove(index)} aria-label={`移除 ${file.name}`} data-tip="移除">
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  )
}
