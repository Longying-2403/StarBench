// Finds plugins on disk and starts or stops them on the kernel.
//
// A plugin is a folder under the plugins directory with a package.json and an
// ES module exporting `apply(ctx, config)` and optionally `inject`. Plugins
// run inside the main process with its full privileges, so each one stays off
// until the user enables it.

import type { Context, Fiber } from 'cordis'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginInfo } from '../shared/types.ts'
import { readJson, writeJson } from './json-file.ts'
import type { ToolRegistry } from './tools.ts'

/** How long enabling waits for a plugin to start before reporting it as still waiting. */
const START_TIMEOUT_MS = 2000
// Values of cordis' FiberState, which is a const enum and so cannot be imported.
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

interface Manifest {
  name?: unknown
  version?: unknown
  description?: unknown
  main?: unknown
}

interface StoredState {
  enabled?: boolean
  /** Passed to the plugin as the second argument of `apply`. */
  config?: unknown
}

interface PluginModule {
  inject?: unknown
  apply(ctx: Context, config: unknown): unknown
}

interface Running {
  fiber: Fiber
  inject: string[]
  error?: string
}

export interface PluginManagerOptions {
  root: Context
  tools: ToolRegistry
  /** Folder holding one sub-folder per plugin. */
  dir: string
  /** JSON file remembering which plugins are enabled and their config. */
  stateFile: string
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Accepts `export function apply`, a default-exported function, or a default-exported object. */
function resolveModule(mod: Record<string, unknown>): PluginModule {
  const candidates = [mod, mod.default]
  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      return { inject: (candidate as { inject?: unknown }).inject, apply: candidate as PluginModule['apply'] }
    }
    if (candidate && typeof (candidate as PluginModule).apply === 'function') return candidate as PluginModule
  }
  throw new Error('The plugin module must export an apply(ctx, config) function')
}

function injectNames(inject: unknown): string[] {
  if (Array.isArray(inject)) return inject.filter((n): n is string => typeof n === 'string')
  if (inject && typeof inject === 'object') return Object.keys(inject)
  return []
}

export class PluginManager {
  private running = new Map<string, Running>()
  /** Start-up failures of plugins that are enabled but could not be loaded. */
  private loadErrors = new Map<string, string>()
  private state: Record<string, StoredState> = {}
  private opts: PluginManagerOptions
  /** Serialises enable/disable so two quick toggles cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: PluginManagerOptions) {
    this.opts = opts
  }

  get dir(): string {
    return this.opts.dir
  }

  /** Creates the plugins folder and starts every plugin the user enabled earlier. */
  async init(): Promise<void> {
    await fs.mkdir(this.opts.dir, { recursive: true })
    this.state = (await readJson<Record<string, StoredState>>(this.opts.stateFile)) ?? {}
    for (const id of await this.discover()) {
      if (this.state[id]?.enabled) await this.start(id)
    }
  }

  async list(): Promise<PluginInfo[]> {
    const tools = this.opts.tools.list()
    const infos: PluginInfo[] = []
    for (const id of await this.discover()) {
      const manifest = (await this.readManifest(id)) ?? {}
      const running = this.running.get(id)
      const info: PluginInfo = {
        id,
        name: typeof manifest.name === 'string' && manifest.name ? manifest.name : id,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        enabled: Boolean(this.state[id]?.enabled),
        status: 'disabled',
        tools: tools.filter((t) => t.source === id).map((t) => t.name)
      }
      const loadError = this.loadErrors.get(id)
      if (running) {
        const state = running.fiber.state as number
        if (state === FIBER_ACTIVE) {
          info.status = 'active'
        } else if (state === FIBER_FAILED || running.error) {
          info.status = 'error'
          info.error = running.error ?? 'The plugin failed to start'
        } else {
          info.status = 'waiting'
          const missing = running.inject.filter((name) => this.opts.root.get(name) === undefined)
          if (missing.length) info.error = `Waiting for services: ${missing.join(', ')}`
        }
      } else if (loadError) {
        info.status = 'error'
        info.error = loadError
      }
      infos.push(info)
    }
    return infos.sort((a, b) => a.name.localeCompare(b.name))
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    const task = this.queue.then(async () => {
      if (!(await this.discover()).includes(id)) throw new Error(`Unknown plugin: ${id}`)
      this.state[id] = { ...this.state[id], enabled }
      await writeJson(this.opts.stateFile, this.state)
      await this.stop(id)
      if (enabled) await this.start(id)
    })
    this.queue = task.catch(() => {})
    return task
  }

  /** Stops every running plugin. */
  async dispose(): Promise<void> {
    await this.queue
    for (const id of [...this.running.keys()]) await this.stop(id)
  }

  /** Plugin ids are folder names; only folders with a package.json count. */
  private async discover(): Promise<string[]> {
    const entries = await fs.readdir(this.opts.dir, { withFileTypes: true }).catch(() => [])
    const ids: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (await this.readManifest(entry.name)) ids.push(entry.name)
    }
    return ids
  }

  private readManifest(id: string): Promise<Manifest | null> {
    return readJson<Manifest>(path.join(this.opts.dir, id, 'package.json'))
  }

  private async start(id: string): Promise<void> {
    this.loadErrors.delete(id)
    let fiber: Fiber | undefined
    try {
      const folder = path.join(this.opts.dir, id)
      const manifest = (await this.readManifest(id)) ?? {}
      const main = typeof manifest.main === 'string' && manifest.main ? manifest.main : 'index.js'
      const entry = path.resolve(folder, main)
      const relative = path.relative(folder, entry)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`"main" points outside the plugin folder: ${main}`)
      }
      // The query string makes Node evaluate the entry file again after a disable/enable.
      // Files it imports stay cached, so deeper code changes still need an app restart.
      const url = `${pathToFileURL(entry).href}?v=${Date.now()}`
      const plugin = resolveModule((await import(/* @vite-ignore */ url)) as Record<string, unknown>)
      const inject = injectNames(plugin.inject)

      // The wrapper pins the Cordis name to the plugin id, which is how tools are attributed.
      const started = this.opts.root.plugin(
        { name: id, inject, apply: (ctx: Context, config: unknown) => plugin.apply(ctx, config) },
        this.state[id]?.config ?? {}
      )
      fiber = started
      const running: Running = { fiber: started, inject }
      this.running.set(id, running)

      const outcome = await Promise.race([
        Promise.resolve(started).then(
          () => undefined,
          (err: unknown) => describe(err)
        ),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), START_TIMEOUT_MS).unref())
      ])
      if (outcome !== undefined) running.error = outcome
    } catch (err) {
      this.loadErrors.set(id, describe(err))
      if (fiber) await this.stop(id)
    }
  }

  private async stop(id: string): Promise<void> {
    const running = this.running.get(id)
    if (!running) return
    this.running.delete(id)
    // Disposing the fiber undoes every effect the plugin created, including its tools.
    await running.fiber.dispose().catch((err: unknown) => {
      console.error(`[plugins] ${id} failed while stopping: ${describe(err)}`)
    })
  }
}
