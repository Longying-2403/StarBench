import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { groupByWorkspace } from '../../shared/folders.ts'
import { SESSION_ICONS } from '../../shared/types.ts'
import type { SessionIcon, SessionSummary } from '../../shared/types.ts'
import {
  ArchiveIcon,
  ChevronDownIcon,
  ComposeIcon,
  FolderIcon,
  MoreIcon,
  PlusIcon,
  ResetIcon,
  SettingsIcon,
  TrashIcon
} from './icons.tsx'
import { NoMarkIcon, SessionMark, markLabel } from './SessionIcons.tsx'
import { errorText, isWindows, useOutsidePress } from './util.ts'

const COLLAPSED_KEY = 'collapsedWorkspaces'

function readCollapsed(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

const WIDTH_KEY = 'sidebarWidth'
/** The sidebar's width in pixels: what it starts with, and how far its edge can be dragged. */
const WIDTH = { initial: 240, min: 180, max: 480 } as const
/** What the chat beside the sidebar always keeps. The stylesheet's `--sidebar` holds to the same numbers. */
const CHAT_MIN = 420

/** The widest the sidebar can be in the window as it is now. */
const widestNow = (): number => Math.max(WIDTH.min, Math.min(WIDTH.max, window.innerWidth - CHAT_MIN))
const fitWidth = (px: number): number => Math.round(Math.min(widestNow(), Math.max(WIDTH.min, px)))

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    return stored >= WIDTH.min && stored <= WIDTH.max ? Math.round(stored) : WIDTH.initial
  } catch {
    return WIDTH.initial
  }
}

/**
 * The sidebar's right edge. Dragging it makes the sidebar wider or narrower, a double click puts
 * the usual width back, and the arrow keys move it without a mouse. The width is remembered.
 */
function Resizer() {
  /** The width that was chosen. A small window may show the sidebar narrower; see `--sidebar`. */
  const [width, setWidth] = useState(readWidth)
  /** Where the drag under way started: the pointer's place, and the width the sidebar had. */
  const drag = useRef<{ x: number; width: number; moved: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)

  // The stylesheet lays the window out from this number. Set before the first paint, so the
  // sidebar does not start at the usual width and jump.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
  }, [width])

  const keep = (px: number): void => {
    const next = fitWidth(px)
    setWidth(next)
    try {
      localStorage.setItem(WIDTH_KEY, String(next))
    } catch {
      // Remembering the width is a convenience; the sidebar works without it.
    }
  }

  /** The width the sidebar has on screen, which is where a change starts from. */
  const shown = (handle: HTMLElement): number => handle.parentElement?.getBoundingClientRect().width ?? width

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // Keeps the press from selecting text.
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, width: shown(e.currentTarget), moved: false }
    setDragging(true)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const from = drag.current
    if (!from || (!from.moved && e.clientX === from.x)) return
    from.moved = true
    setWidth(fitWidth(from.width + e.clientX - from.x))
  }

  const finish = (e: PointerEvent<HTMLDivElement>, commit: boolean): void => {
    const from = drag.current
    if (!from) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    drag.current = null
    setDragging(false)
    // A press without a drag changes nothing: it may be the first half of a double click.
    if (commit && from.moved) keep(from.width + e.clientX - from.x)
    else setWidth(readWidth())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const steps: Record<string, number> = { ArrowLeft: -16, ArrowRight: 16 }
    let next: number
    if (e.key in steps) next = shown(e.currentTarget) + steps[e.key]
    else if (e.key === 'Home') next = WIDTH.min
    else if (e.key === 'End') next = WIDTH.max
    else if (e.key === 'Enter') next = WIDTH.initial
    else return
    e.preventDefault()
    keep(next)
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="侧边栏宽度"
      aria-valuemin={WIDTH.min}
      aria-valuemax={WIDTH.max}
      aria-valuenow={width}
      title="拖动调整侧边栏宽度，双击恢复默认"
      data-dragging={dragging ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onDoubleClick={() => keep(WIDTH.initial)}
      onKeyDown={onKeyDown}
    />
  )
}

interface Actions {
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onArchive: (id: string, archived: boolean) => Promise<void>
  /** Null takes the mark away. */
  onIcon: (id: string, icon: SessionIcon | null) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

/** The size the session menu takes on screen, for keeping it inside the window. `.menu.session-menu` has the width. */
const MENU = { width: 188, height: 208 }
/** How many marks the menu shows in a row; `.icon-grid` has as many columns. */
const MARK_COLUMNS = 6

/** One session in the list: its mark and its name, and a menu to mark, rename, archive or delete it. */
function SessionRow({
  session,
  active,
  busy,
  markSlot,
  onError,
  onOpen,
  onRename,
  onArchive,
  onIcon,
  onDelete
}: Actions & {
  session: SessionSummary
  active: boolean
  /** While a turn runs, sessions can be neither switched nor changed. */
  busy: boolean
  /** Room for a mark is kept even without one, because a session around this one has a mark: the names stay in line. */
  markSlot: boolean
  onError: (message: string) => void
}) {
  /** Where the menu is shown, in window coordinates; null while it is closed. */
  const [menu, setMenu] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  /** The new name being typed; null while the row is not being renamed. */
  const [draft, setDraft] = useState<string | null>(null)
  /** Deleting takes a second press on the same entry. */
  const [confirming, setConfirming] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)

