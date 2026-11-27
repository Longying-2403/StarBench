import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CompactionReport,
  LinkOutcome,
  ModelInfo,
  OpenOutcome,
  PermissionDecision,
  ProviderInput,
  Sent,
  Session,
  SessionEvent,
  Settings,
  SignInOptions,
  SignInResult
} from '../shared/types.ts'
import { PLUGIN_UI_SCHEME, parsePluginUiUrl, pluginUiType } from '../shared/plugin-ui.ts'
import { MAX_ATTACHMENTS, readAttachments } from '../shared/attachments.ts'
import type { AttachmentsRead } from '../shared/attachments.ts'
import { knownContextWindow } from '../shared/context-windows.ts'
import { DEFAULT_PERMISSION_MODE, isPermissionMode } from '../shared/permissions.ts'
import type { PermissionMode } from '../shared/permissions.ts'
import { addCompaction, addStep, addToolTime, addTurn, emptyStats } from '../shared/stats.ts'
import { ABOUT } from '../shared/about.ts'
import { DEFAULT_THEME } from '../shared/theme.ts'
import { webPlace } from '../shared/links.ts'
import { MEMORY_COMMANDS } from '../shared/memory.ts'
import { isLocalAddress, isSessionIcon, notReadyText } from '../shared/types.ts'
import { failureOf, withFailure } from '../shared/failures.ts'
import { cutAt } from '../shared/well-formed.ts'
import { hasUnmerged, isWorktreeName, leftFiles, mergeRecord, notAllowedText, projectFolder, worktreeOfFolder } from '../shared/worktree.ts'
import type { MergeRecord, Merged, WorktreeInfo } from '../shared/worktree.ts'
import { askAside, builtinPrompt, compactConversation, runTurn } from './agent.ts'
import type { RoomOptions, TurnOptions } from './agent.ts'
import { setAppMenu } from './app-menu.ts'
import { attachData, attachFiles } from './attachments.ts'
import { BOX_TAKES_PASTE, FOCUS_BOX, contextMenu } from './context-menu.ts'
import type { MenuPlace } from './context-menu.ts'
import { conversationName } from './conversation-name.ts'
import { SignInError, startAttempt } from './chatgpt/login.ts'
import type { Attempt } from './chatgpt/login.ts'
import { adapterFor } from './providers/index.ts'
import type { Connection } from './providers/index.ts'
import { Git, saidToPerson } from './git.ts'
import { githubRepoOf } from './github.ts'
import { createKernel } from './kernel.ts'
import type { Kernel } from './kernel.ts'
import { languageOf } from './language.ts'
import { McpManager } from './mcp.ts'
import { MemoryService, registerMemoryIpc } from './memory.ts'
import type { MemoryTurn } from './memory.ts'
import { UpdateChecker, askReleases, registerUpdateIpc } from './update-check.ts'
import { UsageService, registerUsageIpc } from './usage.ts'
import { mayGrant, mayNavigate } from './page-guard.ts'
import { PluginChannel } from './plugin-channel.ts'
import { PluginManager } from './plugins.ts'
import { SamplingRegistry, targetOf } from './sampling.ts'
import { SkillStore, loadSkillTool, selectedSkillPrompt, skillsPrompt } from './skills.ts'
import { keepPictures, sessionText } from './session-files.ts'
import * as store from './store.ts'
import { cleanTitle, titleEffort, titlePrompt, titleRecord } from './title.ts'
import { ToolRegistry, registerBuiltinTools } from './tools.ts'
import { barless, windowButtons, windowGround } from './window-look.ts'
import { TraceRegistry } from './trace.ts'
import { findNamed, howToOpen, readImage } from './workspace-files.ts'
import { registerWorktreeIpc } from './worktree-ipc.ts'
import { worktreePrompt, worktreeTools } from './worktree-tools.ts'
import { Worktrees, takenNames } from './worktrees.ts'

// Lets development and tests run against a throwaway profile instead of the real one.
if (process.env.STARBENCH_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STARBENCH_USER_DATA))
}

// The page loads the interfaces of plugins from an address of the app's own (shared/plugin-ui.ts).
// This has to be said before the app is ready. "standard" gives such an address a place and a
// path, so that one file of an interface can import the one next to it. "secure" lets the page
// load from it although the page may itself be a file. "corsEnabled" is what lets a page ask
// for a script from it at all: to the page it is another place, and without this the browser
// refuses the request before it is made.
protocol.registerSchemesAsPrivileged([
  { scheme: PLUGIN_UI_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

// Two copies sharing one data folder would overwrite each other's sessions and settings.
// The lock belongs to the data folder, so a copy started with another STARBENCH_USER_DATA still runs.
const isPrimaryInstance = app.requestSingleInstanceLock()

// Plugin code runs in this process; a promise it forgot to handle must not take the app down.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

let mainWindow: BrowserWindow | null = null

const tools = new ToolRegistry()
registerBuiltinTools(tools)
const sampling = new SamplingRegistry()
/** Who watches what passes between the app and the models. Nobody, unless a plugin asks to. */
const trace = new TraceRegistry()
/** The line between each plugin's code here and its interface in the page. */
const channel = new PluginChannel()
channel.carryWith((plugin, event, payload) => {
  try {
    mainWindow?.webContents.send('plugins:event', { plugin, event, payload })
  } catch (err) {
    // Something that cannot be sent to the page, such as a function: the plugin's mistake, and not a reason to stop.
    console.error(`[plugins] ${plugin} could not tell its interface of "${event}":`, err instanceof Error ? err.message : err)
  }
})
/**
 * The skills that come with the app: beside the app's own files once it is packaged, in the
 * repository's `skills/` folder until then. STARBENCH_BUILTIN_SKILLS names another folder.
 */
const BUILTIN_SKILLS_DIR = process.env.STARBENCH_BUILTIN_SKILLS
  ? path.resolve(process.env.STARBENCH_BUILTIN_SKILLS)
  : path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'skills')
const skills = new SkillStore(path.join(app.getPath('userData'), 'skills'), BUILTIN_SKILLS_DIR)
tools.register(loadSkillTool(skills), 'builtin')
/**
 * The notes the model keeps from one conversation to the next (memory.ts), and the commands that
 * come with them, offered while the memory is on: beside the app's own files once it is packaged,
 * in the repository's `memory-commands/` folder until then.
 */
const memory = new MemoryService({
  dir: path.join(app.getPath('userData'), 'memory'),
  commandsDir: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'memory-commands'),
  skills,
  windows: process.platform === 'win32',
  workspaces: () => store.listWorkspaces(),
  emit: (event) => mainWindow?.webContents.send('memory:event', event)
})
/**
 * The look for a newer build (update-check.ts): made when the person asks for it on the About
 * page, and by the app itself once a day where they switched that on. Once packaged it asks
 * GitHub and nobody else; before that, a test may name another address to ask.
 */
const updates = new UpdateChecker({
  file: path.join(app.getPath('userData'), 'updates.json'),
  version: app.getVersion(),
  revision: ABOUT.revision,
  ask: () => askReleases({ agent: `StarBench/${app.getVersion()}`, ...(!app.isPackaged && process.env.STARBENCH_UPDATE_TEST_SERVER ? { url: process.env.STARBENCH_UPDATE_TEST_SERVER } : {}) }),
  emit: (event) => mainWindow?.webContents.send('updates:event', event)
})
/**
 * What was asked of the model services, counted while the app keeps count, and the balance
 * DeepSeek tells with the key the service is used with (usage.ts): for the usage page of the
 * settings and the row under the message box.
 */
const usage = new UsageService({
  file: path.join(app.getPath('userData'), 'usage.json'),
  providers: async () => (await store.getSettings()).providers,
  keyOf: async (providerId) => (await store.getConnection(providerId))?.apiKey ?? null,
  emit: (event) => mainWindow?.webContents.send('usage:event', event)
})
/**
 * Git, which the app runs for one thing: the worktrees of a repository (worktrees.ts). Only in a
 * repository the person said it may be run in, and with no hook of the repository's: the folder
 * named here is the app's own and stays empty (git.ts).
 */
const git = new Git({ noHooksDir: path.join(app.getPath('userData'), 'git-no-hooks'), allowed: (repo) => store.allowsGit(repo) })
const worktrees = new Worktrees({ git })
const mcp = new McpManager({
  configFile: path.join(app.getPath('userData'), 'mcp.json'),
  tools,
  clientInfo: { name: 'starbench', version: app.getVersion() },
  // The tokens in `env` and `headers` are kept on disk the way API keys are.
  secrets: { seal: store.sealSecret, open: store.openSecret }
})
let kernel: Kernel | null = null
let plugins: PluginManager | null = null
/** Resolves once enabled plugins have been started; plugin IPC waits for it. */
let pluginsReady: Promise<PluginManager> | null = null

/**
 * Started with `--no-plugins` (or STARBENCH_NO_PLUGINS=1): no plugin is loaded this time,
 * neither its code here nor its interface in the page. The way out when a plugin keeps the app
 * from starting or the window from being used, so that it can be switched off in the settings.
 */
const PLUGINS_HELD = process.argv.includes('--no-plugins') || process.env.STARBENCH_NO_PLUGINS === '1'

/**
 * The plugins that come with the app: beside the app's own files once it is packaged, in the
 * repository's `plugins/` folder until then. STARBENCH_BUILTIN_PLUGINS names another folder, for
 * working on such a plugin or testing with a set of one's own.
 */
const BUILTIN_PLUGINS_DIR = process.env.STARBENCH_BUILTIN_PLUGINS
  ? path.resolve(process.env.STARBENCH_BUILTIN_PLUGINS)
  : path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'plugins')

