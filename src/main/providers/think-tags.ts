// Thinking that arrives inside the answer. Some model servers do not keep a model's thinking
// apart from its answer: the text opens with the thinking between <think> and </think>, and the
// answer follows. This takes the two apart while the text streams in.
// Nothing in this file depends on Electron.

const OPEN = '<think>'
const CLOSE = '</think>'

/** How much of the end of `text` could be the beginning of `tag`, with the rest of it still to come. */
function begun(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return length
  }
  return 0
}

export interface Split {
  reasoning: string
  text: string
}

/**
 * Splits a streamed answer into thinking and text. Only a block that opens the answer counts:
 * the same tags further in are something the model wrote about, not its thinking.
 */
export class ThinkTags {
  private state: 'start' | 'thinking' | 'text' = 'start'
  /** Held back because it may be the beginning of a tag that the next piece completes. */
  private held = ''
  /** The white space after a tag is dropped: the thinking and the answer each begin with their first word. */
  private trimming = false
  /** Whether the answer opened with thinking. */
  found = false

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
      } else {
        this.state = 'text'
      }
    }

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

  private trimmed(text: string): string {
    if (!this.trimming) return text
    const kept = text.trimStart()
    if (kept) this.trimming = false
    return kept
  }
}
