// The list of folders the user has worked in, offered again when picking a folder.
// Nothing in this file depends on Electron.

import { folderKey as sharedFolderKey } from '../shared/folders.ts'

/** How many folders the picker offers. */
export const MAX_RECENT_FOLDERS = 8

/** Two spellings with the same key are the same folder on this computer. */
export function folderKey(dir: string, windows = process.platform === 'win32'): string {
  return sharedFolderKey(dir, windows)
}

/**
 * Joins lists of folders into one, earlier entries first, keeping the first spelling of each
 * folder and dropping empty entries.
 */
export function mergeFolders(lists: readonly (readonly string[])[], limit = MAX_RECENT_FOLDERS, windows?: boolean): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const dir of lists.flat()) {
    if (typeof dir !== 'string') continue
    const key = folderKey(dir, windows)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(dir)
    if (merged.length >= limit) break
  }
  return merged
}
