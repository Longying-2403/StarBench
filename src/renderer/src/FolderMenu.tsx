import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { CheckIcon, ChevronDownIcon, FolderIcon, PlusIcon } from './icons.tsx'
import { folderKey, folderName } from '../../shared/folders.ts'
import { isWindows, roomStyle, useOutsidePress, usePopupPlace } from './util.ts'

const api = window.harness

const sameFolder = (a: string, b: string): boolean => folderKey(a, isWindows) === folderKey(b, isWindows)

/**
 * The workspace of a new chat. Pressing it lists the folders used before, with an entry at
 * the bottom that opens the system dialog to add another.
 */
export function FolderMenu({ workspace, onChoose }: { workspace: string; onChoose: (dir: string) => void }) {
  const [open, setOpen] = useState(false)
  /** Null until the list has been read. */
  const [folders, setFolders] = useState<string[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Below the button for as long as a few folders fit there; `.menu` sits 6px from it.
  const place = usePopupPlace(open, triggerRef, 220, 6)

  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }
  useOutsidePress(open, rootRef, () => close(false))

  const show = (): void => {
    // Read each time: folders are added by use and can disappear from the disk.
    setFolders(null)
    setOpen(true)
    api.listWorkspaces().then(setFolders, () => setFolders([]))
  }

  const items = (): HTMLElement[] => Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.menu-item') ?? [])

  // Once the list is there, the keyboard starts on the folder in use, or on the first entry.
  useEffect(() => {
    if (!open || folders === null) return
    const all = items()
    ;(all.find((el) => el.getAttribute('aria-checked') === 'true') ?? all[0])?.focus({ preventScroll: true })
  }, [open, folders])

  const add = async (): Promise<void> => {
    close(false)
    const picked = await api.pickWorkspace()
    if (picked) onChoose(picked)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const all = items()
    if (all.length === 0) return
    const at = all.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
    e.preventDefault()
    all[next].focus({ preventScroll: true })
    all[next].scrollIntoView({ block: 'nearest' })
  }

  return (
    <div className="folder-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="folder"
        aria-haspopup="menu"
        aria-expanded={open}
        title={workspace || undefined}
        onClick={() => (open ? close(false) : show())}
      >
        <FolderIcon />
        <span className="folder-name">{workspace ? folderName(workspace) : '选择工作文件夹'}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="工作文件夹" data-side={place.side} style={roomStyle(place)} onKeyDown={onKeyDown}>
          {folders !== null && folders.length > 0 && (
            <>
              <div className="menu-label">用过的文件夹</div>
              <div className="menu-list">
                {folders.map((dir) => {
                  const current = Boolean(workspace) && sameFolder(dir, workspace)
                  return (
                    <button
                      key={dir}
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      className="menu-item"
                      title={dir}
                      onClick={() => {
                        onChoose(dir)
                        close(true)
                      }}
                    >
                      <span className="menu-item-text">
                        <span className="menu-item-name">{folderName(dir)}</span>
                        <span className="menu-item-path">{dir}</span>
                      </span>
                      {current && <CheckIcon />}
                    </button>
                  )
                })}
              </div>
              <div className="menu-divider" />
            </>
          )}
          <button type="button" role="menuitem" className="menu-item menu-add" onClick={() => void add()}>
            <PlusIcon />
            新增文件夹…
          </button>
        </div>
      )}
    </div>
  )
}
