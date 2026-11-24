// When a conversation was last gone on with, as a person would say it looking down the list:
// "刚刚", "3 分钟前", "今天 14:32", "昨天 09:10", "5 天前", and past a month the date.
// Everything is told by the clock of this computer, where the person reads it.

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const two = (n: number): string => String(n).padStart(2, '0')
const clock = (d: Date): string => `${two(d.getHours())}:${two(d.getMinutes())}`
/** The day `d` is in, as a count of days that goes up by one at every midnight, whatever the clocks do in between. */
const dayOf = (d: Date): number => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (24 * HOUR))

/** The day as it is written out: without the year while it is this one's. */
function dateText(then: Date, today: Date): string {
  const day = `${then.getMonth() + 1}月${then.getDate()}日`
  return then.getFullYear() === today.getFullYear() ? day : `${then.getFullYear()}年${day}`
}

/**
 * How long ago `at` was, said from `now` (both in milliseconds, as `Date.now()` tells them).
 * Within the hour it is minutes, today and yesterday the time of day, then days, and from a
 * month back the date: the further off, the less it matters to the hour.
 */
export function whenText(at: number, now: number): string {
  const then = new Date(at)
  const today = new Date(now)
  const ago = now - at
  // A moment that has not come yet: the clock was set back, or the file is from another computer. Its date is all that can be said.
  if (ago < -5 * MINUTE) return dateText(then, today)
  if (ago < MINUTE) return '刚刚'
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} 分钟前`
  const days = dayOf(today) - dayOf(then)
  if (days <= 0) return `今天 ${clock(then)}`
  if (days === 1) return `昨天 ${clock(then)}`
  // A month back is the same day of the month before, or that month's last day where it has no
  // such day (from the 31st of March, the 28th of February). What is older is told by its date.
  const lastOfMonthBefore = new Date(today.getFullYear(), today.getMonth(), 0).getDate()
  const monthBack = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), lastOfMonthBefore))
  if (dayOf(then) >= dayOf(monthBack)) return `${days} 天前`
  return dateText(then, today)
}

/** The moment written out in full, for whoever asks what "3 天前" was exactly: "2026-11-24 14:32". */
export function whenExact(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(d)}`
}
