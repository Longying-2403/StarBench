// Run with: node --test test/shortcuts.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SEND_KEYS, SHORTCUTS, keysInText, keysLabel, pressed, sendsMessage } from '../src/shared/shortcuts.ts'
import type { KeyPress } from '../src/shared/shortcuts.ts'

const press = (key: string, held: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...held })

test('a shortcut is its key with exactly its modifiers', () => {
  const { keys } = SHORTCUTS.search
  assert.equal(keys, 'Mod+K')
  assert.equal(pressed(press('k', { ctrlKey: true }), keys, false), true)
  assert.equal(pressed(press('K', { ctrlKey: true }), keys, false), true, 'with Caps Lock on the key comes as a capital')
  assert.equal(pressed(press('k'), keys, false), false, 'typing a k is not a shortcut')
  assert.equal(pressed(press('k', { ctrlKey: true, shiftKey: true }), keys, false), false)
  assert.equal(pressed(press('k', { ctrlKey: true, altKey: true }), keys, false), false, 'AltGr comes as Ctrl and Alt together')
  assert.equal(pressed(press('j', { ctrlKey: true }), keys, false), false)
  assert.equal(pressed(press('k', { metaKey: true }), keys, false), false, 'the Windows key is not Ctrl')
  assert.equal(pressed(press('k', { ctrlKey: true, metaKey: true }), keys, false), false)
})

test('on a Mac the shortcuts are on ⌘', () => {
  const { keys } = SHORTCUTS.search
  assert.equal(pressed(press('k', { metaKey: true }), keys, true), true)
  assert.equal(pressed(press('k', { ctrlKey: true }), keys, true), false, 'Ctrl+K deletes to the end of the line there')
  assert.equal(pressed(press('k', { metaKey: true, ctrlKey: true }), keys, true), false)
})

test('the sidebar is folded away and opened again with Ctrl+B, and no two shortcuts are on the same keys', () => {
  const { keys } = SHORTCUTS.sidebar
  assert.equal(keys, 'Mod+B')
  assert.equal(pressed(press('b', { ctrlKey: true }), keys, false), true)
  assert.equal(pressed(press('b', { metaKey: true }), keys, true), true)
  assert.equal(pressed(press('b'), keys, false), false, 'typing a b is not a shortcut')
  assert.equal(pressed(press('b', { ctrlKey: true }), SHORTCUTS.search.keys, false), false)
  assert.equal(keysLabel(keys, false), 'Ctrl B')

  const all = Object.values(SHORTCUTS).map((shortcut) => shortcut.keys.toLowerCase())
  assert.equal(new Set(all).size, all.length, all.join(', '))
})

test('combinations with more to them are read the same way', () => {
  assert.equal(pressed(press('P', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+P', false), true)
  assert.equal(pressed(press('p', { ctrlKey: true }), 'Mod+Shift+P', false), false)
  assert.equal(pressed(press('ArrowUp', { altKey: true }), 'Alt+ArrowUp', false), true)
  assert.equal(pressed(press('ArrowUp', { altKey: true, ctrlKey: true }), 'Alt+ArrowUp', false), false)
  assert.equal(pressed(press('Escape'), 'Escape', false), true)
  assert.equal(pressed(press(',', { ctrlKey: true }), 'mod + ,', false), true, 'however it is spaced and cased')
})

test('a shortcut is shown the way the keyboard at hand names it', () => {
  assert.equal(keysLabel('Mod+K', false), 'Ctrl K')
  assert.equal(keysLabel('Mod+K', true), '⌘K')
  assert.equal(keysLabel('Mod+Shift+P', false), 'Ctrl Shift P')
  assert.equal(keysLabel('Mod+Shift+P', true), '⌘⇧P')
  assert.equal(keysLabel('Alt+ArrowUp', false), 'Alt ArrowUp')
  assert.equal(keysLabel('mod+k', false), 'Ctrl K')
  assert.equal(keysLabel('Escape', true), 'Escape')
})

test('in the message box Enter sends the message, or makes a new line with Ctrl+Enter to send, as it is set', () => {
  // As the app comes: Enter sends with any modifier but Shift, and Shift+Enter is left to the box for a new line.
  assert.equal(sendsMessage(press('Enter'), 'send', false), true)
  assert.equal(sendsMessage(press('Enter', { shiftKey: true }), 'send', false), false)
  assert.equal(sendsMessage(press('Enter', { ctrlKey: true }), 'send', false), true)
  assert.equal(sendsMessage(press('Enter', { metaKey: true }), 'send', true), true)
  assert.equal(sendsMessage(press('a'), 'send', false), false)
  // Set to make a new line: Enter and Shift+Enter are the box's, and only Ctrl+Enter sends, ⌘Enter on a Mac.
  assert.equal(sendsMessage(press('Enter'), 'newline', false), false)
  assert.equal(sendsMessage(press('Enter', { shiftKey: true }), 'newline', false), false)
  assert.equal(sendsMessage(press('Enter', { ctrlKey: true }), 'newline', false), true)
  assert.equal(sendsMessage(press('Enter', { ctrlKey: true, shiftKey: true }), 'newline', false), false)
  assert.equal(sendsMessage(press('Enter', { ctrlKey: true, altKey: true }), 'newline', false), false, 'AltGr comes as Ctrl and Alt together')
  assert.equal(sendsMessage(press('Enter', { metaKey: true }), 'newline', false), false, 'the Windows key is not Ctrl')
  assert.equal(sendsMessage(press('Enter', { metaKey: true }), 'newline', true), true)
  assert.equal(sendsMessage(press('Enter', { ctrlKey: true }), 'newline', true), false)
  assert.equal(sendsMessage(press('a', { ctrlKey: true }), 'newline', false), false)
  // Not one of the shortcuts of the window, which work wherever the keyboard is.
  assert.equal(Object.values(SHORTCUTS).some((shortcut) => shortcut.keys.toLowerCase() === SEND_KEYS.toLowerCase()), false)
  // Said in a sentence the way the keyboard at hand names the keys.
  assert.equal(keysInText(SEND_KEYS, false), 'Ctrl+Enter')
  assert.equal(keysInText(SEND_KEYS, true), '⌘Enter')
  assert.equal(keysInText('Shift+Enter', false), 'Shift+Enter')
  assert.equal(keysInText('Shift+Enter', true), '⇧Enter')
})
