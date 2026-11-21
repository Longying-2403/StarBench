import { contextBridge, ipcRenderer } from 'electron'
import type { HarnessApi, SessionEvent } from '../shared/types.ts'

const api: HarnessApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
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
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
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
