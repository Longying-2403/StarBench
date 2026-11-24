// The memory: notes the model keeps from one conversation to the next. Each note is a Markdown
// file in the app's data folder, those that hold everywhere in `memory/global/`, those of a
// workspace in a folder of their own under `memory/workspaces/`. Nothing of it lies in the
// workspace itself: a repository that was cloned cannot bring notes along, and nothing is written
// into the person's project.
//
// A conversation takes in the notes at its first turn and goes on with those (shared/memory.ts,
// `refreshSnapshot`), so that the start of its requests stays the same and the services can read
// it from their caches. The model reads and writes notes through three tools that the memory adds
// to each turn, as far as the person lets the service in use.
//
// Nothing in this file depends on Electron.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { folderKey, folderName } from '../shared/folders.ts'
import {
  DETAILS_MAX,
  MEMORY_DEFAULTS,
  TEXT_MAX,
  argsSensitive,
  cleanMemorySettings,
  cleanText,
  defaultScope,
  isMemoryKind,
  isProviderMode,
  listLimit,
  memoryIdOf,
  memoryPrompt,
  newMemoryId,
  readEntryFile,
  refreshSnapshot,
  toSnapshotEntry,
  writeEntryFile
} from '../shared/memory.ts'
import type {
  MemoryChange,
  MemoryEntry,
  MemoryEvent,
  MemoryInput,
  MemoryKind,
  MemoryListing,
  MemoryScope,
  MemorySettings,
  MemorySnapshot,
  MemorySource,
  MemoryState,
  MemoryUse,
  ProviderMemoryMode
} from '../shared/memory.ts'
import type { TurnOptions } from './agent.ts'
import { readJson, writeJson } from './json-file.ts'
import type { SkillStore } from './skills.ts'
import { ToolRegistry } from './tools.ts'
import type { ToolSpec } from './tools.ts'

/** What a turn hands the model as tools, and what the memory hands it back with its own put in. */
export type TurnTools = TurnOptions['tools']

export interface MemoryServiceOptions {
  /** The folder the memory keeps everything in: `<userData>/memory`. */
  dir: string
  /** The commands that come with the memory (memory-commands/), offered while the memory is on. */
  commandsDir?: string
  skills?: Pick<SkillStore, 'addRoot'>
  /** Folders are told apart as Windows does: without regard to letter case or to which separator is used. */
  windows: boolean
  /** The folders of the workspaces in the list, for telling which notes belong to one that was taken out of it. */
  workspaces?: () => Promise<string[]>
  /** Tells the page of a change. */
  emit(event: MemoryEvent): void
  /** The clock, for tests. */
  now?: () => number
}

/** The model a turn talks to, as far as the memory needs to know it. */
export interface MemoryTurn {
  /** The id of the conversation. */
  session: string
  workspace: string
  provider: { id: string; name?: string; local: boolean }
  model: string
  /** How many tokens the model's context holds, where that is known. */
  window?: number
}

/** The model a list is drawn up for on the page. */
export interface MemoryUseOf {
  provider: { id: string; name: string; local: boolean }
  window?: number
}

/** A change kept for a while, so that it can be undone. */
interface Done {
  action: MemoryChange['action']
  before?: MemoryEntry
  after?: MemoryEntry
}

/** How many changes are kept for undoing. */
const KEEP_DONE = 100
const NOTE_FILE = /^([a-z0-9]{1,16})\.md$/
const SESSION_ID = /^[\w-]{1,100}$/

/** A folder's name as part of the name of another folder: what Windows does not allow in a name taken out. */
const safeName = (name: string): string => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').slice(0, 40) || 'workspace'

/** Writes a file in one piece: a reader sees the old file or the new one, never half of it. */
async function writeText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Something else (a virus scanner, an indexer) has the file open for a moment.
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 12) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '')

