// What the popup menus of the message box have in common: how the keyboard moves through them.

import type { KeyboardEvent } from 'react'

/** The entries of a menu, in the order they stand in. */
export const menuItems = (menu: Element | null): HTMLElement[] => Array.from(menu?.querySelectorAll<HTMLElement>('.menu-item') ?? [])

/**
 * Moves the keyboard through the entries of a menu: the arrows up and down go round, Home and
 * End go to the ends. Returns whether the key was one of these, and so was used up.
 */
export function moveInMenu(e: KeyboardEvent<HTMLElement>, menu: Element | null): boolean {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return false
  const all = menuItems(menu)
  if (all.length === 0) return false
  const at = all.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
  e.preventDefault()
  all[next].focus({ preventScroll: true })
  all[next].scrollIntoView({ block: 'nearest' })
  return true
}
