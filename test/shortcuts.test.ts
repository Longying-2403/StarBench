// Run with: node --test test/shortcuts.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHORTCUTS, keysLabel, pressed } from '../src/shared/shortcuts.ts'
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
