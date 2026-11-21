import { useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'

const TRACK_PX = 22
/** Distance from each end of the track to the outermost stops: half the track height. */
const INSET_PX = TRACK_PX / 2

/** A repeatable number between 0 and 1 for particle `i`, so particles keep their place from one render to the next. */
const scatter = (i: number, salt: number): number => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Where one particle sits in the fill, how far it drifts and how fast it twinkles. */
const sparkStyle = (i: number): CSSProperties =>
  ({
    left: `${4 + scatter(i, 1) * 88}%`,
    top: `${18 + scatter(i, 2) * 64}%`,
    '--spark-size': `${1.4 + scatter(i, 3) * 1.4}px`,
    '--spark-dx': `${3 + scatter(i, 4) * 7}px`,
    '--spark-dy': `${-3 + scatter(i, 5) * 6}px`,
    animationDuration: `${2.2 + scatter(i, 6) * 2.6}s`,
    // Negative, so the particles are already out of step when the slider appears.
    animationDelay: `${-scatter(i, 7) * 5}s`
  }) as CSSProperties

const fractionOf = (index: number, count: number): number => (count < 2 ? 0 : index / (count - 1))
const nearestStop = (fraction: number, count: number): number => Math.round(fraction * (count - 1))

/**
 * A slider with a few named stops: one dot per stop, a fill up to a round thumb.
 * Dragging follows the pointer and snaps to the nearest stop on release; the arrow keys,
 * Home and End step between stops. `index` is -1 while no stop is selected.
 */
export function Slider({
  stops,
  index,
  label,
  emptyText,
  sparks = 0,
  onPreview,
  onCommit
}: {
  /** The names of the stops, lowest first. */
  stops: readonly string[]
  index: number
  label: string
  /** Read out when no stop is selected. */
  emptyText: string
  /** How many twinkling particles drift in the filled part. */
  sparks?: number
  /** The stop under the pointer during a drag; null when the drag ends. */
  onPreview: (index: number | null) => void
  onCommit: (index: number) => void
}) {
  const count = stops.length
  /** Position of the drag between 0 and 1, while one is in progress. */
  const [drag, setDrag] = useState<number | null>(null)
  const fraction = drag ?? (index >= 0 && index < count ? fractionOf(index, count) : null)
  const shownIndex = drag === null ? index : nearestStop(drag, count)

  const locate = (e: PointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    const usable = rect.width - INSET_PX * 2
    return usable <= 0 ? 0 : Math.min(1, Math.max(0, (e.clientX - rect.left - INSET_PX) / usable))
  }

  const follow = (e: PointerEvent<HTMLDivElement>): void => {
    const at = locate(e)
    setDrag(at)
    onPreview(nearestStop(at, count))
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || count < 2) return
    // Keeps the press from selecting text; the keyboard keeps working after a drag.
    e.preventDefault()
    e.currentTarget.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    follow(e)
  }

  const finish = (e: PointerEvent<HTMLDivElement>, commit: boolean): void => {
    if (drag === null) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDrag(null)
    onPreview(null)
    if (commit) onCommit(nearestStop(drag, count))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || count < 2) return
    const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }
    let next: number
    if (e.key in steps) next = Math.min(count - 1, Math.max(0, index + steps[e.key]))
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = count - 1
    else return
    e.preventDefault()
    e.stopPropagation()
    if (next !== index) onCommit(next)
  }

  return (
    <div
      className="slider"
      style={
        { '--slider-pos': fraction ?? 0, '--slider-track': `${TRACK_PX}px`, '--slider-inset': `${INSET_PX}px` } as CSSProperties
      }
      data-dragging={drag === null ? undefined : ''}
    >
      <div
        className="slider-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="horizontal"
        // "No stop selected" is exposed as one position below the first stop.
        aria-valuemin={shownIndex < 0 ? -1 : 0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={shownIndex}
        aria-valuetext={stops[shownIndex] ?? emptyText}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => drag !== null && follow(e)}
        onPointerUp={(e) => finish(e, true)}
        onPointerCancel={(e) => finish(e, false)}
        onKeyDown={onKeyDown}
      >
        {fraction !== null && (
          <div className="slider-fill" aria-hidden="true">
            {Array.from({ length: sparks }, (_, i) => (
              <span key={i} className="slider-spark" style={sparkStyle(i)} />
            ))}
          </div>
        )}
        {stops.map((stop, at) => {
          const position = fractionOf(at, count)
          return (
            <span
              key={stop}
              className="slider-dot"
              style={{ '--slider-at': position } as CSSProperties}
              data-filled={fraction !== null && position <= fraction + 1e-6 ? '' : undefined}
              aria-hidden="true"
            />
          )
        })}
        {fraction !== null && <div className="slider-thumb" aria-hidden="true" />}
      </div>
    </div>
  )
}
