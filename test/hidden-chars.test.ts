// Run with: node --test test/hidden-chars.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasHidden, revealHidden } from '../src/shared/hidden-chars.ts'

test('characters that do not show are cut out and named', () => {
  // The right-to-left mark makes "gpj.exe" read as "exe.jpg".
  assert.deepEqual(revealHidden('start ‮gpj.exe'), ['start ', { hidden: 'U+202E' }, 'gpj.exe'])
  assert.deepEqual(revealHidden('rm​ -rf'), ['rm', { hidden: 'U+200B' }, ' -rf'])
  // Tag characters can carry a whole text that nobody sees.
  assert.deepEqual(revealHidden('ok\u{E0041}\u{E0042}'), ['ok', { hidden: 'U+E0041' }, { hidden: 'U+E0042' }])
  assert.deepEqual(revealHidden('ㅤx'), [{ hidden: 'U+3164' }, 'x'])
  assert.deepEqual(revealHidden('a\u0007b c'), ['a', { hidden: 'U+0007' }, 'b', { hidden: 'U+2028' }, 'c'])
  assert.equal(hasHidden('x⁦y'), true)
})

test('ordinary text, tabs and line ends are left as they are', () => {
  for (const text of ['Get-ChildItem -Recurse | Select-Object Name', '你好，世界　全角空格也是看得见的', 'a\tb\nc\r\nd']) {
    assert.deepEqual(revealHidden(text), [text], JSON.stringify(text))
    assert.equal(hasHidden(text), false, JSON.stringify(text))
  }
  assert.deepEqual(revealHidden(''), [])
})
