import { contextBridge, ipcRenderer } from 'electron'
import {
  EVENT_CHANNEL,
  RPC_METHODS,
  type EventName,
  type Events,
  type Rpc,
  type RpcMethod,
} from '../shared/ipc'

const allowed = new Set<string>(RPC_METHODS)

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** The only surface the renderer can reach. Method names are allowlisted. */
const api = {
  async invoke<K extends RpcMethod>(
    method: K,
    ...args: Parameters<Rpc[K]>
  ): Promise<Awaited<ReturnType<Rpc[K]>>> {
    if (!allowed.has(method)) throw new Error(`unknown method ${method}`)
    const res = (await ipcRenderer.invoke(method, ...args)) as Result<Awaited<ReturnType<Rpc[K]>>>
    if (!res.ok) throw new Error(res.error)
    return res.value
  },

  on<K extends EventName>(name: K, cb: (payload: Events[K]) => void): () => void {
    const channel = EVENT_CHANNEL(name)
    const listener = (_: unknown, payload: Events[K]) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  platform: process.platform,
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
