import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CompactionReport,
  ModelInfo,
  OpenOutcome,
  PermissionDecision,
  ProviderInput,
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
import { DEFAULT_THEME } from '../shared/theme.ts'
import { isLocalAddress, isSessionIcon } from '../shared/types.ts'
import { askAside, builtinPrompt, compactConversation, runTurn } from './agent.ts'
import type { RoomOptions } from './agent.ts'
import { attachData, attachFiles } from './attachments.ts'
import { conversationName } from './conversation-name.ts'
import { SignInError, startAttempt } from './chatgpt/login.ts'
import type { Attempt } from './chatgpt/login.ts'
import { adapterFor } from './providers/index.ts'
import type { Connection } from './providers/index.ts'
import { createKernel } from './kernel.ts'
import type { Kernel } from './kernel.ts'
import { languageOf } from './language.ts'
import { McpManager } from './mcp.ts'
import { MemoryService, registerMemoryIpc } from './memory.ts'
import type { MemoryTurn } from './memory.ts'
import { mayGrant, mayNavigate } from './page-guard.ts'
import { PluginChannel } from './plugin-channel.ts'
import { PluginManager } from './plugins.ts'
import { SamplingRegistry } from './sampling.ts'
import { SkillStore, loadSkillTool, selectedSkillPrompt, skillsPrompt } from './skills.ts'
import * as store from './store.ts'
import { cleanTitle, titleEffort, titlePrompt, titleRecord } from './title.ts'
import { ToolRegistry, registerBuiltinTools } from './tools.ts'
import { barless, windowButtons, windowGround } from './window-look.ts'
import { TraceRegistry } from './trace.ts'
import { findNamed, howToOpen, readImage } from './workspace-files.ts'

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
const modelKey = (connection: { provider: string; model: string }): string => `${connection.provider}\n${connection.model}`
/** The connection, with what a session has found out about its server. */
const asLearned = (sessionId: string, connection: Connection): Connection => ({
  ...connection,
  ...(wholeReplies.get(sessionId) === modelKey(connection) ? { wholeReplies: true } : {}),
  ...(textTools.get(sessionId) === modelKey(connection) ? { textTools: true } : {}),
  ...(noImages.get(sessionId) === modelKey(connection) ? { noImages: true } : {})
})

