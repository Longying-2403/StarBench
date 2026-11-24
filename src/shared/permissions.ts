// What a model may do in a conversation without asking, as the person set it for that
// conversation. Used by the agent loop, which goes by it, and by the page, which shows it.

/**
 * The modes, from the least a model may do to the most:
 *
 *   view   it reads and searches; nothing is changed and nothing is run
 *   ask    as `view`, and everything else is asked about first, call by call
 *   edit   as `ask`, but files in the workspace are written and edited without asking
 *   full   nothing is asked about
 */
export const PERMISSION_MODES = ['view', 'ask', 'edit', 'full'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** What a conversation starts with, and what one from before there were modes goes by. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask'

export const isPermissionMode = (value: unknown): value is PermissionMode => (PERMISSION_MODES as readonly unknown[]).includes(value)

/**
 * What a tool does, as far as the modes tell tools apart. It only `read`s: such a tool never
 * asked. It `edit`s files of the workspace and does nothing else. Or it is any `other` tool that
 * asks: a command, which is not held to the workspace, or a tool of an MCP server or of a plugin.
 */
export type ToolAccess = 'read' | 'edit' | 'other'

/** What becomes of a call: it is `run`, the person is `ask`ed first, or it is `refuse`d and not run. */
export type Ruling = 'run' | 'ask' | 'refuse'

/** What a mode says of a call of a tool. */
export function rulingFor(mode: PermissionMode, access: ToolAccess): Ruling {
  if (access === 'read') return 'run'
  if (mode === 'view') return 'refuse'
  if (mode === 'full' || (mode === 'edit' && access === 'edit')) return 'run'
  return 'ask'
}

/**
 * Folders whose files other programs run commands from by themselves: git what its configuration
 * and hooks name (`.git`), editors the tasks and settings of a folder (`.vscode`, `.idea`). A file
 * written there is a command waiting for the next `git status`, which an editor may run unasked.
 * So a conversation that lets files be changed without asking still asks about these.
 */
export const RUNS_ON_ITS_OWN: readonly string[] = ['.git', '.vscode', '.idea']

/**
 * Which folder of `RUNS_ON_ITS_OWN` a path the model wrote goes into, as far as the path as it is
 * written tells; null for none. The parts are read as Windows reads them: letter case aside, a
 * stream name after a colon left off (`.git::$INDEX_ALLOCATION` is `.git`), dots and spaces at the
 * end left off (`.git.` is `.git`). Only what lies inside the workspace counts. Links, short names
 * and second names of a file are for the main process to follow (tools.ts, `runsOnItsOwn`).
 */
export function runsOnItsOwnPart(workspace: string, target: string): string | null {
  const slashes = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = slashes(workspace).toLowerCase()
  let inside = slashes(target)
  if (root && inside.toLowerCase().startsWith(`${root}/`)) inside = inside.slice(root.length + 1)
  for (const part of inside.split('/')) {
    const name = part.replace(/:.*$/, '').replace(/[. ]+$/, '').toLowerCase()
    if (RUNS_ON_ITS_OWN.includes(name)) return name
  }
  return null
}

/**
 * What the model is told in place of a result when a call was not run because the conversation
 * is view-only. The page knows such a call by this text, as it knows one the person refused.
 */
export const VIEW_ONLY_RESULT =
  'Not run: the user has set this conversation to view-only. You can read and search files; changing files, running commands and other tools are switched off. Say what you would do, and the user can change the setting.'
