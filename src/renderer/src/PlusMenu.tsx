import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { SkillInfo } from '../../shared/types.ts'
import { BookIcon, ChevronRightIcon, PaperclipIcon, PlusIcon, line } from './icons.tsx'
import { menuItems, moveInMenu } from './menu.ts'
import { roomStyle, useOutsidePress, usePopupPlace } from './util.ts'

const api = window.harness

/** A command: a slash in a box, as it is typed. */
function CommandIcon() {
  return (
    <svg {...line}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m10 16 4-8" />
    </svg>
  )
}

/**
 * The "+" at the lower left of the message box: what can be put with a message. A menu with an
 * entry for adding files, one for the skills and one for the commands (skills only the person
 * picks, such as the memory's), whose lists open beside it. Typing "/" into the box still finds
 * them by name; this is the way there for the mouse.
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
  /** Which list is open beside the menu: the skills, or the commands. */
  const [sub, setSub] = useState<'skills' | 'commands' | null>(null)
  /** Null until the list has been read. */
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const skillsItemRef = useRef<HTMLButtonElement>(null)
  const commandsItemRef = useRef<HTMLButtonElement>(null)
  /** What the open list shows: the skills, or the commands, which only the person picks. */
  const commands = skills?.filter((skill) => skill.userOnly) ?? []
  const listed = sub === 'commands' ? commands : (skills?.filter((skill) => !skill.userOnly) ?? null)
  /** Set when the list of skills was opened with the keyboard: its first entry then takes the keyboard once it is there. */
  const intoSub = useRef(false)
  // Room for the list of skills at its tallest; the popups sit 6px from the button.
  const place = usePopupPlace(open, triggerRef, 320, 6)

  const close = (refocus: boolean): void => {
    setOpen(false)
    setSub(null)
    if (refocus) triggerRef.current?.focus()
  }
  useOutsidePress(open, rootRef, () => close(false))

  const show = (): void => {
    setOpen(true)
    setSub(null)
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

  const openSub = (which: 'skills' | 'commands', withKeyboard: boolean): void => {
    intoSub.current = withKeyboard
    setSub(which)
    // Already open: the keyboard goes into it now.
    if (withKeyboard && sub === which) menuItems(subRef.current)[0]?.focus({ preventScroll: true })
  }

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    const which = document.activeElement === skillsItemRef.current ? 'skills' : document.activeElement === commandsItemRef.current ? 'commands' : null
    if (e.key === 'ArrowRight' && which) {
      e.preventDefault()
      openSub(which, true)
      return
    }
    moveInMenu(e, menuRef.current)
  }

  const onSubKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      // Back to the entry the list belongs to; the menu stays.
      e.preventDefault()
      e.stopPropagation()
      const back = sub === 'commands' ? commandsItemRef : skillsItemRef
      setSub(null)
      back.current?.focus({ preventScroll: true })
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
        data-tip="添加文件或 Skill"
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
              onMouseEnter={() => setSub(null)}
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
              aria-expanded={sub === 'skills'}
              data-open={sub === 'skills' ? '' : undefined}
              onMouseEnter={() => openSub('skills', false)}
              // A press is a keyboard's Enter as well: either way the list is wanted, and the keyboard goes into it.
              onClick={() => openSub('skills', true)}
            >
              <BookIcon />
              <span className="menu-item-grow">Skills</span>
              <ChevronRightIcon />
            </button>
            {/* Only when there is a command to pick: the memory's, while it is on, or one of the person's own. */}
            {commands.length > 0 && (
              <button
                ref={commandsItemRef}
                type="button"
                role="menuitem"
                className="menu-item"
                aria-haspopup="menu"
                aria-expanded={sub === 'commands'}
                data-open={sub === 'commands' ? '' : undefined}
                data-tip="只由你选用的 Skill，模型自己不会调用"
                onMouseEnter={() => openSub('commands', false)}
                onClick={() => openSub('commands', true)}
              >
                <CommandIcon />
                <span className="menu-item-grow">指令</span>
                <ChevronRightIcon />
              </button>
            )}
          </div>
          {sub && (
            <div ref={subRef} className="menu plus-sub" role="menu" aria-label={sub === 'commands' ? '指令' : 'Skills'} onKeyDown={onSubKey}>
              {listed === null ? null : listed.length === 0 ? (
                <div className="skill-empty">还没有 Skill。在“设置 → Skills”里可以打开文件夹添加。</div>
              ) : (
                <div className="menu-list">
                  {listed.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      data-tip={skill.description}
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
