// The page's way to the worktrees (`WorktreeApi` in shared/worktree.ts): what a folder is to
// git, the person's yes to git in a repository, and the state, the merging and the taking away
// of the worktree a conversation works in. What it needs of the rest of the app it is handed
// (`WorktreeIpcDeps`), so that nothing in this file depends on Electron or on where conversations
// are kept.

import path from 'node:path'
import { suggestWorktreeName } from '../shared/worktree.ts'
import type { MergeOutcome, MergeRecord, Merged, RemoveOutcome, RepoInfo, UndoOutcome, WorktreeInfo, WorktreeState } from '../shared/worktree.ts'
import { saidToPerson } from './git.ts'
import { repoKind, takenNames } from './worktrees.ts'
import type { Worktrees } from './worktrees.ts'

/** What the main process's IPC needs of `ipcMain`. */
interface Handles {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

export interface WorktreeIpcDeps<Told> {
  worktrees: Pick<Worktrees, 'state' | 'merge' | 'undo' | 'remove'>
  /** Whether git is installed where the app finds it. */
  hasGit(): boolean
  /** Whether the person said a model may read a folder. */
  trusts(folder: string): Promise<boolean>
  /** Whether they said git may be run in it, and their yes and their taking it back, which resolve with the settings as the page sees them. */
  allows(folder: string): Promise<boolean>
  allow(folder: unknown): Promise<Told>
  forget(folder: unknown): Promise<Told>
  /** The worktree a saved conversation works in, and the name of the conversation. Null for one that works in none, or that is gone. */
  worktreeOf(sessionId: string): Promise<{ info: WorktreeInfo; title: string } | null>
  /** A turn of the conversation is under way, or about to be. */
  running(sessionId: string): boolean
  /** Writes a merge down with its conversation, and tells the page. */
  merged(sessionId: string, done: Merged): Promise<void>
  /** A merge the conversation keeps, by its id. */
  recordOf(sessionId: string, mergeId: string): Promise<MergeRecord | null>
  /** Writes down that a merge was taken back, and tells the page. */
  undone(sessionId: string, mergeId: string): Promise<void>
}

/** A folder that is nothing to git, or that the page has no business asking about. */
const NOT_A_REPO: RepoInfo = { kind: 'none', git: false, allowed: false, taken: [], suggested: '' }

export function registerWorktreeIpc<Told>(ipc: Handles, deps: WorktreeIpcDeps<Told>): void {
  const found = async (sessionId: unknown): Promise<{ id: string; info: WorktreeInfo; title: string } | null> => {
    const id = String(sessionId ?? '')
    const tree = await deps.worktreeOf(id)
    return tree ? { id, ...tree } : null
  }
  const notAtWork = (id: string): void => {
    if (deps.running(id)) throw new Error('This conversation is at work. Try again when its turn is over.')
  }
  /** What went wrong on the way is said to the person in the language of the app, where the error has words for them (`Explained`). */
  const forPerson = <T>(work: () => Promise<T>): Promise<T> =>
    work().catch((err: unknown) => {
      throw saidToPerson(err)
    })

  // Asked of the folder a new chat is about to be in. Git is not run for it: the answer is read
  // from the folder itself, and only for a folder the person said a model may read.
  ipc.handle('worktrees:repo', async (_e, folder: unknown): Promise<RepoInfo> => {
    const dir = typeof folder === 'string' ? folder : ''
    if (!dir || !path.isAbsolute(dir) || !(await deps.trusts(dir))) return NOT_A_REPO
    const kind = await repoKind(dir)
    const taken = kind === 'main' ? await takenNames(dir) : []
    return { kind, git: deps.hasGit(), allowed: await deps.allows(dir), taken, suggested: suggestWorktreeName(taken) }
  })
  ipc.handle('worktrees:allow', (_e, folder: unknown) => deps.allow(folder))
  ipc.handle('worktrees:forget', (_e, folder: unknown) => deps.forget(folder))

  ipc.handle('worktrees:state', async (_e, sessionId: unknown): Promise<WorktreeState | null> => {
    const tree = await found(sessionId)
    return tree ? forPerson(() => deps.worktrees.state(tree.info)) : null
  })

  ipc.handle('worktrees:merge', async (_e, sessionId: unknown): Promise<MergeOutcome> => {
    const tree = await found(sessionId)
    if (!tree) throw new Error('This conversation works in no worktree.')
    // A turn changes files as it goes: merged in the middle of one, half of its work would go over.
    notAtWork(tree.id)
    // What is not committed there yet is committed under the name of the conversation.
    const outcome = await forPerson(() => deps.worktrees.merge(tree.info, tree.title.trim() || `Work from ${tree.info.name}`))
    if (outcome.kind === 'merged') await deps.merged(tree.id, outcome)
    return outcome
  })

  ipc.handle('worktrees:undo', async (_e, sessionId: unknown, mergeId: unknown): Promise<UndoOutcome> => {
    const tree = await found(sessionId)
    const record = tree ? await deps.recordOf(tree.id, String(mergeId ?? '')) : null
    if (!tree || !record) throw new Error('This merge is not known to the conversation any more.')
    if (record.undone !== undefined) return { kind: 'undone' }
    const outcome = await forPerson(() => deps.worktrees.undo(tree.info.repo, record))
    if (outcome.kind === 'undone') await deps.undone(tree.id, record.id)
    return outcome
  })

  ipc.handle('worktrees:remove', async (_e, sessionId: unknown, opts: unknown): Promise<RemoveOutcome> => {
    const tree = await found(sessionId)
    if (!tree) return { kind: 'removed' }
    notAtWork(tree.id)
    // Said as an answer and not as an error: the page tells the person where they give their yes
    // again. Where nothing is left of the worktree, neither folder nor git branch, nothing needs git.
    if (!(await deps.allows(tree.info.repo))) return (await takenNames(tree.info.repo)).includes(tree.info.name) ? { kind: 'not-allowed' } : { kind: 'removed' }
    const discard = typeof opts === 'object' && opts !== null && (opts as { discard?: unknown }).discard === true
    return forPerson(() => deps.worktrees.remove(tree.info, { discard }))
  })
}
