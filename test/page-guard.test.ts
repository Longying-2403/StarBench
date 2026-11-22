// Run with: node --test test/page-guard.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mayGrant, mayNavigate } from '../src/main/page-guard.ts'

test('the packaged page goes nowhere, whatever the address', () => {
  // To a page that is a file, each of these has the same origin as itself.
  for (const target of [
    'file:///C:/Users/someone/Downloads/evil.html',
    'file:///C:/Program%20Files/StarBench/resources/app.asar/out/renderer/index.html',
    'data:text/html,<script>alert(1)</script>',
    'starbench-plugin://ui/debug/index.js',
    'https://example.com/',
    'not an address'
  ]) {
    assert.equal(mayNavigate(target, undefined), false, target)
  }
})

test('while developing, the page reloads from the development server and goes nowhere else', () => {
  const dev = 'http://localhost:5173'
  assert.equal(mayNavigate('http://localhost:5173/', dev), true)
  assert.equal(mayNavigate('http://localhost:5173/src/main.tsx?t=1', dev), true)
  for (const target of ['http://localhost:5174/', 'https://localhost:5173/', 'http://127.0.0.1:5173/', 'file:///C:/page.html', 'data:text/html,x', 'not an address']) {
    assert.equal(mayNavigate(target, dev), false, target)
  }
  assert.equal(mayNavigate('file:///C:/other.html', 'file:///C:/page.html'), false, 'a page that is a file has no origin to go by')
})

test('of what a browser asks permission for, the page has the clipboard and nothing else', () => {
  assert.equal(mayGrant('clipboard-sanitized-write'), true)
  for (const permission of ['clipboard-read', 'media', 'display-capture', 'geolocation', 'notifications', 'openExternal', 'fullscreen', 'pointerLock', 'unknown']) {
    assert.equal(mayGrant(permission), false, permission)
  }
})
