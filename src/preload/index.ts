import { contextBridge, ipcRenderer } from 'electron'
import type { HarnessApi, SessionEvent } from '../shared/types.ts'

const api: HarnessApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
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
  getModelInfo: () => ipcRenderer.invoke('models:info'),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  setPluginEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
  openPluginsFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  openSkillsFolder: () => ipcRenderer.invoke('skills:openFolder'),
  getMcp: () => ipcRenderer.invoke('mcp:get'),
  saveMcp: (config) => ipcRenderer.invoke('mcp:save', config),
  reconnectMcp: () => ipcRenderer.invoke('mcp:reconnect'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
  setSessionArchived: (id, archived) => ipcRenderer.invoke('sessions:archive', id, archived),
  setSessionIcon: (id, icon) => ipcRenderer.invoke('sessions:icon', id, icon),
  send: (sessionId, workspace, text, skill) => ipcRenderer.invoke('agent:send', sessionId, workspace, text, skill),
  stop: (sessionId) => ipcRenderer.invoke('agent:stop', sessionId),
  respondPermission: (id, decision) => ipcRenderer.invoke('permission:respond', id, decision),
  onEvent: (listener) => {
    const handler = (_: unknown, payload: SessionEvent): void => listener(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  }
}

contextBridge.exposeInMainWorld('harness', api)
