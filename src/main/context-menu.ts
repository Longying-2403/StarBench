// The menu of a right-click in the window. Electron shows none by itself, so without this a
// right-click did nothing anywhere: no paste in the message box, no copy in an answer (GitHub
// issue #1). The menu is about text and nothing more: no link is opened from it (a link in an
// answer is asked about first, LinkAsk.tsx), and there are no developer tools. A place with a menu
// of its own, a conversation's row or a workspace's in the sidebar, cancels the event in the page,
// and Electron then asks for no menu.
// Only Electron's types are used here, so that the menu is tested without it.

import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

/** Of a right-click, what its menu goes by. */
export type MenuPlace = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags' | 'misspelledWord' | 'dictionarySuggestions'>

/** What the menu does to its page besides Electron's editing commands. */
export interface MenuPage {
  /** Puts `word` in the place of the misspelled word that was right-clicked. */
  replaceMisspelling(word: string): void
  /** Pastes what the clipboard holds into the message box, as Ctrl+V there would. */
  pasteIntoBox(): void
}

/**
 * The menu for a right-click. In a box that takes text: the spellchecker's suggestions for a
 * misspelled word, then undo, redo, cut, copy, paste and select all, each to be chosen where the
 * page says it can be done. Anywhere else, an answer, a code window, a link or empty space: copy,
 * for text that is selected, and a paste that goes into the message box, where `boxTakesPaste`
 * says the box can take one (`BOX_TAKES_PASTE`).
 */
export function contextMenu(place: MenuPlace, page: MenuPage, boxTakesPaste: boolean): MenuItemConstructorOptions[] {
  const can = place.editFlags
  if (!place.isEditable) {
    return [
      { role: 'copy', label: '复制', enabled: can.canCopy && place.selectionText.trim() !== '' },
      { label: '粘贴到输入框', enabled: boxTakesPaste, click: () => page.pasteIntoBox() }
    ]
  }
  const suggestions: MenuItemConstructorOptions[] = place.misspelledWord
    ? place.dictionarySuggestions.map((word) => ({ label: word, click: () => page.replaceMisspelling(word) }))
    : []
  return [
    ...suggestions,
    ...(suggestions.length > 0 ? [{ type: 'separator' as const }] : []),
    { role: 'undo', label: '撤销', enabled: can.canUndo },
    { role: 'redo', label: '重做', enabled: can.canRedo },
    { type: 'separator' },
    { role: 'cut', label: '剪切', enabled: can.canCut },
    { role: 'copy', label: '复制', enabled: can.canCopy },
    { role: 'paste', label: '粘贴', enabled: can.canPaste },
    { type: 'separator' },
    { role: 'selectAll', label: '全选', enabled: can.canSelectAll }
  ]
}

/** The message box, as the page draws it (Composer.tsx). */
const BOX = '.composer textarea[aria-label="消息"]'

/**
 * Run in the page: whether the message box can take a paste now. It is there, not greyed, and in
 * sight: no page such as 设置 and no dialog lies over the middle of it.
 */
export const BOX_TAKES_PASTE = `(() => {
  const box = document.querySelector('${BOX}')
  if (!box || box.disabled || box.readOnly) return false
  const r = box.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === box
})()`

/** Run in the page: puts the keyboard in the message box, where it last was, so that a paste goes there. */
export const FOCUS_BOX = `(() => {
  const box = document.querySelector('${BOX}')
  if (!box || box.disabled) return false
  box.focus()
  return document.activeElement === box
})()`
