// A turn that ended in an error, as its conversation keeps it. The reason a turn failed (the
// service refused the request, the reply was cut short, a sign-in was over) was once only on the
// page that watched the turn: going to another conversation and back, the message was there with
// no answer and nothing to say why. So the reason is written down with the conversation, and is
// shown at the end of the turn it ended, whenever the conversation is opened.
//
// It is kept beside the messages, not among them: no model is ever sent it.

import type { ErrorHint } from './types.ts'
import { cutAt } from './well-formed.ts'

/** A turn that ended in an error. */
export interface TurnFailure {
  /** How many messages of the person the conversation held by then: the turn it is shown at the end of. */
  turn: number
  /** When, in milliseconds since 1970. */
  at: number
  /** What went wrong, in the words of whoever said so: the service, or the app. */
  message: string
  /** Set for an error that is shown with a way out instead of as plain text. */
  hint?: ErrorHint
  /** Whose request it was, for those: which of the model services, by its id. */
  provider?: string
}

/** How many of them a conversation keeps: the oldest give way. */
export const FAILURES_KEPT = 50
/** A reason longer than this is cut: a service can answer with a whole page. */
export const FAILURE_TEXT_MAX = 4000

const HINTS: readonly ErrorHint[] = ['chatgpt-usage', 'chatgpt-sign-in']

/** What is written down of an error that ended a turn. */
export function failureOf(error: { message: string; hint?: ErrorHint; provider?: string }, turn: number, at: number): TurnFailure {
  return {
    turn,
    at,
    message: cutAt(error.message, FAILURE_TEXT_MAX),
    ...(error.hint ? { hint: error.hint, ...(error.provider ? { provider: error.provider } : {}) } : {})
  }
}

/** The failures of a conversation with one more, the oldest dropped where there are too many. */
export function withFailure(failures: readonly TurnFailure[] | undefined, failure: TurnFailure): TurnFailure[] {
  return [...(failures ?? []), failure].slice(-FAILURES_KEPT)
}

/** The failures a conversation's file holds, each as the app writes it; what does not read like one is left out. */
export function readFailures(value: unknown): TurnFailure[] {
  const failures: TurnFailure[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    const told = typeof entry === 'object' && entry !== null ? (entry as Partial<TurnFailure>) : null
    if (!told || typeof told.message !== 'string' || !told.message || typeof told.at !== 'number' || typeof told.turn !== 'number' || !Number.isFinite(told.turn) || told.turn < 0) continue
    const hint = HINTS.find((known) => known === told.hint)
    failures.push({
      turn: Math.floor(told.turn),
      at: told.at,
      message: cutAt(told.message, FAILURE_TEXT_MAX),
      ...(hint ? { hint, ...(typeof told.provider === 'string' && told.provider ? { provider: told.provider } : {}) } : {})
    })
  }
  return failures.slice(-FAILURES_KEPT)
}
