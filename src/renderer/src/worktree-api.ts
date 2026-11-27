// The page's way to the worktrees of repositories: `window.worktrees`, put there by the preload
// script beside `window.harness` (src/preload/index.ts).

import type { Settings } from '../../shared/types.ts'
import type { WorktreeApi } from '../../shared/worktree.ts'

declare global {
  interface Window {
    worktrees: WorktreeApi<Settings>
  }
}

export const worktreesApi: WorktreeApi<Settings> = window.worktrees
