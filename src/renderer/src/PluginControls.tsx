// The controls the app hands to the interfaces of plugins, so that a plugin's panel looks and
// behaves like the rest of the window: a slider for a number between two ends, a switch, and a
// field to type in. Each takes a value and tells of a new one; none keeps the value itself.
//
// What they take is a promise to the people who write plugins. A new control or a new optional
// prop is an addition; taking one away or changing what it means is not, and wants a new number
// for the plugin API (shared/plugin-ui.ts).

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
// What each control takes is written down in the types for the people who write plugins, and
// taken from there: the promise and the control cannot say different things.
import type { FieldProps, PluginUiApi, SliderProps, SwitchProps } from '../../../types/starbench-plugin'
import { decimalsOf, onSliderStep } from '../../shared/plugin-ui.ts'

/**
 * The words that name a control. A name that is not to be seen is still there for a screen
 * reader, out of the way of the layout: it takes no room, and leaves no gap where it would be.
 */
function Words({ id, label, labelHidden, hint }: { id?: string; label: string; labelHidden?: boolean; hint?: string }): ReactNode {
  const name = (
    <span id={id} className={labelHidden ? 'plugin-control-label plugin-control-unseen' : 'plugin-control-label'}>
      {label}
    </span>
  )
  if (labelHidden && !hint) return name
  return (
    <span className="plugin-control-words">
      {name}
      {hint && <span className="hint">{hint}</span>}
    </span>
  )
}

/**
 * A number between two ends: a thumb to drag, and beside it the number itself to type over.
 * What is typed counts when the box is left or Enter is pressed, and is then brought within the
 * ends and onto a step; something that is no number is dropped.
 */
export function Slider({ label, labelHidden, hint, disabled, value, min, max, step, onChange }: SliderProps) {
  const name = useId()
  /** What is being typed in the number box, while it differs from the value. */
  const [typed, setTyped] = useState<string | null>(null)
  // Ends that are no range, as a plugin's mistake may give them, leave a slider that cannot be moved.
  const sound = Number.isFinite(min) && Number.isFinite(max) && max > min
  const by = step !== undefined && Number.isFinite(step) && step > 0 ? step : sound && max - min <= 10 ? 0.01 : 1
  const places = decimalsOf(by, sound ? min : 0)
  const shown = sound ? onSliderStep(value, min, max, by) : 0
  const take = (text: string): void => {
    setTyped(null)
    const number = Number(text)
    if (text.trim() === '' || !Number.isFinite(number)) return
    const next = onSliderStep(number, min, max, by)
    if (next !== shown) onChange(next)
  }
  return (
    <div className="plugin-control" role="group" aria-labelledby={name}>
      <Words id={name} label={label} labelHidden={labelHidden} hint={hint} />
      <span className="plugin-slider">
        <input
          type="range"
          min={sound ? min : 0}
          max={sound ? max : 1}
          step={by}
          value={shown}
          disabled={disabled || !sound}
          aria-labelledby={name}
          aria-valuetext={shown.toFixed(places)}
          onChange={(e) => onChange(onSliderStep(Number(e.target.value), min, max, by))}
        />
        <input
          type="text"
          inputMode="decimal"
          className="plugin-input plugin-slider-number"
          value={typed ?? shown.toFixed(places)}
          disabled={disabled || !sound}
          aria-label={`${label}（数值）`}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={(e) => typed !== null && take(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') take(e.currentTarget.value)
            if (e.key === 'Escape') setTyped(null)
          }}
        />
      </span>
    </div>
  )
}

/** Something that is on or off. */
export function Switch({ label, labelHidden, hint, disabled, checked, onChange }: SwitchProps) {
  return (
    <label className="plugin-control plugin-control-row">
      <Words label={label} labelHidden={labelHidden} hint={hint} />
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

/** A line of text to type, or several. A number field shows the keys for numbers and keeps what is typed as text all the same. */
export function Field({ label, labelHidden, hint, disabled, value, onChange, placeholder, type = 'text', multiline }: FieldProps) {
  return (
    <label className="plugin-control">
      <Words label={label} labelHidden={labelHidden} hint={hint} />
      {multiline ? (
        <textarea className="plugin-input" rows={3} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          type="text"
          inputMode={type === 'number' ? 'decimal' : undefined}
          className="plugin-input"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  )
}

/** The controls as a plugin gets them (`api.controls`). */
export const PLUGIN_CONTROLS: PluginUiApi['controls'] = Object.freeze({ Slider, Switch, Field })
