import type { Api } from '../../desktop/src/preload'
import type { EventName, Events, Rpc, RpcMethod, Settings } from '../../desktop/src/shared/ipc'
import {
  DESKTOP_ONLY,
  WEB_SUPPORT,
  type FromWorker,
  type HandlerMap,
  type MethodsBy,
  type ToWorker,
  type WorkerMethod,
  type WorkerRpc,
} from './protocol'

export type PageHandlers = HandlerMap<Pick<Rpc, MethodsBy<'page'>>>

/** Talks to the backend worker; the page's side of protocol.ts. */
export class WorkerClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Map<EventName, Set<(payload: unknown) => void>>()

  constructor(private readonly worker: Worker) {
    worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
      const msg = e.data
      if (msg.type === 'result') {
        const call = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.ok) call?.resolve(msg.value)
        else call?.reject(new Error(msg.error))
      } else if (msg.type === 'event') {
        for (const cb of this.listeners.get(msg.name) ?? []) cb(msg.payload)
      }
    })
  }

  call<K extends WorkerMethod>(
    method: K,
    ...args: Parameters<WorkerRpc[K]>
  ): Promise<Awaited<ReturnType<WorkerRpc[K]>>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ type: 'invoke', id, method, args } satisfies ToWorker)
    })
  }

  on<K extends EventName>(name: K, cb: (payload: Events[K]) => void): () => void {
    const set = this.listeners.get(name) ?? new Set()
    this.listeners.set(name, set)
    const listener = cb as (payload: unknown) => void
    set.add(listener)
    return () => set.delete(listener)
  }
}

/**
 * The `window.api` the shared renderer expects (the desktop preload's shape),
 * routed by WEB_SUPPORT: to the worker, to the page's own handlers, or
 * refused for desktop-only methods.
 */
export function createApi(
  client: WorkerClient,
  page: PageHandlers,
  hooks: {
    blobUrl: (sha256: string) => string
    onSettings: (s: Settings) => void
    /** After a call succeeds. */
    onCall?: (method: RpcMethod) => void
  },
): Api {
  return {
    async invoke<K extends RpcMethod>(
      method: K,
      ...args: Parameters<Rpc[K]>
    ): Promise<Awaited<ReturnType<Rpc[K]>>> {
      const support = WEB_SUPPORT[method]
      let value: unknown
      if (support === 'desktop') throw new Error(DESKTOP_ONLY)
      if (support === 'page') {
        const fn = page[method as MethodsBy<'page'>] as (...a: unknown[]) => unknown
        value = await fn(...args)
      } else {
        value = await (client.call as (m: string, ...a: unknown[]) => Promise<unknown>)(
          method,
          ...args,
        )
      }
      if (method === 'settings.get' || method === 'settings.set')
        hooks.onSettings(value as Settings)
      hooks.onCall?.(method)
      return value as Awaited<ReturnType<Rpc[K]>>
    },
    on: (name, cb) => client.on(name, cb),
    blobUrl: hooks.blobUrl,
    platform: 'web',
  }
}
