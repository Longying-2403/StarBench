// Text that is whole. A character outside the first 65,536 of Unicode (an emoji, a rarer Chinese
// character) is written in JavaScript as two units, and a string cut by its length can end between
// the two. Half a character is nothing that can be written down in UTF-8: put into the body of a
// request it becomes an escape that stands for no character, and services answer such a request
// with an error. What was cut is kept in the conversation, so every request after it fails the same
// way, and the conversation is stuck.
//
// Two things keep that from happening. Where text is cut to a length, it is cut between
// characters (`cutAt`). And whatever goes to a model service is looked through once more on its way
// out (`wholeText`, in main/agent.ts), which also lets a conversation go on that holds such a
// half from before.

const isFirstHalf = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff

/** A half of a character that stands without its other half. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
/** The mark for what cannot be read (U+FFFD), written by its number so that no editor makes something else of it. */
const UNREADABLE = String.fromCharCode(0xfffd)

/** Whether a text holds no half of a character that stands alone. */
export function isWhole(text: string): boolean {
  LONE.lastIndex = 0
  return !LONE.test(text)
}

/** A text with every half character that stands alone replaced by the mark for what cannot be read (U+FFFD). The text itself where there is none. */
export function whole(text: string): string {
  return isWhole(text) ? text : text.replace(LONE, UNREADABLE)
}

/**
 * The beginning of a text, `max` units long at most: one unit shorter where that many would end
 * with the first half of a character. A text that is no longer than that is returned as it is.
 */
export function cutAt(text: string, max: number): string {
  if (text.length <= max) return text
  const end = max > 0 && isFirstHalf(text.charCodeAt(max - 1)) ? max - 1 : max
  return text.slice(0, Math.max(end, 0))
}

/**
 * Something that is to be sent as JSON, with every text in it made whole (`whole`): its texts, the
 * texts in its lists and in what its names stand for, however deep. What holds no half character
 * is handed back as it is, the very same thing, so that nothing is copied without need. Only
 * lists and plain objects are gone into, which is all that JSON is made of: anything else (a
 * buffer of bytes, say) is handed back untouched.
 */
export function wholeText<T>(value: T): T {
  if (typeof value === 'string') return whole(value) as T
  if (Array.isArray(value)) {
    let changed = false
    const made = value.map((entry: unknown) => {
      const sound = wholeText(entry)
      if (sound !== entry) changed = true
      return sound
    })
    return (changed ? made : value) as T
  }
  if (typeof value !== 'object' || value === null) return value
  const kind: unknown = Object.getPrototypeOf(value)
  if (kind !== Object.prototype && kind !== null) return value
  let made: Record<string, unknown> | undefined
  for (const [name, entry] of Object.entries(value)) {
    const sound = wholeText(entry)
    const key = whole(name)
    if (sound === entry && key === name) continue
    made ??= { ...(value as Record<string, unknown>) }
    if (key !== name) delete made[name]
    made[key] = sound
  }
  return (made ?? value) as T
}
