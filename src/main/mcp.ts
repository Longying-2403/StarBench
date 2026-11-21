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
import type { ToolRegistry } from './tools.ts'

/** Generous, because `npx` may download the server on first use. */
const CONNECT_TIMEOUT_MS = 60_000
const CALL_TIMEOUT_MS = 120_000
const MAX_DESCRIPTION_CHARS = 2000
const STDERR_TAIL_CHARS = 600

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
    try {
      config = parseMcpConfig(await this.readConfigText())
    } catch (err) {
      this.lastLoadError = describe(err)
      throw err
    }
    this.lastLoadError = undefined
    await this.apply(config)
  }

  async readConfigText(): Promise<string> {
    return fs.readFile(this.opts.configFile, 'utf8').catch(() => EMPTY_MCP_CONFIG)
  }

  /** Validates and saves new configuration text, then reconnects every server. */
  async saveConfigText(text: string): Promise<void> {
    const config = parseMcpConfig(text)
    // Saved as the user wrote it would be nicer, but re-serialising guarantees the file parses next launch.
    await writeJson(this.opts.configFile, JSON.parse(text))
    this.lastLoadError = undefined
    await this.apply(config)
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
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        // An explicit env replaces the default one in the SDK, which would drop PATH.
        env: { ...getDefaultEnvironment(), ...config.env },
        cwd: config.cwd,
        stderr: 'pipe'
      })
      // What the server prints before dying is usually the only clue to why it failed.
      ;(transport.stderr as Readable | null)?.on('data', (chunk: Buffer) => stderr.push(chunk))
      return attempt(transport)
    }

    const url = new URL(config.url as string)
    const requestInit = config.headers ? { headers: config.headers } : undefined
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