  const closeMenu = (refocus: boolean): void => {
    setMenu(null)
    setConfirming(false)
    if (refocus) moreRef.current?.focus()
  }
  useOutsidePress(menu !== null, rowRef, () => closeMenu(false))

  // The menu is placed in window coordinates, so it would stay behind if the list scrolled.
  useEffect(() => {
    if (!menu) return
    const onScroll = (): void => closeMenu(false)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  })

  useEffect(() => {
    if (menu) rowRef.current?.querySelector<HTMLElement>('.menu-item')?.focus({ preventScroll: true })
  }, [menu])

  // Renaming starts with the whole name selected, so typing replaces it.
  const renaming = draft !== null
  useEffect(() => {
    if (!renaming) return
    const input = rowRef.current?.querySelector<HTMLInputElement>('.session-rename')
    input?.focus({ preventScroll: true })
    input?.select()
  }, [renaming])

  /** Opens the menu at a point, turned upwards when it would run off the bottom of the window. */
  const openMenuAt = (x: number, top: number, bottomOfAnchor: number): void => {
    const left = Math.max(8, Math.min(x, window.innerWidth - MENU.width - 8))
    const roomBelow = window.innerHeight - bottomOfAnchor
    setConfirming(false)
    setMenu(roomBelow >= MENU.height + 12 ? { left, top: bottomOfAnchor + 4 } : { left, bottom: window.innerHeight - top + 4 })
  }

  const onMore = (): void => {
    if (menu) return closeMenu(false)
    const rect = moreRef.current?.getBoundingClientRect()
    if (rect) openMenuAt(rect.left, rect.top, rect.bottom)
  }

  const onContextMenu = (e: MouseEvent): void => {
    if (busy || draft !== null) return
    e.preventDefault()
    openMenuAt(e.clientX, e.clientY, e.clientY)
  }

  const run = (action: Promise<void>): void => {
    action.catch((err) => onError(errorText(err)))
  }

  const commitRename = (): void => {
    const title = (draft ?? '').replace(/\s+/g, ' ').trim()
    setDraft(null)
    if (title && title !== session.title) run(onRename(session.id, title))
  }