/** A day as it stands on the person's calendar, as the instructions give today's date (agent.ts), and not as it is in Greenwich. */
function dayOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export class MemoryService {
  private opts: MemoryServiceOptions
  private settings: MemorySettings = { ...MEMORY_DEFAULTS, providers: {} }
  private loaded: Promise<void> | null = null
  private removeCommands: (() => void) | undefined
  private done = new Map<string, Done>()
  private count = 0
  /** Changes to the notes, one after another, so that two never write over each other. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: MemoryServiceOptions) {
    this.opts = opts
  }

  get folder(): string {
    return this.opts.dir
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** Reads the settings and offers the commands, if the memory is on. Called once at start; everything else waits for it. */
  init(): Promise<void> {
    this.loaded ??= (async () => {
      this.settings = cleanMemorySettings(await readJson(path.join(this.opts.dir, 'settings.json')))
      this.syncCommands()
    })()
    return this.loaded
  }

  /** The commands go with the memory: offered while it is on, gone while it is off. */
  private syncCommands(): void {
    if (this.settings.enabled && !this.removeCommands && this.opts.commandsDir && this.opts.skills) {
      this.removeCommands = this.opts.skills.addRoot(this.opts.commandsDir, 'memory')
    } else if (!this.settings.enabled && this.removeCommands) {
      this.removeCommands()
      this.removeCommands = undefined
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => {})
    return result
  }

  // ───────────────────────── Files ─────────────────────────

  private globalDir(): string {
    return path.join(this.opts.dir, 'global')
  }

  private workspaceDir(folder: string): string {
    const key = folderKey(folder, this.opts.windows)
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 10)
    return path.join(this.opts.dir, 'workspaces', `${safeName(folderName(folder))}-${hash}`)
  }

  private fileOf(entry: Pick<MemoryEntry, 'id' | 'scope' | 'workspace'>): string {
    return path.join(entry.scope === 'global' ? this.globalDir() : this.workspaceDir(entry.workspace ?? ''), `${entry.id}.md`)
  }

  /** The notes in one folder. A file that is not a note is passed over. */
  private async readNotes(dir: string, scope: MemoryScope, workspace?: string): Promise<MemoryEntry[]> {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const notes: MemoryEntry[] = []
    for (const name of names.sort()) {
      const id = NOTE_FILE.exec(name)?.[1]
      if (!id) continue
      const file = path.join(dir, name)
      const [text, stat] = await Promise.all([fs.readFile(file, 'utf8').catch(() => null), fs.stat(file).catch(() => null)])
      if (text === null) continue
      const entry = readEntryFile(text, { id, scope, ...(workspace ? { workspace } : {}), ...(stat ? { modified: stat.mtimeMs } : {}) })
      if (entry) notes.push(entry)
    }
    return notes
  }

  /** Every workspace that has a folder of notes, with the folder it is of. */
  private async readWorkspaces(): Promise<{ folder: string; entries: MemoryEntry[] }[]> {
    const root = path.join(this.opts.dir, 'workspaces')
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const found: { folder: string; entries: MemoryEntry[] }[] = []
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const told = await readJson<{ folder?: unknown }>(path.join(root, dir.name, 'workspace.json'))
      const folder = typeof told?.folder === 'string' ? told.folder : ''
      if (!folder) continue
      const entries = await this.readNotes(path.join(root, dir.name), 'workspace', folder)
      if (entries.length) found.push({ folder, entries })
    }
    return found
  }

  /** The notes a conversation in `workspace` may see: those that hold everywhere, and the workspace's own. */
  private async notesFor(workspace: string): Promise<MemoryEntry[]> {
    const [global, own] = await Promise.all([this.readNotes(this.globalDir(), 'global'), workspace ? this.readNotes(this.workspaceDir(workspace), 'workspace', workspace) : []])
    return [...global, ...own]
  }

  private async write(entry: MemoryEntry): Promise<void> {
    if (entry.scope === 'workspace') {
      const told = path.join(this.workspaceDir(entry.workspace ?? ''), 'workspace.json')
      if (!(await readJson(told))) await writeJson(told, { folder: entry.workspace })
    }
    await writeText(this.fileOf(entry), writeEntryFile(entry))
  }

  private async unlink(entry: Pick<MemoryEntry, 'id' | 'scope' | 'workspace'>): Promise<void> {
    await fs.rm(this.fileOf(entry), { force: true })
  }

  private remember(done: Done): string {
    const id = `c${++this.count}-${this.now().toString(36)}`
    this.done.set(id, done)
    while (this.done.size > KEEP_DONE) this.done.delete(this.done.keys().next().value!)
    return id
  }

  // ───────────────────────── A turn ─────────────────────────

  private snapshotFile(session: string): string | null {
    return SESSION_ID.test(session) ? path.join(this.opts.dir, 'snapshots', `${session}.json`) : null
  }

  /** What a service may do with the memory, as the person set it. */
  modeOf(providerId: string): ProviderMemoryMode {
    return this.settings.enabled ? (this.settings.providers[providerId] ?? 'rw') : 'off'
  }

  /**
   * What a turn adds to the instructions, and the tools it gives the model with the memory's put
   * in. Takes in what changed of the notes since the conversation began, as far as that counts in
   * it now (`refreshSnapshot`), and keeps that with the conversation.
   */
  async forTurn(turn: MemoryTurn, base: TurnTools): Promise<{ prompt?: string; tools: TurnTools }> {
    await this.init()
    const mode = this.modeOf(turn.provider.id)
    if (mode === 'off') return { tools: base }
    const file = this.snapshotFile(turn.session)
    const kept = file ? await readJson<MemorySnapshot>(file) : null
    const { snapshot, changed } = refreshSnapshot(kept && Array.isArray(kept.entries) ? kept : null, await this.notesFor(turn.workspace), this.now())
    if (changed && file) await writeJson(file, snapshot)
    const prompt = memoryPrompt(snapshot.entries, { mode, local: turn.provider.local, limit: listLimit(this.settings.budget, turn.window, turn.provider.local) })
    return { ...(prompt.text ? { prompt: prompt.text } : {}), tools: this.toolsFor(turn, mode, base) }
  }

  /** Forgets what was kept of a conversation that was deleted. */
  async dropSession(session: string): Promise<void> {
    const file = this.snapshotFile(session)
    if (file) await fs.rm(file, { force: true })
  }

  /**
   * The tools of a turn: those the app has, and the memory's. A model that may only read the notes
   * gets recall alone. The memory's tools never ask, whatever the conversation is set to: keeping a
   * note is no change to the workspace, and the person sees each one and can undo it. A note that
   * looks as if it holds a secret or personal data is asked about first (`mustAsk`).
   */
  private toolsFor(turn: MemoryTurn, mode: 'rw' | 'ro', base: TurnTools): TurnTools {
    const own = new ToolRegistry()
    for (const spec of this.toolSpecs(turn, mode)) own.register(spec, 'builtin')
    const ours = new Set(own.list().map((tool) => tool.name))
    return {
      // A tool of another's with one of these names gives way to the memory's in this turn.
      specs: () => [...base.specs().filter((tool) => !ours.has(tool.name)), ...own.specs()],
      needsPermission: (name) => (ours.has(name) ? false : base.needsPermission(name)),
      execute: (name, rawArgs, ctx) => (ours.has(name) ? own.execute(name, rawArgs, ctx) : base.execute(name, rawArgs, ctx)),
      list: () => [...(base.list?.() ?? []).filter((tool) => !ours.has(tool.name)), ...own.list()],
      accessOf: (name) => (ours.has(name) ? 'read' : (base.accessOf?.(name) ?? (base.needsPermission(name) ? 'other' : 'read'))),
      mustAsk: (name, rawArgs) => {
        if (name !== 'remember' || !ours.has(name)) return base.mustAsk?.(name, rawArgs) ?? false
        try {
          const args: unknown = JSON.parse(rawArgs || '{}')
          return typeof args === 'object' && args !== null && argsSensitive(args as { text?: unknown; details?: unknown })
        } catch {
          return false
        }
      }
    }
  }

  private toolSpecs(turn: MemoryTurn, mode: 'rw' | 'ro'): ToolSpec[] {
    const recall: ToolSpec = {
      name: 'recall',
      description: 'Read the details of a note, or search the notes, those the list had no room for as well. Give the name of a note, or a query.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name of a note as listed, such as k3f9' },
          query: { type: 'string', description: 'Words to look for in the notes' }
        }
      },
      needsPermission: false,
      run: (args) => this.recall(turn, args)
    }
    if (mode === 'ro') return [recall]
    const remember: ToolSpec = {
      name: 'remember',
      description: `Save a note for later conversations, or update one with replaces. One fact per note, in the user's language, at most ${TEXT_MAX} characters; the why and the how go in details. The user sees every note you save and can undo it. Never save secrets such as keys or passwords.`,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact, on one line' },
          kind: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
          scope: {
            type: 'string',
            enum: ['global', 'workspace'],
            description: 'Where it holds: global (every conversation) or workspace (this workspace). By default user and feedback are global, project and reference workspace.'
          },
          details: { type: 'string', description: 'Optional: why it holds and how to apply it' },
          replaces: { type: 'string', description: 'The name of the note this one updates' }
        },
        required: ['text', 'kind']
      },
      needsPermission: false,
      run: (args) => this.saveFromModel(turn, args)
    }
    const forget: ToolSpec = {
      name: 'forget',
      description: 'Remove a note that turned out wrong, or that the user asked you to drop.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The name of the note as listed, such as k3f9' } }, required: ['name'] },
      needsPermission: false,
      run: (args) => this.forgetFromModel(turn, args)
    }
    return [remember, forget, recall]
  }

  /** Who is writing, as the note keeps it. */
  private sourceOf(turn: MemoryTurn): MemorySource {
    return {
      conversation: turn.session,
      provider: turn.provider.id,
      ...(turn.provider.name ? { providerName: turn.provider.name } : {}),
      model: turn.model,
      ...(turn.provider.local ? { local: true } : {})
    }
  }

  /** The notes a model of this turn may see: a service elsewhere does not see what was kept for models of one's own. */
  private async visibleTo(turn: MemoryTurn): Promise<MemoryEntry[]> {
    return (await this.notesFor(turn.workspace)).filter((entry) => turn.provider.local || !entry.localOnly)
  }

  private tell(turn: MemoryTurn, changeId: string, action: MemoryChange['action'], entry: MemoryEntry): void {
    const shown = { id: entry.id, scope: entry.scope, ...(entry.workspace ? { workspace: entry.workspace } : {}), kind: entry.kind, text: entry.text }
    this.opts.emit({ type: 'notice', sessionId: turn.session, change: { id: changeId, action, entry: shown } })
    this.opts.emit({ type: 'changed' })
  }

  private saveFromModel(turn: MemoryTurn, args: Record<string, unknown>): Promise<string> {
    return this.serial(async () => {
      const text = cleanText(str(args, 'text'))
      if (!text) throw new Error('The note is empty.')
      if (text.length > TEXT_MAX) throw new Error(`The note is ${text.length} characters long. Keep it to one fact of at most ${TEXT_MAX} characters, and put the rest in details.`)
      const details = str(args, 'details').trim()
      if (details.length > DETAILS_MAX) throw new Error(`The details are ${details.length} characters long; at most ${DETAILS_MAX} fit.`)
      const kind = args.kind as MemoryKind
      if (!isMemoryKind(kind)) throw new Error('kind has to be one of user, feedback, project, reference.')
      const scope: MemoryScope = args.scope === 'global' || args.scope === 'workspace' ? args.scope : defaultScope(kind)
      if (scope === 'workspace' && !turn.workspace) throw new Error('This conversation has no workspace; save the note with scope global.')
      const visible = await this.visibleTo(turn)
      const now = this.now()
      const replaces = memoryIdOf(args.replaces)
      if (replaces) {
        const before = visible.find((entry) => entry.id === replaces)
        if (!before) throw new Error(`There is no note named ${replaces}.`)
        const after: MemoryEntry = {
          id: before.id,
          scope,
          ...(scope === 'workspace' ? { workspace: turn.workspace } : {}),
          kind,
          text,
          ...(details ? { details } : {}),
          // What a model of one's own wrote into a note may be what it was kept from the others for.
          ...(before.localOnly || turn.provider.local ? { localOnly: true } : {}),
          created: before.created,
          updated: now,
          ...(before.byUser ? { byUser: before.byUser } : {}),
          source: this.sourceOf(turn)
        }
        if (this.fileOf(before) !== this.fileOf(after)) await this.unlink(before)
        await this.write(after)
        this.tell(turn, this.remember({ action: 'updated', before, after }), 'updated', after)
        return `Updated note #${after.id} (${scope}, ${kind}).`
      }
      const same = visible.find((entry) => entry.scope === scope && entry.text === text)
      if (same) return `This is already note #${same.id}; nothing was changed.`
      const entry: MemoryEntry = {
        id: newMemoryId(new Set((await this.notesFor(turn.workspace)).map((note) => note.id))),
        scope,
        ...(scope === 'workspace' ? { workspace: turn.workspace } : {}),
        kind,
        text,
        ...(details ? { details } : {}),
        ...(turn.provider.local ? { localOnly: true } : {}),
        created: now,
        updated: now,
        source: this.sourceOf(turn)
      }
      await this.write(entry)
      this.tell(turn, this.remember({ action: 'saved', after: entry }), 'saved', entry)
      return `Saved as note #${entry.id} (${scope}, ${kind}). It is listed from the next conversation on.`
    })
  }

  private forgetFromModel(turn: MemoryTurn, args: Record<string, unknown>): Promise<string> {
    return this.serial(async () => {
      const id = memoryIdOf(args.name)
      const before = (await this.visibleTo(turn)).find((entry) => entry.id === id)
      if (!before) throw new Error(`There is no note named ${id || '(none given)'}.`)
      await this.unlink(before)
      this.tell(turn, this.remember({ action: 'deleted', before }), 'deleted', before)
      return `Removed note #${id}.`
    })
  }

  private async recall(turn: MemoryTurn, args: Record<string, unknown>): Promise<string> {
    const visible = await this.visibleTo(turn)
    const id = memoryIdOf(args.name)
    const describe = (entry: MemoryEntry): string =>
      [
        `#${entry.id} [${entry.kind}] (${entry.scope === 'global' ? 'holds everywhere' : 'this workspace'}), saved ${dayOf(entry.created)}${entry.updated !== entry.created ? `, changed ${dayOf(entry.updated)}` : ''}`,
        entry.text,
        ...(entry.details ? ['', entry.details] : [])
      ].join('\n')
    if (id) {
      const entry = visible.find((note) => note.id === id)
      if (!entry) throw new Error(`There is no note named ${id}.`)
      return describe(entry)
    }
    const words = str(args, 'query').toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) throw new Error('Give the name of a note, or a query.')
    const found = visible.filter((entry) => words.every((word) => `${entry.text}\n${entry.details ?? ''}`.toLowerCase().includes(word))).slice(0, 20)
    return found.length ? found.map(describe).join('\n\n') : 'No note matches.'
  }

  // ───────────────────────── The page ─────────────────────────

  async state(): Promise<MemoryState> {
    await this.init()
    return { enabled: this.settings.enabled, budget: this.settings.budget, providers: { ...this.settings.providers }, folder: this.opts.dir }
  }

  private async saveSettings(): Promise<MemoryState> {
    await writeJson(path.join(this.opts.dir, 'settings.json'), this.settings)
    this.syncCommands()
    this.opts.emit({ type: 'changed' })
    return this.state()
  }

  async setEnabled(on: boolean): Promise<MemoryState> {
    await this.init()
    this.settings = { ...this.settings, enabled: on }
    return this.saveSettings()
  }

  async setBudget(tokens: number): Promise<MemoryState> {
    await this.init()
    this.settings = cleanMemorySettings({ ...this.settings, budget: tokens })
    return this.saveSettings()
  }

  async setProviderMode(providerId: string, mode: unknown): Promise<MemoryState> {
    await this.init()
    if (!providerId || !isProviderMode(mode)) throw new Error('This is not one of the ways a service can use the memory.')
    const providers = { ...this.settings.providers }
    if (mode === 'rw') delete providers[providerId]
    else providers[providerId] = mode
    this.settings = { ...this.settings, providers }
    return this.saveSettings()
  }

  /**
   * Every note, those of each workspace with it, and for the workspace and model asked about,
   * which notes a new conversation would be shown and what that weighs.
   */
  async list(workspace: string, use: MemoryUseOf | null): Promise<MemoryListing> {
    await this.init()
    const [global, workspaces, known] = await Promise.all([this.readNotes(this.globalDir(), 'global'), this.readWorkspaces(), this.opts.workspaces?.().catch(() => null) ?? null])
    const keys = known ? new Set(known.map((folder) => folderKey(folder, this.opts.windows))) : null
    const sortNew = (entries: MemoryEntry[]): MemoryEntry[] => [...entries].sort((a, b) => b.updated - a.updated)
    const listing: MemoryListing = {
      global: sortNew(global),
      workspaces: workspaces.map(({ folder, entries }) => ({ folder, present: keys ? keys.has(folderKey(folder, this.opts.windows)) : true, entries: sortNew(entries) }))
    }
    if (use) {
      const mode = this.modeOf(use.provider.id)
      const own = workspace ? (workspaces.find((w) => folderKey(w.folder, this.opts.windows) === folderKey(workspace, this.opts.windows))?.entries ?? []) : []
      const limit = listLimit(this.settings.budget, use.window, use.provider.local)
      const prompt = mode === 'off' ? null : memoryPrompt([...global, ...own].map(toSnapshotEntry), { mode, local: use.provider.local, limit })
      const told: MemoryUse = {
        provider: use.provider,
        ...(use.window ? { window: use.window } : {}),
        mode,
        listed: prompt?.listed ?? [],
        left: prompt?.left ?? 0,
        tokens: prompt?.tokens ?? 0,
        limit
      }
      listing.use = told
    }
    return listing
  }

  /** A note the person wrote or changed on the page. */
  save(raw: unknown): Promise<MemoryEntry> {
    return this.serial(async () => {
      const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<MemoryInput>
      const text = cleanText(typeof input.text === 'string' ? input.text : '')
      if (!text) throw new Error('A note needs a line.')
      if (text.length > TEXT_MAX) throw new Error(`A note's line can be at most ${TEXT_MAX} characters.`)
      const details = typeof input.details === 'string' ? input.details.trim() : ''
      if (details.length > DETAILS_MAX) throw new Error(`The details can be at most ${DETAILS_MAX} characters.`)
      if (!isMemoryKind(input.kind)) throw new Error('This is not one of the kinds of notes.')
      const scope: MemoryScope = input.scope === 'workspace' ? 'workspace' : 'global'
      const workspace = typeof input.workspace === 'string' ? input.workspace : ''
      if (scope === 'workspace' && !workspace) throw new Error('A note of a workspace needs its folder.')
      const now = this.now()
      const placed = { scope, ...(scope === 'workspace' ? { workspace } : {}) }
      if (typeof input.id === 'string' && input.id) {
        const from = input.from && (input.from.scope === 'global' || input.from.scope === 'workspace') ? input.from : placed
        const where = from.scope === 'global' ? this.globalDir() : this.workspaceDir(from.workspace ?? '')
        const before = (await this.readNotes(where, from.scope, from.workspace)).find((entry) => entry.id === input.id)
        if (!before) throw new Error('This note is no longer there.')
        const after: MemoryEntry = {
          ...before,
          ...placed,
          kind: input.kind,
          text,
          updated: now,
          byUser: now
        }
        if (scope === 'global') delete after.workspace
        if (details) after.details = details
        else delete after.details
        if (input.localOnly === true) after.localOnly = true
        else delete after.localOnly
        if (this.fileOf(before) !== this.fileOf(after)) await this.unlink(before)
        await this.write(after)
        this.remember({ action: 'updated', before, after })
        this.opts.emit({ type: 'changed' })
        return after
      }
      const taken = new Set((await this.notesFor(workspace)).map((note) => note.id))
      const entry: MemoryEntry = {
        id: newMemoryId(taken),
        ...placed,
        kind: input.kind,
        text,
        ...(details ? { details } : {}),
        ...(input.localOnly === true ? { localOnly: true } : {}),
        created: now,
        updated: now,
        byUser: now,
        source: { user: true }
      }
      await this.write(entry)
      this.opts.emit({ type: 'changed' })
      return entry
    })
  }

  /** A note the person deleted on the page. Resolves with the id of the change, for undoing it. */
  remove(raw: unknown): Promise<string> {
    return this.serial(async () => {
      const ref = (typeof raw === 'object' && raw !== null ? raw : {}) as { id?: unknown; scope?: unknown; workspace?: unknown }
      const scope: MemoryScope = ref.scope === 'workspace' ? 'workspace' : 'global'
      const workspace = typeof ref.workspace === 'string' ? ref.workspace : undefined
      const where = scope === 'global' ? this.globalDir() : this.workspaceDir(workspace ?? '')
      const before = (await this.readNotes(where, scope, workspace)).find((entry) => entry.id === ref.id)
      if (!before) throw new Error('This note is no longer there.')
      await this.unlink(before)
      const id = this.remember({ action: 'deleted', before })
      this.opts.emit({ type: 'changed' })
      return id
    })
  }

  /**
   * Undoes a change, by the model or on the page: a note that was saved goes, one that was changed
   * is as it was, one that was deleted is back. Counts as the person's doing: conversations under
   * way take it in at their next turn. Resolves with whether there was anything to undo.
   */
  undo(changeId: string): Promise<boolean> {
    return this.serial(async () => {
      const done = this.done.get(changeId)
      if (!done) return false
      this.done.delete(changeId)
      if (done.after) await this.unlink(done.after)
      if (done.before) await this.write({ ...done.before, byUser: this.now() })
      this.opts.emit({ type: 'changed' })
      return true
    })
  }
}

