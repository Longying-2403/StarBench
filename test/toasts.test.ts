// Run with: node --test test/toasts.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { TOAST_LIMIT, TOAST_MS, ToastStore } from '../src/shared/toasts.ts'

/** A store whose clock is the test's: time passes when the test says so. */
function store(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const toasts = new ToastStore()
  const titles = (): string[] => toasts.snapshot().map((toast) => toast.title)
  return { toasts, titles, pass: (ms: number) => t.mock.timers.tick(ms) }
}

test('a notice is shown, newest at the top, and goes away by itself when its time is up', (t) => {
  const { toasts, titles, pass } = store(t)
  let changes = 0
  const stop = toasts.subscribe(() => changes++)

  const first = toasts.add({ title: '正在使用 ChatGPT 套餐', text: '消息会计入你的套餐额度。', link: { label: '管理用量', href: 'https://example.com/usage' } })
  assert.deepEqual(toasts.snapshot(), [
    { id: first, kind: 'info', title: '正在使用 ChatGPT 套餐', text: '消息会计入你的套餐额度。', link: { label: '管理用量', href: 'https://example.com/usage' }, sticky: false, paused: false }
  ])
  pass(2000)
  toasts.add({ kind: 'success', title: '调试面板已启用' })
  assert.deepEqual(titles(), ['调试面板已启用', '正在使用 ChatGPT 套餐'])
  assert.equal(changes, 2)

  // Each has its own time.
  pass(TOAST_MS - 2000 - 1)
  assert.equal(titles().length, 2)
  pass(1)
  assert.deepEqual(titles(), ['调试面板已启用'])
  pass(2000)
  assert.deepEqual(titles(), [])
  assert.equal(changes, 4, 'whoever draws them is told of every change')

  // The list is the same one until something changes, which is how React knows nothing did.
  const before = toasts.snapshot()
  assert.equal(toasts.snapshot(), before)
  toasts.dismiss(999)
  assert.equal(toasts.snapshot(), before, 'taking away what is not there changes nothing')
  assert.equal(changes, 4)
  stop()
  toasts.add({ title: 'after' })
  assert.equal(changes, 4, 'no longer told')
})

test('a failure stays until it is closed, unless it is said to go by itself', (t) => {
  const { toasts, titles, pass } = store(t)
  const failed = toasts.add({ kind: 'error', title: '插件加载失败', text: 'ui/index.js 没有导出 setup。' })
  toasts.add({ kind: 'error', title: '一个小错', sticky: false })
  toasts.add({ kind: 'warning', title: '要留着的提醒', sticky: true })
  assert.deepEqual(
    toasts.snapshot().map((toast) => [toast.title, toast.kind, toast.sticky]),
    [
      ['要留着的提醒', 'warning', true],
      ['一个小错', 'error', false],
      ['插件加载失败', 'error', true]
    ]
  )
  pass(TOAST_MS * 10)
  assert.deepEqual(titles(), ['要留着的提醒', '插件加载失败'])
  toasts.dismiss(failed)
  assert.deepEqual(titles(), ['要留着的提醒'])
})

test('the time of a notice stands still while it is looked at', (t) => {
  const { toasts, titles, pass } = store(t)
  const id = toasts.add({ title: '看着它' })
  pass(4000)
  toasts.pause(id)
  assert.equal(toasts.snapshot()[0].paused, true)
  pass(60_000)
  assert.deepEqual(titles(), ['看着它'], 'however long the pointer rests on it')
  toasts.pause(id)
  toasts.resume(id)
  assert.equal(toasts.snapshot()[0].paused, false)
  // It goes on with the two seconds it had left, not with a time of its own again.
  pass(1999)
  assert.deepEqual(titles(), ['看着它'])
  pass(1)
  assert.deepEqual(titles(), [])

  // One that stays anyway has no time to hold, and one that is gone has none either.
  const sticky = toasts.add({ kind: 'error', title: '出错' })
  toasts.pause(sticky)
  toasts.resume(sticky)
  toasts.pause(id)
  toasts.resume(id)
  assert.deepEqual(toasts.snapshot().map((toast) => [toast.title, toast.paused]), [['出错', false]])
})

test('one of the same thing takes the place of the first, and can be taken away by what it is of', (t) => {
  const { toasts, titles, pass } = store(t)
  toasts.add({ key: 'plan', title: '第一次说' })
  toasts.add({ title: '别的事' })
  pass(5000)
  toasts.add({ key: 'plan', title: '又说了一次' })
  assert.deepEqual(titles(), ['又说了一次', '别的事'], 'not said twice, and the newer one is on top')
  // Its time starts anew, and the clock of the one it replaced does nothing to it.
  pass(1000)
  assert.deepEqual(titles(), ['又说了一次'])
  pass(TOAST_MS - 1001)
  assert.deepEqual(titles(), ['又说了一次'])
  pass(1)
  assert.deepEqual(titles(), [])

  toasts.add({ kind: 'error', key: 'plugin-ui:debug', title: '界面出错了' })
  toasts.add({ kind: 'error', key: 'plugin-ui:other', title: '另一个插件' })
  toasts.dismissKey('plugin-ui:debug')
  toasts.dismissKey('nothing-by-that-name')
  assert.deepEqual(titles(), ['另一个插件'])
})

test('only so many are shown at once: the oldest that would have left anyway makes room', (t) => {
  const { toasts, titles, pass } = store(t)
  toasts.add({ kind: 'error', title: '出错 1' })
  toasts.add({ title: '提示 1' })
  toasts.add({ title: '提示 2' })
  assert.equal(titles().length, TOAST_LIMIT)
  toasts.add({ title: '提示 3' })
  assert.deepEqual(titles(), ['提示 3', '提示 2', '出错 1'], 'the failure waits to be closed, so the oldest passing notice went')
  // What was pushed out does not come back to take another one with it when its time would have been up.
  pass(TOAST_MS)
  assert.deepEqual(titles(), ['出错 1'])

  // Nothing but failures: then the oldest of those goes.
  toasts.add({ kind: 'error', title: '出错 2' })
  toasts.add({ kind: 'error', title: '出错 3' })
  toasts.add({ kind: 'error', title: '出错 4' })
  assert.deepEqual(titles(), ['出错 4', '出错 3', '出错 2'])
  // And a new one is never the one pushed out.
  toasts.add({ title: '提示 4' })
  assert.deepEqual(titles(), ['提示 4', '出错 4', '出错 3'])
})
