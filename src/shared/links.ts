// The addresses in an answer: which of them lead to the web, and which name a file on this
// computer. A model that made a picture shows it as `![sunset](sunset.png)`: a path in the
// folder of the conversation, which the page cannot go to by itself.

/**
 * A path with a drive letter, as Windows writes it. The backslash may come percent-encoded: the
 * Markdown reader does that to every address before the page sees it.
 */
const DRIVE_PATH = /^[a-zA-Z]:(?:[\\/]|%5C)/i

/**
 * Whether the address of a link or a picture names a file on this computer instead of a place on
 * the web: a path, relative ("out/chart.png") or with a drive letter, or a file: address.
 */
export function namesFile(address: string): boolean {
  if (!address) return false
  if (DRIVE_PATH.test(address) || /^file:/i.test(address)) return true
  // A place on the page itself, or an address on the web that left out "https:".
  if (/^(?:#|\?|\/\/)/.test(address)) return false
  // Whatever has a scheme leads elsewhere: https, mailto and the like.
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(address)
}

/**
 * The address on the web that a link or a picture leads to. One that left its scheme out
 * ("//example.com/a.png") is given https. Left as it is, the app's window, which is itself a
 * file, would read it as a file on another computer and go looking for that computer.
 */
export function webAddress(address: string): string {
  return address.startsWith('//') ? `https:${address}` : address
}

/** Whether a picture can be fetched from an address: over https, which is all the page lets through. */
export function fetchablePicture(address: string): boolean {
  return /^https:\/\//i.test(address)
}

/** The address as the model wrote it, with the spaces and the letters that the Markdown reader percent-encoded. */
export function writtenAddress(address: string): string {
  try {
    return decodeURIComponent(address)
  } catch {
    return address
  }
}
