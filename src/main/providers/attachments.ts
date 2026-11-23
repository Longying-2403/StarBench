// The pictures of a user message, as far as the request builders need them. (The text files of a
// message are part of its text: `userText` in history.ts.) See shared/attachments.ts for what an
// attachment is.

import type { ImageAttachment } from '../../shared/attachments.ts'
import type { ChatMessage } from '../../shared/types.ts'
import type { Connection, ModelRequest } from './types.ts'

type UserMessage = Extract<ChatMessage, { role: 'user' }>

/**
 * The pictures of a user message that go to the model as pictures. None where the model is known
 * to take none (`Connection.noImages`): it is then told of them in words (`userText`).
 */
export function userImages(message: UserMessage, connection: Pick<Connection, 'noImages'>): ImageAttachment[] {
  if (connection.noImages) return []
  return (message.attachments ?? []).filter((file): file is ImageAttachment => file.kind === 'image')
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
