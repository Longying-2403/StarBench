import assert from 'node:assert/strict'
import { test } from 'node:test'
import { whenExact, whenText } from '../src/shared/when.ts'

/** A moment by the clock of this computer, which is the clock the list is read by. */
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number => new Date(year, month - 1, day, hour, minute, second).getTime()

test('how long ago a conversation was gone on with is said the way a person would say it', () => {
  const now = at(2026, 11, 24, 15, 0)
  assert.equal(whenText(now, now), '刚刚')
  assert.equal(whenText(at(2026, 11, 24, 14, 59, 20), now), '刚刚')
  assert.equal(whenText(at(2026, 11, 24, 14, 59), now), '1 分钟前')
  assert.equal(whenText(at(2026, 11, 24, 14, 57), now), '3 分钟前')
  assert.equal(whenText(at(2026, 11, 24, 14, 0, 1), now), '59 分钟前')
  // From an hour on it is the time of day, with the day it was.
  assert.equal(whenText(at(2026, 11, 24, 14, 0), now), '今天 14:00')
  assert.equal(whenText(at(2026, 11, 24, 0, 5), now), '今天 00:05')
  assert.equal(whenText(at(2026, 11, 23, 23, 59), now), '昨天 23:59')
  assert.equal(whenText(at(2026, 11, 23, 9, 7), now), '昨天 09:07')
  // Then days, counted by the calendar and not in spans of 24 hours.
  assert.equal(whenText(at(2026, 11, 22, 23, 0), now), '2 天前')
  assert.equal(whenText(at(2026, 10, 25, 8, 0), now), '30 天前')
})

test('a day is the calendar\'s: minutes are counted across midnight, and "yesterday" begins there', () => {
  const now = at(2026, 11, 24, 0, 10)
  assert.equal(whenText(at(2026, 11, 23, 23, 50), now), '20 分钟前')
  assert.equal(whenText(at(2026, 11, 23, 22, 0), now), '昨天 22:00', 'two hours ago, and yesterday')
  assert.equal(whenText(at(2026, 11, 22, 23, 59), now), '2 天前', 'a little over a day ago, and the day before yesterday')
})

test('past a month a conversation is told by its date', () => {
  const now = at(2026, 11, 24, 15, 0)
  assert.equal(whenText(at(2026, 10, 24, 12, 0), now), '31 天前', 'a month back to the day is still within the month')
  assert.equal(whenText(at(2026, 10, 23, 12, 0), now), '10月23日')
  assert.equal(whenText(at(2026, 1, 2, 3, 4), now), '1月2日')
  assert.equal(whenText(at(2025, 12, 31, 12, 0), now), '2025年12月31日', 'with its year once that is another one')

  // From the last day of a long month, a month back is the last day of the month before.
  const endOfMarch = at(2026, 3, 31, 12, 0)
  assert.equal(whenText(at(2026, 2, 28, 9, 0), endOfMarch), '31 天前')
  assert.equal(whenText(at(2026, 2, 27, 9, 0), endOfMarch), '2月27日')
  // Early in January the month before is last year's December.
  assert.equal(whenText(at(2025, 12, 20, 9, 0), at(2026, 1, 5, 9, 0)), '16 天前')
  assert.equal(whenText(at(2025, 12, 4, 9, 0), at(2026, 1, 5, 9, 0)), '2025年12月4日')
})

test('a moment that has not come yet is told by its date, and a clock a little off is forgiven', () => {
  const now = at(2026, 11, 24, 15, 0)
  assert.equal(whenText(at(2026, 11, 24, 15, 2), now), '刚刚')
  assert.equal(whenText(at(2026, 11, 25, 9, 0), now), '11月25日')
  assert.equal(whenText(at(2027, 1, 1, 0, 0), now), '2027年1月1日')
})

test('the exact moment is written out in full', () => {
  assert.equal(whenExact(at(2026, 1, 5, 9, 7)), '2026-01-05 09:07')
  assert.equal(whenExact(at(2026, 11, 24, 23, 59)), '2026-11-24 23:59')
})
