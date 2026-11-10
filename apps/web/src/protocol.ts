/**
 * How the web app answers each RPC method of the desktop contract
 * (apps/desktop/src/shared/ipc.ts), and the messages between the page and the
 * backend worker.
 *
 * WEB_SUPPORT is typed over every method, so adding one to `Rpc` fails the web
 * typecheck until it is classified here, and the worker / page handler maps
 * are typed from it, so each class must be implemented in full.
 */
import type { EventName, ImportResult, Rpc, RpcMethod } from '../../desktop/src/shared/ipc'

/**
 * - worker: implemented by the backend worker (owns SQLite, blobs, model calls)
 * - stub: harmless read the renderer makes on start; answered with an empty value
 * - page: needs the page itself (file pickers, downloads, clipboard, windows)
 * - desktop: needs the local machine; the UI hides it, and a call fails
 */
export type Support = 'worker' | 'stub' | 'page' | 'desktop'

export const WEB_SUPPORT = {
  'app.info': 'worker',
  'app.logError': 'worker',
  'app.revealLogs': 'desktop',
  'updates.status': 'stub',
  'updates.check': 'stub',
  'updates.install': 'desktop',
  'feedback.send': 'worker',
  'settings.get': 'worker',
  'settings.set': 'worker',
  'settings.suggestedShortcut': 'stub',
  'providers.list': 'worker',
  'providers.create': 'worker',
  'providers.update': 'worker',
  'providers.delete': 'worker',
  'providers.test': 'worker',
  'providers.syncModels': 'worker',
  'models.list': 'worker',
  'models.available': 'worker',
  'models.add': 'worker',
  'models.update': 'worker',
  'models.delete': 'worker',
  'projects.list': 'stub',
  'conversations.setWorktree': 'desktop',
  'git.changes': 'desktop',
  'git.diff': 'desktop',
  'schedules.list': 'stub',
  'schedules.create': 'desktop',
  'schedules.update': 'desktop',
  'schedules.delete': 'desktop',
  'schedules.runNow': 'desktop',
  'projects.create': 'desktop',
  'projects.update': 'desktop',
  'projects.delete': 'desktop',
  'projects.reveal': 'desktop',
  'conversations.list': 'worker',
  'conversations.get': 'worker',
  'conversations.create': 'worker',
  'conversations.update': 'worker',
  'conversations.delete': 'worker',
  'conversations.revealWorkspace': 'desktop',
  'chat.send': 'worker',
  'chat.regenerate': 'worker',
  'chat.edit': 'worker',
  'chat.stop': 'worker',
  'chat.switchBranch': 'worker',
  'chat.running': 'worker',
  'chat.commands': 'stub',
  'chat.files': 'stub',
  'chat.approve': 'desktop',
  'chat.approvals': 'stub',
  'chat.rewindFiles': 'desktop',
  'remote.status': 'stub',
  'remote.configure': 'desktop',
  'remote.detect': 'desktop',
  'remote.pair': 'desktop',
  'remote.pairCancel': 'desktop',
  'remote.pairRespond': 'desktop',
  'remote.revoke': 'desktop',
  'mcp.list': 'stub',
  'mcp.save': 'desktop',
  'mcp.delete': 'desktop',
  'skills.list': 'stub',
  'skills.create': 'desktop',
  'skills.read': 'desktop',
  'skills.save': 'desktop',
  'skills.reveal': 'desktop',
  'skills.delete': 'desktop',
  'preview.html': 'page',
  'artifact.url': 'page',
  'artifact.readFile': 'desktop',
  'browser.show': 'desktop',
  'chromeExt.status': 'stub',
  'chromeExt.install': 'desktop',
  'chromeExt.exportZip': 'desktop',
  'computer.permissions': 'stub',
  'computer.displays': 'stub',
  'computer.requestPermission': 'desktop',
  'blobs.put': 'worker',
  'blobs.saveAs': 'page',
  'blobs.copyImage': 'page',
  'images.list': 'worker',
  'images.generate': 'worker',
  'images.delete': 'worker',
  'data.export': 'page',
  'data.import': 'page',
} as const satisfies Record<RpcMethod, Support>

export type MethodsBy<S extends Support> = {
  [K in RpcMethod]: (typeof WEB_SUPPORT)[K] extends S ? K : never
}[RpcMethod]

/** Worker methods the page uses to implement its own ('page') methods. */
export interface Internal {
  '__blob.read': (sha256: string) => { data: Uint8Array; mime: string }
  '__data.export': () => Uint8Array
  '__data.import': (zip: Uint8Array) => ImportResult
  /** Another tab takes over: close the database and let go of the OPFS files. */
  __close: () => void
}

export type WorkerRpc = Pick<Rpc, MethodsBy<'worker' | 'stub'>> & Internal
export type WorkerMethod = keyof WorkerRpc

export type Handler<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => R | Promise<R>
  : never
export type HandlerMap<T> = { [K in keyof T]: Handler<T[K]> }

/** Where the database lives: OPFS, or memory when the browser offers no storage (e.g. private mode). */
export type StorageMode = 'opfs' | 'memory'

export type ToWorker = { type: 'invoke'; id: number; method: WorkerMethod; args: unknown[] }

export type FromWorker =
  | { type: 'ready'; storage: StorageMode; reason?: string }
  | { type: 'fatal'; error: string }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'event'; name: EventName; payload: unknown }

export const DESKTOP_ONLY = '网页版不支持这个功能，请使用桌面端'
