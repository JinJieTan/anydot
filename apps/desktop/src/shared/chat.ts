/**
 * Message helpers shared by the desktop chat service and the web app's
 * backend. No Node or Electron imports: this also runs in a browser worker.
 */
import type { MessagePart } from '@aitech/core'
import type { Attachment } from './ipc'

const TITLE_MAX = 40

export function appendDelta(parts: MessagePart[], type: 'text' | 'reasoning', chunk: string) {
  const last = parts.findLast((p) => p.type === type) as
    { type: typeof type; text: string } | undefined
  if (last) last.text += chunk
  else parts.push({ type, text: chunk })
}

export function userParts(text: string, attachments: Attachment[]): MessagePart[] {
  const parts: MessagePart[] = attachments.map((a) =>
    a.mime.startsWith('image/')
      ? { type: 'image', blob: a.blob, mime: a.mime, name: a.name }
      : { type: 'file', blob: a.blob, mime: a.mime, name: a.name },
  )
  const trimmed = text.trim()
  if (trimmed) parts.push({ type: 'text', text: trimmed })
  return parts
}

export function deriveTitle(text: string, attachments: Attachment[] = []): string {
  const line = text.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
  if (line) return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line
  return attachments[0]?.name ?? '新对话'
}
