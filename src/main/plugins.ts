// Finds plugins on disk and starts or stops them on the kernel.
//
// A plugin is a folder under the plugins directory with a package.json and an
// ES module exporting `apply(ctx, config)` and optionally `inject`. It may also
// ship a `skills/` folder, and a `ui/` folder with an interface that the page
// loads (shared/plugin-ui.ts); it may consist of either of those and nothing
// else. Plugins run inside the main process with its full privileges, so each
// one stays off until the user enables it.

import type { Context, Fiber } from 'cordis'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_UI_ENTRY, PLUGIN_UI_STYLE } from '../shared/plugin-ui.ts'
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
  /** Absent for a plugin that has no code for the main process: only skills, or only an interface. */
  fiber?: Fiber
  inject: string[]
  error?: string
  removeSkills?: () => void
  /** It has an interface for the page to load: a `ui/index.js`. */
  ui: boolean
  /** Its interface comes with a style sheet: a `ui/index.css`. */
  uiStyle: boolean
  /** Which start this is, counted over all plugins since the app started. */
  run: number
  /** Where it was started from: the folder it was in at that moment. */
  folder: string
}

/** A plugin as it is found on disk. */
interface Found {
  folder: string
  builtin: boolean
}

/** The most a plugin's config may come to once it is written out. It is read whole at every start and kept in one file with the others. */
const MAX_CONFIG_BYTES = 64 * 1024

