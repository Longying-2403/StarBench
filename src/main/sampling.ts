// The sampling settings plugins add to model requests: temperature, top_p and the like.
// Nothing in this file depends on Electron or the plugin kernel.

import type { ProviderKind } from '../shared/types.ts'

/** The model a request is about to go to. */
export interface SamplingTarget {
  /** Id of the configured provider. */
  provider: string
  kind: ProviderKind
  baseURL: string
  /** Whether that address is on this computer or the network around it: a model server the person runs themselves. */
  local: boolean
  model: string
}

/**
 * Request fields under the names the service knows them by, such as `{ temperature: 0.7, top_p: 0.9 }`.
 * Services differ in what they take beyond those two. A field a server does not know is, as a
 * rule, ignored by it, and now and then refused.
 */
export type SamplingParams = Record<string, unknown>

/** Asked before every request, so it answers at once. Returns nothing to leave the request as it is. */
export type SamplingSource = (target: SamplingTarget) => SamplingParams | null | undefined

/**
 * The parts of a request that are the app's own: what is said, to which model, with which tools,
 * and how the answer comes back. `n` is among them because the app reads one answer, and several
 * would arrive mixed into each other. A sampling source cannot set any of these.
 */
export const RESERVED: ReadonlySet<string> = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'n', 'reasoning_effort'])

/** Everything that wants a say in how the model picks its words, whoever provided it. */
export class SamplingRegistry {
  private sources: { ask: SamplingSource; owner: string }[] = []

  /** Adds a source and returns the function that removes it again. `owner` names it in error messages. */
  register(ask: SamplingSource, owner: string): () => void {
    if (typeof ask !== 'function') throw new Error('A sampling source must be a function')
    const entry = { ask, owner }
    this.sources.push(entry)
    return () => {
      const at = this.sources.indexOf(entry)
      if (at >= 0) this.sources.splice(at, 1)
    }
  }

  /**
   * The fields to add to a request for `target`. Sources are asked in the order they were added,
   * and where two set the same field the later one wins. A source that throws is left out: a
   * plugin's mistake must not stop the conversation.
   */
  paramsFor(target: SamplingTarget): SamplingParams {
    const out: SamplingParams = {}
    for (const { ask, owner } of this.sources) {
      let params: unknown
      try {
        params = ask({ ...target })
      } catch (err) {
        console.error(`[sampling] ${owner} failed: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (typeof params !== 'object' || params === null || Array.isArray(params)) continue
      if (typeof (params as { then?: unknown }).then === 'function') {
        console.error(`[sampling] ${owner} returned a promise; a sampling source has to answer at once`)
        continue
      }
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && !RESERVED.has(key)) out[key] = value
      }
    }
    return out
  }
}
