import { contextBridge, ipcRenderer } from 'electron'
import type { HarnessApi, SessionEvent } from '../shared/types.ts'

const api: HarnessApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  send: (sessionId, workspace, text) => ipcRenderer.invoke('agent:send', sessionId, workspace, text),
  stop: (sessionId) => ipcRenderer.invoke('agent:stop', sessionId),
  respondPermission: (id, decision) => ipcRenderer.invoke('permission:respond', id, decision),
  onEvent: (listener) => {
    const handler = (_: unknown, payload: SessionEvent): void => listener(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  }
}

contextBridge.exposeInMainWorld('harness', api)