/** The folder the page and its own scripts are in. */
const PAGE_DIR = path.join(import.meta.dirname, '../renderer')
/** Set while developing: the page then comes from a local server and not from a file. */
const DEV_PAGE_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL

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
        return { ok: true, settings: withModel ?? saved.settings, providerId: saved.providerId, welcome: saved.welcome }
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
    for (const run of activeRuns.values()) if (run.provider === providerId) run.controller.abort()
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
  const memoryTurnOf = (session: Session, connection: Connection, room: RoomOptions): MemoryTurn => ({
    session: session.id,
    workspace: session.workspace,
    provider: { id: connection.provider, ...(connection.providerName ? { name: connection.providerName } : {}), local: isLocalAddress(connection.baseURL) },
    model: connection.model,
    ...(room.window ? { window: room.window } : {})
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
        const { name, data } = typeof file === 'object' && file !== null ? (file as { name?: unknown; data?: unknown }) : {}
        return data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? [{ name: String(name ?? ''), data: data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }] : []
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
    const clean = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
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
  /** Deletes a saved session, and with it what is kept of it for as long as the app runs. */
  const dropSession = async (id: string): Promise<void> => {
    activeRuns.get(id)?.controller.abort()
    alwaysAllowed.delete(id)
    textTools.delete(id)
    wholeReplies.delete(id)
    noImages.delete(id)
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
    for (const { id } of going) await dropSession(id)
    // A session that came since keeps the workspace in the list, and its folder is then still one to offer.
    if (all.some((s) => !s.archived && !going.includes(s))) return store.getSettings()
    // What is archived of it stays, and says from then on which folder it ran in.
    return store.forgetWorkspace(dir)
  })

  /** Takes a message into its session and starts the turn that answers it. Resolves, with the session's id, once the turn has begun. */
  const beginTurn = async (sessionId: string | null, workspace: string, text: string, skill?: string, extras?: unknown): Promise<string> => {
    const connection = await store.getConnection()
    if (!connection) throw new Error('The model service in use has no API key or sign-in yet. Open Settings to add one.')
    if (!connection.model) throw new Error('No model chosen yet. Pick one next to the message box.')
    if (sessionId && activeRuns.has(sessionId)) throw new Error('This session is already running.')
    // Loaded before anything is saved, so a skill that vanished fails the send instead of the turn.
    const pickedSkill = skill ? { name: skill, prompt: selectedSkillPrompt(skill, await skills.load(skill)) } : undefined
    const systemExtra = skillsPrompt(await skills.list())
    // What goes with the message arrives from the page, and is checked like everything that does.
    const { mode: askedMode, attachments: given } = typeof extras === 'object' && extras !== null ? (extras as { mode?: unknown; attachments?: unknown }) : {}
    const attachments = readAttachments(given)
    if (typeof text !== 'string' || (!text.trim() && attachments.length === 0)) throw new Error('There is nothing to send.')

    let session: Session | null = sessionId ? await store.loadSession(sessionId) : null
    if (!session) {
      session = {
        id: randomUUID(),
        // A message that is files and no words is named after the first of them.
        title: text.trim().replace(/\s+/g, ' ').slice(0, 60) || attachments[0]?.name.slice(0, 60) || 'New chat',
        workspace,
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
    store.rememberWorkspace(current.workspace).catch((err) => console.error('[store] could not remember the folder:', err))
    current.messages.push({ role: 'user', content: text, ...(pickedSkill ? { skill: pickedSkill } : {}), ...(attachments.length ? { attachments } : {}), at: Date.now() })

    const run: ActiveRun = { controller: new AbortController(), provider: connection.provider, pending: new Set(), mode }
    activeRuns.set(current.id, run)
    let allowed = alwaysAllowed.get(current.id)
    if (!allowed) alwaysAllowed.set(current.id, (allowed = new Set()))

    // Saves are chained so an older snapshot can never land after a newer one.
    let saving: Promise<void> = Promise.resolve()
    const checkpoint = (): void => {
      current.updatedAt = Date.now()
      // The mode as it is now: the person may have changed it while the turn ran. The one a conversation starts with is not written down.
      if (run.mode === DEFAULT_PERMISSION_MODE) delete current.permissionMode
      else current.permissionMode = run.mode
      const snapshot = structuredClone(current)
      saving = saving.then(() => store.saveSession(snapshot)).catch((err) => console.error('save failed', err))
    }
    liveSessions.set(current.id, { session: current, checkpoint, saved: () => saving })
    // A name the model wrote for the session while this message was on its way is taken up with it,
    // and said to the page once it is in the file, where the list is read from.
    const named = takeTitle(current)
    checkpoint()
    if (named) void saving.then(() => send({ sessionId: current.id, event: { type: 'titled', title: current.title } }))

    const room = await roomFor(current, connection)
    // What the memory tells the model in this conversation, and the tools it adds: nothing of it while the memory is off for this service.
    const remembered = await memory.forTurn(memoryTurnOf(current, connection, room), tools).catch((err: unknown) => {
      console.error('[memory] left out of this turn:', err instanceof Error ? err.message : err)
      return { prompt: undefined, tools }
    })

    void runTurn({
      connection: asLearned(current.id, connection),
      workspace: current.workspace,
      messages: current.messages,
      systemExtra,
      memory: remembered.prompt,
      conversation: conversationName(current.id),
      room,
      signal: run.controller.signal,
      tools: remembered.tools,
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
      emit: (event) => send({ sessionId: current.id, event }),
      checkpoint,
      // The numbers are kept with the conversation, so the next checkpoint saves them; the page is told at once.
      stats: counting
        ? {
            step: (measure) => {
              current.stats = addStep(current.stats ?? emptyStats(), measure)
              send({ sessionId: current.id, event: { type: 'stats', stats: current.stats } })
            },
            tool: (ms) => {
              current.stats = addToolTime(current.stats ?? emptyStats(), ms)
              send({ sessionId: current.id, event: { type: 'stats', stats: current.stats } })
            },
            compacted: (done) => {
              current.stats = addCompaction(current.stats ?? emptyStats(), done)
              send({ sessionId: current.id, event: { type: 'stats', stats: current.stats } })
            }
          }
        : undefined,
      onFastRefused: () => {
        store.dropFastMode(connection.provider, connection.model).catch((err) => console.error('[store] could not switch fast mode off:', err))
      },
      onToolsRefused: () => textTools.set(current.id, modelKey(connection)),
      onStreamRefused: () => wholeReplies.set(current.id, modelKey(connection)),
      onImagesRefused: () => noImages.set(current.id, modelKey(connection)),
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
      })
      // By itself and after the turn: the person can go on with the conversation meanwhile.
      .then(() => (unnamed ? nameConversation(current, connection) : undefined))

    return current.id
  }

  ipcMain.handle('agent:send', async (_e, sessionId: string | null, workspace: string, text: string, skill?: string, extras?: unknown) => {
    // From here until its turn has begun the session is on its way into memory: a name that
    // arrives for it meanwhile waits for it there, and is not written into a file it is being read from.
    if (sessionId) opening.add(sessionId)
    try {
      return await beginTurn(sessionId, workspace, text, skill, extras)
    } finally {
      if (sessionId) opening.delete(sessionId)
    }
  })

  // The person asks for a conversation to be compacted now. It counts as running while that is
  // done: nothing can be sent in it meanwhile, and a stop ends the writing of the summary.
  const compactSession = async (id: string): Promise<CompactionReport> => {
    const connection = await store.getConnection()
    if (!connection) throw new Error('The model service in use has no API key or sign-in yet. Open Settings to add one.')
    if (!connection.model) throw new Error('No model chosen yet. Pick one next to the message box.')
    const session = await store.loadSession(id)
    if (!session) throw new Error('This session no longer exists.')
    // No tool runs while a conversation is compacted, so its mode has nothing to say here; it is kept as the session has it.
    const run: ActiveRun = { controller: new AbortController(), provider: connection.provider, pending: new Set(), mode: session.permissionMode ?? DEFAULT_PERMISSION_MODE }
    activeRuns.set(id, run)
    try {
      const counting = await store.countsStats()
      let saving: Promise<void> = Promise.resolve()
      const checkpoint = (): void => {
        session.updatedAt = Date.now()
        const snapshot = structuredClone(session)
        saving = saving.then(() => store.saveSession(snapshot))
      }
      liveSessions.set(id, { session, checkpoint, saved: () => saving })
      // A name the model wrote for the session just now is taken up with it. Saved as it is:
      // a new name is no reason for the session to move up the list. The page is told once it is in the file.
      if (takeTitle(session)) {
        const snapshot = structuredClone(session)
        const written = (saving = saving.then(() => store.saveSession(snapshot)))
        void written.then(
          () => send({ sessionId: id, event: { type: 'titled', title: snapshot.title } }),
          () => {}
        )
      }
      const room = await roomFor(session, connection)
      const remembered = await memory.forTurn(memoryTurnOf(session, connection, room), tools).catch(() => ({ prompt: undefined, tools }))
      const report = await compactConversation({
        connection: asLearned(id, connection),
        workspace: session.workspace,
        messages: session.messages,
        // The same instructions and tools a message would go out with: they take their part of the context.
        systemExtra: skillsPrompt(await skills.list()),
        memory: remembered.prompt,
        room,
        signal: run.controller.signal,
        tools: remembered.tools,
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
    }
  })

  ipcMain.handle('agent:stop', (_e, sessionId: string) => {
    const run = activeRuns.get(sessionId)
    if (!run) return
    run.controller.abort()
    // A run blocked on a permission prompt would otherwise never notice the stop.
    for (const id of [...run.pending]) permissionResolvers.get(id)?.('deny')
  })

  ipcMain.handle('permission:respond', (_e, id: string, decision: PermissionDecision) => {
    permissionResolvers.get(id)?.(decision)
  })

  // What the model may do in a conversation without asking. In one that is at work it counts from
  // the next tool call, and is saved with the conversation at its next step: written into the
  // file now, it would be undone by that save. A question that already waits still waits.
  ipcMain.handle('permission:setMode', async (_e, sessionId: unknown, mode: unknown) => {
    if (!isPermissionMode(mode)) throw new Error('This is not one of the permission modes.')
    const id = String(sessionId ?? '')
    const run = activeRuns.get(id)
    if (run) run.mode = mode
    else await store.updateSession(id, { permissionMode: mode })
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
