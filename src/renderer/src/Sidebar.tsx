import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { groupByWorkspace } from '../../shared/folders.ts'
import type { SessionSummary } from '../../shared/types.ts'
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

interface Actions {
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onArchive: (id: string, archived: boolean) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

/** One session in the list: its name, and a menu to rename, archive or delete it. */
function SessionRow({
  session,
  active,
  busy,
  onError,
  onOpen,
  onRename,
  onArchive,
  onDelete
}: Actions & {
  session: SessionSummary
  active: boolean
  /** While a turn runs, sessions can be neither switched nor changed. */
  busy: boolean
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
    const left = Math.max(8, Math.min(x, window.innerWidth - 168))
    const roomBelow = window.innerHeight - bottomOfAnchor
    setConfirming(false)
    setMenu(roomBelow >= 130 ? { left, top: bottomOfAnchor + 4 } : { left, bottom: window.innerHeight - top + 4 })
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

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return closeMenu(true)
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.menu-item'))
    const at = all.indexOf(document.activeElement as HTMLElement)
    e.preventDefault()
    all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
  }

  return (
    <div
      ref={rowRef}
      className={`session ${active ? 'session-active' : ''} ${menu ? 'session-menu-open' : ''}`}
      onContextMenu={onContextMenu}
    >
      {draft === null ? (
        <button className="session-open" disabled={busy} onClick={() => onOpen(session.id)} title={session.title}>
          {session.title}
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

  const row = (session: SessionSummary) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === activeId}
      busy={busy}
      onError={setError}
      {...actions}
    />
  )

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
              {open && <div className="group-body">{group.sessions.map(row)}</div>}
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
            {archivedOpen && <div className="group-body">{archived.map(row)}</div>}
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
    </aside>
  )
}
