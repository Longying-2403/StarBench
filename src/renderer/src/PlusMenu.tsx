import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { SkillInfo } from '../../shared/types.ts'
import { BookIcon, ChevronRightIcon, PaperclipIcon, PlusIcon } from './icons.tsx'
import { menuItems, moveInMenu } from './menu.ts'
import { roomStyle, useOutsidePress, usePopupPlace } from './util.ts'

const api = window.harness

/**
 * The "+" at the lower left of the message box: what can be put with a message. A menu with an
 * entry for adding files, and one for the skills, whose list opens beside it. Typing "/" into
 * the box still finds a skill by name; this is the way there for the mouse.
 */
export function PlusMenu({
  disabled,
  onAddFiles,
  onPickSkill
}: {
  disabled: boolean
  /** Opens the system dialog for picking files. */
  onAddFiles: () => void
  onPickSkill: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  /** The list of skills is open beside the menu. */
  const [sub, setSub] = useState(false)
  /** Null until the list has been read. */
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const skillsItemRef = useRef<HTMLButtonElement>(null)
  /** Set when the list of skills was opened with the keyboard: its first entry then takes the keyboard once it is there. */
  const intoSub = useRef(false)
  // Room for the list of skills at its tallest; the popups sit 6px from the button.
  const place = usePopupPlace(open, triggerRef, 320, 6)

  const close = (refocus: boolean): void => {
    setOpen(false)
    setSub(false)
    if (refocus) triggerRef.current?.focus()
  }
  useOutsidePress(open, rootRef, () => close(false))

  const show = (): void => {
    setOpen(true)
    setSub(false)
    // Read each time: skills can be added while the app is running.
    setSkills(null)
    api.listSkills().then(setSkills, () => setSkills([]))
  }

  // The keyboard starts on the first entry.
  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!sub || skills === null || !intoSub.current) return
    intoSub.current = false
    menuItems(subRef.current)[0]?.focus({ preventScroll: true })
  }, [sub, skills])

  const openSub = (withKeyboard: boolean): void => {
    intoSub.current = withKeyboard
    setSub(true)
    // Already open: the keyboard goes into it now.
    if (withKeyboard && sub) menuItems(subRef.current)[0]?.focus({ preventScroll: true })
  }

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (e.key === 'ArrowRight' && document.activeElement === skillsItemRef.current) {
      e.preventDefault()
      openSub(true)
      return
    }
    moveInMenu(e, menuRef.current)
  }

  const onSubKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      // Back to the entry the list belongs to; the menu stays.
      e.preventDefault()
      e.stopPropagation()
      setSub(false)
      skillsItemRef.current?.focus({ preventScroll: true })
      return
    }
    moveInMenu(e, subRef.current)
  }

  return (
    <div className="plus-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="plus-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="添加文件或 Skill"
        title="添加文件或 Skill"
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
      >
        <PlusIcon />
      </button>
      {open && (
        <div className="plus-pop" data-side={place.side} style={roomStyle(place)}>
          <div ref={menuRef} className="menu plus-menu" role="menu" aria-label="添加" onKeyDown={onMenuKey}>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onMouseEnter={() => setSub(false)}
              onClick={() => {
                close(false)
                onAddFiles()
              }}
            >
              <PaperclipIcon />
              <span className="menu-item-grow">添加文件…</span>
            </button>
            <button
              ref={skillsItemRef}
              type="button"
              role="menuitem"
              className="menu-item"
              aria-haspopup="menu"
              aria-expanded={sub}
              data-open={sub ? '' : undefined}
              onMouseEnter={() => openSub(false)}
              // A press is a keyboard's Enter as well: either way the list is wanted, and the keyboard goes into it.
              onClick={() => openSub(true)}
            >
              <BookIcon />
              <span className="menu-item-grow">Skills</span>
              <ChevronRightIcon />
            </button>
          </div>
          {sub && (
            <div ref={subRef} className="menu plus-sub" role="menu" aria-label="Skills" onKeyDown={onSubKey}>
              {skills === null ? null : skills.length === 0 ? (
                <div className="skill-empty">还没有 Skill。在“设置 → Skills”里可以打开文件夹添加。</div>
              ) : (
                <div className="menu-list">
                  {skills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      title={skill.description}
                      onClick={() => {
                        onPickSkill(skill.name)
                        close(false)
                      }}
                    >
                      <span className="menu-item-text">
                        <span className="menu-item-name skill-name">{skill.name}</span>
                        {skill.description && <span className="menu-item-path">{skill.description}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
