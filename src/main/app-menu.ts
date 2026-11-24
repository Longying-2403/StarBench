// The window's menu. An app that sets none gets one of Electron's making, whose keys work although
// the bar is hidden: Ctrl+R reloads the page and Ctrl+Shift+I opens the developer tools, in the
// packaged app as well. A reload loses what the page holds while a turn goes on in the main
// process: the question the turn waits on, and that it is at work, so that it can no longer be
// stopped from the page. The packaged app therefore has a menu of its own with the rest of
// Electron's: editing text, zooming, the full screen, the window.

import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

/** Electron's menu without the reloads and the developer tools. */
export const APP_MENU: MenuItemConstructorOptions[] = [
  { role: 'fileMenu' },
  { role: 'editMenu' },
  { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  { role: 'windowMenu' }
]

/** Puts the app's own menu in place of Electron's in the packaged app. While developing, Electron's stays, with its reload and its tools. */
export function setAppMenu(packaged: boolean): void {
  if (packaged) Menu.setApplicationMenu(Menu.buildFromTemplate(APP_MENU))
}
