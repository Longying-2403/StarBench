import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { PERMISSION_MODES } from '../../shared/permissions.ts'
import type { PermissionMode } from '../../shared/permissions.ts'
import { CheckIcon, ChevronDownIcon, EyeIcon, HandIcon, PencilIcon, UnlockIcon } from './icons.tsx'
import { menuItems, moveInMenu } from './menu.ts'
import { roomStyle, useOutsidePress, usePopupPlace } from './util.ts'

/** What each mode is called, what it lets the model do, and the drawing it goes by. */
const MODES: Record<PermissionMode, { name: string; about: string; icon: () => ReactNode }> = {
  view: { name: '仅可查看', about: '只读取和搜索文件，不修改、不执行', icon: EyeIcon },
  ask: { name: '每次询问', about: '修改文件、执行命令前都先问你', icon: HandIcon },
  edit: { name: '工作区内修改', about: '改工作文件夹里的文件不再问，命令仍然先问', icon: PencilIcon },
  full: { name: '完全权限', about: '全部直接执行，不再询问；命令不限于工作文件夹', icon: UnlockIcon }
}

/**
 * What the model may do in the conversation without asking: a button at the lower left of the
 * message box that says which mode is in force, and a menu to pick another. The mode with
 * nothing held back is red, on the button as in the menu, so that it is not left on unnoticed.
 */
export function ModeMenu({ mode, onChange }: { mode: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Four entries of two lines each, under a heading; `.menu` sits 6px from the button.
  const place = usePopupPlace(open, triggerRef, 250, 6)

  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }
  useOutsidePress(open, rootRef, () => close(false))

  // The keyboard starts on the mode in force.
  useEffect(() => {
    if (!open) return
    const all = menuItems(menuRef.current)
    ;(all.find((el) => el.getAttribute('aria-checked') === 'true') ?? all[0])?.focus({ preventScroll: true })
  }, [open])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    moveInMenu(e, menuRef.current)
  }

  const current = MODES[mode]
  const Current = current.icon
  return (
    <div className="mode-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="mode-trigger"
        data-mode={mode}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`权限：${current.name}`}
        title={`权限：${current.name}。${current.about}`}
        onClick={() => setOpen((now) => !now)}
      >
        <Current />
        <span className="mode-name">{current.name}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div ref={menuRef} className="menu mode-menu" role="menu" aria-label="模型可以做什么" data-side={place.side} style={roomStyle(place)} onKeyDown={onKeyDown}>
          <div className="menu-label">模型可以做什么</div>
          {PERMISSION_MODES.map((id) => {
            const { name, about, icon: Icon } = MODES[id]
            return (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={id === mode}
                className={`menu-item${id === 'full' ? ' menu-item-danger' : ''}`}
                onClick={() => {
                  if (id !== mode) onChange(id)
                  close(true)
                }}
              >
                <Icon />
                <span className="menu-item-text">
                  <span className="menu-item-name">{name}</span>
                  <span className="menu-item-path">{about}</span>
                </span>
                {id === mode && <CheckIcon />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
