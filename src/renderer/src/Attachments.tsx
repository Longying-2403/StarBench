// The files a person puts with a message, in the page: how they are shown, in the message box
// and in the conversation, and how a picture is made one that can be sent.

import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, base64Bytes, isImageType } from '../../shared/attachments.ts'
import type { Attachment, AttachmentProblem, AttachmentsRead, ImageAttachment, ImageType, RawImage } from '../../shared/attachments.ts'
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
 * texts as they are, the pictures made fit to send. The rest is told with the reason.
 */
export async function attachable(read: AttachmentsRead, room: number): Promise<{ files: Attachment[]; problems: AttachmentsRead['problems'] }> {
  const files: Attachment[] = []
  const problems = [...read.problems]
  for (const file of read.files) {
    if (files.length >= room) {
      problems.push({ name: file.name, reason: 'too-many' })
      continue
    }
    if (file.kind === 'text') {
      files.push(file)
      continue
    }
    const fitted = await fitImage(file)
    if (fitted) files.push(fitted)
    else problems.push({ name: file.name, reason: 'unsupported' })
  }
  return { files, problems }
}

const PROBLEMS: Record<AttachmentProblem, string> = {
  'too-large': '文件太大',
  unsupported: '不支持这种文件，目前可以添加图片和文本文件',
  unreadable: '读取不了',
  'too-many': `一条消息最多带 ${MAX_ATTACHMENTS} 个文件`
}

/** Why files were not attached, as one line for each. */
export const problemsText = (problems: AttachmentsRead['problems']): string => problems.map((p) => `${p.name}：${PROBLEMS[p.reason]}`).join('\n')

/**
 * The files of a message in a row: a picture as itself, small; a text file by its name. With
 * `onRemove` each has a way to take it off again, as in the message box before it is sent.
 */
export function AttachmentRow({ files, onRemove, sent }: { files: readonly Attachment[]; onRemove?: (index: number) => void; sent?: boolean }) {
  if (files.length === 0) return null
  return (
    <div className={`attach-row${sent ? ' attach-row-sent' : ''}`}>
      {files.map((file, index) => (
        <span key={index} className={`attach attach-${file.kind}`} title={file.name}>
          {file.kind === 'image' ? (
            <img src={imageSrc(file)} alt={file.name} draggable={false} />
          ) : (
            <>
              <FileIcon />
              <span className="attach-name">{file.name}</span>
            </>
          )}
          {onRemove && (
            <button type="button" className="attach-remove" onClick={() => onRemove(index)} aria-label={`移除 ${file.name}`} title="移除">
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  )
}