/** What the main process's IPC needs of `ipcMain`. */
interface Handles {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

/** The page's way to the memory (window.memory). */
export function registerMemoryIpc(ipc: Handles, memory: MemoryService, deps: { use(): Promise<MemoryUseOf | null>; openFolder(dir: string): Promise<void> }): void {
  ipc.handle('memory:state', () => memory.state())
  ipc.handle('memory:list', async (_e, workspace: unknown) => memory.list(typeof workspace === 'string' ? workspace : '', await deps.use().catch(() => null)))
  ipc.handle('memory:save', (_e, input: unknown) => memory.save(input))
  ipc.handle('memory:remove', (_e, ref: unknown) => memory.remove(ref))
  ipc.handle('memory:undo', (_e, id: unknown) => memory.undo(String(id ?? '')))
  ipc.handle('memory:setEnabled', (_e, on: unknown) => memory.setEnabled(on === true))
  ipc.handle('memory:setBudget', (_e, tokens: unknown) => memory.setBudget(Number(tokens)))
  ipc.handle('memory:setProviderMode', (_e, providerId: unknown, mode: unknown) => memory.setProviderMode(String(providerId ?? ''), mode))
  ipc.handle('memory:openFolder', async () => {
    await fs.mkdir(memory.folder, { recursive: true })
    await deps.openFolder(memory.folder)
  })
}
