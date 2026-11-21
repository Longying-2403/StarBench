// Finds plugins on disk and starts or stops them on the kernel.
//
// A plugin is a folder under the plugins directory with a package.json and an
// ES module exporting `apply(ctx, config)` and optionally `inject`. It may also
// ship a `skills/` folder, and may consist of nothing else. Plugins run inside
// the main process with its full privileges, so each one stays off until the
// user enables it.

import type { Context, Fiber } from 'cordis'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginInfo } from '../shared/types.ts'
import { readJson, writeJson } from './json-file.ts'
import type { SkillStore } from './skills.ts'
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
  /** Absent for a plugin that only ships skills. */
  fiber?: Fiber
  inject: string[]
  error?: string
  removeSkills?: () => void
}

export interface PluginManagerOptions {
  root: Context
  tools: ToolRegistry
  /** When given, an enabled plugin's `skills/` folder is added to it. */
  skills?: Pick<SkillStore, 'addRoot' | 'list'>
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
    const skills = (await this.opts.skills?.list()) ?? []
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
        tools: tools.filter((t) => t.source === id).map((t) => t.name),
        skills: skills.filter((s) => s.source === id).map((s) => s.name)
      }
      const loadError = this.loadErrors.get(id)
      if (running) {
        const state = running.fiber?.state as number | undefined
        if (state === undefined || state === FIBER_ACTIVE) {
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
    let started = false
    try {
      const folder = path.join(this.opts.dir, id)
      const manifest = (await this.readManifest(id)) ?? {}
      const declaredMain = typeof manifest.main === 'string' && manifest.main ? manifest.main : undefined
      const main = declaredMain ?? 'index.js'
      const entry = path.resolve(folder, main)
      const relative = path.relative(folder, entry)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`"main" points outside the plugin folder: ${main}`)
      }
      const skillsDir = path.join(folder, 'skills')
      const hasSkills = Boolean(this.opts.skills) && (await isDirectory(skillsDir))
      const hasEntry = await fs.stat(entry).then((s) => s.isFile(), () => false)
      if (!hasEntry && (declaredMain || !hasSkills)) throw new Error(`Entry file not found: ${main}`)

      const running: Running = { inject: [] }
      if (hasSkills) running.removeSkills = this.opts.skills?.addRoot(skillsDir, id)
      this.running.set(id, running)
      started = true
      // A plugin without code only contributes its skills.
      if (!hasEntry) return

      // The query string makes Node evaluate the entry file again after a disable/enable.
      // Files it imports stay cached, so deeper code changes still need an app restart.
      const url = `${pathToFileURL(entry).href}?v=${Date.now()}`
      const plugin = resolveModule((await import(/* @vite-ignore */ url)) as Record<string, unknown>)
      running.inject = injectNames(plugin.inject)

      // The wrapper pins the Cordis name to the plugin id, which is how tools are attributed.
      const fiber = this.opts.root.plugin(
        { name: id, inject: running.inject, apply: (ctx: Context, config: unknown) => plugin.apply(ctx, config) },
        this.state[id]?.config ?? {}
      )
      running.fiber = fiber

      const outcome = await Promise.race([
        Promise.resolve(fiber).then(
          () => undefined,
          (err: unknown) => describe(err)
        ),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), START_TIMEOUT_MS).unref())
      ])
      if (outcome !== undefined) running.error = outcome
    } catch (err) {
      // The module could not be loaded: undo whatever was set up before the failure.
      if (started) await this.stop(id)
      this.loadErrors.set(id, describe(err))
    }
  }

  private async stop(id: string): Promise<void> {
    const running = this.running.get(id)
    if (!running) return
    this.running.delete(id)
    running.removeSkills?.()
    // Disposing the fiber undoes every effect the plugin created, including its tools.
    await running.fiber?.dispose().catch((err: unknown) => {
      console.error(`[plugins] ${id} failed while stopping: ${describe(err)}`)
    })
  }
}

function isDirectory(dir: string): Promise<boolean> {
  return fs.stat(dir).then(
    (s) => s.isDirectory(),
    () => false
  )
}
