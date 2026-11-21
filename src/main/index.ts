import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { PermissionDecision, Session, SessionEvent, SettingsInput } from '../shared/types.ts'
import { runTurn } from './agent.ts'
import { createKernel } from './kernel.ts'
import type { Kernel } from './kernel.ts'
import { PluginManager } from './plugins.ts'
import * as store from './store.ts'
import { ToolRegistry, registerBuiltinTools } from './tools.ts'

// Lets development and tests run against a throwaway profile instead of the real one.
if (process.env.STARBENCH_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STARBENCH_USER_DATA))
}

// Plugin code runs in this process; a promise it forgot to handle must not take the app down.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

let mainWindow: BrowserWindow | null = null

const tools = new ToolRegistry()
registerBuiltinTools(tools)
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
    dir: path.join(userData, 'plugins'),
    stateFile: path.join(userData, 'plugins.json')
  })
  await plugins.init()
  return plugins
}

async function shutdown(): Promise<void> {
  await plugins?.dispose()
  await kernel?.dispose()
}

interface ActiveRun {
  controller: AbortController
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
  ipcMain.handle('settings:save', (_e, input: SettingsInput) => store.saveSettings(input))

  ipcMain.handle('workspace:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

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

  ipcMain.handle('sessions:list', () => store.listSessions())
  ipcMain.handle('sessions:load', (_e, id: string) => store.loadSession(id))
  ipcMain.handle('sessions:delete', async (_e, id: string) => {
    activeRuns.get(id)?.controller.abort()
    alwaysAllowed.delete(id)
    await store.deleteSession(id)
  })

  ipcMain.handle('agent:send', async (_e, sessionId: string | null, workspace: string, text: string) => {
    const connection = await store.getConnection()
    if (!connection) throw new Error('No API key configured. Open Settings and add one.')
    if (sessionId && activeRuns.has(sessionId)) throw new Error('This session is already running.')

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
    current.messages.push({ role: 'user', content: text })

    const run: ActiveRun = { controller: new AbortController(), pending: new Set() }
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
      ...connection,
      workspace: current.workspace,
      messages: current.messages,
      signal: run.controller.signal,
      tools,
      alwaysAllowed: allowed,
      emit: (event) => send({ sessionId: current.id, event }),
      checkpoint,
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

void app.whenReady().then(() => {
  registerIpc()
  createWindow()
  // Plugins load in the background so a slow or stuck one cannot delay the window.
  pluginsReady = startPlugins()
  pluginsReady.catch((err) => console.error('[plugins] failed to start:', err))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Give plugins a chance to release what they hold (child processes, files) before exiting.
let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown) return
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
