// The tools the model can call. Nothing in this file depends on Electron, so it
// can be exercised from a plain Node script.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_OUTPUT_CHARS = 30_000
const MAX_FILE_BYTES = 1_000_000
const MAX_SEARCH_HITS = 200
const COMMAND_TIMEOUT_MS = 120_000
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv'])

export interface ToolContext {
  workspace: string
  signal: AbortSignal
}

interface ToolSpec {
  description: string
  parameters: Record<string, unknown>
  /** Tools that change files or run code ask the user first. */
  needsPermission: boolean
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const dropped = text.length - MAX_OUTPUT_CHARS
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${dropped} characters]`
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`Missing string argument "${key}"`)
  return value
}

/** Resolves a model-supplied path and refuses anything outside the workspace. */
export function resolveInWorkspace(workspace: string, target: string): string {
  const root = path.resolve(workspace)
  const full = path.resolve(root, target)
  const rel = path.relative(root, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${target}`)
  }
  return full
}

async function readTextFile(full: string): Promise<string> {
  const stat = await fs.stat(full)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to read (${stat.size} bytes, limit ${MAX_FILE_BYTES})`)
  }
  return fs.readFile(full, 'utf8')
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function runCommand(command: string, ctx: ToolContext): Promise<string> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const child = isWindows
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          cwd: ctx.workspace,
          windowsHide: true
        })
      : spawn('/bin/sh', ['-c', command], { cwd: ctx.workspace })

    let output = ''
    let note = ''
    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const kill = (reason: string): void => {
      note = reason
      if (isWindows && child.pid) {
        // Kill the whole process tree; child.kill() only stops the shell.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => kill(`Timed out after ${COMMAND_TIMEOUT_MS / 1000}s`), COMMAND_TIMEOUT_MS)
    const onAbort = (): void => kill('Cancelled by user')
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    const finish = (tail: string): void => {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      resolve(truncate(`${output}${output && !output.endsWith('\n') ? '\n' : ''}${tail}`))
    }
    child.on('error', (err) => finish(`Failed to start command: ${err.message}`))
    child.on('close', (code) => finish(note ? `[${note}]` : `[exit code ${code}]`))
  })
}

export const TOOLS: Record<string, ToolSpec> = {
  read_file: {
    description: 'Read a UTF-8 text file from the workspace. Returns the content with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        offset: { type: 'integer', description: 'First line to return, 1-based (default 1)' },
        limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000)' }
      },
      required: ['path']
    },
    needsPermission: false,
    async run(args, ctx) {
      const text = await readTextFile(resolveInWorkspace(ctx.workspace, str(args, 'path')))
      const lines = text.split(/\r?\n/)
      const offset = Math.max(1, Number(args.offset) || 1)
      const limit = Math.max(1, Number(args.limit) || 2000)
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((line, i) => `${offset + i}\t${line}`).join('\n')
      const rest = lines.length - (offset - 1 + slice.length)
      return truncate(rest > 0 ? `${body}\n… [${rest} more lines]` : body)
    }
  },

  write_file: {
    description: 'Create a file or overwrite it completely. Parent directories are created as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        content: { type: 'string', description: 'The full new content of the file' }
      },
      required: ['path', 'content']
    },
    needsPermission: true,
    async run(args, ctx) {
      const full = resolveInWorkspace(ctx.workspace, str(args, 'path'))
      const content = str(args, 'content')
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, content, 'utf8')
      return `Wrote ${content.length} characters to ${str(args, 'path')}`
    }
  },

  edit_file: {
    description:
      'Replace an exact string in a file. old_string must match the file exactly (including whitespace) and must be unique unless replace_all is true. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    needsPermission: true,
    async run(args, ctx) {
      const full = resolveInWorkspace(ctx.workspace, str(args, 'path'))
      const oldString = str(args, 'old_string')
      const newString = str(args, 'new_string')
      if (!oldString) throw new Error('old_string must not be empty')
      if (oldString === newString) throw new Error('old_string and new_string are identical')

      const original = await readTextFile(full)
      // Models usually emit \n; match the file's own line endings so CRLF files still work.
      const crlf = original.includes('\r\n')
      const adapt = (s: string): string => (crlf ? s.replace(/\r?\n/g, '\r\n') : s)
      const needle = adapt(oldString)
      const count = original.split(needle).length - 1
      if (count === 0) throw new Error('old_string was not found in the file')
      if (count > 1 && args.replace_all !== true) {
        throw new Error(`old_string matches ${count} places; add more context or set replace_all`)
      }
      // split/join avoids the special meaning of "$" in String.replace replacements.
      const updated = original.split(needle).join(adapt(newString))
      await fs.writeFile(full, updated, 'utf8')
      return `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${str(args, 'path')}`
    }
  },

  list_dir: {
    description: 'List the entries of a directory in the workspace. Directories end with "/".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root (default ".")' }
      }
    },
    needsPermission: false,
    async run(args, ctx) {
      const target = typeof args.path === 'string' && args.path ? args.path : '.'
      const entries = await fs.readdir(resolveInWorkspace(ctx.workspace, target), { withFileTypes: true })
      if (entries.length === 0) return '(empty directory)'
      return truncate(
        entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n')
      )
    }
  },

  search: {
    description:
      'Search file contents in the workspace with a JavaScript regular expression. Returns matching lines as path:line: text. Skips node_modules, .git and build output.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: { type: 'string', description: 'Directory or file to search, relative to the workspace root (default ".")' },
        case_insensitive: { type: 'boolean', description: 'Ignore case (default false)' }
      },
      required: ['pattern']
    },
    needsPermission: false,
    async run(args, ctx) {
      const regex = new RegExp(str(args, 'pattern'), args.case_insensitive === true ? 'i' : '')
      const target = typeof args.path === 'string' && args.path ? args.path : '.'
      const start = resolveInWorkspace(ctx.workspace, target)
      const stat = await fs.stat(start)
      const files = stat.isDirectory() ? walk(start) : [start]

      const hits: string[] = []
      for await (const file of files) {
        if (ctx.signal.aborted) break
        const info = await fs.stat(file).catch(() => null)
        if (!info || info.size > MAX_FILE_BYTES) continue
        const text = await fs.readFile(file, 'utf8').catch(() => '')
        if (text.includes('\u0000')) continue // binary
        const rel = path.relative(ctx.workspace, file).split(path.sep).join('/')
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
          if (hits.length >= MAX_SEARCH_HITS) {
            return truncate(`${hits.join('\n')}\n… [stopped at ${MAX_SEARCH_HITS} matches]`)
          }
        }
      }
      return hits.length ? truncate(hits.join('\n')) : 'No matches'
    }
  },

  run_command: {
    description:
      'Run a shell command in the workspace root and return its combined output and exit code. On Windows the shell is PowerShell; elsewhere it is /bin/sh. Commands time out after 120 seconds and cannot read interactive input.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run' }
      },
      required: ['command']
    },
    needsPermission: true,
    run(args, ctx) {
      return runCommand(str(args, 'command'), ctx)
    }
  }
}

/** Tool definitions in the shape the chat completions API expects. */
export const TOOL_DEFINITIONS = Object.entries(TOOLS).map(([name, spec]) => ({
  type: 'function' as const,
  function: { name, description: spec.description, parameters: spec.parameters }
}))

/** Runs a tool and always resolves with text; failures become an error message for the model. */
export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const spec = TOOLS[name]
  if (!spec) return `Error: unknown tool "${name}"`
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(rawArgs || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('arguments must be a JSON object')
    }
    args = parsed as Record<string, unknown>
  } catch (err) {
    return `Error: invalid tool arguments: ${(err as Error).message}`
  }
  try {
    return await spec.run(args, ctx)
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}
