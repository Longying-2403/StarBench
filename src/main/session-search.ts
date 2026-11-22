// Finding conversations by what was said in them. Nothing in this file depends on Electron or
// on where the conversations are kept: it is handed them, and says which ones match.

import type { Session, SessionHit } from '../shared/types.ts'

/** What of a conversation is searched: its name, and what the person and the model wrote. */
export interface Searchable {
  id: string
  title: string
  /** The messages of the person and the answers of the model, in order, each on one line. */
  texts: string[]
  /** Name and messages in lower case, for telling quickly whether a word is there at all. */
  lowTitle: string
  lowTexts: string[]
}

/** How many words a search may have, and how long each may be. More than this is not a search someone typed. */
const MAX_TERMS = 8
const MAX_TERM = 100
/**
 * How much of a message is shown around the word that was found. Little before it: the piece is
 * shown on one line of a narrow list, and the word has to be on it. `BEFORE` is in the widths of
 * Latin letters, of which a Chinese character takes two; `AFTER` is in characters.
 */
const BEFORE = 12
const AFTER = 60

/** Whether a character is as wide as two Latin letters: Chinese, Japanese and Korean writing, and the full-width forms. */
const isWide = (ch: string): boolean => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)
/** What a piece does not begin with: a space or a mark that ended what came before it. */
const SEPARATOR = /[\s,.;:!?，。、；：！？]/

/**
 * What of a conversation is searched. The thinking of the model and what the tools returned are
 * left out: a file that was read is not something that was said, and would be found for every
 * word in it.
 */
export function searchableOf(session: Pick<Session, 'id' | 'title' | 'messages'>): Searchable {
  const texts = session.messages.flatMap((message) => {
    // Nor is the summary of a compacted conversation: what it sums up is in the conversation, and is searched there.
    if (message.role === 'tool' || message.role === 'compaction' || typeof message.content !== 'string') return []
    const text = message.content.replace(/\s+/g, ' ').trim()
    return text ? [text] : []
  })
  return { id: session.id, title: session.title, texts, lowTitle: session.title.toLowerCase(), lowTexts: texts.map((text) => text.toLowerCase()) }
}

/** The words of a search: what was typed, split at the spaces, in lower case. */
export function termsOf(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.slice(0, MAX_TERM))
  return [...new Set(terms)].slice(0, MAX_TERMS)
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A piece of `text` around the first place `term` stands in it, with where each of the words
 * stands in that piece. The words are looked for in the text as it is written, whatever its case.
 */
function snippetOf(text: string, term: string, terms: string[]): NonNullable<SessionHit['snippet']> {
  const at = Math.max(0, text.search(new RegExp(escaped(term), 'i')))
  let start = at
  for (let room = BEFORE; start > 0; start--) {
    const width = isWide(text[start - 1]) ? 2 : 1
    if (width > room) break
    room -= width
  }
  // Not from the middle of a word in Latin letters, where there is a next word to start from.
  if (start > 0 && /\w/.test(text[start - 1]) && /\w/.test(text[start])) {
    const space = text.indexOf(' ', start)
    if (space >= 0 && space < at) start = space + 1
  }
  while (start > 0 && start < at && SEPARATOR.test(text[start])) start++
  const end = Math.min(text.length, at + term.length + AFTER)
  const piece = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
  const marks: [number, number][] = []
  // Longer words first, so that of two words where one holds the other the whole one is marked.
  const any = new RegExp([...terms].sort((a, b) => b.length - a.length).map(escaped).join('|'), 'gi')
  for (const found of piece.matchAll(any)) {
    const from = found.index ?? 0
    if (found[0]) marks.push([from, from + found[0].length])
  }
  return { text: piece, marks }
}

/**
 * The conversations in which every word of `query` is found, in the name or in a message, in
 * the order they were handed over. One whose name does not hold all the words comes with a
 * piece of the message that holds the first word missing from the name. An empty search finds nothing.
 */
export function searchSessions(sessions: Iterable<Searchable>, query: string): SessionHit[] {
  const terms = termsOf(query)
  if (terms.length === 0) return []
  const hits: SessionHit[] = []
  for (const session of sessions) {
    const elsewhere = terms.filter((term) => !session.lowTitle.includes(term))
    if (!elsewhere.every((term) => session.lowTexts.some((text) => text.includes(term)))) continue
    if (elsewhere.length === 0) {
      hits.push({ id: session.id })
      continue
    }
    const where = session.lowTexts.findIndex((text) => text.includes(elsewhere[0]))
    hits.push({ id: session.id, snippet: snippetOf(session.texts[where], elsewhere[0], terms) })
  }
  return hits
}
