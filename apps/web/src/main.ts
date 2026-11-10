/**
 * Boot: take the database lock (one tab at a time), start the service worker
 * and the backend worker, install `window.api`, then mount the desktop's
 * renderer, which only ever talks to that api.
 */
import './index.css'
import type { Settings } from '../../desktop/src/shared/ipc'
import { createApi, WorkerClient } from './api'
import { pageHandlers, serveArtifacts } from './page'
import type { FromWorker } from './protocol'

const LOCK = 'anydot-db'
const BASE = import.meta.env.BASE_URL
const root = document.getElementById('root')!
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('anydot') : null

/** The tab's backend once it holds the lock; the service worker asks it for blobs. */
let client: WorkerClient | null = null

/** A full-page message with an optional button; resolves when the button is pressed. */
function screen(title: string, detail: string, button?: string): Promise<void> {
  root.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'flex h-full flex-col items-center justify-center gap-3 px-6 text-center'
  const logo = document.createElement('img')
  logo.src = `${BASE}logo-mark.svg`
  logo.alt = ''
  logo.className = 'mb-2 size-11 dark:invert'
  const h = document.createElement('h1')
  h.className = 'text-xl font-semibold'
  h.textContent = title
  const p = document.createElement('p')
  p.className = 'max-w-md text-sm leading-relaxed text-fg-soft'
  p.textContent = detail
  box.append(logo, h, p)
  root.append(box)
  if (!button) return new Promise(() => {})
  const b = document.createElement('button')
  b.type = 'button'
  b.className =
    'mt-2 h-9 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-strong'
  b.textContent = button
  box.append(b)
  return new Promise((resolve) => b.addEventListener('click', () => resolve(), { once: true }))
}

/** A dismissible note in the corner (e.g. data won't be saved in this mode). */
function notice(text: string) {
  const el = document.createElement('div')
  el.role = 'status'
  el.className =
    'fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-fg shadow-lg'
  const span = document.createElement('span')
  span.className = 'flex-1 leading-relaxed'
  span.textContent = text
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'text-fg-faint hover:text-fg'
  close.textContent = '✕'
  close.onclick = () => el.remove()
  el.append(span, close)
  document.body.append(el)
}

/** Resolves with a release function once the lock is ours; null if taken and `wait` is false. */
function takeLock(wait: boolean): Promise<(() => void) | null> {
  // Without Web Locks (old browsers) two tabs could open the database; OPFS refuses the second.
  if (!navigator.locks) return Promise.resolve(() => {})
  return new Promise((resolve) => {
    void navigator.locks.request(LOCK, wait ? {} : { ifAvailable: true }, (lock) => {
      if (!lock) return resolve(null)
      return new Promise<void>((release) => resolve(release))
    })
  })
}

async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  try {
    const url = import.meta.env.DEV ? `${BASE}src/sw.ts` : `${BASE}sw.js`
    await navigator.serviceWorker.register(url, {
      scope: BASE,
      type: import.meta.env.DEV ? 'module' : 'classic',
    })
    if (!navigator.serviceWorker.controller) {
      // First visit: the worker claims this page once it activates.
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        })
        setTimeout(resolve, 5000)
      })
    }
    return !!navigator.serviceWorker.controller
  } catch (err) {
    console.warn('[sw] unavailable', err)
    return false
  }
}

function answerBlobRequests() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', async (e) => {
    if (e.data?.type !== 'anydot-blob') return
    const port = e.ports[0]
    if (!port) return
    if (!client) return port.postMessage({ ok: false })
    try {
      const { data, mime } = await client.call('__blob.read', String(e.data.sha256))
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      port.postMessage({ ok: true, data: buf, mime }, [buf as ArrayBuffer])
    } catch {
      port.postMessage({ ok: false })
    }
  })
  navigator.serviceWorker.startMessages()
}

/** The web app sets data-theme; desktop follows the OS through nativeTheme instead. */
function applyTheme(settings: Settings) {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = settings.theme
}

let persistAsked = false
/** Ask the browser not to evict our data, once there is data worth keeping. */
function askPersist() {
  if (persistAsked || !navigator.storage?.persist) return
  persistAsked = true
  void navigator.storage.persist()
}

async function start(release: () => void, serviceWorker: boolean) {
  const worker = new Worker(new URL('./backend/worker.ts', import.meta.url), { type: 'module' })
  const ready = await new Promise<FromWorker>((resolve) =>
    worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
      if (e.data.type === 'ready' || e.data.type === 'fatal') resolve(e.data)
    }),
  )
  if (ready.type === 'fatal') {
    release()
    await screen('AnyDot 打开失败', ready.error)
    return
  }
  if (ready.type !== 'ready') return
  const backend = new WorkerClient(worker)
  client = backend

  window.api = createApi(backend, pageHandlers(backend), {
    blobUrl: (sha256) => `${BASE}__blob/${sha256}`,
    onSettings: applyTheme,
    onCall: (method) => {
      if (method === 'providers.create') askPersist()
    },
  })
  applyTheme(await backend.call('settings.get'))
  if (ready.storage === 'opfs' && (await backend.call('providers.list')).length) askPersist()

  root.innerHTML = ''
  const { mount } = await import('./app')
  const unmount = mount(root)

  if (ready.storage === 'memory')
    notice('当前浏览器模式（如无痕窗口）不能保存数据：对话和图片只在这个页面里，关闭后会丢失。')
  if (!serviceWorker) notice('当前浏览器模式不支持 Service Worker，图片和视频可能无法显示。')

  // Another tab asked to take over: hand the database to it.
  channel?.addEventListener('message', async (e) => {
    if (e.data !== 'takeover') return
    await backend.call('__close').catch(() => {})
    worker.terminate()
    client = null
    unmount()
    release()
    await screen(
      'AnyDot 已在另一个标签页打开',
      '同一个浏览器里一次只能在一个标签页使用，避免数据冲突。',
      '切回这里',
    )
    location.href = `${location.pathname}?takeover`
  })
}

async function boot() {
  serveArtifacts()
  answerBlobRequests()
  const serviceWorker = await registerServiceWorker()

  const takeover = new URLSearchParams(location.search).has('takeover')
  if (takeover) history.replaceState(null, '', location.pathname)
  let release = await takeLock(false)
  if (!release) {
    if (!takeover)
      await screen(
        'AnyDot 已在其他标签页打开',
        '同一个浏览器里一次只能在一个标签页使用，避免数据冲突。在这里使用会关闭另一个标签页里的 AnyDot。',
        '在这里使用',
      )
    void screen('正在切换…', '等待另一个标签页释放数据')
    channel?.postMessage('takeover')
    release = (await takeLock(true))!
  }
  await start(release, serviceWorker)
}

void boot()
