// Thinking that arrives inside the answer. Some model servers do not keep a model's thinking
// apart from its answer: the text opens with the thinking between <think> and </think>, and the
// answer follows. With some models not even that: the template they are prompted with writes
// the opening tag itself (Qwen 3.5, DeepSeek R1), so what the model writes begins inside the
// thinking, and only the closing tag shows where it ends. This takes thinking and answer apart
// while the text streams in.
// Nothing in this file depends on Electron.

const OPEN = '<think>'
const CLOSE = '</think>'

/** How much of the end of `text` could be the beginning of `tag`, with the rest of it still to come. */
export function begun(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return length
  }
  return 0
}

export interface Split {
  reasoning: string
  text: string
  /**
   * Set when a closing tag showed that the answer had begun inside the thinking: all the text
   * handed out before this was thinking. `reasoning` is then the rest of it, up to the tag.
   */
  wasThinking?: boolean
}

/**
 * What is made of an answer that does not open with the tag. `no`: it is the answer. `watch`: it
 * is, until a closing tag at the start of a line shows that all of it so far was thinking.
 * `expect`: it is thinking up to the closing tag, because that is how this model's answers came
 * before; the one who says so finds out from `assumed` and `open` when that was wrong.
 */
export type Unopened = 'no' | 'watch' | 'expect'

/**
 * Splits a streamed answer into thinking and text. A block that opens the answer counts, and,
 * where asked for, thinking that only a closing tag ends. The same tags further in are something
 * the model wrote about, not its thinking.
 */
export class ThinkTags {
  private state: 'start' | 'thinking' | 'watching' | 'text' = 'start'
  private unopened: Unopened
  /** Held back because it may be the beginning of a tag that the next piece completes. */
  private held = ''
  /** The white space after a tag is dropped: the thinking and the answer each begin with their first word. */
  private trimming = false
  /** While watching: whether the line being written is empty so far, so that a tag which comes now stands at its start. */
  private lineBlank = true
  /** Whether the answer held thinking: between tags at its start, or before a closing tag that was never opened. */
  found = false
  /** The thinking came without its opening tag, and its end was seen. */
  bare = false
  /** The answer was taken for thinking from its first word on, without a tag saying so (`expect`). */
  assumed = false

  constructor(unopened: Unopened = 'no') {
    this.unopened = unopened
  }

  /** Whether the thinking is still going on: at the end of an answer, that its end never came. */
  get open(): boolean {
    return this.state === 'thinking'
  }

  /** The service hands the thinking over by itself, so that what stands in the answer is the answer (unless it opens with the tag). */
  settle(): void {
    this.unopened = 'no'
    if (this.state === 'watching') this.state = 'text'
  }

  push(piece: string): Split {
    let rest = this.held + piece
    this.held = ''
    const out: Split = { reasoning: '', text: '' }

    if (this.state === 'start') {
      const body = rest.trimStart()
      if (body.startsWith(OPEN)) {
        this.state = 'thinking'
        this.found = true
        this.trimming = true
        rest = body.slice(OPEN.length)
      } else if (OPEN.startsWith(body)) {
        // White space, or the first letters of the tag: the next piece tells.
        this.held = rest
        return out
      } else if (this.unopened === 'expect') {
        this.state = 'thinking'
        this.assumed = true
        this.trimming = true
      } else {
        this.state = this.unopened === 'watch' ? 'watching' : 'text'
      }
    }

    if (this.state === 'watching') return this.watch(rest, out)

    if (this.state === 'thinking') {
      const end = rest.indexOf(CLOSE)
      const until = end >= 0 ? end : rest.length - begun(rest, CLOSE)
      out.reasoning = this.trimmed(rest.slice(0, until))
      if (end < 0) {
        this.held = rest.slice(until)
        return out
      }
      this.state = 'text'
      this.trimming = true
      if (this.assumed) this.found = this.bare = true
      rest = rest.slice(end + CLOSE.length)
    }

    out.text = this.trimmed(rest)
    return out
  }

  /** What was still held back when the stream ended. */
  end(): Split {
    const held = this.held
    this.held = ''
    return this.state === 'thinking' ? { reasoning: held, text: '' } : { reasoning: '', text: held }
  }

  /**
   * Hands text on as the answer, on the lookout for a closing tag that was never opened. It has
   * to stand at the start of a line, the way a model ends its thinking: the tag written about in
   * the middle of a sentence is not that. And an opening tag anywhere before it ends the watch,
   * since the two belong together and are something the model wrote about.
   */
  private watch(rest: string, out: Split): Split {
    const opened = rest.indexOf(OPEN)
    for (let at = rest.indexOf(CLOSE); at >= 0 && (opened < 0 || at < opened); at = rest.indexOf(CLOSE, at + 1)) {
      const line = rest.lastIndexOf('\n', at - 1) + 1
      if (!/^[ \t]*$/.test(rest.slice(line, at)) || (line === 0 && !this.lineBlank)) continue
      this.state = 'text'
      this.found = this.bare = true
      this.trimming = true
      out.wasThinking = true
      out.reasoning = rest.slice(0, at)
      out.text = this.trimmed(rest.slice(at + CLOSE.length))
      return out
    }
    if (opened >= 0) {
      this.state = 'text'
      out.text = rest
      return out
    }
    // The beginning of either tag at the end of the piece waits for the next one.
    const kept = Math.max(begun(rest, CLOSE), begun(rest, OPEN))
    const text = rest.slice(0, rest.length - kept)
    this.held = rest.slice(rest.length - kept)
    const line = text.lastIndexOf('\n')
    this.lineBlank = (line >= 0 || this.lineBlank) && /^[ \t]*$/.test(text.slice(line + 1))
    out.text = text
    return out
  }

  private trimmed(text: string): string {
    if (!this.trimming) return text
    const kept = text.trimStart()
    if (kept) this.trimming = false
    return kept
  }
}
