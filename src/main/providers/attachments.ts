// The pictures and the PDFs of a user message, as far as the request builders need them. (The text
// files of a message are part of its text: `userText` in history.ts.) See shared/attachments.ts for
// what an attachment is.

import { pageTokens, pdfTokens } from '../../shared/attachments.ts'
import type { ImageAttachment, PdfAttachment, PdfWithheld } from '../../shared/attachments.ts'
import type { ChatMessage } from '../../shared/types.ts'
import type { Connection, ModelRequest } from './types.ts'

type UserMessage = Extract<ChatMessage, { role: 'user' }>

/**
 * The pictures of a user message that go to the model as pictures. None where the model is known
 * to take none (`Connection.noImages`): it is then told of them in words (`userText`).
 */
export function userImages(message: UserMessage, connection: Pick<Connection, 'noImages'>): ImageAttachment[] {
  if (connection.noImages) return []
  // A picture whose file is no longer kept has nothing to send; `userText` says so instead.
  return (message.attachments ?? []).filter((file): file is ImageAttachment => file.kind === 'image' && file.data !== '')
}

/** A picture as an address that holds it whole, the form two of the three formats take pictures in. */
export const imageUrl = (image: ImageAttachment): string => `data:${image.type};base64,${image.data}`

/** Whether a request sends any picture. */
export function carriesImages(request: Pick<ModelRequest, 'messages' | 'connection'>): boolean {
  return request.messages.some((message) => message.role === 'user' && userImages(message, request.connection).length > 0)
}

/**
 * Thrown, before anything of a reply arrived, when the service will not take the pictures of a
 * request: the model cannot see, or the server was not set up for it. The message is what the
 * service said. The request can be made again with the pictures told in words instead; see
 * `Connection.noImages`.
 */
export class ImagesRefused extends Error {}

/**
 * Whether an error is a service turning a request down for the pictures in it. Every service
 * words it its own way: "unknown variant `image_url`, expected `text`" (DeepSeek), "image input
 * is not supported" (llama.cpp without a projector), "does not support vision", "this model is
 * not multimodal". Only asked about a request that did carry pictures, and only of an error that
 * says the request itself was at fault: not a wrong key, and not a limit that was reached.
 */
export function refusesImages(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { status, message } = err as { status?: unknown; message?: unknown }
  if (typeof status !== 'number' || status < 400 || status >= 500 || [401, 403, 404, 408, 429].includes(status)) return false
  return typeof message === 'string' && /image|vision|multi-?modal|unknown variant/i.test(message)
}

/** What of a connection decides whether a PDF goes to the model as it is. */
export type PdfReach = Partial<Pick<Connection, 'pdfs' | 'noDocuments' | 'pdfRoom' | 'kind'>>

/**
 * Why a PDF does not go to the model as it is, or undefined where it does. It goes only while its
 * copy is kept, to a service that reads PDFs (`Connection.pdfs`) whose model has not turned them
 * down in this conversation (`noDocuments`), and while it fits the model's context
 * (`Connection.pdfRoom`). That last is judged only by pages the PDF tells: a guess by its size could
 * hold back one that fits. Any other is told of in words, with where it lies (`userText`).
 */
export function pdfWithheld(file: PdfAttachment, connection?: PdfReach): PdfWithheld | undefined {
  if (file.data === '') return 'gone'
  if (!connection?.pdfs || connection.noDocuments) return 'unread'
  if (connection.pdfRoom !== undefined && file.pages !== undefined && pdfTokens(file, pageTokens(connection.kind)) > connection.pdfRoom) return 'long'
  return undefined
}

/** Whether a PDF goes to the model as it is (`pdfWithheld`). */
export const sendsPdf = (file: PdfAttachment, connection?: PdfReach): boolean => pdfWithheld(file, connection) === undefined

/** The PDFs of a user message that go to the model as they are (`sendsPdf`). */
export function userDocuments(message: UserMessage, connection: PdfReach): PdfAttachment[] {
  return (message.attachments ?? []).filter((file): file is PdfAttachment => file.kind === 'pdf' && sendsPdf(file, connection))
}

/** A PDF as an address that holds it whole, the form OpenAI's two formats take a file in. */
export const pdfUrl = (pdf: PdfAttachment): string => `data:application/pdf;base64,${pdf.data}`

/** Whether a request sends any PDF as it is. */
export function carriesDocuments(request: Pick<ModelRequest, 'messages' | 'connection'>): boolean {
  return request.messages.some((message) => message.role === 'user' && userDocuments(message, request.connection).length > 0)
}

/**
 * Thrown, before anything of a reply arrived, when the service will not take the PDFs of a request:
 * the model reads none, a PDF has more pages than it takes, or the request grew too large with them.
 * The message is what the service said. The request can be made again with the PDFs told of by
 * where they lie instead; see `Connection.noDocuments`.
 */
export class DocumentsRefused extends Error {}

/** How services word a refusal of a request's PDFs, as far as it is told from other refusals. */
const ABOUT_DOCUMENTS =
  /pdf|\bdocuments?\b|input_file|file_data|unknown variant [`'"]?(?:file|input_file|document)|mime|request[ _]too[ _]large|request entity too large|payload size/i

/**
 * Whether an error is a service turning a request down for its PDFs: "A maximum of 100 PDF pages
 * may be provided" (Anthropic), "Unsupported MIME type: application/pdf" (Gemini), a request too
 * large (413, or Gemini's "Request payload size exceeds the limit"), a part the service does not
 * know. Only asked about a request that did carry PDFs, and only of an error that says the request
 * itself was at fault: not a wrong key, and not a limit of use that was reached.
 */
export function refusesDocuments(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { status, message } = err as { status?: unknown; message?: unknown }
  if (typeof status !== 'number' || status < 400 || status >= 500 || [401, 403, 404, 408, 429].includes(status)) return false
  return status === 413 || (typeof message === 'string' && ABOUT_DOCUMENTS.test(message))
}
