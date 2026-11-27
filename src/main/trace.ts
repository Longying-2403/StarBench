// A record of what passes between the app and a model: each request as it was sent, the reply
// as it came, what it cost and how long it took. Kept for whoever watches (a plugin that shows
// it, for telling why a model behaves as it does) and for nobody else: while no one watches,
// nothing is copied and nothing more is asked of the service.
// Nothing in this file depends on Electron or the plugin kernel.

import type { Exchange } from '../../types/starbench-plugin'
import { isLocalAddress } from '../shared/types.ts'
import type { Connection, ModelReply, ModelRequest } from './providers/types.ts'

export type { Exchange }

/**
 * What an adapter reports of a request while it handles it. On a request while the app keeps
 * count of what conversations cost (meter.ts), or a plugin watches (below), or both.
 */
export interface WireProbe {
  /**
   * The body of the request as it is about to go out, and the headers the adapter adds to it of
   * its own accord, if any: never the one that carries the key. Called for every attempt: a
   * request may be sent again another way.
   */
  sent(body: unknown, headers?: Readonly<Record<string, string>>): void
  /** What the service says the reply cost, in its own shape. */
  usage(usage: unknown): void
  /** Why the service says the reply ended, in its own word. */
  finished(reason: string): void
  /**
   * A piece of a reply that comes in pieces has arrived: text, thinking, or part of a tool call.
   * The first call is the one that counts. Never called for a reply that came whole.
   */
  arrived(): void
}

/** An exchange as the agent loop knows it; the conversation and the number are added by who passes it on. */
export type ExchangeDraft = Omit<Exchange, 'id' | 'conversation'>

/** Follows one request from before it is sent to after its reply, and makes the record of it. */
export interface ExchangeWatch {
  /** The request with the watching put in: its pieces are counted on their way to where they were going. */
  over(request: ModelRequest): ModelRequest
  done(reply: ModelReply): ExchangeDraft
  failed(err: unknown): ExchangeDraft
}

/** From how long on the data of a picture is left out of a record. Nothing that short is one worth leaving out. */
const PICTURE_FROM = 512
const leftOut = (characters: number, what = 'picture'): string => `[${characters} characters of ${what} data, left out of this record]`
/** Whether a part of a request, or an attachment, is a PDF and not a picture: by the kind of its data, each format its own way. */
const isPdfPart = (part: Record<string, unknown>): boolean => part.kind === 'pdf' || part.media_type === 'application/pdf' || part.mimeType === 'application/pdf'

/**
 * A copy of what a request holds, for the record, without the pictures the person attached: one
 * of them is megabytes of letters that tell a reader nothing, and the record goes to the page.
 * A picture is known by where it stands: an address that holds one (`data:image/…;base64,`), or
 * the `data` of a part that is marked as a picture, each format in its own way. Everything else
 * is copied as it is, long as it may be.
 */
export function withoutPictures(value: unknown): unknown {
  if (typeof value === 'string') {
    // A PDF goes as such an address too (`file_data` in OpenAI's formats).
    const kind = value.length > PICTURE_FROM ? /^data:(?:(image)\/[\w.+-]+|application\/(pdf));base64,/i.exec(value) : null
    const comma = kind ? value.indexOf(',') : -1
    return comma < 0 ? value : `${value.slice(0, comma + 1)}${leftOut(value.length - comma - 1, kind?.[2] ? 'PDF' : 'picture')}`
  }
  if (Array.isArray(value)) return value.map(withoutPictures)
  if (typeof value !== 'object' || value === null) return value
  const proto: unknown = Object.getPrototypeOf(value)
  // What is no plain object is copied the way everything was before.
  if (proto !== Object.prototype && proto !== null) return structuredClone(value)
  const part = value as Record<string, unknown>
  const picture = part.kind === 'image' || part.kind === 'pdf' || part.type === 'base64' || typeof part.media_type === 'string' || typeof part.mimeType === 'string'
  const what = isPdfPart(part) ? 'PDF' : 'picture'
  return Object.fromEntries(
    Object.entries(part).map(([key, held]) => [key, picture && key === 'data' && typeof held === 'string' && held.length > PICTURE_FROM ? leftOut(held.length, what) : withoutPictures(held)])
  )
}

