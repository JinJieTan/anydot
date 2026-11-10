/**
 * RPC methods the page answers itself ('page' in WEB_SUPPORT): they need a
 * window, a file picker, a download or the clipboard, which the worker lacks.
 */
import type { PageHandlers, WorkerClient } from './api'

/** Model-generated pages waiting for public/artifact.html to ask for them, by id. */
const artifacts = new Map<string, string>()
const MAX_ARTIFACTS = 100
/** Windows opened by "open in its own window", allowed to ask for a page. */
const previews = new Set<Window>()

async function pageId(html: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html))
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function putArtifact(html: string): Promise<string> {
  const id = await pageId(html)
  artifacts.delete(id)
  artifacts.set(id, html)
  for (const key of artifacts.keys()) {
    if (artifacts.size <= MAX_ARTIFACTS) break
    artifacts.delete(key)
  }
  return new URL(`artifact.html#${id}`, document.baseURI).href
}

/**
 * artifact.html runs on an opaque origin (its CSP sandboxes it), so it can't
 * read the page; it asks by id and gets the HTML back by postMessage. Only our
 * own iframes and preview windows get an answer.
 */
export function serveArtifacts(): void {
  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'anydot-artifact-ready' || !e.source) return
    const source = e.source as Window
    const ours =
      previews.has(source) ||
      [...document.querySelectorAll('iframe')].some((f) => f.contentWindow === source)
    const html = artifacts.get(String(e.data.id))
    if (ours && html !== undefined) source.postMessage({ type: 'anydot-artifact', html }, '*')
  })
}

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
}

/** Clipboards only take PNG reliably: convert anything else through a canvas. */
async function asPng(data: Uint8Array, mime: string): Promise<Blob> {
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: mime })
  if (mime === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

export function pageHandlers(client: WorkerClient): PageHandlers {
  return {
    'artifact.url': (html) => putArtifact(html),
    'preview.html': async (html) => {
      const win = window.open(await putArtifact(html), '_blank')
      if (!win) throw new Error('浏览器拦截了新窗口，请允许本站弹出窗口')
      previews.add(win)
    },
    'blobs.saveAs': async ({ sha256, suggestedName }) => {
      const { data, mime } = await client.call('__blob.read', sha256)
      const ext = EXT[mime]
      const name = ext ? suggestedName.replace(/\.[a-z0-9]+$/i, '') + `.${ext}` : suggestedName
      download(data as Uint8Array<ArrayBuffer>, name, mime)
      return true
    },
    'blobs.copyImage': async (sha256) => {
      const { data, mime } = await client.call('__blob.read', sha256)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': asPng(data, mime) })])
    },
    'data.export': async () => {
      const zip = await client.call('__data.export')
      const name = `anydot-backup-${new Date().toISOString().slice(0, 10)}.zip`
      download(zip as Uint8Array<ArrayBuffer>, name, 'application/zip')
      return { path: `下载文件夹中的 ${name}` }
    },
    'data.import': async () => {
      const file = await pickFile('.zip,application/zip')
      if (!file) return null
      return client.call('__data.import', new Uint8Array(await file.arrayBuffer()))
    },
  }
}
