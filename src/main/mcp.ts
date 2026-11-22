// MCP client: connects to the Model Context Protocol servers listed in mcp.json
// and offers their tools to the model. Servers run as separate processes (or
// remote services), so unlike plugins they need no trust in this process.
// Nothing in this file depends on Electron.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { promises as fs } from 'node:fs'
import type { Readable } from 'node:stream'
import type { McpServerStatus } from '../shared/types.ts'
import { OutputTail } from './decode.ts'
import { writeJson } from './json-file.ts'
import { envValue, onPath } from './program-path.ts'
import { sendsKeySafely } from '../shared/key-address.ts'
import type { ToolRegistry } from './tools.ts'

/** Generous, because `npx` may download the server on first use. */
const CONNECT_TIMEOUT_MS = 60_000
const CALL_TIMEOUT_MS = 120_000
const MAX_DESCRIPTION_CHARS = 2000
const STDERR_TAIL_CHARS = 600
/** Why the headers of a remote server go only where plain http would not expose them (shared/key-address.ts). */
const HEADERS_NEED_HTTPS =
  "Headers are only sent over https://, or over http:// to this computer or to a local-network IP address: they usually carry a token, and a name could be answered for by another machine. Change the address to https://, or write the server's IP address."
/** How a value of `env` or `headers` starts in mcp.json once it is sealed; the sealed form follows. */
const SEALED = 'starbench-sealed:'

export const EMPTY_MCP_CONFIG = '{\n  "mcpServers": {}\n}\n'

/** One entry of `mcpServers`, in the format other MCP clients use. */
export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** For `url` servers: "sse" selects the older SSE transport. */
  type?: string
  disabled?: boolean
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringMap(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`${where} must be an object whose values are strings`)
  }
  return value as Record<string, string>
}

/** Parses and validates the text of mcp.json. Throws an error fit to show to the user. */
export function parseMcpConfig(text: string): McpConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`)
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error('The configuration must be an object with an "mcpServers" object')
  }
  const mcpServers: Record<string, McpServerConfig> = {}
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    const where = `Server "${name}"`
    if (!name.trim()) throw new Error('Server names must not be empty')
    if (!isRecord(raw)) throw new Error(`${where} must be an object`)
    const hasCommand = typeof raw.command === 'string' && raw.command !== ''
    const hasUrl = typeof raw.url === 'string' && raw.url !== ''
    if (hasCommand === hasUrl) throw new Error(`${where} needs either "command" or "url"`)
    if (hasUrl && !/^https?:\/\//i.test(raw.url as string)) throw new Error(`${where}: "url" must start with http:// or https://`)
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string'))) {
      throw new Error(`${where}: "args" must be an array of strings`)
    }
    if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new Error(`${where}: "cwd" must be a string`)
    mcpServers[name] = {
      ...(hasCommand ? { command: raw.command as string } : { url: raw.url as string }),
      args: raw.args as string[] | undefined,
      env: stringMap(raw.env, `${where}: "env"`),
      headers: stringMap(raw.headers, `${where}: "headers"`),
      cwd: raw.cwd as string | undefined,
      type: typeof raw.type === 'string' ? raw.type : undefined,
      disabled: raw.disabled === true
    }
  }
  return { mcpServers }
}

/** Tool names must fit the model API's rules; server and tool names often do not. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64)
}

interface ToolResult {
  content?: unknown
  structuredContent?: unknown
  /** What servers predating `content` return. */
  toolResult?: unknown
  isError?: unknown
}

/** Flattens an MCP tool result into the text handed to the model. Throws when the server flagged an error. */
export function formatMcpResult(result: ToolResult): string {
  const parts: string[] = []
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(item)) continue
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    else if (item.type === 'resource' && isRecord(item.resource) && typeof item.resource.text === 'string') parts.push(item.resource.text)
    else if (item.type === 'resource_link' && typeof item.uri === 'string') parts.push(`[resource: ${item.uri}]`)
    else parts.push(`[${String(item.type)} content omitted]`)
  }
  const fallback = result.structuredContent ?? result.toolResult
  if (parts.length === 0 && fallback !== undefined) {
    parts.push(typeof fallback === 'string' ? fallback : JSON.stringify(fallback, null, 2))
  }
  const text = parts.join('\n') || '(no output)'
  if (result.isError) throw new Error(text)
  return text
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Seals secrets and opens them again: the operating system's credential store, the way API keys are kept (store.ts). */
export interface SecretBox {
  seal(value: string): Promise<string>
  open(sealed: string): Promise<string>
}

/** Applies `change` to every value of `env` and `headers` of every server of a parsed mcp.json; the rest stays as it is. */
async function mapSecrets(raw: unknown, change: (value: string) => Promise<string>): Promise<unknown> {
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) return raw
  const servers: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(raw.mcpServers)) {
    if (!isRecord(server)) {
      servers[name] = server
      continue
    }
    const next: Record<string, unknown> = { ...server }
    for (const field of ['env', 'headers']) {
      const values = server[field]
      if (!isRecord(values)) continue
      const changed: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(values)) changed[key] = typeof value === 'string' ? await change(value) : value
      next[field] = changed
    }
    servers[name] = next
  }
  return { ...raw, mcpServers: servers }
}