  const chooseIcon = (icon: SessionIcon | null): void => {
    closeMenu(false)
    if (icon !== (session.icon ?? null)) run(onIcon(session.id, icon))
  }

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return closeMenu(true)
    }
    const marks = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.icon-choice'))
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.menu-item'))
    const focused = document.activeElement as HTMLElement
    const atMark = marks.indexOf(focused)
    const atItem = items.indexOf(focused)
    let target: HTMLElement | undefined
    if (atMark >= 0) {
      // Among the marks the arrows move as in a grid; above its first row and below its last are the entries.
      if (e.key === 'ArrowRight') target = marks[Math.min(marks.length - 1, atMark + 1)]
      else if (e.key === 'ArrowLeft') target = marks[Math.max(0, atMark - 1)]
      else if (e.key === 'ArrowDown') target = marks[atMark + MARK_COLUMNS] ?? items[0]
      else if (e.key === 'ArrowUp') target = marks[atMark - MARK_COLUMNS] ?? items.at(-1)
    } else if (e.key === 'ArrowDown') {
      target = items[atItem + 1] ?? marks[0]
    } else if (e.key === 'ArrowUp') {
      // From the first entry up into the marks: to the one in use.
      target = atItem > 0 ? items[atItem - 1] : marks.find((m) => m.getAttribute('aria-checked') === 'true')
    }
    if (!target) return
    e.preventDefault()
    target.focus()
  }

  const mark = (session.icon || markSlot) && (
    <span className="session-icon" aria-hidden="true">
      {session.icon && <SessionMark name={session.icon} />}
    </span>
  )

  return (
    <div
      ref={rowRef}
      className={`session ${active ? 'session-active' : ''} ${menu ? 'session-menu-open' : ''}`}
      onContextMenu={onContextMenu}
    >
      {draft === null ? (
        <button className="session-open" disabled={busy} onClick={() => onOpen(session.id)} title={session.title}>
          {mark}
          <span className="session-title">{session.title}</span>
        </button>
      ) : (
        <input
          className="session-rename"
          value={draft}
          aria-label="会话名称"
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            // While an IME is composing, Enter confirms its candidate, not the name.
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setDraft(null)
          }}
        />
      )}
      {draft === null && (
        <button
          ref={moreRef}
          className="session-more"
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          aria-label={`会话"${session.title}"的更多操作`}
          title="更多操作"
          onClick={onMore}
        >
          <MoreIcon />
        </button>
      )}
      {menu && (
        <div className="menu session-menu" role="menu" style={menu} onKeyDown={onMenuKeyDown}>
          {/* The marks, one press away: the first takes the mark off again. */}
          <div className="icon-grid" role="group" aria-label="图标">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!session.icon}
              className="icon-choice"
              aria-label="不用图标"
              title="不用图标"
              onClick={() => chooseIcon(null)}
            >
              <NoMarkIcon />
            </button>
            {SESSION_ICONS.map((name) => (
              <button
                key={name}
                type="button"
                role="menuitemradio"
                aria-checked={session.icon === name}
                className="icon-choice"
                aria-label={markLabel(name)}
                title={markLabel(name)}
                onClick={() => chooseIcon(name)}
              >
                <SessionMark name={name} />
              </button>
            ))}
          </div>
          <div className="menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              closeMenu(false)
              setDraft(session.title)
            }}
          >
            <ComposeIcon />
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              closeMenu(false)
              run(onArchive(session.id, !session.archived))
            }}
          >
            {session.archived ? <ResetIcon /> : <ArchiveIcon />}
            {session.archived ? '取消归档' : '归档'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item menu-item-danger"
            onClick={() => {
              if (!confirming) return setConfirming(true)
              closeMenu(false)
              run(onDelete(session.id))
            }}
          >
            <TrashIcon />
            {confirming ? '确认删除？' : '删除'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The left column: a button for a new chat, the sessions sorted into their workspaces,
 * the archived ones tucked away below, and the settings.
 */
export function Sidebar({
  sessions,
  activeId,
  busy,
  onNewChat,
  onSettings,
  ...actions
}: Actions & {
  /** Most recent first. */
  sessions: SessionSummary[]
  activeId: string | null
  busy: boolean
  /** With a folder, the new chat starts in that workspace. */
  onNewChat: (workspace?: string) => void
  onSettings: () => void
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [error, setError] = useState('')

  const groups = groupByWorkspace(
    sessions.filter((s) => !s.archived),
    isWindows
  )
  const archived = sessions.filter((s) => s.archived)

  const toggle = (key: string): void => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
    } catch {
      // Remembering what is folded is a convenience; the list works without it.
    }
  }

  // A message about a failed action goes away by itself.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(''), 6000)
    return () => clearTimeout(timer)
  }, [error])

  /** The sessions of one group. When one of them has a mark, all of them keep room for one. */
  const rows = (list: SessionSummary[]) => {
    const markSlot = list.some((s) => s.icon)
    return list.map((session) => (
      <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeId}
        busy={busy}
        markSlot={markSlot}
        onError={setError}
        {...actions}
      />
    ))
  }

  return (
    <aside className="sidebar">
      <button className="btn btn-primary sidebar-new" onClick={() => onNewChat()} disabled={busy}>
        <ComposeIcon />
        新对话
      </button>
      <nav className="sessions" aria-label="会话">
        {groups.length > 0 && <div className="sidebar-label">工作区</div>}
        {groups.map((group) => {
          const open = !collapsed.includes(group.key)
          return (
            <section key={group.key} className="group">
              <div className="group-head">
                <button className="group-toggle" aria-expanded={open} onClick={() => toggle(group.key)} title={group.workspace}>
                  <span className="group-chevron">
                    <ChevronDownIcon />
                  </span>
                  <FolderIcon />
                  <span className="group-name">{group.name}</span>
                </button>
                <button
                  className="group-add"
                  disabled={busy}
                  onClick={() => onNewChat(group.workspace)}
                  aria-label={`在 ${group.name} 里开始新对话`}
                  title="在这个文件夹里开始新对话"
                >
                  <PlusIcon />
                </button>
              </div>
              {open && <div className="group-body">{rows(group.sessions)}</div>}
            </section>
          )
        })}
        {sessions.length === 0 && <p className="sidebar-empty">还没有对话。选一个工作文件夹，发出第一条消息后会出现在这里。</p>}
        {archived.length > 0 && (
          <section className="group group-archived">
            <div className="group-head">
              <button className="group-toggle" aria-expanded={archivedOpen} onClick={() => setArchivedOpen((v) => !v)}>
                <span className="group-chevron">
                  <ChevronDownIcon />
                </span>
                <ArchiveIcon />
                <span className="group-name">已归档</span>
                <span className="group-count">{archived.length}</span>
              </button>
            </div>
            {archivedOpen && <div className="group-body">{rows(archived)}</div>}
          </section>
        )}
      </nav>
      {error && (
        <div className="msg-error sidebar-error" role="alert">
          {error}
        </div>
      )}
      <button className="btn sidebar-settings" onClick={onSettings}>
        <SettingsIcon />
        设置
      </button>
      <Resizer />
    </aside>
  )
}
