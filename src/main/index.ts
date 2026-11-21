import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ModelInfo,
  PermissionDecision,
  ProviderInput,
  Session,
  SessionEvent,
  Settings,
  SignInOptions,
  SignInResult
} from '../shared/types.ts'
import { runTurn } from './agent.ts'
import { SignInError, startAttempt } from './chatgpt/login.ts'
import type { Attempt } from './chatgpt/login.ts'
import { adapterFor } from './providers/index.ts'
import { createKernel } from './kernel.ts'
import type { Kernel } from './kernel.ts'
import { McpManager } from './mcp.ts'
import { PluginManager } from './plugins.ts'
import { SkillStore, loadSkillTool, selectedSkillPrompt, skillsPrompt } from './skills.ts'
import * as store from './store.ts'
import { ToolRegistry, registerBuiltinTools } from './tools.ts'

// Lets development and tests run against a throwaway profile instead of the real one.
if (process.env.STARBENCH_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STARBENCH_USER_DATA))
}

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
const skills = new SkillStore(path.join(app.getPath('userData'), 'skills'))
tools.register(loadSkillTool(skills), 'builtin')
const mcp = new McpManager({
  configFile: path.join(app.getPath('userData'), 'mcp.json'),
  tools,
  clientInfo: { name: 'starbench', version: app.getVersion() }
})
let kernel: Kernel | null = null
let plugins: PluginManager | null = null
/** Resolves once enabled plugins have been started; plugin IPC waits for it. */
let pluginsReady: Promise<PluginManager> | null = null

async function startPlugins(): Promise<PluginManager> {
  kernel = await createKernel({ tools })
  const userData = app.getPath('userData')
  plugins = new PluginManager({
    root: kernel.root,
    tools,
    skills,
    dir: path.join(userData, 'plugins'),
    stateFile: path.join(userData, 'plugins.json')
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
}
const activeRuns = new Map<string, ActiveRun>()
const permissionResolvers = new Map<string, (decision: PermissionDecision) => void>()
/** Per-session "always allow" choices; kept in memory only, so they reset on restart. */
const alwaysAllowed = new Map<string, Set<string>>()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16171a',
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
    // Allow dev-server reloads of the app itself, block everything else.
    const current = mainWindow?.webContents.getURL() ?? ''
    if (!current || new URL(event.url).origin !== new URL(current).origin) event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    mainWindow.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') console.error(`[renderer] ${event.message}`)
    })
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
}

function send(payload: SessionEvent): void {
  mainWindow?.webContents.send('agent:event', payload)
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:setEffort', (_e, effort: unknown) => store.setReasoningEffort(effort))
  ipcMain.handle('settings:setFast', (_e, on: unknown) => store.setFastMode(on))
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
  ipcMain.handle('models:info', async () => {
    const connection = await store.getConnection().catch(() => null)
    if (!connection || !connection.model) return null
    // The key is part of it so that correcting a wrong key asks again at once.
    const key = `${connection.provider}\n${connection.baseURL}\n${connection.model}\n${connection.apiKey}`
    const cached = modelInfo?.key === key ? modelInfo : null
    if (cached && ((await cached.value) !== null || Date.now() - cached.at < 60_000)) return cached.value
    const value = adapterFor(connection.kind)
      .modelInfo(connection)
      .catch((err) => {
        console.error('[models] could not ask the service about the model:', err instanceof Error ? err.message : err)
        return null
      })
    modelInfo = { key, at: Date.now(), value }
    return value
  })

  ipcMain.handle('workspace:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    await store.rememberWorkspace(result.filePaths[0])
    return result.filePaths[0]
  })
  ipcMain.handle('workspace:list', () => store.listWorkspaces())

  const pluginManager = async (): Promise<PluginManager> => {
    if (!pluginsReady) throw new Error('Plugins are not available yet.')
    return pluginsReady
  }
  ipcMain.handle('plugins:list', async () => (await pluginManager()).list())
  ipcMain.handle('plugins:setEnabled', async (_e, id: string, enabled: boolean) => {
    const manager = await pluginManager()
    await manager.setEnabled(id, enabled)
    return manager.list()
  })
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

  ipcMain.handle('sessions:list', () => store.listSessions())
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
  ipcMain.handle('sessions:delete', async (_e, id: string) => {
    activeRuns.get(id)?.controller.abort()
    alwaysAllowed.delete(id)
    await store.deleteSession(id)
  })

  ipcMain.handle('agent:send', async (_e, sessionId: string | null, workspace: string, text: string, skill?: string) => {
    const connection = await store.getConnection()
    if (!connection) throw new Error('The model service in use has no API key or sign-in yet. Open Settings to add one.')
    if (!connection.model) throw new Error('No model chosen yet. Pick one next to the message box.')
    if (sessionId && activeRuns.has(sessionId)) throw new Error('This session is already running.')
    // Loaded before anything is saved, so a skill that vanished fails the send instead of the turn.
    const pickedSkill = skill ? { name: skill, prompt: selectedSkillPrompt(skill, await skills.load(skill)) } : undefined
    const systemExtra = skillsPrompt(await skills.list())

    let session: Session | null = sessionId ? await store.loadSession(sessionId) : null
    if (!session) {
      session = {
        id: randomUUID(),
        title: text.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New chat',
        workspace,
        updatedAt: Date.now(),
        messages: []
      }
    }
    const current = session
    // Writing in an archived session brings it back to the list.
    delete current.archived
    // Keeps the folder list in order of use. Not worth failing the message over.
    store.rememberWorkspace(current.workspace).catch((err) => console.error('[store] could not remember the folder:', err))
    current.messages.push({ role: 'user', content: text, ...(pickedSkill ? { skill: pickedSkill } : {}) })

    const run: ActiveRun = { controller: new AbortController(), provider: connection.provider, pending: new Set() }
    activeRuns.set(current.id, run)
    let allowed = alwaysAllowed.get(current.id)
    if (!allowed) alwaysAllowed.set(current.id, (allowed = new Set()))

    // Saves are chained so an older snapshot can never land after a newer one.
    let saving: Promise<void> = Promise.resolve()
    const checkpoint = (): void => {
      current.updatedAt = Date.now()
      const snapshot = structuredClone(current)
      saving = saving.then(() => store.saveSession(snapshot)).catch((err) => console.error('save failed', err))
    }
    checkpoint()

    void runTurn({
      connection,
      workspace: current.workspace,
      messages: current.messages,
      systemExtra,
      signal: run.controller.signal,
      tools,
      alwaysAllowed: allowed,
      emit: (event) => send({ sessionId: current.id, event }),
      checkpoint,
      onFastRefused: () => {
        store.dropFastMode(connection.provider, connection.model).catch((err) => console.error('[store] could not switch fast mode off:', err))
      },
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
    }).finally(() => activeRuns.delete(current.id))

    return current.id
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

  void app.whenReady().then(() => {
    registerIpc()
    createWindow()
    // Plugins load in the background so a slow or stuck one cannot delay the window.
    pluginsReady = startPlugins()
    pluginsReady.catch((err) => console.error('[plugins] failed to start:', err))
    // Only an unreadable mcp.json rejects here; the settings page shows the same error when it is saved.
    mcp.init().catch((err) => console.error('[mcp] could not load mcp.json:', err))
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
