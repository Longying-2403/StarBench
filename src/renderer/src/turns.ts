// The turns of a conversation as the rail at its left edge tells them (TurnRail.tsx): a mark for
// each message of the person, with what they wrote and how the answer to it begins, and how the
// marks are laid out and drawn. Nothing here touches the page.

import type { Item } from './items.ts'

export interface TurnMark {
  /** Where the person's message stands among the items of the conversation. */
  at: number
  /** What the person wrote, on one line; what went with the message, where they wrote nothing. */
  title: string
  /** How the answer begins, in plain words. Empty while there is none. */
  excerpt: string
}

const TITLE_MAX = 120
const EXCERPT_MAX = 220
/** No more of an answer than this is read for its beginning: the marks are made again at every word of an answer being written. */
const READ_MAX = 1200

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * How a Markdown text begins, as plain words on one line: without the marks of headings, lists
 * and emphasis, a link by its words, a picture by what it is said to show, and with code that is
 * set apart left out. A rough reading, for a few words in a small card.
 */
export function plainExcerpt(markdown: string, max = EXCERPT_MAX): string {
  const text = markdown
    .slice(0, READ_MAX)
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
    .replace(/\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
    .replace(/[*~`]+/g, '')
    .replace(/\|/g, ' ')
  return oneLine(text, max)
}

/**
 * The turns of a conversation: one for each message of the person, in their order. The answer of
 * a turn is the last thing the model wrote in it; what it wrote between its calls leads up to that.
 */
export function turnMarks(items: readonly Item[]): TurnMark[] {
  const marks: TurnMark[] = []
  items.forEach((item, at) => {
    if (item.kind === 'user') {
      const said = item.text.trim() ? item.text : item.skill ? `Skill · ${item.skill}` : (item.attachments ?? []).map((file) => file.name).join('、')
      marks.push({ at, title: oneLine(said, TITLE_MAX), excerpt: '' })
    } else if (item.kind === 'assistant' && item.text.trim() && marks.length > 0) {
      marks[marks.length - 1].excerpt = plainExcerpt(item.text)
    }
  })
  return marks
}

/** The measures of the rail, in pixels. */
export const RAIL = {
  /** From one tick to the next, where there is room. */
  pitch: 13,
  /** The closest the ticks are set, in a long conversation. */
  least: 4,
  /** How long a tick is. */
  short: 10,
  /** The tick of the turn in view, while the pointer is elsewhere. */
  current: 18,
  /** The tick under the pointer. */
  long: 30,
  /** How far from the pointer the ticks around it are still drawn longer: at this distance, about three fifths of the way. */
  spread: 22,
  /** Kept clear above and below the rail. */
  margin: 24
} as const

/**
 * Which marks the rail shows, and how far apart. They stand `RAIL.pitch` apart where the room
 * allows, closer in a long conversation, and where even the closest setting has no room for all
 * of them, as many as fit around the turn in view.
 */
export function railLayout(count: number, room: number, current: number): { pitch: number; first: number; shown: number } {
  const space = room - 2 * RAIL.margin
  if (count <= 0 || space < RAIL.least) return { pitch: RAIL.pitch, first: 0, shown: 0 }
  const pitch = Math.max(RAIL.least, Math.min(RAIL.pitch, space / count))
  const shown = Math.min(count, Math.floor(space / pitch + 1e-6))
  const first = Math.max(0, Math.min(count - shown, current - Math.floor(shown / 2)))
  return { pitch, first, shown }
}

/** How near the pointer a tick is: 1 under it, falling off gently to 0 with the distance between them (`RAIL.spread`). */
export function nearness(center: number, pointer: number): number {
  const away = center - pointer
  return Math.exp(-(away * away) / (2 * RAIL.spread * RAIL.spread))
}

/**
 * How long a tick is drawn. With the pointer on the rail, the tick under it is the longest and
 * those around it grow shorter the further they are, the one of the turn in view like any other;
 * with the pointer elsewhere (`null`), that one alone stands out.
 */
export function tickLength(center: number, pointer: number | null, current: boolean): number {
  if (pointer === null) return current ? RAIL.current : RAIL.short
  return RAIL.short + (RAIL.long - RAIL.short) * nearness(center, pointer)
}