async function startPlugins(): Promise<PluginManager> {
  kernel = await createKernel({
    tools,
    sampling,
    channel,
    trace,
    // The manager keeps the configs, and is made after the kernel it runs on. By the time a plugin asks, it is there.
    configs: {
      get: (id) => plugins?.configOf(id) ?? {},
      set: (id, value) => (plugins ? plugins.setConfig(id, value) : Promise.reject(new Error('Plugins are not available yet.')))
    }
  })
  const userData = app.getPath('userData')
  plugins = new PluginManager({
    root: kernel.root,
    tools,
    skills,
    dir: path.join(userData, 'plugins'),
    builtinDir: BUILTIN_PLUGINS_DIR,
    stateFile: path.join(userData, 'plugins.json'),
    held: PLUGINS_HELD
  })
  await plugins.init()
  return plugins
}

/** The ChatGPT sign-in under way, or the one that ended last. There is one at a time. */
let signIn: { attempt: Attempt; outcome: Promise<SignInResult> } | null = null

async function shutdown(): Promise<void> {
  // Closes the listener a sign-in nobody finished is still holding open.
  signIn?.attempt.cancel()
  // MCP servers are child processes; closing the connections is what stops them.
  await Promise.allSettled([mcp.dispose(), plugins?.dispose()])
  await kernel?.dispose()
}

interface ActiveRun {
  controller: AbortController
  /** The provider the run talks to. */
  provider: string
  /** Permission prompts of this run that are still waiting for the user. */
  pending: Set<string>
  /** What the model may do in the conversation without asking. The person can change it while the run goes on; it is read before every tool call. */
  mode: PermissionMode
}
const activeRuns = new Map<string, ActiveRun>()
const permissionResolvers = new Map<string, (decision: PermissionDecision) => void>()
/**
 * Stops a run, whoever asks for it: the person, a deletion of its session, a sign-out. A question
 * it waits on is answered "no" as well; a run blocked on a permission prompt would otherwise never
 * notice the stop, and its session would stay at work until the app is closed.
 */
function stopRun(run: ActiveRun): void {
  run.controller.abort()
  for (const id of [...run.pending]) permissionResolvers.get(id)?.('deny')
}
/** Per-session "always allow" choices; kept in memory only, so they reset on restart. */
const alwaysAllowed = new Map<string, Set<string>>()
/**
 * Sessions in which the server turned out to take no tool definitions, with the provider and
 * model it was. Later messages to that model describe the tools in the instructions at once
 * (`Connection.textTools`), instead of being refused first every time. Kept in memory and by
 * session, so a new chat finds out again: the server may have been set up for tools since.
 */
const textTools = new Map<string, string>()
/**
 * Sessions in which the server turned out not to stream a reply while tools are offered, kept the
 * same way. Later messages ask for whole replies at once, instead of failing first every time.
 */
const wholeReplies = new Map<string, string>()
/**
 * Sessions in which the model turned out to take no pictures, kept the same way. Later messages
 * tell it of the pictures in words at once (`Connection.noImages`), instead of being refused first.
 */
const noImages = new Map<string, string>()
/**
 * Sessions in which the service turned the PDFs down, or a request with them stayed too long for
 * the model, kept the same way. Later messages tell it where the PDFs lie at once (`Connection.noDocuments`).
 */
const noDocuments = new Map<string, string>()
const modelKey = (connection: { provider: string; model: string }): string => `${connection.provider}\n${connection.model}`
/** The connection, with what a session has found out about its server. */
const asLearned = (sessionId: string, connection: Connection): Connection => ({
  ...connection,
  ...(wholeReplies.get(sessionId) === modelKey(connection) ? { wholeReplies: true } : {}),
  ...(textTools.get(sessionId) === modelKey(connection) ? { textTools: true } : {}),
  ...(noImages.get(sessionId) === modelKey(connection) ? { noImages: true } : {}),
  ...(noDocuments.get(sessionId) === modelKey(connection) ? { noDocuments: true } : {})
})

/** The folder the page and its own scripts are in. */
const PAGE_DIR = path.join(import.meta.dirname, '../renderer')
/** Set while developing: the page then comes from a local server and not from a file. */
const DEV_PAGE_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL

/**
 * Shows the menu of a right-click in the window (context-menu.ts). Outside a box that takes text,
 * the page is asked first whether its message box can take a paste, for 粘贴到输入框: the menu
 * comes up once it has answered.
 */
async function showContextMenu(place: MenuPlace): Promise<void> {
  const shown = mainWindow
  if (!shown) return
  const contents = shown.webContents
  const inPage = (script: string): Promise<unknown> => contents.executeJavaScript(script).catch(() => false)
  const boxTakesPaste = !place.isEditable && (await inPage(BOX_TAKES_PASTE)) === true
  const page = {
    replaceMisspelling: (word: string) => contents.replaceMisspelling(word),
    // The keyboard is put in the box first, and the paste is then the page's own, as Ctrl+V there:
    // text goes where the cursor is, files and pictures become attachments.
    pasteIntoBox: () => {
      void inPage(FOCUS_BOX).then((focused) => {
        if (focused === true) contents.paste()
      })
    }
  }
  if (!shown.isDestroyed()) Menu.buildFromTemplate(contextMenu(place, page, boxTakesPaste)).popup({ window: shown })
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    // What the window shows until the page has drawn: the page's own background, in the look that holds.
    backgroundColor: windowGround(dark),
    // On Windows the window has no title bar. The system draws its three buttons over the page's
    // upper right corner, and the page keeps a strip clear for them (`--window-bar` in styles.css).
    ...(barless(process.platform) ? { titleBarStyle: 'hidden' as const, titleBarOverlay: windowButtons(dark) } : {}),
    // A packaged build shows the icon embedded in the executable; in development Electron would show its own.
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), 'build/icon.png'),
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  // Model output can contain links; open them in the real browser, never in the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => {
    // The page goes nowhere; while developing it reloads from the development server (page-guard.ts).
    if (!mayNavigate(event.url, DEV_PAGE_URL)) event.preventDefault()
  })
  // Of what a browser asks permission for, the page gets the clipboard and nothing else; Electron
  // would grant all of it (page-guard.ts).
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, permission, grant) => grant(mayGrant(permission)))
  // A right-click gets a menu for the text where it was made; Electron shows none by itself (context-menu.ts).
  mainWindow.webContents.on('context-menu', (_event, params) => void showContextMenu(params))

  if (DEV_PAGE_URL) {
    mainWindow.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') console.error(`[renderer] ${event.message}`)
    })
    void mainWindow.loadURL(DEV_PAGE_URL)
  } else {
    void mainWindow.loadFile(path.join(PAGE_DIR, 'index.html'))
  }
}

/**
 * Holds the files the window can load to the folder the page itself is in. Once the app is
 * packaged the page is a file, and to the browser a page that is a file may load any other file
 * as its own: a script anywhere on this computer, or on another one that an address names.
 * Nothing in the app needs that, and with the interfaces of plugins in the page it would be a way
 * past the one door made for them (`servePluginUi`). While developing, the page is not a file and
 * the browser refuses files by itself.
 */
function confinePageFiles(): void {
  if (DEV_PAGE_URL) return
  const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  protocol.handle('file', (request) => {
    let asked: string
    try {
      asked = fileURLToPath(request.url)
    } catch {
      return notFound()
    }
    // Told from the names alone, before anything is opened: an address may name a file on another computer.
    const relative = path.relative(PAGE_DIR, asked)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return notFound()
    return net.fetch(request, { bypassCustomProtocolHandlers: true })
  })
}

function send(payload: SessionEvent): void {
  mainWindow?.webContents.send('agent:event', payload)
}

/**
 * Answers the page when it asks for a file of a plugin's interface: with the file, for a plugin
 * that is switched on and a file in its `ui/` folder of a kind an interface is made of, and with
 * "not found" for everything else, whatever the reason. Never kept by the page from one load to
 * the next, so that a changed file is the one that is loaded.
 */
