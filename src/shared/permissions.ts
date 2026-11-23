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
 * What the model is told in place of a result when a call was not run because the conversation
 * is view-only. The page knows such a call by this text, as it knows one the person refused.
 */
export const VIEW_ONLY_RESULT =
  'Not run: the user has set this conversation to view-only. You can read and search files; changing files, running commands and other tools are switched off. Say what you would do, and the user can change the setting.'
