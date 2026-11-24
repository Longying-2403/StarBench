// The repository on GitHub that a folder is a clone of, read from the clone's own settings. Git
// itself is not run: a folder's settings can make git run programs of their choosing, and all
// that is wanted here is one line of a small text file.

import fs from 'node:fs/promises'
import path from 'node:path'
import { originRepo } from '../shared/github.ts'
import type { GitHubRepo } from '../shared/github.ts'

/** A clone's settings are a few lines; a file larger than this is not read. */
const CONFIG_MAX = 256 * 1024

async function readSmall(file: string): Promise<string | null> {
  const stat = await fs.stat(file)
  if (!stat.isFile() || stat.size > CONFIG_MAX) return null
  return fs.readFile(file, 'utf8')
}

/**
 * The repository on GitHub that `folder` is a clone of, by what its settings name as the origin;
 * null for a folder that is no clone, or whose origin is elsewhere. Only whose repository it is
 * and its name leave this function: an address in the settings may carry a token.
 *
 * In a worktree, and in a module of another repository, `.git` is a file that names the folder
 * where git keeps this one's things, and that folder may name the one the settings are in.
 */
export async function githubRepoOf(folder: string): Promise<GitHubRepo | null> {
  try {
    let dir = path.join(folder, '.git')
    if ((await fs.stat(dir)).isFile()) {
      const named = /^gitdir:\s*(.+)$/m.exec((await readSmall(dir)) ?? '')
      if (!named) return null
      dir = path.resolve(folder, named[1].trim())
      const common = await readSmall(path.join(dir, 'commondir')).catch(() => null)
      if (common?.trim()) dir = path.resolve(dir, common.trim())
    }
    const config = await readSmall(path.join(dir, 'config'))
    return config === null ? null : originRepo(config)
  } catch {
    return null
  }
}