/** Starts to follow a request that is about to go to `connection`. */
export function watchExchange(connection: Connection): ExchangeWatch {
  const at = Date.now()
  let first: number | undefined
  let pieces = 0
  let attempts = 0
  let wire: unknown
  /** The headers the adapter said it added to the request that `wire` is the body of. */
  let added: Record<string, string> | undefined
  let usage: unknown
  let finish: string | undefined
  /** What was asked, in the app's own terms, for a service whose adapter does not say what it sent. */
  let asked: unknown
  const piece = (): void => {
    pieces++
  }
  const probe: WireProbe = {
    sent(body, headers) {
      attempts++
      // A copy: the body is made of the conversation itself, and who reads the record must not be able to change that.
      wire = withoutPictures(body)
      // Those of this attempt, and none left over from the one before.
      added = headers && Object.keys(headers).length > 0 ? { ...headers } : undefined
    },
    usage(told) {
      if (told !== undefined && told !== null) usage = structuredClone(told)
    },
    finished(reason) {
      finish = reason
    },
    // When the first piece of a streamed reply came, be it text, thinking or part of a tool call.
    // A reply that came whole has no such moment, and by that the two are told apart: the pieces
    // counted above are only those of text and thinking, and a reply that is one tool call has none.
    arrived() {
      first ??= Date.now() - at
    }
  }
  const record = (rest: Pick<ExchangeDraft, 'reply' | 'error'> & { stopped?: string }): ExchangeDraft => ({
    at,
    provider: { id: connection.provider, name: connection.providerName ?? connection.provider, kind: connection.kind, local: isLocalAddress(connection.baseURL) },
    model: connection.model,
    request: wire !== undefined ? { wire: true, body: wire, ...(added ? { headers: added } : {}) } : { wire: false, body: asked },
    attempts: Math.max(1, attempts),
    reply: rest.reply,
    ...(finish !== undefined ? { finish } : {}),
    ...(rest.stopped !== undefined ? { stopped: rest.stopped } : {}),
    ...(usage !== undefined ? { usage } : {}),
    timing: { ...(first !== undefined ? { first } : {}), total: Date.now() - at },
    pieces,
    ...(rest.error !== undefined ? { error: rest.error } : {})
  })
  return {
    over(request) {
      asked = withoutPictures({ system: request.system, messages: request.messages, tools: request.tools.map((t) => t.name), ...(request.sampling ? { sampling: request.sampling } : {}) })
      return {
        ...request,
        probe,
        onText: (delta) => (piece(), request.onText(delta)),
        onReasoning: (delta) => (piece(), request.onReasoning(delta))
      }
    },
    done: ({ message, stopped }) =>
      record({
        reply: {
          text: message.content,
          reasoning: message.reasoning_content ?? '',
          toolCalls: (message.tool_calls ?? []).map((call) => ({ name: call.name, arguments: call.arguments }))
        },
        ...(stopped !== undefined ? { stopped } : {})
      }),
    failed: (err) => record({ reply: { text: '', reasoning: '', toolCalls: [] }, error: err instanceof Error ? err.message : String(err) })
  }
}

export type ExchangeObserver = (exchange: Exchange) => void

/** Everyone who watches what passes between the app and the models. */
export class TraceRegistry {
  private observers: { see: ExchangeObserver; owner: string }[] = []
  private count = 0

  /** Whether anyone watches. While nobody does, the agent loop makes no records at all. */
  get active(): boolean {
    return this.observers.length > 0
  }

  /** Has `see` told of every exchange from now on, and returns the function that stops it. `owner` names it in error messages. */
  observe(see: ExchangeObserver, owner: string): () => void {
    if (typeof see !== 'function') throw new Error('An observer must be a function')
    const entry = { see, owner }
    this.observers.push(entry)
    return () => {
      const at = this.observers.indexOf(entry)
      if (at >= 0) this.observers.splice(at, 1)
    }
  }

  /**
   * Tells every watcher of an exchange. Each gets a copy of its own, so that one cannot change
   * what the next one sees, and one that throws does not keep the others from seeing it.
   */
  emit(draft: ExchangeDraft, conversation: string): void {
    if (this.observers.length === 0) return
    const exchange: Exchange = { id: ++this.count, conversation, ...draft }
    for (const { see, owner } of [...this.observers]) {
      try {
        see(structuredClone(exchange))
      } catch (err) {
        console.error(`[trace] ${owner} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
