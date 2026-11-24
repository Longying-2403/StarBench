import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { Item } from './items.ts'
import { nearness, railLayout, tickLength, turnMarks } from './turns.ts'

/** The messages of the person as they stand on the page, in their order (`data-turn`, set where the conversation is drawn). */
const turnsOn = (scroller: HTMLElement): NodeListOf<HTMLElement> => scroller.querySelectorAll<HTMLElement>('[data-turn]')

/**
 * The rail at the left edge of a conversation: a tick for each message of the person. The tick of
 * the turn in view is the longest. With the pointer on the rail it gives that up: the tick under
 * the pointer is the longest then, those around it shorter the further they are, and a card
 * beside it says what was written there and how the answer begins. Pressing a tick goes to its
 * message. The rail lies over the conversation and does not move with it.
 */
export function TurnRail({ items, scroller }: { items: readonly Item[]; scroller: RefObject<HTMLDivElement | null> }) {
  const marks = useMemo(() => turnMarks(items), [items])
  const count = marks.length
  /** How high the conversation's box is: the room the rail has. */
  const [room, setRoom] = useState(0)
  /** The turn in view. */
  const [current, setCurrent] = useState(0)
  /** Where the pointer is on the rail, down from its top. */
  const [pointer, setPointer] = useState<number | null>(null)
  /** The tick the keyboard is on. */
  const [held, setHeld] = useState<number | null>(null)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setRoom(el.clientHeight)
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [scroller])

  // The turn in view is the one at the top of the box: the last whose message has come up to
  // there, so that a tick that was pressed is the one that stands out afterwards (its message is
  // put 16px under the top). At the end of the conversation it is the last turn, however short.
  useEffect(() => {
    const el = scroller.current
    if (!el || count === 0) return
    let frame = 0
    const find = (): void => {
      frame = 0
      let now = count - 1
      if (el.scrollHeight - el.scrollTop - el.clientHeight >= 4) {
        const line = el.getBoundingClientRect().top + 28
        now = 0
        turnsOn(el).forEach((node, i) => {
          if (node.getBoundingClientRect().top <= line) now = i
        })
      }
      setCurrent(Math.max(0, Math.min(count - 1, now)))
    }
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(find)
    }
    find()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scroller, count, room])

  // A conversation of one turn has nowhere to go.
  if (count < 2) return null
  const { pitch, first, shown } = railLayout(count, room, current)
  if (shown === 0) return null
  const height = shown * pitch
  const center = (i: number): number => (i - first + 0.5) * pitch
  const last = first + shown - 1
  const onKeys = held !== null && held >= first && held <= last ? held : null
  /** Where the lengths are measured from: the pointer, or the tick the keyboard is on. */
  const from = pointer ?? (onKeys !== null ? center(onKeys) : null)
  const picked = pointer !== null ? Math.max(first, Math.min(last, first + Math.floor(pointer / pitch))) : onKeys

  const jump = (i: number): void => {
    const el = scroller.current
    const node = el ? turnsOn(el)[i] : undefined
    if (!el || !node) return
    const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: Math.max(0, top - 16), behavior: still ? 'auto' : 'smooth' })
    // The message that was gone to shows itself for a moment.
    node.classList.add('msg-flash')
    window.setTimeout(() => node.classList.remove('msg-flash'), 1200)
  }

  const shownMark = picked !== null ? marks[picked] : undefined
  return (
    <>
      <nav
        className="turn-rail"
        aria-label="对话记录"
        style={{ height }}
        onMouseMove={(e) => setPointer(e.clientY - e.currentTarget.getBoundingClientRect().top)}
        onMouseLeave={() => setPointer(null)}
        // The rail lies over the conversation: the wheel turned on it moves the conversation all the same.
        onWheel={(e) => scroller.current?.scrollBy({ top: e.deltaY })}
      >
        {marks.slice(first, first + shown).map((mark, offset) => {
          const i = first + offset
          const stands = picked === i ? 'picked' : from === null && i === current ? 'current' : undefined
          // Near the pointer a tick is a little brighter as well as longer.
          const shade = stands || from === null ? undefined : `color-mix(in srgb, var(--muted) ${Math.round(45 + 55 * nearness(center(i), from))}%, var(--bg))`
          return (
            <button
              key={mark.at}
              type="button"
              className="turn-tick"
              style={{ height: pitch }}
              // One stop for the keyboard; the arrows go from tick to tick.
              tabIndex={i === (onKeys ?? current) ? 0 : -1}
              aria-label={`第 ${i + 1} 条：${mark.title || '（没有文字）'}`}
              aria-current={i === current ? 'true' : undefined}
              data-stands={stands}
              // The pointer does not take the keyboard's place: a tick it pressed is not left held when it goes away.
              onMouseDown={(e) => e.preventDefault()}
              onFocus={() => setHeld(i)}
              onBlur={() => setHeld(null)}
              onClick={() => jump(i)}
              onKeyDown={(e) => {
                const to = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.key === 'ArrowUp' ? e.currentTarget.previousElementSibling : null
                if (!(to instanceof HTMLElement)) return
                e.preventDefault()
                to.focus()
              }}
            >
              <span style={{ width: tickLength(center(i), from, i === current), ...(shade ? { background: shade } : {}) }} />
            </button>
          )
        })}
      </nav>
      {shownMark && picked !== null && (
        // Beside its tick, and kept inside the box where the tick is near the top or the bottom of it.
        <div className="turn-card" style={{ top: `clamp(52px, calc(50% + ${Math.round(center(picked) - height / 2)}px), calc(100% - 52px))` }}>
          <div className="turn-card-title">{shownMark.title || '（没有文字）'}</div>
          {shownMark.excerpt && <div className="turn-card-text">{shownMark.excerpt}</div>}
        </div>
      )}
    </>
  )
}