export interface PluginManagerOptions {
  root: Context
  tools: ToolRegistry
  /** When given, an enabled plugin's `skills/` folder is added to it. */
  skills?: Pick<SkillStore, 'addRoot' | 'list'>
  /** Folder holding one sub-folder per plugin: the person's own, which the settings page opens. */
  dir: string
  /**
   * A second folder of the same kind, with the plugins that come with the app. They are found
   * and switched on and off like the others, and say that they are built in. A plugin of the
   * person's own with the same folder name takes the place of the built-in one, so that a copy
   * of it can be changed and tried.
   */
  builtinDir?: string
  /** JSON file remembering which plugins are enabled and their config. */
  stateFile: string
  /**
   * Plugins are found and listed, and none is started: the app was started without them, as the
   * way out when one of them keeps it from being usable. The switches can still be changed, and
   * count from the next ordinary start.
   */
  held?: boolean
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
  /** Counts the starts, so that the page can tell a plugin that was started again from one that kept running. */
  private runs = 0

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
    if (this.opts.held) return
    for (const id of (await this.discover()).keys()) {
      if (this.state[id]?.enabled) await this.start(id)
    }
  }

  /** What a plugin has saved as its config: a copy, so that nothing is changed by changing it. Empty when it has saved none. */
  configOf(id: string): Record<string, unknown> {
    const config = this.state[id]?.config
    return typeof config === 'object' && config !== null && !Array.isArray(config) ? (structuredClone(config) as Record<string, unknown>) : {}
  }

  /**
   * Saves a plugin's config in place of what it had: an object of plain data, which is what the
   * file can hold. It counts at once for whoever asks `configOf`, and is handed to the plugin's
   * `apply` at its next start.
   */
  setConfig(id: string, value: unknown): Promise<void> {
    let text: string | undefined
    try {
      text = JSON.stringify(value)
    } catch {
      // A value that turns in on itself, or holds what cannot be written down.
    }
    const plain: unknown = text === undefined ? undefined : JSON.parse(text)
    if (typeof plain !== 'object' || plain === null || Array.isArray(plain)) return Promise.reject(new Error('A plugin config has to be an object of plain data'))
    if (Buffer.byteLength(text!, 'utf8') > MAX_CONFIG_BYTES) return Promise.reject(new Error(`A plugin config can be at most ${MAX_CONFIG_BYTES / 1024} KB`))
    // Counts from now, also for a reader that does not wait for the file.
    this.state[id] = { ...this.state[id], config: plain }
    const task = this.queue.then(() => writeJson(this.opts.stateFile, this.state))
    this.queue = task.catch(() => {})
    return task
  }

  /** Whether the app was started with every plugin left out. */
  get held(): boolean {
    return Boolean(this.opts.held)
  }

  async list(): Promise<PluginInfo[]> {
    const tools = this.opts.tools.list()
    const skills = (await this.opts.skills?.list()) ?? []
    const infos: PluginInfo[] = []
    for (const [id, found] of await this.discover()) {
      const manifest = (await this.readManifest(found.folder)) ?? {}
      const running = this.running.get(id)
      const info: PluginInfo = {
        id,
        name: typeof manifest.name === 'string' && manifest.name ? manifest.name : id,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        builtin: found.builtin,
        enabled: Boolean(this.state[id]?.enabled),
        status: 'disabled',
        tools: tools.filter((t) => t.source === id).map((t) => t.name),
        skills: skills.filter((s) => s.source === id).map((s) => s.name),
        ui: Boolean(running?.ui),
        uiStyle: Boolean(running?.ui && running.uiStyle),
        run: running?.run ?? 0
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
      } else if (this.opts.held && info.enabled) {
        info.status = 'held'
      }
      infos.push(info)
    }
    return infos.sort((a, b) => a.name.localeCompare(b.name))
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    const task = this.queue.then(async () => {
      if (!(await this.discover()).has(id)) throw new Error(`Unknown plugin: ${id}`)
      this.state[id] = { ...this.state[id], enabled }
      await writeJson(this.opts.stateFile, this.state)
      await this.stop(id)
      if (enabled && !this.opts.held) await this.start(id)
    })
    this.queue = task.catch(() => {})
    return task
  }

  /**
   * Stops a plugin that is switched on and starts it again, to take up what was changed in its
   * folder: its entry for the main process is read anew, and so is its interface in the page.
   * Files that the entry for the main process imports stay as they were read first; those need
   * the app started again.
   */
  reload(id: string): Promise<void> {
    const task = this.queue.then(async () => {
      if (!(await this.discover()).has(id)) throw new Error(`Unknown plugin: ${id}`)
      if (!this.state[id]?.enabled) throw new Error(`The plugin "${id}" is switched off`)
      await this.stop(id)
      if (!this.opts.held) await this.start(id)
    })
    this.queue = task.catch(() => {})
    return task
  }

  /**
   * Where a file of a plugin's interface is on disk: `file` within the plugin's `ui/` folder. Null
   * unless the plugin is switched on and the file lies in that folder. The page loads what this
   * names, so it names nothing else: not the plugin's own code for the main process, not its
   * dependencies, and not a plugin that is off.
   */
  uiFile(id: string, file: string): string | null {
    const running = this.running.get(id)
    if (!running) return null
    const root = path.join(running.folder, 'ui')
    const full = path.resolve(root, file)
    const relative = path.relative(root, full)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
    return full
  }

  /** Stops every running plugin. */
  async dispose(): Promise<void> {
    await this.queue
    for (const id of [...this.running.keys()]) await this.stop(id)
    // What a plugin saved as it stopped is on disk before this is over.
    await this.queue
  }

  /**
   * The plugins on disk, by id. Plugin ids are folder names; only folders with a package.json
   * count. The person's own folder is looked through first, so that a plugin there stands in
   * front of a built-in one of the same name.
   */
  private async discover(): Promise<Map<string, Found>> {
    const found = new Map<string, Found>()
    const roots = [{ dir: this.opts.dir, builtin: false }, ...(this.opts.builtinDir ? [{ dir: this.opts.builtinDir, builtin: true }] : [])]
    for (const root of roots) {
      const entries = await fs.readdir(root.dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || found.has(entry.name)) continue
        const folder = path.join(root.dir, entry.name)
        if (await this.readManifest(folder)) found.set(entry.name, { folder, builtin: root.builtin })
      }
    }
    return found
  }

  private readManifest(folder: string): Promise<Manifest | null> {
    return readJson<Manifest>(path.join(folder, 'package.json'))
  }

  private async start(id: string): Promise<void> {
    this.loadErrors.delete(id)
    let started = false
    try {
      const folder = (await this.discover()).get(id)?.folder
      if (!folder) throw new Error(`Unknown plugin: ${id}`)
      const manifest = (await this.readManifest(folder)) ?? {}
      const declaredMain = typeof manifest.main === 'string' && manifest.main ? manifest.main : undefined
      const main = declaredMain ?? 'index.js'
      const entry = path.resolve(folder, main)
      const relative = path.relative(folder, entry)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`"main" points outside the plugin folder: ${main}`)
      }
      const skillsDir = path.join(folder, 'skills')
      const hasSkills = Boolean(this.opts.skills) && (await isDirectory(skillsDir))
      const hasEntry = await isFile(entry)
      const hasUi = await isFile(path.join(folder, 'ui', PLUGIN_UI_ENTRY))
      // A plugin may be skills alone, or an interface alone; one that names an entry has to have it.
      if (!hasEntry && (declaredMain || (!hasSkills && !hasUi))) throw new Error(`Entry file not found: ${main}`)

      const running: Running = { inject: [], ui: hasUi, uiStyle: hasUi && (await isFile(path.join(folder, 'ui', PLUGIN_UI_STYLE))), run: ++this.runs, folder }
      if (hasSkills) running.removeSkills = this.opts.skills?.addRoot(skillsDir, id)
      this.running.set(id, running)
      started = true
      // A plugin without code for the main process contributes its skills, its interface, or both.
      if (!hasEntry) return

      // The query string makes Node evaluate the entry file again after a disable/enable.
      // Files it imports stay cached, so deeper code changes still need an app restart.
      const url = `${pathToFileURL(entry).href}?v=${Date.now()}`
      const plugin = resolveModule((await import(/* @vite-ignore */ url)) as Record<string, unknown>)
      running.inject = injectNames(plugin.inject)

      // The wrapper pins the Cordis name to the plugin id, which is how tools are attributed.
      const fiber = this.opts.root.plugin(
        { name: id, inject: running.inject, apply: (ctx: Context, config: unknown) => plugin.apply(ctx, config) },
        this.configOf(id)
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

function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then(
    (s) => s.isFile(),
    () => false
  )
}
