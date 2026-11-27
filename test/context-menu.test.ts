// The menu of a right-click (GitHub issue #1): what it holds where, that nothing in it leaves the
// page, and the two scripts that find the message box for 粘贴到输入框.
// Run with: node --test test/context-menu.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { EditFlags, MenuItemConstructorOptions } from 'electron'
import { BOX_TAKES_PASTE, FOCUS_BOX, contextMenu } from '../src/main/context-menu.ts'
import type { MenuPage, MenuPlace } from '../src/main/context-menu.ts'

const NOTHING: EditFlags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false }

/** A right-click, by default where nothing is selected and nothing is typed. */
const place = (over: Partial<MenuPlace> = {}): MenuPlace => ({ isEditable: false, selectionText: '', editFlags: NOTHING, misspelledWord: '', dictionarySuggestions: [], ...over })

/** The entries as the person reads them: the name, "（灰）" for one that cannot be chosen, "—" for a line between groups. */
const shown = (items: MenuItemConstructorOptions[]): string[] =>
  items.map((item) => (item.type === 'separator' ? '—' : `${item.label}${item.enabled === false ? '（灰）' : ''}`))

const nowhere: MenuPage = { replaceMisspelling: () => assert.fail('nothing is replaced here'), pasteIntoBox: () => assert.fail('nothing is pasted here') }

/** Chooses an entry that is not one of Electron's editing commands, as the menu does with a click. */
const choose = (item: MenuItemConstructorOptions | undefined): void => (item?.click as () => void)()

test('in a box that takes text, the menu has undo, redo, cut, copy, paste and select all, each to be chosen as the page says', () => {
  // Typed into, nothing selected, text on the clipboard.
  const typed = contextMenu(place({ isEditable: true, editFlags: { ...NOTHING, canUndo: true, canPaste: true, canSelectAll: true } }), nowhere, false)
  assert.deepEqual(shown(typed), ['撤销', '重做（灰）', '—', '剪切（灰）', '复制（灰）', '粘贴', '—', '全选'])
  assert.deepEqual(typed.map((item) => item.role), ['undo', 'redo', undefined, 'cut', 'copy', 'paste', undefined, 'selectAll'])
  // Part of it selected.
  const selected = contextMenu(place({ isEditable: true, selectionText: 'hello', editFlags: { ...NOTHING, canUndo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }), nowhere, false)
  assert.deepEqual(shown(selected), ['撤销', '重做（灰）', '—', '剪切', '复制', '粘贴', '—', '全选'])
  // Empty, and nothing on the clipboard: the menu is there all the same, everything grey.
  assert.deepEqual(shown(contextMenu(place({ isEditable: true }), nowhere, false)), ['撤销（灰）', '重做（灰）', '—', '剪切（灰）', '复制（灰）', '粘贴（灰）', '—', '全选（灰）'])
  // A box's own paste is its own: the message box is not asked about there.
  assert.deepEqual(shown(contextMenu(place({ isEditable: true }), nowhere, true)), ['撤销（灰）', '重做（灰）', '—', '剪切（灰）', '复制（灰）', '粘贴（灰）', '—', '全选（灰）'])
})

test('outside a box the menu has copy, for selected text, and a paste that goes into the message box', () => {
  const copyable = { ...NOTHING, canCopy: true, canSelectAll: true }
  // Text selected in an answer or a code window.
  const selected = contextMenu(place({ selectionText: 'const x = 1', editFlags: copyable }), nowhere, true)
  assert.deepEqual(shown(selected), ['复制', '粘贴到输入框'])
  assert.equal(selected[0].role, 'copy')
  assert.equal(selected[1].role, undefined)
  // Nothing selected, or white space alone: copy is there, grey.
  assert.deepEqual(shown(contextMenu(place(), nowhere, true)), ['复制（灰）', '粘贴到输入框'])
  assert.deepEqual(shown(contextMenu(place({ selectionText: ' \n\t ', editFlags: copyable }), nowhere, true)), ['复制（灰）', '粘贴到输入框'])
  // The message box cannot take a paste (not there, greyed, under a page or a dialog).
  assert.deepEqual(shown(contextMenu(place({ selectionText: 'x', editFlags: copyable }), nowhere, false)), ['复制', '粘贴到输入框（灰）'])
  // On a link or a picture the menu is the same: nothing in it opens one.
  const onLink = { ...place(), linkURL: 'https://example.com/', linkText: 'example', mediaType: 'none' }
  const onPicture = { ...place(), srcURL: 'data:image/png;base64,AAAA', mediaType: 'image', hasImageContents: true }
  assert.deepEqual(shown(contextMenu(onLink, nowhere, true)), ['复制（灰）', '粘贴到输入框'])
  assert.deepEqual(shown(contextMenu(onPicture, nowhere, true)), ['复制（灰）', '粘贴到输入框'])
})

test('choosing 粘贴到输入框 pastes into the message box, once', () => {
  let pasted = 0
  const page: MenuPage = { replaceMisspelling: () => assert.fail('nothing is replaced here'), pasteIntoBox: () => pasted++ }
  choose(contextMenu(place(), page, true).find((item) => item.label === '粘贴到输入框'))
  assert.equal(pasted, 1)
})

test('a misspelled word gets the spellchecker\'s suggestions at the top, and choosing one puts it in the word\'s place', () => {
  const replaced: string[] = []
  const page: MenuPage = { replaceMisspelling: (word) => replaced.push(word), pasteIntoBox: () => assert.fail('nothing is pasted here') }
  const items = contextMenu(place({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'eh'], editFlags: { ...NOTHING, canPaste: true, canSelectAll: true } }), page, false)
  assert.deepEqual(shown(items), ['the', 'ten', 'eh', '—', '撤销（灰）', '重做（灰）', '—', '剪切（灰）', '复制（灰）', '粘贴', '—', '全选'])
  choose(items[1])
  assert.deepEqual(replaced, ['ten'])
  // A misspelled word the spellchecker has nothing for: no line above the rest.
  assert.deepEqual(shown(contextMenu(place({ isEditable: true, misspelledWord: 'qzxv' }), page, false)).slice(0, 2), ['撤销（灰）', '重做（灰）'])
  // Suggestions are only taken for a misspelled word.
  assert.deepEqual(shown(contextMenu(place({ isEditable: true, dictionarySuggestions: ['the'] }), page, false))[0], '撤销（灰）')
})

