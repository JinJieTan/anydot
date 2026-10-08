import { BrowserWindow } from 'electron'
import { EVENT_CHANNEL, type EventName, type Events } from '../shared/ipc'

/** Push an event to every open window. */
export function emit<K extends EventName>(name: K, payload: Events[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL(name), payload)
  }
}
