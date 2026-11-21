// Folder paths as the app compares and shows them. Used by both the main process and the page.

import type { SessionSummary } from './types.ts'

/**
 * What makes two spellings the same folder: a trailing separator never matters, and on
 * Windows neither does letter case or which of the two separators is used.
 */
export function folderKey(dir: string, windows: boolean): string {
  const trimmed = dir.trim().replace(/[\\/]+$/, '')
  return windows ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed
}

/** The last part of a path, which is how people name a folder. */
export function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
}

export interface WorkspaceGroup {
  /** Stable identity of the folder, for remembering which groups are collapsed. */
  key: string
  /** The folder as its most recent session spells it. */
  workspace: string
  name: string
  sessions: SessionSummary[]
}

/**
 * Sorts sessions into their workspaces. Groups come in order of their most recent session,
 * and so do the sessions inside each group; `sessions` is expected most recent first.
 */
export function groupByWorkspace(sessions: readonly SessionSummary[], windows: boolean): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>()
  for (const session of sessions) {
    const key = folderKey(session.workspace, windows)
    let group = groups.get(key)
    if (!group) {
      group = { key, workspace: session.workspace, name: folderName(session.workspace) || session.workspace, sessions: [] }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }
  return [...groups.values()]
}
