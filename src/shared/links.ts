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

/**
 * A page on the web that a link leads to, taken apart for the person to judge before it is
 * opened: the words of a link are the model's and may say anything, so the question shows where
 * it really leads, with the site told apart from what stands around it.
 */
export interface WebPlace {
  /** The whole address, as it is opened. */
  address: string
  /** The site a yes of "do not ask again" is kept for: how it is reached and where (`https://github.com`), with its port if it names one. */
  site: string
  /** The site as it is shown: its name, with its port if it names one. A name in other letters than Latin ones comes in the spelling of the address itself (`xn--…`), where a look-alike shows. */
  host: string
  /** What stands in front of the site: `https://`, and a name written before the site, if there is one. */
  before: string
  /** What follows the site: the path, and what is asked of the page. */
  after: string
  /** A name stands in front of the site (`https://github.com@elsewhere.example/`): a way to make one site read as another. */
  named: boolean
}

/** The page on the web an address leads to, or null for an address that is no http or https one. */
export function webPlace(address: string): WebPlace | null {
  let url: URL
  try {
    url = new URL(webAddress(address.trim()))
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.host) return null
  const name = url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
  return {
    address: url.href,
    site: url.origin,
    host: url.host,
    before: `${url.protocol}//${name}`,
    after: `${url.pathname}${url.search}${url.hash}`,
    named: name !== ''
  }
}

/** Whether a text names a site as `WebPlace.site` does: nothing but how it is reached and where. What arrives over IPC or from a file is checked with this. */
export function isSite(value: unknown): value is string {
  return typeof value === 'string' && webPlace(value)?.site === value
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
