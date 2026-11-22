import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { SHORTCUTS, pressed } from '../../shared/shortcuts.ts'
import type { ShortcutId } from '../../shared/shortcuts.ts'

export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors that crossed IPC; the prefix is noise for the user.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Folder paths compare without regard to case on Windows; see `folderKey`. */
export const isWindows = navigator.userAgent.includes('Windows')
/** On a Mac the shortcuts are on ⌘ where they are on Ctrl elsewhere. */
export const isMac = navigator.userAgent.includes('Macintosh')

/**
 * Has `run` called when the keys of a shortcut are pressed, wherever in the window the keyboard
 * is. Not while a dialog is open, which has the window to itself, and not while an input method
 * is composing, whose keys are its own.
 */
export function useShortcut(id: ShortcutId, run: () => void): void {
  // Read through a ref so the listener is not re-attached on every render.
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || !pressed(e, SHORTCUTS[id].keys, isMac)) return
      if (document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id])
}

/** Where a popup opens, and how tall it may be there without reaching past the edge of the window. */
export interface PopupPlace {
  side: 'up' | 'down'
  room: number
}

/** The distance a popup keeps from the edge of the window. */
const WINDOW_MARGIN = 8

/**
 * Where a popup attached to `anchor` should open. Down is preferred, for as long as a height of
 * `enough` fits there; otherwise it opens on the side with more room, which is above once the
 * message box sits at the bottom of the window. `gap` is the distance between anchor and popup.
 *
 * The popup has to keep to `room` and scroll what does not fit: one that reaches past the edge
 * of the window makes the whole window scroll.
 */
export function popupPlace(anchor: Element | null, enough: number, gap: number): PopupPlace {
  if (!anchor) return { side: 'down', room: enough }
  const rect = anchor.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom - gap - WINDOW_MARGIN
  const above = rect.top - gap - WINDOW_MARGIN
  const side = below >= enough || below >= above ? 'down' : 'up'
  return { side, room: Math.max(80, Math.floor(side === 'down' ? below : above)) }
}

/**
 * The place of a popup while it is open: worked out as it opens, before it is first painted, and
 * again whenever the window changes size or the popup comes to need another height.
 */
export function usePopupPlace(open: boolean, anchor: RefObject<Element | null>, enough: number, gap: number): PopupPlace {
  const [place, setPlace] = useState<PopupPlace>({ side: 'down', room: enough })
  useLayoutEffect(() => {
    if (!open) return
    const fit = (): void => {
      const next = popupPlace(anchor.current, enough, gap)
      setPlace((was) => (was.side === next.side && was.room === next.room ? was : next))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [open, anchor, enough, gap])
  return place
}

/** The popup's room, handed to the stylesheet. */
export const roomStyle = (place: PopupPlace): CSSProperties => ({ '--popup-room': `${place.room}px` }) as CSSProperties

/** Calls `onClose` when the user presses anywhere outside `root` while a popup is open. */
export function useOutsidePress(open: boolean, root: RefObject<HTMLElement | null>, onClose: () => void): void {
  // Read through a ref so the listener is not re-attached on every render.
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) latest.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, root])
}
