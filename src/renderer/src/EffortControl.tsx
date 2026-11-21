import { useEffect, useRef, useState } from 'react'
import type { ModelInfo, ReasoningEffort } from '../../shared/types.ts'
import { BoltIcon, ChevronDownIcon, ResetIcon } from './icons.tsx'
import { Slider } from './Slider.tsx'
import { popupSide, useOutsidePress } from './util.ts'

/** A level the user can put the slider on; "default" means none was chosen. */
type Level = Exclude<ReasoningEffort, 'default'>

const LEVELS: readonly Level[] = ['none', 'low', 'high', 'max']
const LABELS: Record<Level, string> = { none: '关闭', low: '低', high: '高', max: '最高' }

/**
 * The model and its thinking effort, shown in the message box. Pressing it opens a small card
 * with a slider from "off" to the highest level the model offers.
 */
export function EffortControl({
  model,
  modelInfo,
  effort,
  onChange
}: {
  /** The model id from the settings. */
  model: string
  /** What the service says about that model, once known. */
  modelInfo: ModelInfo | null
  effort: ReasoningEffort
  onChange: (effort: ReasoningEffort) => void
}) {
  const [open, setOpen] = useState(false)
  /** Where the card opens; decided each time, since the message box moves from the middle to the bottom. */
  const [side, setSide] = useState<'up' | 'down'>('down')
  /** The stop under the pointer while the slider is dragged. */
  const [preview, setPreview] = useState<number | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // "Off" is always offered; the rest follows the service when it says which levels the model takes.
  // The saved choice stays on the slider either way, so it never shows something else than what is sent.
  const offered = modelInfo?.efforts
  const levels = LEVELS.filter((id) => id === 'none' || id === effort || !offered || offered.includes(id))
  const recommended = modelInfo?.defaultEffort
  const chosen = effort === 'default' ? undefined : effort
  /** With nothing chosen the service decides; the slider shows its level when that is known. */
  const shown = chosen ?? recommended
  const index = shown ? levels.indexOf(shown) : -1
  const displayed = levels[preview ?? index]
  const levelText = displayed ? LABELS[displayed] : '默认'

  const name = modelInfo?.name ?? model
  const canReset = chosen !== undefined && chosen !== recommended
  // "Recommended" only when the service named a level; otherwise it is simply whatever the service does.
  const resetText = recommended
    ? canReset
      ? `重设为推荐值（${LABELS[recommended]}）`
      : '已经是推荐值'
    : canReset
      ? '重设为默认值'
      : '已经是默认值'

  const close = (refocus: boolean): void => {
    setOpen(false)
    setPreview(null)
    if (refocus) triggerRef.current?.focus()
  }
  useOutsidePress(open, rootRef, () => close(false))

  // The slider takes the keyboard as soon as the card opens.
  useEffect(() => {
    if (open) rootRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true })
  }, [open])

  return (
    <span className="effort" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="effort-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`模型 ${name}，思考强度 ${levelText}，点击调整`}
        title={`模型：${model}\n思考强度：${levelText}（从下一条消息开始生效）`}
        onClick={() => {
          if (open) return close(false)
          setSide(popupSide(triggerRef.current, 130))
          setOpen(true)
        }}
      >
        <span className="effort-model">{name}</span>
        <span className="effort-level">{levelText}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div
          className="effort-panel"
          role="dialog"
          aria-label="调整思考强度"
          data-level={displayed}
          data-side={side}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            close(true)
          }}
        >
          <div className="effort-head">
            {/* A place for a faster-answers switch. No model the app talks to offers one yet. */}
            <button type="button" className="icon-btn" disabled aria-label="Fast Mode" title="当前模型不支持 Fast Mode">
              <BoltIcon />
            </button>
            <div className="effort-heading">
              <div className="effort-level-name">{levelText}</div>
              <div className="effort-model-name" title={model}>
                {name}
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              disabled={!canReset}
              aria-label={resetText}
              title={resetText}
              onClick={() => {
                onChange('default')
                // The button disables itself once the default is back; the keyboard stays in the card.
                rootRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true })
              }}
            >
              <ResetIcon />
            </button>
          </div>
          <Slider
            stops={levels.map((id) => LABELS[id])}
            index={index}
            label="思考强度"
            emptyText="默认"
            // The harder the model thinks, the livelier the slider.
            sparks={displayed === 'max' ? 14 : displayed === 'high' ? 5 : 0}
            onPreview={setPreview}
            onCommit={(at) => levels[at] !== shown && onChange(levels[at])}
          />
        </div>
      )}
    </span>
  )
}
