import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  type EventChannel,
  type EventMap,
  type InvokeChannel,
  type InvokeMap,
  invokeArgSchemas,
} from '../shared/ipc'

type Handler<C extends InvokeChannel> = (
  arg: InvokeMap[C][0]
) => InvokeMap[C][1] | Promise<InvokeMap[C][1]>
export type Handlers = { [C in InvokeChannel]: Handler<C> }

/** Registers every invoke handler, validating arguments with the shared zod schemas. */
export function registerIpc(handlers: Handlers): void {
  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    ipcMain.handle(channel, async (_event, arg: unknown) => {
      const schema = invokeArgSchemas[channel]
      const parsed = schema ? schema.parse(arg) : arg
      return (handlers[channel] as Handler<typeof channel>)(parsed as never)
    })
  }
}

/** Sends an event to every open window, so reopened windows keep receiving updates. */
export function broadcast<C extends EventChannel>(
  channel: C,
  payload: EventMap[C]
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

export async function chooseFolder(): Promise<string | null> {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = window
    ? await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
      })
    : await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
      })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export function showInFinder(absolutePath: string): void {
  shell.showItemInFolder(absolutePath)
}
