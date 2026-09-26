import { contextBridge, ipcRenderer } from 'electron'
import type { EventChannel, EventMap, InvokeChannel, RendererApi } from '../shared/ipc'

const api: RendererApi = {
  invoke: ((channel: InvokeChannel, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)) as RendererApi['invoke'],
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void) {
    const wrapped = (_event: unknown, payload: EventMap[C]) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('lms', api)
