import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode, RefObject } from 'react'
import { WORKSPACE_NAME_LIMIT, cleanWorkspaceName, folderName, groupByWorkspace, workspaceName } from '../../shared/folders.ts'
import type { WorkspaceGroup } from '../../shared/folders.ts'
import { SHORTCUTS, keysLabel } from '../../shared/shortcuts.ts'
import { SESSION_ICONS } from '../../shared/types.ts'
import type { SessionHit, SessionIcon, SessionSummary } from '../../shared/types.ts'
import { whenExact, whenText } from '../../shared/when.ts'
import {
  AppIcon,
  ArchiveIcon,
  ChevronDownIcon,
  ComposeIcon,
  FoldIcon,
  FolderIcon,
  HandIcon,
  MoreIcon,
  PluginIcon,
  PlusIcon,
  QuillIcon,
  ResetIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
  UnfoldIcon
} from './icons.tsx'
import { MemoryNavButton } from './MemoryPage.tsx'
import { NoMarkIcon, SessionMark, markLabel } from './SessionIcons.tsx'
import { errorText, isMac, isWindows, useNow, useOutsidePress, useShortcut } from './util.ts'

const COLLAPSED_KEY = 'collapsedWorkspaces'

function readCollapsed(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

const FOLDED_KEY = 'sidebarFolded'

/** Whether the sidebar was left folded away to its strip. */
function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === '1'
  } catch {
    return false
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
      data-tip="拖动调整侧边栏宽度，双击恢复默认"
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

/** What can be done to a workspace as a whole. The folder itself is never touched. */
interface WorkspaceActions {
  /** An empty name gives the workspace back the name of its folder. */
  onRenameWorkspace: (folder: string, name: string) => Promise<void>
  /** Archives the sessions the list shows under the workspace. */
  onArchiveWorkspace: (folder: string) => Promise<void>
  /** Deletes `sessions`, which are the ones the person was shown and said yes to, and takes the workspace out of the list. */
  onRemoveWorkspace: (folder: string, sessions: string[]) => Promise<void>
}

/** The size the session menu takes on screen, for keeping it inside the window. `.menu.session-menu` has the width. */
const MENU = { width: 188, height: 208 }
/** The menu of a workspace is as wide, and has its three entries without the marks above them. */
const GROUP_MENU = { width: MENU.width, height: 108 }
/** How many marks the menu shows in a row; `.icon-grid` has as many columns. */
const MARK_COLUMNS = 6

/**
 * The menu of a row of the list: of a session, or of a workspace. It opens under the row's button
 * for more, or where the row was right-clicked, in window coordinates, so that the scrolling list
 * cannot cut it off. A press elsewhere closes it, and so does the list scrolling. Both menus end
 * in an entry that deletes and takes a second press: `confirming` says that the first was made.
 */
function useRowMenu(rowRef: RefObject<HTMLElement | null>, moreRef: RefObject<HTMLElement | null>, size: { width: number; height: number }) {
  /** Where the menu is shown, in window coordinates; null while it is closed. */
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const close = (refocus: boolean): void => {
    setPlace(null)
    setConfirming(false)
    if (refocus) moreRef.current?.focus()
  }
  useOutsidePress(place !== null, rowRef, () => close(false))

  // The menu is placed in window coordinates, so it would stay behind if the list scrolled.
  useEffect(() => {
    if (!place) return
    const onScroll = (): void => close(false)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  })

  useEffect(() => {
    if (place) rowRef.current?.querySelector<HTMLElement>('.menu-item')?.focus({ preventScroll: true })
  }, [place, rowRef])

  /** Opens the menu at a point, turned upwards when it would run off the bottom of the window. */
  const openAt = (x: number, top: number, bottomOfAnchor: number): void => {
    const left = Math.max(8, Math.min(x, window.innerWidth - size.width - 8))
    const roomBelow = window.innerHeight - bottomOfAnchor
    setConfirming(false)
    setPlace(roomBelow >= size.height + 12 ? { left, top: bottomOfAnchor + 4 } : { left, bottom: window.innerHeight - top + 4 })
  }

  /** The button for more opens the menu under itself, and closes the open one. */
  const toggle = (): void => {
    if (place) return close(false)
    const rect = moreRef.current?.getBoundingClientRect()
    if (rect) openAt(rect.left, rect.top, rect.bottom)
  }

  /** A right-click on the row opens the menu where the pointer is. */
  const openAtPointer = (e: MouseEvent): void => {
    e.preventDefault()
    openAt(e.clientX, e.clientY, e.clientY)
  }

  /** Escape closes the menu. The arrows move through its entries and, where it has marks, through those as in a grid. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return close(true)
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

  return { place, confirming, setConfirming, close, toggle, openAtPointer, onKeyDown }
}

/** A piece of a message that a search found, with the words that were looked for set off in it. */
function Snippet({ text, marks }: NonNullable<SessionHit['snippet']>) {
  const parts: ReactNode[] = []
  let at = 0
  for (const [from, to] of marks) {
    if (from < at) continue
    if (from > at) parts.push(text.slice(at, from))
    parts.push(<mark key={from}>{text.slice(from, to)}</mark>)
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return <span className="session-snippet">{parts}</span>
}

/** One session in the list: its mark and its name, and a menu to mark, rename, archive or delete it. */
function SessionRow({
  session,
  active,
  working,
  waiting,
  busy,
  markSlot,
  snippet,
  place,
  now,
  onError,
  onOpen,
  onRename,
  onArchive,
  onIcon,
  onDelete
}: Actions & {
  session: SessionSummary
  active: boolean
  /** A turn of this session is under way: a ring turns at the left of its row. */
  working: boolean
  /** That turn waits for the person to allow or refuse a tool call: a hand stands in the place of the ring. */
  waiting: boolean
  /** While a turn runs, sessions can be neither switched nor changed. */
  busy: boolean
  /** Room for a mark is kept even without one, because a session around this one has a mark: the names stay in line. */
  markSlot: boolean
  /** Where in the session a search found its words, when that was in a message and not in the name. */
  snippet?: SessionHit['snippet']
  /** The workspace the session ran in, by the name it goes by, for a session that is not listed under it. */
  place?: string
  /** The time as the list has it, from which the row says how long ago the session was gone on with. Absent, the row does not say it (设置 → 外观). */
  now?: number
  onError: (message: string) => void
}) {
  /** The new name being typed; null while the row is not being renamed. */
  const [draft, setDraft] = useState<string | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menu = useRowMenu(rowRef, moreRef, MENU)

  // Renaming starts with the whole name selected, so typing replaces it.
  const renaming = draft !== null
  useEffect(() => {
    if (!renaming) return
    const input = rowRef.current?.querySelector<HTMLInputElement>('.session-rename')
    input?.focus({ preventScroll: true })
    input?.select()
  }, [renaming])

  const onContextMenu = (e: MouseEvent): void => {
    if (busy || draft !== null) return
    menu.openAtPointer(e)
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
    menu.close(false)
    if (icon !== (session.icon ?? null)) run(onIcon(session.id, icon))
  }

  const mark = (session.icon || markSlot) && (
    <span className="session-icon" aria-hidden="true">
      {session.icon && <SessionMark name={session.icon} />}
    </span>
  )

  return (
    <div
      ref={rowRef}
      className={`session ${active ? 'session-active' : ''} ${menu.place ? 'session-menu-open' : ''}`}
      onContextMenu={onContextMenu}
    >
      {/* In the margin left of the mark, so that no name moves when it comes and goes. A turn that
          stands still until the person has answered says that, and not that it is at work. */}
      {waiting ? (
        <span className="session-waiting" role="img" aria-label="等你确认" data-tip="等你确认：模型要调用一个需要你允许的工具">
          <HandIcon />
        </span>
      ) : (
        working && <span className="session-working" role="img" aria-label="正在工作" data-tip="正在工作" />
      )}
      {draft === null ? (
        <button className="session-open" disabled={busy} onClick={() => onOpen(session.id)}>
          {mark}
          <span className="session-words">
            {/* The whole name, for one that is cut short: asked of the name itself, since the row holds more than it. */}
            <span className="session-title" data-tip={session.title}>
              {session.title}
            </span>
            {place && (
              <span className="session-place" data-tip={`工作区：${session.workspace}`}>
                {place}
              </span>
            )}
            {snippet && <Snippet {...snippet} />}
            {/* When the conversation was last gone on with, said from now; the exact moment for whoever asks. */}
            {now !== undefined && (
              <span className="session-time" data-tip={`最后更新：${whenExact(session.updatedAt)}`}>
                {whenText(session.updatedAt, now)}
              </span>
            )}
          </span>
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
          aria-expanded={menu.place !== null}
          aria-label={`会话"${session.title}"的更多操作`}
          data-tip="更多操作"
          onClick={menu.toggle}
        >
          <MoreIcon />
        </button>
      )}
      {menu.place && (
        <div className="menu session-menu" role="menu" style={menu.place} onKeyDown={menu.onKeyDown}>
          {/* The marks, one press away: the first takes the mark off again. */}
          <div className="icon-grid" role="group" aria-label="图标">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!session.icon}
              className="icon-choice"
              aria-label="不用图标"
              data-tip="不用图标"
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
                data-tip={markLabel(name)}
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
              menu.close(false)
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
              menu.close(false)
              run(onArchive(session.id, !session.archived))
            }}
          >
            {session.archived ? <ResetIcon /> : <ArchiveIcon />}
            {session.archived ? '取消归档' : '归档'}
          </button>
          <button
            type="button"
            role="menuitem"
            // The second press is the one that deletes, and is made to look like it.
            className={`menu-item menu-item-danger${menu.confirming ? ' menu-item-confirm' : ''}`}
            onClick={() => {
              if (!menu.confirming) return menu.setConfirming(true)
              menu.close(false)
              run(onDelete(session.id))
            }}
          >
            <TrashIcon />
            {menu.confirming ? '确认删除？' : '删除'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The head of a workspace: its name, which folds its sessions away and back; a menu to give the
 * workspace another name, to archive its sessions, or to take it out of the list with them; and
 * a button for a new chat in its folder.
 */
function GroupHead({
  group,
  open,
  busy,
  partial,
  onToggle,
  onNewChat,
  onError,
  onRenameWorkspace,
  onArchiveWorkspace,
  onRemoveWorkspace
}: WorkspaceActions & {
  group: WorkspaceGroup
  /** The sessions of the group are on show. */
  open: boolean
  busy: boolean
  /** The group holds what a search found, not all of its workspace: nothing is then done to the workspace as a whole. */
  partial: boolean
  onToggle: () => void
  onNewChat: (workspace: string) => void
  onError: (message: string) => void
}) {
  /** The new name being typed; null while the workspace is not being renamed. */
  const [draft, setDraft] = useState<string | null>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menu = useRowMenu(headRef, moreRef, GROUP_MENU)

  // Renaming starts with the whole name selected, so typing replaces it.
  const renaming = draft !== null
  useEffect(() => {
    if (!renaming) return
    const input = headRef.current?.querySelector<HTMLInputElement>('.group-rename')
    input?.focus({ preventScroll: true })
    input?.select()
  }, [renaming])

  const onContextMenu = (e: MouseEvent): void => {
    if (busy || partial || renaming) return
    menu.openAtPointer(e)
  }

  const run = (action: Promise<void>): void => {
    action.catch((err) => onError(errorText(err)))
  }

  const commitRename = (): void => {
    const name = cleanWorkspaceName(draft ?? '')
    setDraft(null)
    // An emptied box gives the workspace back the name of its folder.
    if (name !== group.name) run(onRenameWorkspace(group.workspace, name))
  }

  return (
    <div ref={headRef} className={`group-head ${menu.place ? 'group-menu-open' : ''}`} onContextMenu={onContextMenu}>
      {draft === null ? (
        <button className="group-toggle" aria-expanded={open} onClick={onToggle} data-tip={group.workspace}>
          <span className="group-chevron">
            <ChevronDownIcon />
          </span>
          <FolderIcon />
          <span className="group-name">{group.name}</span>
        </button>
      ) : (
        // The arrow and the folder stay where they are, so that the name is typed where it stands.
        <div className="group-toggle group-renaming" data-folded={open ? undefined : ''}>
          <span className="group-chevron">
            <ChevronDownIcon />
          </span>
          <FolderIcon />
          <input
            className="group-rename"
            value={draft}
            aria-label="工作区名称"
            // What the workspace is called with the box left empty.
            placeholder={folderName(group.workspace)}
            maxLength={WORKSPACE_NAME_LIMIT}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              // While an IME is composing, Enter confirms its candidate, not the name.
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setDraft(null)
            }}
          />
        </div>
      )}
      {draft === null && !partial && (
        <button
          ref={moreRef}
          className="group-more"
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menu.place !== null}
          aria-label={`工作区"${group.name}"的更多操作`}
          data-tip="更多操作"
          onClick={menu.toggle}
        >
          <MoreIcon />
        </button>
      )}
      {draft === null && (
        <button
          className="group-add"
          disabled={busy}
          onClick={() => onNewChat(group.workspace)}
          aria-label={`在 ${group.name} 里开始新对话`}
          data-tip="在这个文件夹里开始新对话"
        >
          <PlusIcon />
        </button>
      )}
      {menu.place && (
        <div className="menu session-menu" role="menu" style={menu.place} onKeyDown={menu.onKeyDown}>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-tip="只改这里显示的名字，磁盘上的文件夹不改名"
            onClick={() => {
              menu.close(false)
              setDraft(group.name)
            }}
          >
            <ComposeIcon />
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-tip="把这个工作区列出的对话都收进“已归档”"
            onClick={() => {
              menu.close(false)
              run(onArchiveWorkspace(group.workspace))
            }}
          >
            <ArchiveIcon />
            全部归档
          </button>
          <button
            type="button"
            role="menuitem"
            // The second press is the one that deletes, and says how much goes.
            className={`menu-item menu-item-danger${menu.confirming ? ' menu-item-confirm' : ''}`}
            data-tip="删除这个工作区列出的对话，并把它从列表里拿掉。文件夹和里面的文件不动，已归档的对话保留。"
            onClick={() => {
              if (!menu.confirming) return menu.setConfirming(true)
              menu.close(false)
              run(
                onRemoveWorkspace(
                  group.workspace,
                  group.sessions.map((s) => s.id)
                )
              )
            }}
          >
            <TrashIcon />
            {menu.confirming ? `确认删除 ${group.sessions.length} 个对话？` : '删除工作区'}
          </button>
        </div>
      )}
    </div>
  )
}

/** How long after the last key a search is made: not for every letter of a word being typed. */
const SEARCH_DELAY_MS = 150

/**
 * The left column: a button for a new chat, the search box and the way to the plugins, the
 * sessions sorted into their workspaces, the archived ones tucked away below, and the settings.
 * Beside the button for a new chat is the one that folds the column away to a strip. The strip
 * shows the app's icon, which opens the column again, the button for a new chat, and the
 * settings at the bottom; how the column was left is remembered.
 */
export function Sidebar({
  sessions,
  names,
  activeId,
  workingId,
  waitingIds,
  busy,
  page,
  showTimes,
  onNewChat,
  onSearch,
  onPlugins,
  onMemory,
  onSettings,
  onRenameWorkspace,
  onArchiveWorkspace,
  onRemoveWorkspace,
  ...actions
}: Actions &
  WorkspaceActions & {
  /** Most recent first. */
  sessions: SessionSummary[]
  /** The names the person gave workspaces, by the key of the folder. A workspace not in here goes by the name of its folder. */
  names?: Readonly<Record<string, string>>
  activeId: string | null
  /** The session whose turn the page itself is running, if any. Of sessions at work elsewhere the list says so (`running`). */
  workingId: string | null
  /** The sessions that wait for the person to allow or refuse a tool call. */
  waitingIds: readonly string[]
  busy: boolean
  /** What the main part of the window shows: the conversation, the plugins, the settings, or the memory. */
  page: 'chat' | 'plugins' | 'settings' | 'memory'
  /** Whether each session says, under its name, when it was last gone on with (设置 → 外观). */
  showTimes: boolean
  /** With a folder, the new chat starts in that workspace. */
  onNewChat: (workspace?: string) => void
  /** The sessions in which the words of a search are found, in the name or in what was said. */
  onSearch: (query: string) => Promise<SessionHit[]>
  /** Shows the plugins in the main part of the window, or goes back from them to the conversation. */
  onPlugins: () => void
  /** The same for the memory's page (MemoryPage.tsx). */
  onMemory: () => void
  onSettings: () => void
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  /** What the search found, by session. Null while nothing is searched for, and until the first answer. */
  const [hits, setHits] = useState<ReadonlyMap<string, SessionHit> | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const searching = query.trim() !== ''
  // For the "3 分钟前" under each session: told anew twice a minute, so that it does not stand still.
  const now = useNow(30_000)

  /** Folded away to a strip: the app's icon, the button for a new chat, and the way to the settings. */
  const [folded, setFolded] = useState(readFolded)
  /** The button of the open sidebar that folds it, and the one on the strip that opens it again. Each hands the keyboard to the other. */
  const foldRef = useRef<HTMLButtonElement>(null)
  const unfoldRef = useRef<HTMLButtonElement>(null)
  /** What takes the keyboard once the sidebar is drawn the other way: the button that undoes the one pressed, or the search box. */
  const focusNext = useRef<'toggle' | 'search' | null>(null)

  // The stylesheet lays the window out from this. Set before the first paint, so that a sidebar
  // that was left folded does not start wide and jump.
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-sidebar-folded', folded)
  }, [folded])

  const fold = (next: boolean, focus: 'toggle' | 'search' | null = null): void => {
    focusNext.current = focus
    setFolded(next)
    try {
      localStorage.setItem(FOLDED_KEY, next ? '1' : '0')
    } catch {
      // Remembering how the sidebar was left is a convenience; it works without it.
    }
  }

  const toSearch = (): void => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }

  useEffect(() => {
    const focus = focusNext.current
    focusNext.current = null
    if (focus === 'toggle') (folded ? unfoldRef.current : foldRef.current)?.focus()
    else if (focus === 'search' && !folded) toSearch()
  }, [folded])

  useShortcut('sidebar', () => fold(!folded))
  // The search box is in the part that folds away: asked for from the strip, the sidebar opens first.
  useShortcut('search', () => (folded ? fold(false, 'search') : toSearch()))

  // Asked a moment after the typing pauses, and again when the sessions change under the search.
  // What was found before stays on show until the answer comes; an answer to an older search is dropped.
  const search = useRef(onSearch)
  search.current = onSearch
  useEffect(() => {
    if (!searching) return setHits(null)
    let current = true
    const timer = setTimeout(() => {
      search.current(query).then(
        (found) => current && setHits(new Map(found.map((hit) => [hit.id, hit]))),
        (err) => current && setError(errorText(err))
      )
    }, SEARCH_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, searching, sessions])

  /** The list holds what the search found, and no longer everything. */
  const filtered = searching && hits !== null
  const shown = filtered ? sessions.filter((s) => hits.has(s.id)) : sessions
  const groups = groupByWorkspace(
    shown.filter((s) => !s.archived),
    isWindows,
    names
  )
  const archived = shown.filter((s) => s.archived)

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // While an IME is composing, these keys are its own.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      // First the words go, then the cursor.
      if (query) setQuery('')
      else e.currentTarget.blur()
    } else if (e.key === 'Enter') {
      // The first one found, as the list shows them.
      if (filtered) listRef.current?.querySelector<HTMLButtonElement>('.session-open:not(:disabled)')?.click()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      listRef.current?.querySelector<HTMLElement>('.session-open')?.focus()
    }
  }

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

  /**
   * The sessions of one group. When one of them has a mark, all of them keep room for one.
   * `placed` is for a group that is not a workspace: each session then says which one it ran in.
   */
  const rows = (list: SessionSummary[], placed = false) => {
    const markSlot = list.some((s) => s.icon)
    return list.map((session) => (
      <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeId}
        working={session.running === true || session.id === workingId}
        waiting={waitingIds.includes(session.id)}
        busy={busy}
        markSlot={markSlot}
        snippet={filtered ? hits.get(session.id)?.snippet : undefined}
        place={placed ? workspaceName(session.workspace, names, isWindows) : undefined}
        now={showTimes ? now : undefined}
        onError={setError}
        {...actions}
      />
    ))
  }

  const foldKeys = keysLabel(SHORTCUTS.sidebar.keys, isMac)
  return (
    <aside className={`sidebar${folded ? ' sidebar-folded' : ''}`}>
      {/* The app's icon and name, and the button that folds the sidebar away. Where the window has
          no title bar of its own (Windows), this row is what says which app this is. */}
      <div className="sidebar-head">
        <span className="sidebar-mark">
          <AppIcon />
        </span>
        {!folded && <span className="sidebar-name">StarBench</span>}
        {!folded && (
          <button ref={foldRef} type="button" className="sidebar-fold" aria-label="收起侧边栏" data-tip={`收起侧边栏（${foldKeys}）`} onClick={() => fold(true, 'toggle')}>
            <FoldIcon />
          </button>
        )}
      </div>
      {/* On the strip a button of its own opens the sidebar again: the icon above it is a picture, and is not pressed. */}
      {folded && (
        <button ref={unfoldRef} type="button" className="sidebar-fold" aria-label="展开侧边栏" data-tip={`展开侧边栏（${foldKeys}）`} onClick={() => fold(false, 'toggle')}>
          <UnfoldIcon />
        </button>
      )}
      {/* Without their words on the strip, this button and the one for the settings say what they are when asked. */}
      <button className="btn btn-primary sidebar-new" onClick={() => onNewChat()} disabled={busy} {...(folded ? { 'aria-label': '新对话', 'data-tip': '新对话' } : {})}>
        <QuillIcon />
        {!folded && '新对话'}
      </button>
      <div className="sidebar-nav">
        {/* A press anywhere on the row puts the cursor into the box. */}
        <label className="sidebar-search" data-tip="搜索对话的标题和内容">
          <SearchIcon />
          <input
            ref={searchRef}
            className="sidebar-search-input"
            value={query}
            placeholder="搜索"
            aria-label={SHORTCUTS.search.label}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {query ? (
            <button
              type="button"
              className="sidebar-search-clear"
              aria-label="清除搜索"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              ×
            </button>
          ) : (
            <kbd className="sidebar-key" aria-hidden="true">
              {keysLabel(SHORTCUTS.search.keys, isMac)}
            </kbd>
          )}
        </label>
        <button type="button" className="sidebar-item" aria-pressed={page === 'plugins'} onClick={onPlugins}>
          <PluginIcon />
          插件
        </button>
        {/* Only while the memory is on; folded away with the rest of this block. */}
        <MemoryNavButton pressed={page === 'memory'} onOpen={onMemory} />
      </div>
      <nav className="sessions" aria-label="会话" ref={listRef}>
        {filtered ? (
          <div className="sidebar-label" role="status">
            {shown.length > 0 ? `找到 ${shown.length} 个对话` : `没有找到包含“${query.trim()}”的对话`}
          </div>
        ) : (
          groups.length > 0 && <div className="sidebar-label">工作区</div>
        )}
        {groups.map((group) => {
          // What a search found is shown, also in a folder that was folded away.
          const open = filtered || !collapsed.includes(group.key)
          return (
            <section key={group.key} className="group">
              <GroupHead
                group={group}
                open={open}
                busy={busy}
                partial={filtered}
                onToggle={() => !filtered && toggle(group.key)}
                onNewChat={onNewChat}
                onError={setError}
                onRenameWorkspace={onRenameWorkspace}
                onArchiveWorkspace={onArchiveWorkspace}
                onRemoveWorkspace={onRemoveWorkspace}
              />
              {open && <div className="group-body">{rows(group.sessions)}</div>}
            </section>
          )
        })}
        {sessions.length === 0 && !filtered && <p className="sidebar-empty">还没有对话。选一个工作文件夹，发出第一条消息后会出现在这里。</p>}
        {archived.length > 0 && (
          <section className="group group-archived">
            <div className="group-head">
              <button className="group-toggle" aria-expanded={archivedOpen || filtered} onClick={() => !filtered && setArchivedOpen((v) => !v)}>
                <span className="group-chevron">
                  <ChevronDownIcon />
                </span>
                <ArchiveIcon />
                <span className="group-name">已归档</span>
                <span className="group-count">{archived.length}</span>
              </button>
            </div>
            {(archivedOpen || filtered) && <div className="group-body">{rows(archived, true)}</div>}
          </section>
        )}
      </nav>
      {error && (
        <div className="msg-error sidebar-error" role="alert">
          {error}
        </div>
      )}
      {/* Like the plugins: pressed once it shows the settings in the main part of the window, pressed again it goes back. */}
      <button
        type="button"
        className="btn sidebar-settings"
        aria-pressed={page === 'settings'}
        onClick={onSettings}
        {...(folded ? { 'aria-label': '设置', 'data-tip': '设置' } : {})}
      >
        <SettingsIcon />
        {!folded && '设置'}
      </button>
      <Resizer />
    </aside>
  )
}
