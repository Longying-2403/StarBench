// Characters that do not show where text is shown, though they are there when it is used: the
// marks that turn the direction of text around (with them a command can read as something other
// than what it does), the ones without any width, control characters, and the tag characters that
// can carry a whole text nobody sees. Where a person judges a tool call by reading it, they are
// shown as what they are.

/** Format and control characters, line and paragraph separators, and the letters drawn as nothing. Tabs and line ends are text. */
const HIDDEN = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]/gu

/** A piece of text as it shows, or one character that would not show, named by its code point (`U+202E`). */
export type Piece = string | { hidden: string }

/** The text cut into what shows and what would not; each character that would not show is a piece of its own. */
export function revealHidden(text: string): Piece[] {
  const pieces: Piece[] = []
  let shownFrom = 0
  for (const match of text.matchAll(HIDDEN)) {
    const at = match.index ?? 0
    if (at > shownFrom) pieces.push(text.slice(shownFrom, at))
    pieces.push({ hidden: `U+${(match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}` })
    shownFrom = at + match[0].length
  }
  if (shownFrom < text.length) pieces.push(text.slice(shownFrom))
  return pieces
}

/** Whether the text holds a character that would not show. */
export function hasHidden(text: string): boolean {
  return revealHidden(text).some((piece) => typeof piece !== 'string')
}