function servePluginUi(): void {
  const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  protocol.handle(PLUGIN_UI_SCHEME, async (request) => {
    const asked = request.method === 'GET' ? parsePluginUiUrl(request.url) : null
    const type = asked ? pluginUiType(asked.file) : null
    const full = asked && type ? (plugins?.uiFile(asked.id, asked.file) ?? null) : null
    if (!full || !type) return notFound()
    try {
      const data = await fs.readFile(full)
      return new Response(new Uint8Array(data), {
        // The page is another place than this address, and a script from another place is only run when that place allows it.
        headers: { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
      })
    } catch {
      return notFound()
    }
  })
}

/**
 * A session that is in memory to be changed, by a turn or by a compaction, as that work has it.
 * While it lasts, what is saved of the session is saved from there, and a change made to the
 * file would be undone by the next save. So what else changes the session meanwhile changes it
 * here, and has it saved from here.
 */
const liveSessions = new Map<string, { session: Session; checkpoint(): void; /** Resolves once what was last checkpointed is in the file. */ saved(): Promise<void> }>()
/** Sessions on their way into memory: a message for one has arrived, and its turn has not begun yet. */
const opening = new Set<string>()
/** A name the model wrote for a session just then: handed to the session as it comes into memory. */
const pendingTitles = new Map<string, { from: string; to: string }>()
/**
 * A permission mode the person chose for a session on its way into memory. The work that is
 * about to begin was handed the mode the page had a moment before, and takes this one up instead.
 */
const pendingModes = new Map<string, PermissionMode>()
/** Takes up a mode chosen for the session while its work was on its way (`pendingModes`). */
function takeMode(id: string, run: ActiveRun): void {
  const chosen = pendingModes.get(id)
  pendingModes.delete(id)
  if (chosen) run.mode = chosen
}
/**
 * Saves the mode of a session whose work is over, where the person changed it after the work last
 * saved the session: after what that work saved, so that it is not undone by it.
 */
function keepMode(id: string, run: ActiveRun, saved: PermissionMode | undefined, after: Promise<unknown>): void {
  if (run.mode === (saved ?? DEFAULT_PERMISSION_MODE)) return
  void after
    .then(() => store.updateSession(id, { permissionMode: run.mode }))
    .catch((err: unknown) => console.error('[store] could not keep the permission mode:', err instanceof Error ? err.message : err))
}

/**
 * Changes to a session that is on its way into memory, made by something other than the work
 * that is about to begin: the record of a merge the person asked for just then. Each is made to
 * the session once it is there (`takeChanges`), where that work saves it from.
 */
const pendingChanges = new Map<string, ((session: Session) => void)[]>()
/** Makes the changes that waited for a session to come into memory. Says whether there were any. */
function takeChanges(session: Session): boolean {
  const waiting = pendingChanges.get(session.id) ?? []
  pendingChanges.delete(session.id)
  for (const change of waiting) change(session)
  return waiting.length > 0
}
/** For a session that did not come into memory after all: what waited for it is made to its file. */
function settleChanges(id: string): void {
  const waiting = pendingChanges.get(id) ?? []
  pendingChanges.delete(id)
  if (waiting.length === 0) return
  store
    .changeSession(id, (session) => waiting.forEach((change) => change(session)))
    .catch((err: unknown) => console.error('[store] could not keep a change to a session:', err instanceof Error ? err.message : err))
}

/**
 * Changes the merges a session keeps of its worktree (`Session.merges`), wherever the session is
 * just then: in memory, being worked on; on its way there; or in its file.
 */
async function changeMerges(id: string, change: (merges: MergeRecord[]) => MergeRecord[]): Promise<void> {
  const apply = (session: Session): void => {
    const merges = change(session.merges ?? [])
    if (merges.length > 0) session.merges = merges
    else delete session.merges
  }
  const live = liveSessions.get(id)
  if (live) {
    apply(live.session)
    live.checkpoint()
    await live.saved()
  } else if (opening.has(id)) {
    pendingChanges.set(id, [...(pendingChanges.get(id) ?? []), apply])
  } else {
    await store.changeSession(id, apply)
  }
}

/** How many messages of the person a conversation holds: the turn a merge is shown at the end of. */
const turnsOf = (session: Pick<Session, 'messages'>): number => session.messages.filter((message) => message.role === 'user').length

/** Writes a merge of a worktree's work down with its conversation, and tells the page: it shows the merge, and offers to take it back. */
async function recordMerge(id: string, done: Merged): Promise<void> {
  const where = (session: Session): { turn: number; name: string } => ({ turn: turnsOf(session), name: session.worktree?.name ?? '' })
  const live = liveSessions.get(id)
  const { turn, name } = (live ? where(live.session) : await store.peekSession(id, where)) ?? { turn: 0, name: '' }
  const record = mergeRecord(done, randomUUID(), Date.now(), turn)
  await changeMerges(id, (merges) => [...merges, record])
  send({ sessionId: id, event: { type: 'merged', record, name } })
}

/** Writes down that a merge was taken back, and tells the page. */
async function recordUndo(id: string, mergeId: string): Promise<void> {
  const at = Date.now()
  await changeMerges(id, (merges) => merges.map((merge) => (merge.id === mergeId ? { ...merge, undone: at } : merge)))
  send({ sessionId: id, event: { type: 'merge_undone', id: mergeId, at } })
}

/**
 * What a turn in a conversation that works in a worktree has on top of the rest: the lines of
 * its instructions that say where it is, and the worktree's tools (worktree-tools.ts). Nothing
 * for any other conversation.
 */
function worktreeParts(session: Pick<Session, 'id' | 'worktree'>, base: TurnOptions['tools']): { prompt?: string; tools: TurnOptions['tools'] } {
  const info = session.worktree
  if (!info) return { tools: base }
  return { prompt: worktreePrompt(info), tools: worktreeTools(base, { info, worktrees, merged: (done) => recordMerge(session.id, done) }) }
}

/**
 * Whether a folder is one a model may read: one the person said so of, or a worktree the app
 * made of such a repository, which is asked about no second time.
 */
async function readable(folder: string): Promise<boolean> {
  if (await store.trusts(folder)) return true
  const tree = worktreeOfFolder(folder, process.platform === 'win32')
  return tree !== null && (await store.trusts(tree.repo))
}

/**
 * Gives a session the name the model wrote for it, where it still goes by `from`, the first
 * words of the person: a name they gave it in the meantime is theirs to keep. The page is told
 * once the name holds.
 */
async function applyTitle(id: string, from: string, to: string): Promise<void> {
  const live = liveSessions.get(id)
  if (live) {
    if (live.session.title !== from) return
    live.session.title = to
    live.checkpoint()
    // The page asks for the list as soon as it is told, and the list is read from the files: so first the file.
    await live.saved()
  } else if (opening.has(id)) {
    // Said to the page when the session takes the name up (`takeTitle`).
    pendingTitles.set(id, { from, to })
    return
  } else if (!(await store.retitleSession(id, from, to))) {
    return
  }
  send({ sessionId: id, event: { type: 'titled', title: to } })
}

/** Takes up a name that was written for a session while it was on its way into memory. Says whether there was one to take. */
function takeTitle(session: Session): boolean {
  const waiting = pendingTitles.get(session.id)
  pendingTitles.delete(session.id)
  if (!waiting || session.title !== waiting.from) return false
  session.title = waiting.to
  return true
}

/** How long the model is given to write the name of a conversation, in milliseconds. Nobody waits for it; past this it is let be. */
const TITLE_WAIT_MS = 45_000

/**
 * Has the model in use write a name for a conversation whose first turn is over (title.ts), and
 * gives the conversation that name. One small request by itself: it is no part of the
 * conversation, offers the model no tools, and is not counted among what the conversation cost.
 * Whatever goes wrong with it, the conversation keeps the name it has, and the person is told nothing.
 */
async function nameConversation(session: Session, connection: Connection): Promise<void> {
  const from = session.title
  try {
    if (!(await store.namesConversations())) return
    // A turn that ended without an answer, stopped or failed, names nothing: the service may not be there to ask.
    if (!session.messages.some((message) => message.role === 'assistant')) return
    const record = titleRecord(session.messages)
    if (!record) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TITLE_WAIT_MS)
    try {
      const written = await askAside({
        connection: { ...connection, reasoningEffort: titleEffort(connection) },
        system: titlePrompt(languageOf(session.messages)),
        text: record,
        signal: controller.signal,
        // What it cost is counted with the rest, while the app keeps count.
        measured: (await store.countsStats()) ? (measure) => usage.record(measure, connection.providerName) : undefined,
        trace: {
          get active() {
            return trace.active
          },
          record: (exchange) => trace.emit(exchange, session.id)
        }
      })
      // What had arrived of a reply that was given up on is no title.
      if (controller.signal.aborted) return
      const title = cleanTitle(written)
      if (title && title !== from) await applyTitle(session.id, from, title)
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    console.error('[title] no name was written for a conversation:', err instanceof Error ? err.message : err)
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => store.getSettings())
  // For the About page: the version of the app that is running.
  ipcMain.handle('app:info', () => ({ version: app.getVersion() }))
  ipcMain.handle('settings:setEffort', (_e, effort: unknown) => store.setReasoningEffort(effort))
  ipcMain.handle('settings:setFast', (_e, on: unknown) => store.setFastMode(on))
  ipcMain.handle('settings:setWebSearch', (_e, on: unknown) => store.setWebSearch(on))
  ipcMain.handle('settings:setWindow', (_e, providerId: unknown, model: unknown, tokens: unknown) => store.setContextWindow(providerId, model, tokens))
  ipcMain.handle('settings:setStats', (_e, on: unknown) => store.setStats(on))
  ipcMain.handle('settings:setTheme', async (_e, theme: unknown) => {
    const settings = await store.setTheme(theme)
    // The page, and whatever is drawn in it, goes by what the window says the look is.
    nativeTheme.themeSource = settings.theme
    return settings
  })
  ipcMain.handle('settings:setTitles', (_e, on: unknown) => store.setTitles(on))
  ipcMain.handle('settings:setSessionTimes', (_e, on: unknown) => store.setSessionTimes(on))
  ipcMain.handle('settings:setEnterKey', (_e, key: unknown) => store.setEnterKey(key))
  ipcMain.handle('settings:setCompaction', (_e, change: unknown) => store.setCompaction(change))
  ipcMain.handle('prompt:builtin', () => builtinPrompt())
  ipcMain.handle('prompt:set', (_e, providerId: string, prompt: unknown) => store.setPrompt(providerId, prompt))
  ipcMain.handle('providers:save', (_e, input: ProviderInput) => store.saveProvider(input))
  ipcMain.handle('providers:remove', (_e, id: string) => store.removeProvider(id))
  ipcMain.handle('models:select', (_e, providerId: string, model: string) => store.selectModel(providerId, model))

  ipcMain.handle('models:list', async (_e, providerId: string) => {
    const connection = await store.getConnection(providerId)
    if (!connection) throw new Error('This provider has no API key or sign-in yet.')
    return adapterFor(connection.kind).listModels(connection)
  })

  /** A freshly signed-in account has no model chosen; the first one its plan lists is a sensible start. */
  const chooseFirstModel = async (providerId: string): Promise<Settings | null> => {
    const connection = await store.getConnection(providerId)
    if (!connection || connection.model) return null
    const [first] = await adapterFor(connection.kind).listModels(connection)
    return first ? store.setProviderModel(providerId, first.id) : null
  }

  ipcMain.handle('signin:start', async (_e, raw: unknown) => {
    const options: SignInOptions = typeof raw === 'object' && raw !== null ? raw : {}
    const providerId = typeof options.providerId === 'string' ? options.providerId : undefined
    const stored = providerId ? await store.signInOf(providerId) : null
    if (stored?.tokens && options.otherAccount === true) throw new Error('Sign out before signing in with another account.')
    // Signing in to the same account again continues its registration; anything else starts a new one.
    const known = stored && options.otherAccount !== true ? stored : undefined
    signIn?.attempt.cancel()
    const attempt = await startAttempt({
      service: store.signInService,
      hostId: await store.signInHostId(),
      ...(known ? { known, consent: options.consent === true } : {}),
      // With a stand-in service there is nobody to sign in; whoever runs the test opens the address.
      openBrowser: (url) => (store.signInIsTest ? undefined : shell.openExternal(url))
    })
    const outcome = attempt.result
      .then(async (record): Promise<SignInResult> => {
        const saved = await store.saveSignIn(providerId, record)
        const withModel = await chooseFirstModel(saved.providerId).catch((err) => {
          console.error('[sign-in] could not list the models of the account:', err instanceof Error ? err.message : err)
          return null
        })
        // The person is in the browser at this point; the app comes back to them.
        if (mainWindow?.isMinimized()) mainWindow.restore()
        mainWindow?.show()
        mainWindow?.focus()
        return { ok: true, settings: withModel ?? saved.settings, providerId: saved.providerId, welcome: saved.welcome, ...(saved.already ? { already: true as const } : {}) }
      })
      .catch(
        (err): SignInResult => ({
          ok: false,
          reason: err instanceof SignInError ? err.reason : 'failed',
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    signIn = { attempt, outcome }
    return { url: attempt.url }
  })
  ipcMain.handle(
    'signin:finish',
    (): Promise<SignInResult> | SignInResult => signIn?.outcome ?? { ok: false, reason: 'failed', detail: 'No sign-in is under way.' }
  )
  ipcMain.handle('signin:cancel', () => signIn?.attempt.cancel())
  ipcMain.handle('signin:out', async (_e, providerId: string) => {
    // Requests stop first, then the tokens they were using are given up.
    for (const run of activeRuns.values()) if (run.provider === providerId) stopRun(run)
    return store.signOut(providerId)
  })

  // Asked again whenever the settings change; the answer is kept so that costs one request per model.
  // A failure is kept for a minute only, so a service that was unreachable at startup gets another try.
  let modelInfo: { key: string; at: number; value: Promise<ModelInfo | null> } | null = null
  /** What the service says of the model of the connection in use. */
  const toldOf = async (connection: Connection): Promise<ModelInfo | null> => {
    // The key is part of it so that correcting a wrong key asks again at once.
    const key = `${connection.provider}\n${connection.baseURL}\n${connection.model}\n${connection.apiKey}`
    const cached = modelInfo?.key === key ? modelInfo : null
    if (!cached || ((await cached.value) === null && Date.now() - cached.at >= 60_000)) {
      const value = adapterFor(connection.kind)
        .modelInfo(connection)
        .catch((err) => {
          console.error('[models] could not ask the service about the model:', err instanceof Error ? err.message : err)
          return null
        })
      modelInfo = { key, at: Date.now(), value }
    }
    return modelInfo!.value
  }
  /**
   * How much the context of the model in use holds, and who says so. What the person typed in
   * counts before what the service says, and that before what the app knows of well-known
   * models. Read anew each time: the person may have typed it in since.
   */
  const roomOf = async (connection: Connection, told: ModelInfo | null): Promise<Pick<ModelInfo, 'contextWindow' | 'contextSource'> | null> => {
    const typed = await store.typedContextWindow()
    const known = knownContextWindow(connection.model)
    return typed
      ? { contextWindow: typed, contextSource: 'manual' }
      : told?.contextWindow
        ? { contextWindow: told.contextWindow, contextSource: 'service' }
        : known
          ? { contextWindow: known, contextSource: 'known' }
          : null
  }
  ipcMain.handle('models:info', async () => {
    const connection = await store.getConnection().catch(() => null)
    if (!connection || !connection.model) return null
    const told = await toldOf(connection)
    const room = await roomOf(connection, told)
    return room ? { ...told, ...room } : told
  })

  /**
   * What a turn is told about keeping a conversation within the context of its model: how much
   * that holds, what the person set about compacting, and how far the app's guesses were off the
   * last time the service counted. The service has been asked about the model by the time a
   * message is sent, as a rule; where it has not answered yet, the message is not held up for it.
   */
  const roomFor = async (session: Session, connection: Connection): Promise<RoomOptions> => {
    const told = await Promise.race([toldOf(connection), new Promise<null>((resolve) => setTimeout(resolve, 1500, null))])
    const window = (await roomOf(connection, told))?.contextWindow
    const context = session.stats?.context
    const fit = context && context.provider === connection.provider && context.model === connection.model ? context.fit : undefined
    return { settings: await store.compactionSettings(), ...(window ? { window } : {}), ...(fit ? { fit } : {}) }
  }

  /** The conversation and the model a turn is for, as the memory needs to know them (memory.ts). */
  /** `skill`: the one the person picked for the message, if any; one of the memory's commands says what the model may do to the notes. */
  const memoryTurnOf = (session: Session, connection: Connection, room: RoomOptions, skill?: string): MemoryTurn => ({
    session: session.id,
    // The notes of a workspace are those of the repository, also for a conversation in a worktree of it.
    workspace: projectFolder(session),
    provider: { id: connection.provider, ...(connection.providerName ? { name: connection.providerName } : {}), local: isLocalAddress(connection.baseURL) },
    model: connection.model,
    ...(room.window ? { window: room.window } : {}),
    ...(skill && (MEMORY_COMMANDS as readonly string[]).includes(skill) ? { command: true } : {})
  })

  ipcMain.handle('workspace:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    // Not remembered yet: a folder the app has not been in before is asked about first, and a no leaves no trace of it.
    return result.filePaths[0]
  })
  // The person's yes to that question, which also remembers the folder.
  ipcMain.handle('workspace:trust', (_e, folder: unknown) => store.trustFolder(folder))
  ipcMain.handle('workspace:list', () => store.listWorkspaces())

  // Files to put with a message: picked in the system dialog, or dropped on the message box or
  // pasted into it. Either way they are read and judged here (attachments.ts).
  ipcMain.handle('attachments:pick', async (): Promise<AttachmentsRead> => {
    if (!mainWindow) return { files: [], problems: [] }
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return { files: [], problems: [] }
    return attachFiles(result.filePaths)
  })
  ipcMain.handle('attachments:read', (_e, files: unknown): AttachmentsRead => {
    const given = Array.isArray(files) ? files : []
    return attachData(
      given.flatMap((file: unknown) => {
        // How large it is and where it lies are the page's word: attachData takes them only as far as they can be true.
        const { name, data, size, path: where } = typeof file === 'object' && file !== null ? (file as { name?: unknown; data?: unknown; size?: unknown; path?: unknown }) : {}
        return data instanceof ArrayBuffer || ArrayBuffer.isView(data)
          ? [{ name: String(name ?? ''), data: data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength), size, path: where }]
          : []
      })
    )
  })

  // The files an answer points to. What is read or opened lies in the folder of the conversation.
  ipcMain.handle('files:image', (_e, workspace: unknown, address: unknown) => readImage(String(workspace ?? ''), String(address ?? '')))
  ipcMain.handle('files:open', async (_e, workspace: unknown, address: unknown): Promise<OpenOutcome> => {
    const found = await findNamed(String(workspace ?? ''), String(address ?? ''))
    if (typeof found === 'string') return { ok: false, reason: found }
    if (howToOpen(found) === 'reveal') {
      shell.showItemInFolder(found.full)
      return { ok: true, how: 'revealed' }
    }
    const error = await shell.openPath(found.full)
    return error ? { ok: false, reason: 'failed', detail: error } : { ok: true, how: 'opened' }
  })

  // A page on the web that an answer links to. The words of a link are the model's and may say
  // anything, so the person is shown where it leads and asked before the browser goes there
  // (LinkAsk.tsx), except for the sites they said not to ask about again. Whether a site is one
  // of those is decided here, by the settings as they are kept.
  ipcMain.handle('links:open', async (_e, address: unknown, answer: unknown): Promise<LinkOutcome> => {
    const place = webPlace(typeof address === 'string' ? address : '')
    if (!place) return { opened: false, reason: 'not-web' }
    const said = typeof answer === 'object' && answer !== null
    if (!said && !(await store.trustsSite(place.site))) return { opened: false, reason: 'ask' }
    try {
      await shell.openExternal(place.address)
    } catch {
      return { opened: false, reason: 'failed' }
    }
    // A site is kept only once a page of it did open.
    const settings = said && (answer as { remember?: unknown }).remember === true ? await store.trustSite(place.site) : undefined
    return { opened: true, ...(settings ? { settings } : {}) }
  })
  ipcMain.handle('links:forget', (_e, site: unknown) => store.forgetSite(site))
  // The repository on GitHub a workspace is a clone of, for the words of an answer that name a
  // pull request or a commit of it. Looked for only in a folder the person said a model may read.
  ipcMain.handle('workspace:github', async (_e, workspace: unknown) => {
    const folder = typeof workspace === 'string' ? workspace : ''
    return folder && path.isAbsolute(folder) && (await readable(folder)) ? githubRepoOf(folder) : null
  })

  const pluginManager = async (): Promise<PluginManager> => {
    if (!pluginsReady) throw new Error('Plugins are not available yet.')
    return pluginsReady
  }
  ipcMain.handle('plugins:list', async () => (await pluginManager()).list())
  ipcMain.handle('plugins:held', () => PLUGINS_HELD)
  ipcMain.handle('plugins:setEnabled', async (_e, id: string, enabled: boolean) => {
    const manager = await pluginManager()
    try {
      await manager.setEnabled(id, enabled)
    } finally {
      // Whether or not it went well: what is running may have changed, and the page shows the interfaces of what is running.
      mainWindow?.webContents.send('plugins:changed')
    }
    return manager.list()
  })
  ipcMain.handle('plugins:reload', async (_e, id: string) => {
    const manager = await pluginManager()
    try {
      await manager.reload(id)
    } finally {
      mainWindow?.webContents.send('plugins:changed')
    }
    return manager.list()
  })
  // What the interface of a plugin asks its own code here. A plugin that is off has nobody to answer.
  ipcMain.handle('plugins:call', (_e, plugin: unknown, name: unknown, payload: unknown) => channel.call(String(plugin), String(name), payload))
  ipcMain.handle('plugins:openFolder', async () => {
    const error = await shell.openPath((await pluginManager()).dir)
    if (error) throw new Error(error)
  })

  ipcMain.handle('mcp:get', async () => ({
    config: await mcp.readConfigText(),
    servers: mcp.status(),
    ...(mcp.loadError ? { error: mcp.loadError } : {})
  }))
  ipcMain.handle('mcp:save', async (_e, config: string) => {
    await mcp.saveConfigText(config)
    return mcp.status()
  })
  ipcMain.handle('mcp:reconnect', async () => {
    await mcp.reconnect()
    return mcp.status()
  })
  ipcMain.handle('mcp:status', () => mcp.status())

  ipcMain.handle('skills:list', () => skills.list())
  ipcMain.handle('skills:openFolder', async () => {
    await fs.mkdir(skills.userDir, { recursive: true })
    const error = await shell.openPath(skills.userDir)
    if (error) throw new Error(error)
  })

  // The page of the memory: the notes, and how they are used. Which notes a new conversation would
  // be shown is worked out for the model in use, with what its context holds.
  registerMemoryIpc(ipcMain, memory, {
    use: async () => {
      const connection = await store.getConnection().catch(() => null)
      if (!connection || !connection.model) return null
      const window = (await roomOf(connection, await toldOf(connection)))?.contextWindow
      return { provider: { id: connection.provider, name: connection.providerName ?? connection.provider, local: isLocalAddress(connection.baseURL) }, ...(window ? { window } : {}) }
    },
    openFolder: async (dir) => {
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
    }
  })
  // The look for a newer build, for the About page of the settings.
  registerUpdateIpc(ipcMain, updates)
  // What was asked of the services, and DeepSeek's balance: the usage page, and the row under the message box.
  registerUsageIpc(ipcMain, usage)

  // With which of them are at work just now, so that the list can show it.
  ipcMain.handle('sessions:list', async () => (await store.listSessions()).map((s) => (activeRuns.has(s.id) ? { ...s, running: true as const } : s)))
  // What is typed into the search box of the sidebar. Longer than a search someone types is not one.
  ipcMain.handle('sessions:search', (_e, query: unknown) => (typeof query === 'string' ? store.searchSessions(query.slice(0, 400)) : []))
  ipcMain.handle('sessions:load', (_e, id: string) => store.loadSession(id))
  // A running session is saved from memory at every step, which would undo a change made to its file.
  const notWhileRunning = (id: string): void => {
    if (activeRuns.has(id)) throw new Error('This session is running. Try again when it has finished.')
  }
  ipcMain.handle('sessions:rename', async (_e, id: string, title: unknown) => {
    notWhileRunning(id)
    const clean = typeof title === 'string' ? cutAt(title.replace(/\s+/g, ' ').trim(), 120) : ''
    if (!clean) throw new Error('A session needs a name.')
    await store.updateSession(id, { title: clean })
  })
  ipcMain.handle('sessions:archive', async (_e, id: string, archived: unknown) => {
    notWhileRunning(id)
    await store.updateSession(id, { archived: archived === true })
  })
  ipcMain.handle('sessions:icon', async (_e, id: string, icon: unknown) => {
    notWhileRunning(id)
    if (icon !== null && !isSessionIcon(icon)) throw new Error('This is not one of the icons a session can have.')
    await store.updateSession(id, { icon })
  })
  /**
   * The worktree a saved session still has: its folder, or its git branch. Told from the folders
   * of the repository, without running git. None for a session that works in no worktree, and
   * for one whose worktree was taken away already.
   */
  const keptWorktree = async (id: string): Promise<WorktreeInfo | null> => {
    const info = await store.peekSession(id, (session) => session.worktree ?? null)
    return info && (await takenNames(info.repo)).includes(info.name) ? info : null
  }
  /**
   * Before a session is deleted: a worktree it still has is taken away with it, unless it holds
   * work the main folder does not have. That is thrown away only on the person's own yes, which
   * the page asks for and acts on before it deletes the session (`worktrees:remove`).
   */
  const dropWorktree = async (id: string): Promise<void> => {
    const info = await keptWorktree(id)
    if (!info) return
    // What stops it is said to the person, who asked for the conversation to be deleted: in the language of the app.
    // A yes to git taken back is asked about before git is, which would refuse in English (`notAllowedText`).
    if (!(await store.allowsGit(info.repo))) throw new Error(notAllowedText(info.name))
    const removed = await worktrees.remove(info).catch((err: unknown) => {
      throw saidToPerson(err)
    })
    if (removed.kind === 'unmerged') {
      throw new Error(`这个会话的 worktree「${info.name}」里有还没合并的改动（${removed.files} 个文件，${removed.commits} 个提交）。先合并，或者从这个会话自己的菜单里删除它：那里会问你要不要丢弃这些改动。`)
    }
    // Nothing of it can be merged any more: files are left in its folder, which git cannot tell from changes.
    if (removed.kind === 'left') {
      const commits = removed.commits > 0 ? `，它的 git 分支上还有 ${removed.commits} 个还没合并的提交` : ''
      throw new Error(`这个会话的 worktree「${info.name}」已经失效，但它的文件夹里还留着 ${leftFiles(removed.files)}${commits}。从这个会话自己的菜单里删除它：那里会问你要不要连同${removed.commits > 0 ? '这些文件和提交' : '这些文件'}一起删掉。`)
    }
    if (removed.kind === 'locked') {
      throw new Error(`这个会话的 worktree「${info.name}」被你用 git worktree lock 锁住了。从这个会话自己的菜单里删除它：那里会问你要不要解锁并删除。`)
    }
  }
  /** Deletes a saved session, and with it what is kept of it for as long as the app runs. */
  const dropSession = async (id: string): Promise<void> => {
    const run = activeRuns.get(id)
    if (run) stopRun(run)
    await dropWorktree(id)
    alwaysAllowed.delete(id)
    textTools.delete(id)
    wholeReplies.delete(id)
    noImages.delete(id)
    noDocuments.delete(id)
    await store.deleteSession(id)
    // What the memory kept of it: the notes it saw. The notes themselves stay.
    await memory.dropSession(id).catch((err) => console.error('[memory] could not forget a deleted session:', err))
  }
  ipcMain.handle('sessions:delete', (_e, id: string) => dropSession(id))

  // A workspace is known by its folder. What is asked of one is asked of the sessions the list
  // shows under it, which are those not archived; nothing in the folder itself is touched.
  ipcMain.handle('workspace:rename', (_e, folder: unknown, name: unknown) => store.nameWorkspace(String(folder ?? ''), name))
  /** All of them or none: a workspace half put away, or half deleted, would have to be explained. */
  const noneRunning = (sessions: readonly { id: string }[]): void => {
    if (sessions.some((s) => activeRuns.has(s.id))) throw new Error('A session of this workspace is running. Try again when it has finished.')
  }
  ipcMain.handle('workspace:archive', async (_e, folder: unknown): Promise<string[]> => {
    const shown = (await store.sessionsIn(String(folder ?? ''))).filter((s) => !s.archived)
    noneRunning(shown)
    for (const { id } of shown) await store.updateSession(id, { archived: true })
    return shown.map((s) => s.id)
  })
  ipcMain.handle('workspace:remove', async (_e, folder: unknown, named: unknown): Promise<Settings> => {
    const dir = String(folder ?? '')
    const asked = new Set(Array.isArray(named) ? named.filter((id): id is string => typeof id === 'string') : [])
    const all = await store.sessionsIn(dir)
    // Deleted is what the person was shown and said yes to, and of that only what is of this
    // workspace and in the list: not a session that came since, and none that is archived.
    const going = all.filter((s) => !s.archived && asked.has(s.id))
    noneRunning(going)
    // All of them or none here as well: a worktree with work that was not merged is not thrown away in passing.
    for (const { id, title } of going) {
      const info = await keptWorktree(id)
      if (!info) continue
      // The same where the person took back their yes to git in its repository: told before git is asked, with the conversation named.
      if (!(await store.allowsGit(info.repo))) throw new Error(notAllowedText(info.name, title))
      const would = await worktrees.removable(info).catch((err: unknown) => {
        throw saidToPerson(err)
      })
      if (would.kind === 'removed') continue
      const why = would.kind === 'locked' ? '它被你用 git worktree lock 锁住了' : would.kind === 'left' ? `它已经失效，但文件夹里还留着 ${leftFiles(would.files)}` : '里面有还没合并的改动'
      // Merging is offered only where there is work to merge.
      const how = would.kind === 'unmerged' ? '合并，或者从它自己的菜单里删除' : '从它自己的菜单里删除'
      throw new Error(`会话“${title}”在 worktree「${info.name}」里进行，${why}。先单独处理这个会话（${how}），再删除这个工作区。`)
    }
    for (const { id } of going) await dropSession(id)
    // A session that came since keeps the workspace in the list, and its folder is then still one to offer.
    if (all.some((s) => !s.archived && !going.includes(s))) return store.getSettings()
    // What is archived of it stays, and says from then on which folder it ran in.
    return store.forgetWorkspace(dir)
  })

  /**
   * Why the model service in use cannot be asked now, as the person is told it: the words the page
   * says before a message is sent (`notReadyText`). Where the settings tell nothing amiss and there
   * is still no connection to be had (a key that cannot be read on this computer), that is said.
   */
  const notReady = async (connection: Connection | null): Promise<string> =>
    notReadyText(await store.getSettings()) || (connection ? '请先在右下角选择模型' : '当前的模型服务还不能用。打开设置，检查它的 API Key 或登录。')

  /** Takes a message into its session and starts the turn that answers it. Resolves, with the session's id, once the turn has begun. */
  const beginTurn = async (sessionId: string | null, workspace: string, text: string, skill?: string, extras?: unknown): Promise<Sent> => {
    const connection = await store.getConnection()
    if (!connection?.model) throw new Error(await notReady(connection))
    if (sessionId && activeRuns.has(sessionId)) throw new Error('This session is already running.')
    // Whether the message goes out as a plain chat, with no tools and nothing of the app's beside
    // it (`TurnOptions.plain`): a plugin says so, for this model, and the page has no say in it.
    // Asked once, as the message is sent, and that is what the turn is.
    const plain = sampling.plainFor(targetOf(connection))
    // The memory's commands are carried out with the memory's tools, and a plain chat has none: sent
    // all the same, the model would be told to keep a note it cannot keep, and might say it did.
    if (plain && skill && (MEMORY_COMMANDS as readonly string[]).includes(skill)) {
      throw new Error('This message would go out as a plain chat, which has no tools, and the memory commands need tools to read or change a note. Switch the plain chat off in the debug panel, or send the message without the command.')
    }
    // Loaded before anything is saved, so a skill that vanished fails the send instead of the turn.
    const pickedSkill = skill ? { name: skill, prompt: selectedSkillPrompt(skill, await skills.load(skill)) } : undefined
    // A plain chat is told of no skills. One the person picked for the message is part of what they say, and goes.
    const skillsText = plain ? undefined : skillsPrompt(await skills.list())
    // What goes with the message arrives from the page, and is checked like everything that does.
    const { mode: askedMode, attachments: given, worktree: askedTree } =
      typeof extras === 'object' && extras !== null ? (extras as { mode?: unknown; attachments?: unknown; worktree?: unknown }) : {}
    const attachments = readAttachments(given)
    if (typeof text !== 'string' || (!text.trim() && attachments.length === 0)) throw new Error('There is nothing to send.')

    let session: Session | null = sessionId ? await store.loadSession(sessionId) : null
    /** The worktree made for a new chat that is to work in one. */
    let made: WorktreeInfo | undefined
    if (!session) {
      // The page asks before a new chat goes into a folder (TrustDialog.tsx); a message that comes
      // from anywhere else is held to the same: a folder that is there, named in full, and trusted.
      // Said to the person, in the language of the app: the folder may have been deleted or renamed
      // after it was chosen and before the first message went.
      const there = typeof workspace === 'string' && path.isAbsolute(workspace) && (await fs.stat(workspace).then((s) => s.isDirectory(), () => false))
      if (!there) throw new Error('这个文件夹已经不在了（可能被删掉或改了名字）。重新选择工作文件夹，再发送。')
      if (!(await store.trusts(workspace))) throw new Error('这个文件夹还没有被信任。重新选择这个文件夹，会问你是否允许模型读取里面的文件。')
      if (askedTree !== undefined && askedTree !== null) {
        // The chat is to work in a worktree of the repository in that folder. It is made first: one
        // that cannot be made leaves no conversation behind. Git is run for it, which the person
        // was asked about for this repository (GitDialog.tsx); where they said no, nothing is made.
        const name = typeof askedTree === 'object' ? (askedTree as { name?: unknown }).name : undefined
        // What stops a worktree from being made is said to the person, in the language of the app (`Explained`).
        if (!isWorktreeName(name)) throw new Error('worktree 的名字只能用小写字母、数字和连字符，最多 40 个字符，开头和结尾要是字母或数字。')
        made = await worktrees.create(workspace, name).catch((err: unknown) => {
          throw saidToPerson(err)
        })
      }
      session = {
        id: randomUUID(),
        // A message that is files and no words is named after the first of them.
        title: cutAt(text.trim().replace(/\s+/g, ' '), 60) || cutAt(attachments[0]?.name ?? '', 60) || 'New chat',
        // The files of a conversation in a worktree are the worktree's; in the list it stays one of the repository's.
        workspace: made ? worktrees.folderOf(made) : workspace,
        ...(made ? { worktree: made } : {}),
        updatedAt: Date.now(),
        messages: []
      }
    }
    const current = session
    // Nothing has been answered in it yet: once this turn is over, the model names the conversation by what it is about.
    const unnamed = !current.messages.some((message) => message.role === 'assistant')
    // What the page shows as the mode of the conversation at this moment is what counts; where it says nothing, what the conversation had.
    const mode: PermissionMode = isPermissionMode(askedMode) ? askedMode : (current.permissionMode ?? DEFAULT_PERMISSION_MODE)
    // Writing in an archived session brings it back to the list.
    delete current.archived
    // Counted from the first message sent while the counting is on. A conversation that was
    // already under way says so, since its numbers then leave out what came before.
    const counting = await store.countsStats()
    if (counting) current.stats = addTurn(current.stats ?? emptyStats(current.messages.length > 0))
    // Keeps the folder list in order of use. Not worth failing the message over.
    store.rememberWorkspace(projectFolder(current)).catch((err) => console.error('[store] could not remember the folder:', err))
    current.messages.push({
      role: 'user',
      content: text,
      ...(pickedSkill ? { skill: pickedSkill } : {}),
      ...(attachments.length ? { attachments } : {}),
      at: Date.now(),
      // Kept with the message: the conversation shows which of its messages went out that way.
      ...(plain ? { plain: true as const } : {})
    })
    // Its pictures go into files of their own, once; so do those of a session saved before that was done.
    // Where that fails, they stay in the session's file as before.
    await keepPictures(current, store.picturesRoot()).catch((err: unknown) => console.error('[store] pictures stay in the session file:', err instanceof Error ? err.message : err))

    const run: ActiveRun = { controller: new AbortController(), provider: connection.provider, pending: new Set(), mode }
    activeRuns.set(current.id, run)
    takeMode(current.id, run)
    let allowed = alwaysAllowed.get(current.id)
    if (!allowed) alwaysAllowed.set(current.id, (allowed = new Set()))

    // Saves are chained so an older snapshot can never land after a newer one.
    let saving: Promise<void> = Promise.resolve()
    const checkpoint = (): void => {
      current.updatedAt = Date.now()
      // The mode as it is now: the person may have changed it while the turn ran. The one a conversation starts with is not written down.
      if (run.mode === DEFAULT_PERMISSION_MODE) delete current.permissionMode
      else current.permissionMode = run.mode
      // Written out now, as it is now. The pictures of the session are named, not copied: they are
      // in files of their own, written once (session-files.ts), and not again at every step.
      const text = sessionText(current)
      saving = saving.then(() => store.saveSessionText(current.id, text)).catch((err) => console.error('save failed', err))
    }
    liveSessions.set(current.id, { session: current, checkpoint, saved: () => saving })
    // A name the model wrote for the session while this message was on its way is taken up with it,
    // and said to the page once it is in the file, where the list is read from. So is what else
    // was to be changed of it meanwhile (`pendingChanges`).
    const named = takeTitle(current)
    takeChanges(current)
    checkpoint()
    if (named) void saving.then(() => send({ sessionId: current.id, event: { type: 'titled', title: current.title } }))

    const room = await roomFor(current, connection)
    // What the memory tells the model in this conversation, and the tools it adds: nothing of it while the memory is off for this service.
    // And nothing of it in a plain chat, where the memory is not asked at all: no note is read for the turn, and none can be written in it.
    const remembered = plain
      ? { prompt: undefined, tools }
      : await memory.forTurn(memoryTurnOf(current, connection, room, pickedSkill?.name), tools).catch((err: unknown) => {
          console.error('[memory] left out of this turn:', err instanceof Error ? err.message : err)
          return { prompt: undefined, tools }
        })
    // In a worktree the model is told where it is, and has the worktree's tools. Not in a plain chat, which has nothing of the app's.
    const tree = plain ? { prompt: undefined, tools: remembered.tools } : worktreeParts(current, remembered.tools)
    const systemExtra = [skillsText, tree.prompt].filter(Boolean).join('\n\n') || undefined
    /** Set when the service turned out not to take the level of thinking chosen for the model: what is asked of it after the turn names none either. */
    let levelRefused = false

    void runTurn({
      connection: asLearned(current.id, connection),
      workspace: current.workspace,
      messages: current.messages,
      systemExtra,
      memory: remembered.prompt,
      conversation: conversationName(current.id),
      room,
      plain,
      signal: run.controller.signal,
      tools: tree.tools,
      sampling,
      // Read anew before every request: a plugin that begins to watch in the middle of a turn sees the rest of it.
      trace: {
        get active() {
          return trace.active
        },
        record: (exchange) => trace.emit(exchange, current.id)
      },
      alwaysAllowed: allowed,
      permissionMode: () => run.mode,
      emit: (event) => {
        // What ended the turn in an error is written down with the conversation (shared/failures.ts):
        // the turn saves it once more as it ends, right after it has said so. Until this was kept,
        // the reason was gone once the person went to another conversation and came back.
        if (event.type === 'error') current.failures = withFailure(current.failures, failureOf(event, turnsOf(current), Date.now()))
        send({ sessionId: current.id, event })
      },
      checkpoint,
      // The numbers are kept with the conversation, so the next checkpoint saves them; the page is told at once.
      stats: counting
        ? {
            step: (measure) => {
              current.stats = addStep(current.stats ?? emptyStats(), measure)
              send({ sessionId: current.id, event: { type: 'stats', stats: current.stats } })
              usage.record(measure, connection.providerName)
            },
            tool: (ms) => {
              current.stats = addToolTime(current.stats ?? emptyStats(), ms)
              send({ sessionId: current.id, event: { type: 'stats', stats: current.stats } })
            },
            compacted: (done) => {
              current.stats = addCompaction(current.stats ?? emptyStats(), done)
              send({ sessionId: current.id, event: { type: 'stats', stats: current.stats } })
              if (done.cost) usage.record(done.cost, connection.providerName)
            }
          }
        : undefined,
      onFastRefused: () => {
        store.dropFastMode(connection.provider, connection.model).catch((err) => console.error('[store] could not switch fast mode off:', err))
      },
      onEffortRefused: () => {
        levelRefused = true
        store.dropEffort(connection.provider, connection.model).catch((err) => console.error('[store] could not take the level of thinking back:', err))
      },
      onToolsRefused: () => textTools.set(current.id, modelKey(connection)),
      onStreamRefused: () => wholeReplies.set(current.id, modelKey(connection)),
      onImagesRefused: () => noImages.set(current.id, modelKey(connection)),
      onDocumentsRefused: () => noDocuments.set(current.id, modelKey(connection)),
      requestPermission: (call) =>
        new Promise<PermissionDecision>((resolve) => {
          const id = randomUUID()
          run.pending.add(id)
          permissionResolvers.set(id, (decision) => {
            run.pending.delete(id)
            permissionResolvers.delete(id)
            resolve(decision)
          })
          send({ sessionId: current.id, event: { type: 'permission_request', id, call } })
        })
    })
      .finally(() => {
        activeRuns.delete(current.id)
        liveSessions.delete(current.id)
        keepMode(current.id, run, current.permissionMode, saving)
        // DeepSeek's balance after what the turn cost, where something shows it or waits on it.
        void usage.turnEnded(connection.provider, counting)
      })
      // By itself and after the turn: the person can go on with the conversation meanwhile.
      .then(() => (unnamed ? nameConversation(current, levelRefused ? { ...connection, reasoningEffort: 'default' } : connection) : undefined))

    return { id: current.id, ...(plain ? { plain: true as const } : {}), ...(made ? { worktree: { ...made, folder: current.workspace } } : {}) }
  }

  ipcMain.handle('agent:send', async (_e, sessionId: string | null, workspace: string, text: string, skill?: string, extras?: unknown) => {
    // From here until its turn has begun the session is on its way into memory: a name that
    // arrives for it meanwhile waits for it there, and is not written into a file it is being read from.
    if (sessionId) opening.add(sessionId)
    try {
      return await beginTurn(sessionId, workspace, text, skill, extras)
    } finally {
      if (sessionId) {
        opening.delete(sessionId)
        pendingModes.delete(sessionId)
        settleChanges(sessionId)
      }
    }
  })

  // The person asks for a conversation to be compacted now. It counts as running while that is
  // done: nothing can be sent in it meanwhile, and a stop ends the writing of the summary.
  const compactSession = async (id: string): Promise<CompactionReport> => {
    const connection = await store.getConnection()
    // Compacting now is not stopped by the page where there is no key or no model, as a message is: said here, in the same words.
    if (!connection?.model) throw new Error(await notReady(connection))
    const session = await store.loadSession(id)
    if (!session) throw new Error('This session no longer exists.')
    // No tool runs while a conversation is compacted, so its mode has nothing to say here; it is kept as the session has it.
    const run: ActiveRun = { controller: new AbortController(), provider: connection.provider, pending: new Set(), mode: session.permissionMode ?? DEFAULT_PERMISSION_MODE }
    activeRuns.set(id, run)
    takeMode(id, run)
    let saving: Promise<void> = Promise.resolve()
    try {
      const counting = await store.countsStats()
      const checkpoint = (): void => {
        session.updatedAt = Date.now()
        // A mode the person chose meanwhile is saved with it, as a turn saves it.
        if (run.mode === DEFAULT_PERMISSION_MODE) delete session.permissionMode
        else session.permissionMode = run.mode
        // Written out now, as it is now; its pictures are named, not copied (session-files.ts).
        const text = sessionText(session)
        saving = saving.then(() => store.saveSessionText(id, text))
      }
      liveSessions.set(id, { session, checkpoint, saved: () => saving })
      // A name the model wrote for the session just now is taken up with it, and so is what else
      // was to be changed of it meanwhile (`pendingChanges`). Saved as it is: neither is a reason
      // for the session to move up the list. The page is told of a name once it is in the file.
      const changed = takeChanges(session)
      const named = takeTitle(session)
      if (named || changed) {
        const text = sessionText(session)
        const title = session.title
        const written = (saving = saving.then(() => store.saveSessionText(id, text)))
        if (named) {
          void written.then(
            () => send({ sessionId: id, event: { type: 'titled', title } }),
            () => {}
          )
        }
      }
      const room = await roomFor(session, connection)
      const remembered = await memory.forTurn(memoryTurnOf(session, connection, room), tools).catch(() => ({ prompt: undefined, tools }))
      const tree = worktreeParts(session, remembered.tools)
      const report = await compactConversation({
        connection: asLearned(id, connection),
        workspace: session.workspace,
        messages: session.messages,
        // The same instructions and tools a message would go out with: they take their part of the context.
        systemExtra: [skillsPrompt(await skills.list()), tree.prompt].filter(Boolean).join('\n\n') || undefined,
        memory: remembered.prompt,
        room,
        signal: run.controller.signal,
        tools: tree.tools,
        sampling,
        trace: {
          get active() {
            return trace.active
          },
          record: (exchange) => trace.emit(exchange, id)
        },
        alwaysAllowed: new Set(),
        emit: (event) => send({ sessionId: id, event }),
        checkpoint,
        stats: counting
          ? {
              step: () => {},
              tool: () => {},
              compacted: (done) => {
                session.stats = addCompaction(session.stats ?? emptyStats(session.messages.length > 0), done)
                send({ sessionId: id, event: { type: 'stats', stats: session.stats } })
                if (done.cost) usage.record(done.cost, connection.providerName)
              }
            }
          : undefined,
        // No tool runs here, so there is nothing to ask.
        requestPermission: async () => 'deny'
      })
      await saving
      return report
    } finally {
      activeRuns.delete(id)
      liveSessions.delete(id)
      keepMode(id, run, session.permissionMode, saving.catch(() => {}))
    }
  }
  ipcMain.handle('sessions:compact', async (_e, sessionId: unknown): Promise<CompactionReport> => {
    const id = String(sessionId ?? '')
    if (activeRuns.has(id)) throw new Error('This session is running. Try again when it has finished.')
    // On its way into memory from here on, as with a message that arrives for it (see `agent:send`).
    opening.add(id)
    try {
      return await compactSession(id)
    } finally {
      opening.delete(id)
      pendingModes.delete(id)
      settleChanges(id)
    }
  })

  // The worktrees of repositories (worktree-ipc.ts): what a folder is to git, the person's yes to
  // git there, and the state, the merging and the taking away of a conversation's worktree.
  registerWorktreeIpc(ipcMain, {
    worktrees,
    hasGit: () => git.program() !== null,
    trusts: (folder) => store.trusts(folder),
    allows: (folder) => store.allowsGit(folder),
    allow: (folder) => store.allowGit(folder),
    forget: (folder) => store.forgetGit(folder),
    worktreeOf: async (id) => {
      const session = liveSessions.get(id)?.session
      const told = session ? { info: session.worktree, title: session.title } : await store.peekSession(id, (kept) => ({ info: kept.worktree, title: kept.title }))
      return told?.info ? { info: told.info, title: told.title } : null
    },
    running: (id) => activeRuns.has(id) || opening.has(id),
    merged: recordMerge,
    recordOf: async (id, mergeId) => {
      const live = liveSessions.get(id)?.session
      const merges = live ? (live.merges ?? []) : ((await store.peekSession(id, (kept) => kept.merges ?? [])) ?? [])
      return merges.find((merge) => merge.id === mergeId) ?? null
    },
    undone: recordUndo
  })

  ipcMain.handle('agent:stop', (_e, sessionId: string) => {
    const run = activeRuns.get(sessionId)
    if (run) stopRun(run)
  })

  ipcMain.handle('permission:respond', (_e, id: string, decision: unknown) => {
    // One of the three answers there are; anything else from the page answers nothing, and the question waits on.
    if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') return
    permissionResolvers.get(id)?.(decision)
  })

  // What the model may do in a conversation without asking. In one that is at work it counts from
  // the next tool call, and is saved with the conversation at its next step: written into the
  // file now, it would be undone by that save. A question that already waits still waits.
  ipcMain.handle('permission:setMode', async (_e, sessionId: unknown, mode: unknown) => {
    if (!isPermissionMode(mode)) throw new Error('This is not one of the permission modes.')
    const id = String(sessionId ?? '')
    const run = activeRuns.get(id)
    if (run) {
      run.mode = mode
      return
    }
    // Work on its way to the session was handed the mode the page had when it was asked for: it takes this one up as it begins.
    if (opening.has(id)) pendingModes.set(id, mode)
    await store.updateSession(id, { permissionMode: mode })
  })
}

if (!isPrimaryInstance) {
  console.error('StarBench is already running with this data folder; switching to that window.')
  app.quit()
} else {
  // Starting the app again brings the running window forward instead.
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    setAppMenu(app.isPackaged)
    registerIpc()
    servePluginUi()
    confinePageFiles()
    // The look that was chosen holds from the first thing the window shows. Settings that cannot be read are no reason not to open.
    nativeTheme.themeSource = await store.themeChoice().catch(() => DEFAULT_THEME)
    // The system's buttons over the page go by the look as the page does: when another is chosen in the settings, and when the system changes its own.
    nativeTheme.on('updated', () => {
      if (mainWindow && barless(process.platform)) mainWindow.setTitleBarOverlay(windowButtons(nativeTheme.shouldUseDarkColors))
    })
    createWindow()
    // Plugins load in the background so a slow or stuck one cannot delay the window.
    pluginsReady = startPlugins()
    pluginsReady.catch((err) => console.error('[plugins] failed to start:', err))
    // Only an unreadable mcp.json rejects here; the settings page shows the same error when it is saved.
    mcp.init().catch((err) => console.error('[mcp] could not load mcp.json:', err))
    // The memory's settings, and its commands while it is on. Read again at the first turn if this fails.
    memory.init().catch((err) => console.error('[memory] could not read its settings:', err))
    // While the app stays open it looks for a newer build again once a day has gone by, where the person lets it. The first look is asked for by the page when it is up (updates:auto).
    setInterval(() => void updates.check('app'), 6 * 60 * 60 * 1000).unref()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// Give plugins a chance to release what they hold (child processes, files) before exiting.
let shuttingDown = false
app.on('before-quit', (event) => {
  // A copy that never started has nothing to release.
  if (shuttingDown || !isPrimaryInstance) return
  shuttingDown = true
  event.preventDefault()
  const giveUp = new Promise((resolve) => setTimeout(resolve, 3000))
  void Promise.race([shutdown(), giveUp])
    .catch((err) => console.error('[main] shutdown failed:', err))
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
