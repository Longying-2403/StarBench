// The app's keyboard shortcuts, in one place: what each does and the keys it is on. The keys are
// fixed for now. Everything that reads a shortcut asks here, so that letting people choose their
// own keys later means changing where `SHORTCUTS` comes from, and nothing else.

/**
 * A combination of keys, written the way people say it: modifiers first, then one key, joined
 * by `+`. `Mod` is Ctrl, and ⌘ on a Mac. For example `Mod+K`, `Mod+Shift+P`, `Alt+ArrowUp`.
 */
export type Keys = string

export const SHORTCUTS = {
  /** Puts the cursor into the box that searches the conversations. */
  search: { keys: 'Mod+K', label: '搜索对话' },
  /** Folds the sidebar away to a strip, or opens it again. */
  sidebar: { keys: 'Mod+B', label: '收起或展开侧边栏' }
} as const satisfies Record<string, { keys: Keys; label: string }>

export type ShortcutId = keyof typeof SHORTCUTS

/** What of a key press decides whether it is a shortcut. A keyboard event has all of it. */
export interface KeyPress {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

interface Combination {
  mod: boolean
  shift: boolean
  alt: boolean
  /** The key, in lower case: a letter comes as a capital with Shift or Caps Lock, and is the same key. */
  key: string
  /** The key as it was written, for showing it. */
  name: string
}

function read(keys: Keys): Combination {
  const parts = keys.split('+').map((part) => part.trim())
  const name = parts.pop() ?? ''
  const has = (modifier: string): boolean => parts.some((part) => part.toLowerCase() === modifier)
  return { mod: has('mod'), shift: has('shift'), alt: has('alt'), key: name.toLowerCase(), name }
}

/**
 * Whether a key press is the combination `keys`, with exactly its modifiers: `Mod+K` is not
 * pressed by Ctrl+Shift+K. On a Mac `Mod` is ⌘ and Ctrl is left alone; elsewhere it is Ctrl.
 */
export function pressed(event: KeyPress, keys: Keys, mac: boolean): boolean {
  const wanted = read(keys)
  const mod = mac ? event.metaKey : event.ctrlKey
  const other = mac ? event.ctrlKey : event.metaKey
  return event.key.toLowerCase() === wanted.key && mod === wanted.mod && !other && event.shiftKey === wanted.shift && event.altKey === wanted.alt
}

/** The combination as it is shown to people: `Ctrl K`, and `⌘K` on a Mac. */
export function keysLabel(keys: Keys, mac: boolean): string {
  const { mod, shift, alt, name: written } = read(keys)
  const name = written.length === 1 ? written.toUpperCase() : written
  if (mac) return `${mod ? '⌘' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${name}`
  return [...(mod ? ['Ctrl'] : []), ...(alt ? ['Alt'] : []), ...(shift ? ['Shift'] : []), name].join(' ')
}

/** The combination as it is written in a sentence: `Ctrl+Enter`, and `⌘Enter` on a Mac. */
export function keysInText(keys: Keys, mac: boolean): string {
  return mac ? keysLabel(keys, true) : keysLabel(keys, false).split(' ').join('+')
}

/**
 * What the Enter key does in the message box (设置 → 通用). `send`, as the app comes: it sends the
 * message, and Shift+Enter makes a new line. `newline`: it makes a new line, as in any other text,
 * and the message is sent with `SEND_KEYS` or with the button.
 */
export type EnterKey = 'send' | 'newline'

/** What sends a message where the Enter key makes a new line: Ctrl+Enter, and ⌘Enter on a Mac. */
export const SEND_KEYS: Keys = 'Mod+Enter'

/**
 * Whether a key press in the message box sends the message, as the Enter key is set. Where Enter
 * sends, it does so with any modifier but Shift, which is left to the box for a new line. Where it
 * makes a new line, only `SEND_KEYS` send, with exactly their modifiers.
 */
export function sendsMessage(event: KeyPress, enter: EnterKey, mac: boolean): boolean {
  if (event.key !== 'Enter') return false
  return enter === 'send' ? !event.shiftKey : pressed(event, SEND_KEYS, mac)
}