interface Connection {
  name: string
  config: McpServerConfig
  state: McpServerStatus['state']
  error?: string
  client?: Client
  toolNames: string[]
  removeTools: (() => void)[]
}

export interface McpManagerOptions {
  /** Path of mcp.json. */
  configFile: string
  tools: ToolRegistry
  /** How this app introduces itself to servers. */
  clientInfo: { name: string; version: string }
  /**
   * How the values of `env` and `headers` are kept on disk: sealed, and opened again to be used
   * or edited. Without it they are kept as they are written.
   */
  secrets?: SecretBox
}

export class McpManager {
  private opts: McpManagerOptions
  private servers = new Map<string, Connection>()
  /** Bumped on every (re)load; a connection that finishes for an older generation is discarded. */
  private generation = 0
  private pending: Promise<void>[] = []
  private lastLoadError: string | undefined

  constructor(opts: McpManagerOptions) {
    this.opts = opts
  }

  /** Why mcp.json could not be loaded the last time it was read, if it could not. */
  get loadError(): string | undefined {
    return this.lastLoadError
  }

  /**
   * Loads mcp.json and starts connecting. A broken file rejects and is remembered in
   * `loadError`; the servers that were connected before stay as they are.
   */
  async init(): Promise<void> {
    let config: McpConfig
    let text: string
    try {
      text = await this.readFileText()
      config = parseMcpConfig(text)
    } catch (err) {
      this.lastLoadError = describe(err)
      throw err
    }
    this.lastLoadError = undefined
    // A token written into the file by hand, or by a version that kept them as written, is sealed now.
    await this.sealOnDisk(text).catch((err) => console.error('[mcp] could not seal the secrets in mcp.json:', describe(err)))
    await this.apply(config)
  }

  private readFileText(): Promise<string> {
    return fs.readFile(this.opts.configFile, 'utf8').catch(() => EMPTY_MCP_CONFIG)
  }

