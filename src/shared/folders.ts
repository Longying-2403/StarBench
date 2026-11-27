// Folder paths as the app compares and shows them. Used by both the main process and the page.

import type { SessionSummary } from './types.ts'
import { projectFolder } from './worktree.ts'

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

/** How long a name the person gives a workspace may be. */
export const WORKSPACE_NAME_LIMIT = 60

/** A name for a workspace as it is kept: on one line, without space around it, and no longer than names may be. Empty when nothing is left. */
export function cleanWorkspaceName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, WORKSPACE_NAME_LIMIT).trim()
}

/**
 * What a workspace is called: the name the person gave it, or else its folder's. `names` holds
 * the given names by the key of the folder (`folderKey`). The folder on the disk keeps its own name.
 */
export function workspaceName(folder: string, names: Readonly<Record<string, string>> | undefined, windows: boolean): string {
  const given: unknown = names?.[folderKey(folder, windows)]
  // Only a name: what every object has under names like "constructor" is not one.
  return (typeof given === 'string' && given) || folderName(folder) || folder
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
 * and so do the sessions inside each group; `sessions` is expected most recent first. A group
 * goes by the name the person gave its workspace, where `names` holds one. A session that works
 * in a worktree of a repository stands with the repository's (`projectFolder`): a worktree is no
 * workspace of its own.
 */
export function groupByWorkspace(sessions: readonly SessionSummary[], windows: boolean, names?: Readonly<Record<string, string>>): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>()
  for (const session of sessions) {
    const folder = projectFolder(session)
    const key = folderKey(folder, windows)
    let group = groups.get(key)
    if (!group) {
      group = { key, workspace: folder, name: workspaceName(folder, names, windows), sessions: [] }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }
  return [...groups.values()]
}
