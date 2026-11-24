// The app's own tooltips. An element says what it is with `data-tip`, and one layer for the whole
// window shows that text beside it while the pointer rests on it or the keyboard is on it: in the
// app's colours and type, where the system's own tooltip (`title`) comes in the system's.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** How long the pointer rests on an element before its tip shows, in milliseconds. Not for a pointer that is only passing over. */
const REST_MS = 350
/** For this long after a tip went, the next one shows at once: someone reading along a row of buttons does not wait at each. */
const WARM_MS = 400
/** The distance a tip keeps from its element, and from the edge of the window. */
const GAP = 6
const MARGIN = 8

interface Tip {
  text: string
  /** The element's box, in the window. */
  box: DOMRect
}

/**
 * Whether a tip would only say what already stands there in full: the name of a row whose name
 * is not cut short. Then it is left out.
 */
function saysNothingNew(el: Element, text: string): boolean {
  if ((el.textContent ?? '').trim() !== text.trim()) return false
  return ![el, ...el.querySelectorAll('*')].some((node) => node.scrollWidth > node.clientWidth + 1)
}

/** The element under `target` that has a tip to show now, if any. */
function tipped(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target.closest('[data-tip]') : null
  if (!el) return null
  // While its own menu or card is open, an element needs no word of what it is, and the tip would lie over the menu.
  if (el.getAttribute('aria-expanded') === 'true') return null
  const text = el.getAttribute('data-tip') ?? ''
  return text.trim() && !saysNothingNew(el, text) ? el : null
}

/** Shows the tip of whatever the pointer rests on or the keyboard is on. Put once into the window, over everything else. */
export function TipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let over: Element | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let wentAt = 0
    const show = (el: Element): void => {
      // Gone, or changed, while the pointer rested.
      const text = el.isConnected ? (el.getAttribute('data-tip') ?? '') : ''
      if (text.trim()) setTip({ text, box: el.getBoundingClientRect() })
    }
    const hide = (): void => {
      clearTimeout(timer)
      over = null
      setTip((shown) => {
        if (shown) wentAt = Date.now()
        return null
      })
    }
    const onOver = (e: MouseEvent): void => {
      const el = tipped(e.target)
      if (el === over) return
      hide()
      if (!el) return
      over = el
      timer = setTimeout(() => show(el), Date.now() - wentAt < WARM_MS ? 0 : REST_MS)
    }
    // The keyboard arriving at an element shows its tip at once; a press of the mouse does not count as arriving.
    const onFocus = (e: FocusEvent): void => {
      const el = tipped(e.target)
      if (!el || !(e.target instanceof Element) || !e.target.matches(':focus-visible')) return
      hide()
      over = el
      show(el)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', hide)
    // Whatever is done with the element, or moves it away, ends the tip.
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('scroll', hide, true)
    document.addEventListener('keydown', onKey, true)
    document.documentElement.addEventListener('mouseleave', hide)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('keydown', onKey, true)
      document.documentElement.removeEventListener('mouseleave', hide)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
    }
  }, [])

  // Placed once its own size is known: above the element where there is room, below it otherwise,
  // in the middle of it, and never reaching past the edge of the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!tip || !el) return setPlace(null)
    const { width, height } = el.getBoundingClientRect()
    const above = tip.box.top - GAP - height
    const top = above >= MARGIN ? above : Math.min(tip.box.bottom + GAP, window.innerHeight - MARGIN - height)
    const middle = tip.box.left + tip.box.width / 2 - width / 2
    setPlace({ left: Math.max(MARGIN, Math.min(middle, window.innerWidth - MARGIN - width)), top: Math.max(MARGIN, top) })
  }, [tip])

  if (!tip) return null
  return (
    // Not read out a second time: the element says the same to a screen reader by its own name.
    <div ref={ref} className="tip" aria-hidden="true" data-placed={place ? '' : undefined} style={place ?? { left: 0, top: 0 }}>
      {tip.text}
    </div>
  )
}
