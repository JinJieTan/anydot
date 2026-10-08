import type { MessageDTO } from '../../../shared/ipc'

/** Messages on the active branch, root first. */
export function activePath(messages: MessageDTO[], leafId: string | null): MessageDTO[] {
  if (!leafId) return []
  const byId = new Map(messages.map((m) => [m.id, m]))
  const path: MessageDTO[] = []
  let cur = byId.get(leafId)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.push(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return path.reverse()
}

/** Siblings (same parent, same role) in creation order, for ‹ 1/3 › navigation. */
export function siblingsOf(messages: MessageDTO[], msg: MessageDTO): MessageDTO[] {
  return messages
    .filter((m) => m.parentId === msg.parentId && m.role === msg.role)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}
