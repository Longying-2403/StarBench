import { contextBridge, ipcRenderer } from 'electron'
import type { MemoryApi, MemoryEvent } from '../shared/memory.ts'
import type { HarnessApi, SessionEvent } from '../shared/types.ts'
import type { UpdateEvent } from '../shared/update.ts'
import type { UsageApi, UsageEvent } from '../shared/usage.ts'

const api: HarnessApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  updateState: () => ipcRenderer.invoke('updates:state'),
  checkForUpdate: () => ipcRenderer.invoke('updates:check'),
  setAutoUpdateCheck: (on) => ipcRenderer.invoke('updates:setAuto', on),
  autoCheckForUpdate: () => ipcRenderer.invoke('updates:auto'),
  onUpdateEvent: (listener) => {
    const handler = (_: unknown, event: UpdateEvent): void => listener(event)
    ipcRenderer.on('updates:event', handler)
    return () => ipcRenderer.removeListener('updates:event', handler)
  },
  saveProvider: (input) => ipcRenderer.invoke('providers:save', input),
  removeProvider: (id) => ipcRenderer.invoke('providers:remove', id),
  startSignIn: (options) => ipcRenderer.invoke('signin:start', options),
  finishSignIn: () => ipcRenderer.invoke('signin:finish'),
  cancelSignIn: () => ipcRenderer.invoke('signin:cancel'),
  signOut: (providerId) => ipcRenderer.invoke('signin:out', providerId),
  selectModel: (providerId, model) => ipcRenderer.invoke('models:select', providerId, model),
  listModels: (providerId) => ipcRenderer.invoke('models:list', providerId),
  setReasoningEffort: (effort) => ipcRenderer.invoke('settings:setEffort', effort),
  setFastMode: (on) => ipcRenderer.invoke('settings:setFast', on),
  setWebSearch: (on) => ipcRenderer.invoke('settings:setWebSearch', on),
  setContextWindow: (providerId, model, tokens) => ipcRenderer.invoke('settings:setWindow', providerId, model, tokens),
  setStats: (on) => ipcRenderer.invoke('settings:setStats', on),
  setTheme: (theme) => ipcRenderer.invoke('settings:setTheme', theme),
  setTitles: (on) => ipcRenderer.invoke('settings:setTitles', on),
  setSessionTimes: (on) => ipcRenderer.invoke('settings:setSessionTimes', on),
  setCompaction: (change) => ipcRenderer.invoke('settings:setCompaction', change),
  getModelInfo: () => ipcRenderer.invoke('models:info'),
  builtinPrompt: () => ipcRenderer.invoke('prompt:builtin'),
  setPrompt: (providerId, prompt) => ipcRenderer.invoke('prompt:set', providerId, prompt),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  pluginsHeld: () => ipcRenderer.invoke('plugins:held'),
  setPluginEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
  reloadPlugin: (id) => ipcRenderer.invoke('plugins:reload', id),
  onPluginsChanged: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('plugins:changed', handler)
    return () => ipcRenderer.removeListener('plugins:changed', handler)
  },
  callPlugin: (plugin, name, payload) => ipcRenderer.invoke('plugins:call', plugin, name, payload),
  onPluginEvent: (listener) => {
    const handler = (_: unknown, told: { plugin: string; event: string; payload: unknown }): void => listener(told)
    ipcRenderer.on('plugins:event', handler)
    return () => ipcRenderer.removeListener('plugins:event', handler)
  },
  openPluginsFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  openSkillsFolder: () => ipcRenderer.invoke('skills:openFolder'),
  getMcp: () => ipcRenderer.invoke('mcp:get'),
  saveMcp: (config) => ipcRenderer.invoke('mcp:save', config),
  reconnectMcp: () => ipcRenderer.invoke('mcp:reconnect'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  trustFolder: (folder) => ipcRenderer.invoke('workspace:trust', folder),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  renameWorkspace: (folder, name) => ipcRenderer.invoke('workspace:rename', folder, name),
  archiveWorkspace: (folder) => ipcRenderer.invoke('workspace:archive', folder),
  removeWorkspace: (folder, sessions) => ipcRenderer.invoke('workspace:remove', folder, sessions),
  readImage: (workspace, address) => ipcRenderer.invoke('files:image', workspace, address),
  openFile: (workspace, address) => ipcRenderer.invoke('files:open', workspace, address),
  openWeb: (address, answer) => ipcRenderer.invoke('links:open', address, answer),
  forgetSite: (site) => ipcRenderer.invoke('links:forget', site),
  githubRepo: (workspace) => ipcRenderer.invoke('workspace:github', workspace),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  searchSessions: (query) => ipcRenderer.invoke('sessions:search', query),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
  setSessionArchived: (id, archived) => ipcRenderer.invoke('sessions:archive', id, archived),
  setSessionIcon: (id, icon) => ipcRenderer.invoke('sessions:icon', id, icon),
  send: (sessionId, workspace, text, skill, extras) => ipcRenderer.invoke('agent:send', sessionId, workspace, text, skill, extras),
  pickAttachments: () => ipcRenderer.invoke('attachments:pick'),
  readAttachments: (files) => ipcRenderer.invoke('attachments:read', files),
  setPermissionMode: (sessionId, mode) => ipcRenderer.invoke('permission:setMode', sessionId, mode),
  compactSession: (sessionId) => ipcRenderer.invoke('sessions:compact', sessionId),
  stop: (sessionId) => ipcRenderer.invoke('agent:stop', sessionId),
  respondPermission: (id, decision) => ipcRenderer.invoke('permission:respond', id, decision),
  onEvent: (listener) => {
    const handler = (_: unknown, payload: SessionEvent): void => listener(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  }
}

contextBridge.exposeInMainWorld('harness', api)

/** The page's way to the memory (main/memory.ts), kept apart from the rest. */
const memory: MemoryApi = {
  state: () => ipcRenderer.invoke('memory:state'),
  list: (workspace) => ipcRenderer.invoke('memory:list', workspace),
  save: (input) => ipcRenderer.invoke('memory:save', input),
  remove: (ref) => ipcRenderer.invoke('memory:remove', ref),
  undo: (changeId) => ipcRenderer.invoke('memory:undo', changeId),
  confirm: (id) => ipcRenderer.invoke('memory:confirm', id),
  setEnabled: (on) => ipcRenderer.invoke('memory:setEnabled', on),
  setBudget: (tokens) => ipcRenderer.invoke('memory:setBudget', tokens),
  setProviderMode: (providerId, mode) => ipcRenderer.invoke('memory:setProviderMode', providerId, mode),
  openFolder: () => ipcRenderer.invoke('memory:openFolder'),
  onEvent: (listener) => {
    const handler = (_: unknown, event: MemoryEvent): void => listener(event)
    ipcRenderer.on('memory:event', handler)
    return () => ipcRenderer.removeListener('memory:event', handler)
  }
}

contextBridge.exposeInMainWorld('memory', memory)

/** The page's way to the record of what was asked of the services, and to DeepSeek's balance (main/usage.ts). */
const usage: UsageApi = {
  summary: (range) => ipcRenderer.invoke('usage:summary', range),
  clear: () => ipcRenderer.invoke('usage:clear'),
  balance: (providerId, fresh) => ipcRenderer.invoke('usage:balance', providerId, fresh),
  setAlert: (providerId, amount) => ipcRenderer.invoke('usage:setAlert', providerId, amount),
  settings: () => ipcRenderer.invoke('usage:settings'),
  setBalance: (on) => ipcRenderer.invoke('usage:setBalance', on),
  onEvent: (listener) => {
    const handler = (_: unknown, event: UsageEvent): void => listener(event)
    ipcRenderer.on('usage:event', handler)
    return () => ipcRenderer.removeListener('usage:event', handler)
  }
}

contextBridge.exposeInMainWorld('usage', usage)
