import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { SkillInfo } from '../../shared/types.ts'

const api = window.harness

/** The message box, with a menu for picking a skill by button or by typing "/". */
export function Composer({
  blocked,
  running,
  onSend,
  onStop
}: {
  /** Why sending is impossible right now; empty when it is possible. */
  blocked: string
  running: boolean
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)

  // "/name" with nothing after it is a skill search; "/usr/bin is missing" is an ordinary message.
  const slash = /^\/([\w-]*)$/.exec(draft)
  const slashOpen = slash !== null && dismissed !== draft
  const visible = !blocked && (menuOpen || slashOpen)
  const filter = slashOpen ? slash[1].toLowerCase() : ''
  const matches = visible ? skills.filter((s) => s.name.toLowerCase().includes(filter)) : []
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0))

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
    <div className="composer">
      <div className="composer-main" ref={areaRef}>
        {visible && (
          <div className="skill-menu" id="skill-menu" role="listbox" aria-label="Skills">
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
        </div>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder={blocked || '输入消息，Enter 发送，Shift+Enter 换行，输入 / 选择 Skill'}
          disabled={Boolean(blocked)}
          rows={3}
          aria-controls={visible ? 'skill-menu' : undefined}
        />
      </div>
      {running ? (
        <button className="btn" onClick={onStop}>
          停止
        </button>
      ) : (
        <button className="btn btn-primary" onClick={submit} disabled={Boolean(blocked) || !draft.trim()}>
          发送
        </button>
      )}
    </div>
  )
}
