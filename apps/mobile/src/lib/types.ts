import type { MessagePart } from '@aitech/core'

/** Shapes returned by the desktop's remote API (see desktop remote-service.ts). */
export interface RConversation {
  id: string
  projectId: string | null
  title: string | null
  modelId: string | null
  thinking?: RThinking
  activeLeafId: string | null
  updatedAt: number
}

export type RThinking = 'off' | 'low' | 'medium' | 'high'

export interface RModel {
  id: string
  modelId: string
  displayName: string | null
  capabilities: string[]
}

export interface RMessage {
  id: string
  conversationId: string
  parentId: string | null
  role: 'system' | 'user' | 'assistant' | 'tool'
  parts: MessagePart[]
  modelId?: string | null
  status: 'complete' | 'streaming' | 'error' | 'aborted'
  error: string | null
  createdAt: number
}

export interface RApproval {
  conversationId: string
  toolCallId: string
  name: string
  input: unknown
  summary: string
  reason: string
  danger: boolean
  /** An ask_user question set: answered instead of allowed or denied. */
  questions?: {
    question: string
    header?: string
    options: { label: string; description?: string }[]
    multiSelect?: boolean
  }[]
}

export interface RProject {
  id: string
  name: string
  permissionMode: string
}

export interface RSync {
  desktop: { name: string; platform: string }
  projects: RProject[]
  conversations: RConversation[]
  models?: RModel[]
  /** Permission modes the phone may set; older desktops don't send it. */
  remoteModes?: string[]
  running: string[]
  approvals: RApproval[]
}

export type RChatEvent =
  | { type: 'message'; conversationId: string; message: RMessage }
  | { type: 'delta'; conversationId: string; messageId: string; text?: string; reasoning?: string }
  | { type: 'done'; conversationId: string; message: RMessage }
  | { type: 'conversation'; conversation: RConversation }
  | { type: 'run'; conversationId: string; running: boolean; error?: string }
  | { type: 'approval'; approval: RApproval }
  | { type: 'approval-resolved'; conversationId: string; toolCallId: string }

/** Messages on the active branch, root first. */
export function activePath(messages: RMessage[], leafId: string | null): RMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]))
  const out: RMessage[] = []
  let cur = leafId ? byId.get(leafId) : undefined
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.push(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return out.reverse()
}