test('nothing in the menu leaves the page: the editing commands, the suggestions, which replace a word, and the paste into the message box', () => {
  const all: EditFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: true }
  const editing = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  const done: string[] = []
  const page: MenuPage = { replaceMisspelling: (word) => done.push(`replace ${word}`), pasteIntoBox: () => done.push('paste into the box') }
  const places = [
    place({ isEditable: true, editFlags: all, selectionText: 'x', misspelledWord: 'x', dictionarySuggestions: ['a', 'b'] }),
    place({ editFlags: all, selectionText: 'x' })
  ]
  for (const item of places.flatMap((one) => contextMenu(one, page, true))) {
    if (item.type === 'separator') continue
    if (item.role !== undefined) {
      assert.ok(editing.has(item.role), item.role)
      assert.equal(item.click, undefined, item.role)
      assert.equal(item.submenu, undefined, item.role)
    } else {
      assert.ok(item.click, String(item.label))
      choose(item)
    }
  }
  assert.deepEqual(done, ['replace a', 'replace b', 'paste into the box'])
})

/** A stand-in for the page's document, with the message box or without it, for the two scripts that are run there. */
function pageWith(box: { disabled?: boolean; readOnly?: boolean; hidden?: boolean; covered?: boolean } | null) {
  const document: { activeElement: unknown; querySelector(selector: string): unknown; elementFromPoint(x: number, y: number): unknown } = {
    activeElement: null,
    querySelector: (selector) => (selector === '.composer textarea[aria-label="消息"]' ? element : null),
    // The box lies at 300,400, 800 wide and 36 high; what lies over it is somewhere else's.
    elementFromPoint: (x, y) => (element && !box?.covered && x > 300 && x < 1100 && y > 400 && y < 436 ? element : { tagName: 'DIV' })
  }
  const element = box && {
    disabled: box.disabled ?? false,
    readOnly: box.readOnly ?? false,
    getBoundingClientRect: () => (box.hidden ? { left: 0, top: 0, width: 0, height: 0 } : { left: 300, top: 400, width: 800, height: 36 }),
    focus() {
      document.activeElement = element
    }
  }
  return { document, element }
}

/** Runs a script written for the page against a stand-in for its document. */
const runIn = (script: string, document: unknown): unknown => new Function('document', `return ${script}`)(document)

test('the message box takes a paste where it is there, not greyed and in sight', () => {
  assert.equal(runIn(BOX_TAKES_PASTE, pageWith({}).document), true)
  assert.equal(runIn(BOX_TAKES_PASTE, pageWith(null).document), false, 'no message box')
  assert.equal(runIn(BOX_TAKES_PASTE, pageWith({ disabled: true }).document), false, 'greyed: no key, no folder')
  assert.equal(runIn(BOX_TAKES_PASTE, pageWith({ readOnly: true }).document), false, 'read-only')
  assert.equal(runIn(BOX_TAKES_PASTE, pageWith({ hidden: true }).document), false, 'not drawn')
  assert.equal(runIn(BOX_TAKES_PASTE, pageWith({ covered: true }).document), false, 'a page or a dialog over it')
})

test('for the paste, the keyboard is put in the message box, and nowhere when the box cannot have it', () => {
  const ready = pageWith({})
  assert.equal(runIn(FOCUS_BOX, ready.document), true)
  assert.equal(ready.document.activeElement, ready.element)
  const greyed = pageWith({ disabled: true })
  assert.equal(runIn(FOCUS_BOX, greyed.document), false)
  assert.equal(greyed.document.activeElement, null)
  assert.equal(runIn(FOCUS_BOX, pageWith(null).document), false)
})

test('the message box is found as Composer.tsx draws it', () => {
  // The scripts find it by its container's class and its label: renaming either leaves 粘贴到输入框 grey for good.
  const composer = readFileSync(new URL('../src/renderer/src/Composer.tsx', import.meta.url), 'utf8')
  assert.match(composer, /className="composer"/)
  const start = composer.indexOf('<textarea')
  assert.ok(start >= 0, 'Composer.tsx draws a textarea')
  assert.match(composer.slice(start, composer.indexOf('/>', start)), /aria-label="消息"/)
})
