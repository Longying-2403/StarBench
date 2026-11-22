// Keeping a conversation within the room a model has for it ("compaction"): what the person can
// set about it, and from how many tokens on the app acts by itself. The work is done in
// main/compaction.ts; here is what the page and the main process both have to know.

/** What the person can set about compaction. */
export interface CompactionSettings {
  /** Whether a conversation is compacted by itself as it fills the model's context. */
  auto: boolean
  /** From which share of the model's context on, from 0 to 1. */
  share: number
  /**
   * A number of tokens from which on it is compacted whatever the model's context holds: for a
   * model with so much room that a conversation gets costly long before it is full. Null for none.
   */
  cap: number | null
}

/** A change to those settings. What is left out stays as it is. */
export type CompactionChange = Partial<CompactionSettings>

export const COMPACTION_DEFAULTS: Readonly<CompactionSettings> = { auto: true, share: 0.8, cap: null }
/** The shares that can be set. Lower would compact all the time; higher leaves no room for the next reply. */
export const SHARE_MIN = 0.5
export const SHARE_MAX = 0.95
/** The caps that can be set. Under the lower one the instructions and the tools alone may weigh more. */
export const CAP_MIN = 4000
export const CAP_MAX = 100_000_000

/**
 * Where a summary begins and ends in what is sent to the model. The summary is sent as the start
 * of a user message; the tags tell the model, and the app's own count of what weighs how much
 * (main/meter.ts), where it ends and what the person wrote begins.
 */
export const SUMMARY_OPEN = '<conversation-summary>'
export const SUMMARY_CLOSE = '</conversation-summary>'

/** A share that can be set: the nearest one in range, in whole percent. The default for what is not a number. */
export function readShare(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return COMPACTION_DEFAULTS.share
  return Math.round(Math.min(SHARE_MAX, Math.max(SHARE_MIN, value)) * 100) / 100
}

/** Whether a number of tokens can be a cap. */
export const isCap = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= CAP_MIN && value <= CAP_MAX

/**
 * From how many tokens on a conversation is compacted by itself. Undefined when it never is:
 * that was switched off, or neither the room of the model nor a cap is known.
 */
export function compactFrom(settings: CompactionSettings, window: number | undefined): number | undefined {
  if (!settings.auto) return undefined
  const byShare = window !== undefined && window > 0 ? Math.floor(window * settings.share) : undefined
  const cap = settings.cap ?? undefined
  if (byShare === undefined) return cap
  return cap === undefined ? byShare : Math.min(byShare, cap)
}
