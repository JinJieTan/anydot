import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type AgentPong, type AppInfo } from '../shared/ipc'

/** The only surface the renderer can reach. Keep it narrow and typed. */
const api = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IpcChannel.AppInfo),
  agentPing: (): Promise<AgentPong> => ipcRenderer.invoke(IpcChannel.AgentPing),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
