// What the window lets its page do besides showing the app: go to another address, and have what
// a browser asks permission for. The page is the app's own, and what it shows of a model's answers
// it draws itself (links open in the real browser, pictures are fetched only when asked for), so
// both rules can be narrow. Whatever the page may do matters: it holds the whole of the app's
// interface to the main process, saving the MCP servers to start among it.
// Nothing in this file depends on Electron.

/**
 * Whether the window may go to `target`. The page never goes anywhere by itself. While developing
 * it reloads from the development server, on that server's address and no other. Once packaged,
 * the page is a file, and to a file every other file, every `data:` address and every address of
 * the app's own schemes has the same origin as itself ("null"): no origin can be let through
 * there, so nothing is.
 */
export function mayNavigate(target: string, devPageUrl: string | undefined): boolean {
  if (!devPageUrl) return false
  try {
    const dev = new URL(devPageUrl)
    return (dev.protocol === 'http:' || dev.protocol === 'https:') && new URL(target).origin === dev.origin
  } catch {
    return false
  }
}

/** What the page may have of what a browser asks permission for: writing to the clipboard, for the copy buttons. */
const GRANTED: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/** Whether the page may have something a browser asks permission for. Unless told otherwise, Electron grants everything. */
export function mayGrant(permission: string): boolean {
  return GRANTED.has(permission)
}
