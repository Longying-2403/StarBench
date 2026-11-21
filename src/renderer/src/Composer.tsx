import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ModelInfo, ReasoningEffort, SkillInfo } from '../../shared/types.ts'
import { EffortControl } from './EffortControl.tsx'
import { EnterIcon, StopIcon } from './icons.tsx'
import { popupSide } from './util.ts'

const api = window.harness

/**
 * The message box: the text, a menu for picking a skill by button or by typing "/",
 * the model with its thinking effort, and the send button.
 */
export function Composer({
  blocked,
  running,
  model,
  modelInfo,
  effort,
  onEffortChange,
  onSend,
  onStop
}: {
  /** Why sending is impossible right now; empty when it is possible. */
  blocked: string
  running: boolean
  /** The model id from the settings. */
  model: string
  /** What the service says about that model, once known. */
  modelInfo: ModelInfo | null
  effort: ReasoningEffort
  onEffortChange: (effort: ReasoningEffort) => void
  onSend: (text: string, skill?: string) => void
  onStop: () => void
}) {
  const [draft, setDraft] = useState('')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  /** Opened with the Skills button; the "/" trigger is derived from the draft instead. */
  const [menuOpen, setMenuOpen] = useState(false)
  /** The draft for which Escape closed the "/" menu, so it stays closed until the text changes. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [menuSide, setMenuSide] = useState<'up' | 'down'>('up')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)

  // "/name" with nothing after it is a skill search; "/usr/bin is missing" is an ordinary message.
  const slash = /^\/([\w-]*)$/.exec(draft)
  const slashOpen = slash !== null && dismissed !== draft
  const visible = !blocked && (menuOpen || slashOpen)
  const filter = slashOpen ? slash[1].toLowerCase() : ''
  const matches = visible ? skills.filter((s) => s.name.toLowerCase().includes(filter)) : []
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0))

  // Below the box while it sits in the middle of a new chat, above it once it is at the bottom.
  useLayoutEffect(() => {
    if (visible) setMenuSide(popupSide(areaRef.current, 320))
  }, [visible])

  // Read the list each time the menu opens: skills can be added while the app is running.
  useEffect(() => {
    if (visible) api.listSkills().then(setSkills, () => setSkills([]))
  }, [visible])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!areaRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  useEffect(() => {
    if (visible) areaRef.current?.querySelector('.skill-option-active')?.scrollIntoView({ block: 'nearest' })
  }, [visible, activeIndex])

  const pick = (name: string): void => {
    setPicked(name)
    if (slashOpen) setDraft('')
    setMenuOpen(false)
    inputRef.current?.focus()
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text || running || blocked) return
    onSend(text, picked ?? undefined)
    setDraft('')
    setPicked(null)
    setMenuOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While an IME is composing, Enter and the arrows belong to its candidate list.
    if (e.nativeEvent.isComposing) return
    if (visible) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuOpen(false)
        if (slashOpen) setDismissed(draft)
        return
      }
      if (matches.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const step = e.key === 'ArrowDown' ? 1 : -1
          setActive((activeIndex + step + matches.length) % matches.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          pick(matches[activeIndex].name)
          return
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      className="composer"
      ref={areaRef}
      // The whole card is the text box: a click on its padding puts the cursor in the text.
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        inputRef.current?.focus()
      }}
    >
      {visible && (
        <div className="skill-menu" id="skill-menu" role="listbox" aria-label="Skills" data-side={menuSide}>
          {matches.length === 0 ? (
            <div className="skill-empty">
              {skills.length === 0 ? '还没有 Skill。在"设置 → Skills"里可以打开文件夹添加。' : '没有匹配的 Skill'}
            </div>
          ) : (
            matches.map((skill, index) => (
              <div
                key={skill.name}
                role="option"
                aria-selected={index === activeIndex}
                className={`skill-option ${index === activeIndex ? 'skill-option-active' : ''}`}
                title={skill.description}
                onMouseEnter={() => setActive(index)}
                // mousedown, not click: picking must not take focus away from the text box.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(skill.name)
                }}
              >
                <span className="skill-name">{skill.name}</span>
                {skill.description && <span className="skill-desc">{skill.description}</span>}
              </div>
            ))
          )}
        </div>
      )}
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        placeholder={blocked || '输入消息，Shift+Enter 换行，输入 / 选择 Skill'}
        disabled={Boolean(blocked)}
        rows={1}
        aria-label="消息"
        aria-controls={visible ? 'skill-menu' : undefined}
      />
      <div className="composer-bar">
        <button
          type="button"
          className="btn btn-small"
          aria-haspopup="listbox"
          aria-expanded={visible}
          disabled={Boolean(blocked)}
          onClick={() => {
            setActive(0)
            setMenuOpen((open) => !open)
            inputRef.current?.focus()
          }}
        >
          Skills
        </button>
        {picked && (
          <span className="chip">
            {picked}
            <button className="chip-remove" onClick={() => setPicked(null)} aria-label={`取消使用 Skill ${picked}`}>
              ×
            </button>
          </span>
        )}
        <EffortControl model={model} modelInfo={modelInfo} effort={effort} onChange={onEffortChange} />
        {running ? (
          <button type="button" className="send send-stop" onClick={onStop} aria-label="停止" title="停止">
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="send"
            onClick={submit}
            disabled={Boolean(blocked) || !draft.trim()}
            aria-label="发送"
            title="发送（Enter）"
          >
            <EnterIcon />
          </button>
        )}
      </div>
    </div>
  )
}
