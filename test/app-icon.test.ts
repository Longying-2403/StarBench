import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

test('the icon in the sidebar is the icon of the app', async () => {
  // The window and the taskbar show build/icon.svg (the .png and .ico are made from it); the page
  // draws the same shapes itself, written out in icons.tsx.
  const file = await readFile(path.resolve('build/icon.svg'), 'utf8')
  const source = await readFile(path.resolve('src/renderer/src/icons.tsx'), 'utf8')
  // Up to the brace that closes the function, whichever way the lines of the file end: a checkout on Windows may end them with CR LF.
  const drawn = /export function AppIcon\(\) \{([\s\S]*?)\r?\n\}\r?\n/.exec(source)?.[1] ?? ''
  assert.notEqual(drawn, '', 'AppIcon is there')

  const one = (pattern: RegExp, text: string, what: string): string => {
    const found = pattern.exec(text)?.[1]
    assert.ok(found, `${what} is there`)
    return found
  }
  // The frame, the ground, the prompt and the star: each as the file has it.
  assert.equal(one(/viewBox="([^"]+)"/, drawn, 'the frame of the drawing'), one(/viewBox="([^"]+)"/, file, 'the frame of the file'))
  assert.equal(one(/<rect [^>]*rx="(\d+)"/, drawn, 'the round corners of the drawing'), one(/<rect [^>]*rx="(\d+)"/, file, 'the round corners of the file'))
  assert.equal(one(/<polyline points="([^"]+)"/, drawn, 'the prompt of the drawing'), one(/<polyline points="([^"]+)"/, file, 'the prompt of the file'))
  assert.equal(one(/<path d="([^"]+)"/, drawn, 'the star of the drawing'), one(/<path d="([^"]+)"/, file, 'the star of the file'))
  assert.equal(one(/strokeWidth="(\d+)"/, drawn, 'the weight of the prompt, drawn'), one(/stroke-width="(\d+)"/, file, 'the weight of the prompt, in the file'))

  const colours = (text: string): string[] => [...text.matchAll(/#[0-9a-f]{3,6}\b/gi)].map((found) => found[0].toLowerCase()).sort()
  assert.deepEqual(colours(drawn), colours(file), 'the same colours, as often')
  const ground = (text: string): string => one(/<radialGradient [^>]*cx="(\d+)" cy="\d+" r="\d+"/, text, 'where the ground is lightest')
  assert.equal(ground(drawn), ground(file))
})