  /**
   * The text of mcp.json as the settings page edits it: with the secrets opened. One that cannot be
   * opened here is shown sealed, to be replaced; its server says why it does not connect.
   */
  async readConfigText(): Promise<string> {
    const text = await this.readFileText()
    if (!this.opts.secrets || !text.includes(SEALED)) return text
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return text
    }
    return `${JSON.stringify(await mapSecrets(raw, (value) => this.openValue(value).catch(() => value)), null, 2)}\n`
  }

  /** Validates and saves new configuration text, its secrets sealed, then reconnects every server. */
  async saveConfigText(text: string): Promise<void> {
    const config = parseMcpConfig(text)
    // Saved as the user wrote it would be nicer, but re-serialising guarantees the file parses next launch.
    await writeJson(this.opts.configFile, await mapSecrets(JSON.parse(text), (value) => this.sealValue(value)))
    this.lastLoadError = undefined
    await this.apply(config)
  }

  /** Seals what mcp.json holds unsealed. The file is written again only where there was something to seal. */
  private async sealOnDisk(text: string): Promise<void> {
    if (!this.opts.secrets) return
    let plain = false
    const sealed = await mapSecrets(JSON.parse(text), async (value) => {
      if (value.startsWith(SEALED)) return value
      plain = true
      return this.sealValue(value)
    })
    if (plain) await writeJson(this.opts.configFile, sealed)
  }

  /** A value as it is kept on disk: sealed, unless it already is or there is nothing to seal with. */
  private async sealValue(value: string): Promise<string> {
    return !this.opts.secrets || value.startsWith(SEALED) ? value : SEALED + (await this.opts.secrets.seal(value))
  }

  /** A value as it is used. Throws for a sealed one that cannot be opened here. */
  private async openValue(value: string): Promise<string> {
    if (!value.startsWith(SEALED)) return value
    if (!this.opts.secrets) throw new Error('Nothing was given to open sealed values with')
    return this.opts.secrets.open(value.slice(SEALED.length))
  }

  /** The values of `env` or `headers` as they are used; one that cannot be read here fails the server, saying what to do. */
  private async openAll(values: Record<string, string>): Promise<Record<string, string>> {
    const opened: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      try {
        opened[key] = await this.openValue(value)
      } catch {
        throw new Error(`The value of "${key}" was saved on another computer or by another Windows user and cannot be read here. Enter it again in the MCP settings.`)
      }
    }
    return opened
  }

  /** Drops every connection and connects again from the saved file. */
  async reconnect(): Promise<void> {
    await this.init()
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((c) => ({
      name: c.name,
      transport: c.config.command ? 'stdio' : 'http',
      state: c.state,
      ...(c.error ? { error: c.error } : {}),
      tools: [...c.toolNames]
    }))
  }

  /** Resolves when every connection attempt of the current load has finished. */
  async settled(): Promise<void> {
    await Promise.allSettled(this.pending)
  }

  async dispose(): Promise<void> {
    this.generation++
    await this.closeAll()
  }

  private async apply(config: McpConfig): Promise<void> {
    const generation = ++this.generation
    await this.closeAll()
    this.pending = []
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      const conn: Connection = {
        name,
        config: serverConfig,
        state: serverConfig.disabled ? 'disabled' : 'connecting',
        toolNames: [],
        removeTools: []
      }
      this.servers.set(name, conn)
      if (!serverConfig.disabled) this.pending.push(this.connect(conn, generation))
    }
  }

  private async closeAll(): Promise<void> {
    const old = [...this.servers.values()]
    this.servers = new Map()
    await Promise.allSettled(old.map((conn) => this.close(conn)))
  }

  private async close(conn: Connection): Promise<void> {
    for (const remove of conn.removeTools.splice(0)) remove()
    conn.toolNames = []
    const client = conn.client
    conn.client = undefined
    await client?.close()
  }

  /** Connects one server and registers its tools. Never rejects: failures land in the status. */
  private async connect(conn: Connection, generation: number): Promise<void> {
    const stderr = new OutputTail(STDERR_TAIL_CHARS)
    const withStderr = (message: string): string => {
      const tail = stderr.text()
      return tail ? `${message}\n${tail}` : message
    }
    let client: Client | undefined
    try {
      client = await this.open(conn.config, stderr)
      if (generation !== this.generation) return void (await client.close())
      conn.client = client
      const connected = client
      client.onclose = () => {
        // Fired when the server exits or the network drops, not when we close it ourselves.
        if (conn.client !== connected) return
        conn.state = 'error'
        conn.error = withStderr('Connection closed')
        void this.close(conn).catch(() => {})
      }

      const skipped: string[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS })
        if (generation !== this.generation) return void (await this.close(conn))
        for (const tool of page.tools) {
          const name = mcpToolName(conn.name, tool.name)
          try {
            conn.removeTools.push(
              this.opts.tools.register(
                {
                  name,
                  description: (tool.description || `Tool "${tool.name}" of the MCP server "${conn.name}".`).slice(0, MAX_DESCRIPTION_CHARS),
                  parameters: tool.inputSchema as Record<string, unknown>,
                  // Servers describe their own tools, so none of them is trusted to skip the prompt.
                  needsPermission: true,
                  run: async (args, ctx) =>
                    formatMcpResult(
                      await connected.callTool({ name: tool.name, arguments: args }, undefined, {
                        signal: ctx.signal,
                        timeout: CALL_TIMEOUT_MS,
                        resetTimeoutOnProgress: true
                      })
                    )
                },
                `mcp:${conn.name}`
              )
            )
            conn.toolNames.push(name)
          } catch (err) {
            skipped.push(`${tool.name} (${describe(err)})`)
          }
        }
        cursor = page.nextCursor
      } while (cursor)

      conn.state = 'connected'
      conn.error = skipped.length ? `Skipped tools: ${skipped.join('; ')}` : undefined
    } catch (err) {
      if (generation !== this.generation) return
      conn.state = 'error'
      conn.error = withStderr(describe(err))
      await this.close(conn).catch(() => {})
      if (client && conn.client !== client) await client.close().catch(() => {})
    }
  }

  private async open(config: McpServerConfig, stderr: OutputTail): Promise<Client> {
    const attempt = async (transport: Transport): Promise<Client> => {
      const client = new Client(this.opts.clientInfo)
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
        return client
      } catch (err) {
        await client.close().catch(() => {})
        throw err
      }
    }

    if (config.command) {
      // An explicit env replaces the default one in the SDK, which would drop PATH.
      const env = { ...getDefaultEnvironment(), ...(config.env ? await this.openAll(config.env) : {}) }
      const transport = new StdioClientTransport({
        // Looked up in PATH here: by name alone, a program of that name in `cwd` would be started instead (program-path.ts).
        command: onPath(config.command, envValue(env, 'PATH'), process.env.PATHEXT),
        args: config.args,
        env,
        cwd: config.cwd,
        stderr: 'pipe'
      })
      // What the server prints before dying is usually the only clue to why it failed.
      ;(transport.stderr as Readable | null)?.on('data', (chunk: Buffer) => stderr.push(chunk))
      return attempt(transport)
    }

    // Headers mostly carry a token, which plain http would hand to every network on the way.
    if (config.headers && Object.keys(config.headers).length > 0 && !sendsKeySafely(config.url as string)) throw new Error(HEADERS_NEED_HTTPS)
    const url = new URL(config.url as string)
    const requestInit = config.headers ? { headers: await this.openAll(config.headers) } : undefined
    if (config.type === 'sse') return attempt(new SSEClientTransport(url, { requestInit }))
    try {
      return await attempt(new StreamableHTTPClientTransport(url, { requestInit }))
    } catch (err) {
      // Older servers only speak the SSE transport; report the first error if that fails too.
      return attempt(new SSEClientTransport(url, { requestInit })).catch(() => {
        throw err
      })
    }
  }
}
