import { electronAPI } from '@electron-toolkit/preload'
import type { ElectronApi } from '@shared/contracts'
import { contextBridge, ipcRenderer } from 'electron'

const api: ElectronApi = {
  auth: {
    getStatus: () => ipcRenderer.invoke('auth:getStatus'),
    startDeviceAuth: () => ipcRenderer.invoke('auth:startDeviceAuth'),
    finishDeviceAuth: () => ipcRenderer.invoke('auth:finishDeviceAuth'),
    disconnect: () => ipcRenderer.invoke('auth:disconnect'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (input) => ipcRenderer.invoke('settings:save', input),
    testBinaries: () => ipcRenderer.invoke('settings:testBinaries'),
    testRemote: () => ipcRenderer.invoke('settings:testRemote'),
    pickOutputDirectory: () =>
      ipcRenderer.invoke('settings:pickOutputDirectory'),
  },
  sync: {
    start: (input) => ipcRenderer.invoke('sync:start', input),
    cancel: (runId) => ipcRenderer.invoke('sync:cancel', runId),
    doctor: () => ipcRenderer.invoke('sync:doctor'),
    listRuns: () => ipcRenderer.invoke('sync:listRuns'),
    getRun: (runId) => ipcRenderer.invoke('sync:getRun', runId),
    getSnapshot: () => ipcRenderer.invoke('sync:getSnapshot'),
    getRunLogs: (runId) => ipcRenderer.invoke('sync:getRunLogs', runId),
    getSongLogs: (input) => ipcRenderer.invoke('sync:getSongLogs', input),
    subscribe: (listener) => {
      const wrapped = (_event: unknown, snapshot: unknown) => {
        listener(snapshot as Parameters<typeof listener>[0])
      }
      ipcRenderer.on('sync:snapshot', wrapped)
      return () => {
        ipcRenderer.removeListener('sync:snapshot', wrapped)
      }
    },
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error preload fallback assignment
  window.electron = electronAPI
  // @ts-expect-error preload fallback assignment
  window.api = api
}
