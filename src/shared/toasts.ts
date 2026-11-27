// The notices the app shows in a corner of the window for a moment: what they are, how many are
// shown at once, and when each goes away by itself. Nothing here draws anything; Toasts.tsx does.

/**
 * What a notice is about, which is also the colour of the band down its side: something to
 * know, something that went well, something to mind, something that failed.
 */
export type ToastKind = 'info' | 'success' | 'warning' | 'error'

/** Something to do about what a notice says, in a word or two. Doing it takes the notice away. */
export interface ToastAction {
  label: string
  run(): void
}

export interface ToastInput {
  /** `info` unless said otherwise. */
  kind?: ToastKind
  title: string
  /** A sentence under the title. */
  text?: string
  /** A place on the web that goes with it, opened in the browser. */
  link?: { label: string; href: string }
  /** What can be done about it there and then, such as looking at what was changed or taking it back. */
  actions?: readonly ToastAction[]
  /** Stays until it is closed. A failure stays unless this says otherwise: it must not go by unseen. */
  sticky?: boolean
  /** Says what the notice is of. A second one of the same thing takes the place of the first, and `dismissKey` takes it away. */
  key?: string
}

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  text?: string
  link?: { label: string; href: string }
  actions?: readonly ToastAction[]
  sticky: boolean
  key?: string
  /** Whether the time it has left stands still: the pointer is on it, or the keyboard is in it. */
  paused: boolean
}

/** How long a notice that goes away by itself stays. */
export const TOAST_MS = 6000
/** How many are shown at once. One more pushes out the oldest that would have gone by itself anyway. */
export const TOAST_LIMIT = 3

/** The time a notice has left: how much, and since when that has been running. No timer while it stands still. */
interface Clock {
  left: number
  since: number
  timer?: ReturnType<typeof setTimeout>
}

/** The notices on show, newest first, and the clocks of those that go away by themselves. */
export class ToastStore {
  private toasts: readonly Toast[] = []
  private clocks = new Map<number, Clock>()
  private listeners = new Set<() => void>()
  private count = 0

  /** Shows a notice and returns its number. */
  add(input: ToastInput): number {
    const kind = input.kind ?? 'info'
    const toast: Toast = {
      id: ++this.count,
      kind,
      title: input.title,
      ...(input.text ? { text: input.text } : {}),
      ...(input.link ? { link: { ...input.link } } : {}),
      ...(input.actions?.length ? { actions: [...input.actions] } : {}),
      sticky: input.sticky ?? kind === 'error',
      ...(input.key !== undefined ? { key: input.key } : {}),
      paused: false
    }
    // One of the same thing is not said twice: the newer takes its place, and its time starts anew.
    let next = input.key === undefined ? [...this.toasts] : this.toasts.filter((t) => t.key !== input.key || this.stop(t.id))
    next = [toast, ...next]
    while (next.length > TOAST_LIMIT) {
      // The oldest that would have left by itself goes first; one that waits to be closed is kept as long as there is room.
      const out = [...next].reverse().find((t) => !t.sticky && t.id !== toast.id) ?? next[next.length - 1]
      this.stop(out.id)
      next = next.filter((t) => t !== out)
    }
    this.toasts = next
    if (!toast.sticky) this.run(toast.id, TOAST_MS)
    this.tell()
    return toast.id
  }

  /** Takes a notice away. */
  dismiss(id: number): void {
    if (!this.toasts.some((t) => t.id === id)) return
    this.stop(id)
    this.toasts = this.toasts.filter((t) => t.id !== id)
    this.tell()
  }

  /** Takes away the notice of that thing, if one is on show. */
  dismissKey(key: string): void {
    for (const toast of this.toasts) if (toast.key === key) this.dismiss(toast.id)
  }

  /** Holds the time a notice has left where it is, for as long as it is being looked at. */
  pause(id: number): void {
    const clock = this.clocks.get(id)
    if (clock?.timer === undefined) return
    clearTimeout(clock.timer)
    clock.timer = undefined
    clock.left = Math.max(0, clock.left - (Date.now() - clock.since))
    this.mark(id, true)
  }

  /** Lets the time run on. */
  resume(id: number): void {
    const clock = this.clocks.get(id)
    if (!clock || clock.timer !== undefined) return
    this.run(id, clock.left)
    this.mark(id, false)
  }

  /** The notices on show, newest first. The same list until something changes, as React wants it. */
  snapshot = (): readonly Toast[] => this.toasts

  /** Has `listener` called whenever the list changes, and returns the function that stops that. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private run(id: number, ms: number): void {
    this.clocks.set(id, { left: ms, since: Date.now(), timer: setTimeout(() => this.dismiss(id), ms) })
  }

  /** Ends the clock of a notice. Returns false, so that it can stand in a filter that drops the notice. */
  private stop(id: number): false {
    const clock = this.clocks.get(id)
    if (clock?.timer !== undefined) clearTimeout(clock.timer)
    this.clocks.delete(id)
    return false
  }

  private mark(id: number, paused: boolean): void {
    this.toasts = this.toasts.map((t) => (t.id === id ? { ...t, paused } : t))
    this.tell()
  }

  private tell(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
