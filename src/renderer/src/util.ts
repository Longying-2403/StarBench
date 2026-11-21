import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors that crossed IPC; the prefix is noise for the user.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Folder paths compare without regard to case on Windows; see `folderKey`. */
export const isWindows = navigator.userAgent.includes('Windows')

/**
 * Which way a popup attached to `anchor` should open. Down is preferred; up is used when the
 * popup would not fit below, which is the case once the message box sits at the bottom of the window.
 */
export function popupSide(anchor: Element | null, needed: number): 'up' | 'down' {
  if (!anchor) return 'down'
  const rect = anchor.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom
  return below >= needed || below >= rect.top ? 'down' : 'up'
}

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
