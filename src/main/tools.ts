// The tool registry and the built-in tools. Nothing in this file depends on
// Electron or the plugin kernel, so it can be exercised from a plain Node script.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { decodeOutput } from './decode.ts'

const MAX_OUTPUT_CHARS = 30_000
/** Command output beyond this is dropped while it is still being read. */
const MAX_OUTPUT_BYTES = 400_000
/** On its own line, so PowerShell's error messages quote only the command the model wrote. */
const POWERSHELL_UTF8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n'
const MAX_FILE_BYTES = 1_000_000
const MAX_SEARCH_HITS = 200
const COMMAND_TIMEOUT_MS = 120_000
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.venv'])

export interface ToolContext {
  workspace: string
  signal: AbortSignal
}

/** What a tool author provides. This shape is the public contract for plugins. */
export interface ToolSpec {
  /** Unique name the model calls the tool by: letters, digits, "_" and "-", at most 64 characters. */
  name: string
  description: string
  /** JSON Schema of the arguments object. Defaults to an object with no properties. */
  parameters?: Record<string, unknown>
  /** Whether the user is asked before each call. Defaults to true; set false only for read-only tools. */
  needsPermission?: boolean
  /** Returns the text shown to the model. Throwing reports the error to the model instead. */
  run(args: Record<string, unknown>, ctx: ToolContext): unknown
}

export interface ToolInfo {
  name: string
  description: string
  /** Who registered it: "builtin", a plugin id, or "mcp:<server>". */
  source: string
  needsPermission: boolean
}

/** A tool as the model is told about it, independent of any provider's format. */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  null: (v) => v === null,
  // Models now and then send a number as text; tools read numbers leniently, so that passes.
  number: (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))),
  integer: (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
}

/**
 * Checks arguments against the parts of a tool's JSON Schema that show an input is incomplete or
 * of the wrong kind: required properties, and the basic type of each value given. It is not a
 * full schema validator; nested schemas, formats and limits are left to the tool.
 * Returns what is wrong, or null.
 */
export function checkArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const properties = typeof schema.properties === 'object' && schema.properties !== null ? (schema.properties as Record<string, unknown>) : {}
  /** The basic types a property may have, as far as the schema names ones this check knows. */
  const typesOf = (key: string): string[] => {
    const declared = properties[key]
    if (typeof declared !== 'object' || declared === null) return []
    const type = (declared as { type?: unknown }).type
    return (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === 'string' && t in TYPE_CHECKS)
  }

  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : []
  const missing = required.filter((key) => args[key] === undefined || (args[key] === null && !typesOf(key).includes('null')))
  if (missing.length > 0) return `missing ${missing.map((k) => JSON.stringify(k)).join(', ')}`

  for (const [key, value] of Object.entries(args)) {
    // Models often write null for an optional argument they do not use.
    if (value === null || value === undefined) continue
    const allowed = typesOf(key)
    if (allowed.length > 0 && !allowed.some((t) => TYPE_CHECKS[t](value))) {
      return `${JSON.stringify(key)} must be ${allowed.join(' or ')}`
    }
  }
  return null
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
      ? // Without this prefix PowerShell and the programs it starts write in the system code page.
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${POWERSHELL_UTF8}${command}`], {
          cwd: ctx.workspace,
          windowsHide: true
        })
      : spawn('/bin/sh', ['-c', command], { cwd: ctx.workspace })

    // Kept as bytes until the end: decoding chunk by chunk would break characters split across chunks.
    const chunks: Buffer[] = []
    let bytes = 0
    let note = ''
    const collect = (chunk: Buffer): void => {
      if (bytes < MAX_OUTPUT_BYTES) chunks.push(chunk)
      bytes += chunk.length
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
      // Some programs ignore the console code page, so the decoder still falls back to it.
      const output = decodeOutput(Buffer.concat(chunks))
      resolve(truncate(`${output}${output && !output.endsWith('\n') ? '\n' : ''}${tail}`))
    }
    child.on('error', (err) => finish(`Failed to start command: ${err.message}`))
    child.on('close', (code) => finish(note ? `[${note}]` : `[exit code ${code}]`))
  })
}

const BUILTIN_TOOLS: Record<string, Omit<ToolSpec, 'name'>> = {
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

interface RegisteredTool {
  spec: ToolSpec
  parameters: Record<string, unknown>
  source: string
  needsPermission: boolean
}

/** Every tool the model can call, whoever provided it. */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  /**
   * Adds a tool and returns the function that removes it again.
   * Throws on an invalid spec or a name that is already taken.
   */
  register(spec: ToolSpec, source: string): () => void {
    if (typeof spec !== 'object' || spec === null) throw new Error('Tool spec must be an object')
    const { name } = spec
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      throw new Error(`Invalid tool name ${JSON.stringify(name)}: use letters, digits, "_" and "-", at most 64 characters`)
    }
    if (typeof spec.description !== 'string' || !spec.description.trim()) {
      throw new Error(`Tool "${name}" needs a description`)
    }
    if (typeof spec.run !== 'function') throw new Error(`Tool "${name}" needs a run function`)
    const parameters = spec.parameters ?? { type: 'object', properties: {} }
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
      throw new Error(`Tool "${name}": parameters must be a JSON Schema object`)
    }
    const existing = this.tools.get(name)
    if (existing) throw new Error(`Tool "${name}" is already registered by ${existing.source}`)

    const entry: RegisteredTool = { spec, parameters, source, needsPermission: spec.needsPermission !== false }
    this.tools.set(name, entry)
    return () => {
      // Only remove our own entry: the name may have been re-registered since.
      if (this.tools.get(name) === entry) this.tools.delete(name)
    }
  }

  list(): ToolInfo[] {
    return [...this.tools.entries()].map(([name, t]) => ({
      name,
      description: t.spec.description,
      source: t.source,
      needsPermission: t.needsPermission
    }))
  }

  /** What the model is told about each tool. Each provider turns this into its own request format. */
  specs(): ToolDefinition[] {
    return [...this.tools.entries()].map(([name, t]) => ({ name, description: t.spec.description, parameters: t.parameters }))
  }

  /** Unknown tools need no prompt: running them only reports the error to the model. */
  needsPermission(name: string): boolean {
    return this.tools.get(name)?.needsPermission ?? false
  }

  /** Runs a tool and always resolves with text; failures become an error message for the model. */
  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) return `Error: unknown tool "${name}"`
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
    // A model can send arguments that parse but are incomplete, for instance when its output was
    // cut short. Saying exactly what is wrong lets it send the call again, instead of the tool
    // running on half an input.
    const problem = checkArguments(tool.parameters, args)
    if (problem) return `Error: invalid arguments for ${name}: ${problem}. Received: ${rawArgs.slice(0, 2000)}`
    try {
      const result: unknown = await tool.spec.run(args, ctx)
      if (typeof result === 'string') return truncate(result)
      if (result === undefined || result === null) return '(no output)'
      return truncate(JSON.stringify(result, null, 2) ?? String(result))
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const [name, spec] of Object.entries(BUILTIN_TOOLS)) registry.register({ name, ...spec }, 'builtin')
}
