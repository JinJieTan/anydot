import { create } from 'zustand'
import type { ApprovalDTO, ChatStreamEvent, ConversationDTO, MessageDTO } from '../../../shared/ipc'
import { invoke } from '../lib/api'
import { useApp } from './app'

interface ChatState {
  /** Loaded conversation details, keyed by id. */
  conversations: Record<string, ConversationDTO>
  messages: Record<string, MessageDTO[]>
  /** Tool calls waiting for the user, keyed by toolCallId. */
  approvals: Record<string, ApprovalDTO>
  load: (id: string) => Promise<void>
  loadApprovals: () => Promise<void>
  apply: (e: ChatStreamEvent) => void
  setConversation: (c: ConversationDTO) => void
}

function upsert(list: MessageDTO[], msg: MessageDTO): MessageDTO[] {
  const i = list.findIndex((m) => m.id === msg.id)
  if (i === -1) return [...list, msg]
  const next = list.slice()
  next[i] = msg
  return next
}

export const useChat = create<ChatState>((set, get) => ({
  conversations: {},
  messages: {},
  approvals: {},

  loadApprovals: async () => {
    const list = await invoke('chat.approvals')
    set({ approvals: Object.fromEntries(list.map((a) => [a.toolCallId, a])) })
  },

  load: async (id) => {
    const detail = await invoke('conversations.get', id)
    if (!detail) return
    set((s) => ({
      conversations: { ...s.conversations, [id]: detail.conversation },
      messages: { ...s.messages, [id]: detail.messages },
    }))
  },

  setConversation: (c) => {
    set((s) => ({ conversations: { ...s.conversations, [c.id]: c } }))
    useApp.getState().upsertConversation(c)
  },

  apply: (e) => {
    const app = useApp.getState()
    switch (e.type) {
      case 'conversation':
        get().setConversation(e.conversation)
        break
      case 'message': {
        const { conversationId, message } = e
        set((s) => {
          const conv = s.conversations[conversationId]
          return {
            messages: {
              ...s.messages,
              [conversationId]: upsert(s.messages[conversationId] ?? [], message),
            },
            conversations: conv
              ? {
                  ...s.conversations,
                  [conversationId]: {
                    ...conv,
                    activeLeafId: message.id,
                    updatedAt: message.createdAt,
                  },
                }
              : s.conversations,
          }
        })
        const conv = get().conversations[conversationId]
        if (conv) app.upsertConversation(conv)
        break
      }
      case 'run':
        app.setRunning(e.conversationId, e.running)
        if (e.error) app.notify(e.error, 'error')
        break
      case 'approval':
        set((s) => ({ approvals: { ...s.approvals, [e.approval.toolCallId]: e.approval } }))
        break
      case 'approval-resolved':
        set((s) => {
          const next = { ...s.approvals }
          delete next[e.toolCallId]
          return { approvals: next }
        })
        break
      case 'delta': {
        const { conversationId, messageId } = e
        set((s) => {
          const list = s.messages[conversationId]
          if (!list) return s
          return {
            messages: {
              ...s.messages,
              [conversationId]: list.map((m) => {
                if (m.id !== messageId) return m
                const parts = m.parts.slice()
                const appendTo = (type: 'text' | 'reasoning', chunk: string) => {
                  const idx = parts.findIndex((p) => p.type === type)
                  if (idx === -1) {
                    // Reasoning always renders before the answer.
                    if (type === 'reasoning') parts.unshift({ type, text: chunk })
                    else parts.push({ type, text: chunk })
                  } else {
                    const p = parts[idx] as { type: typeof type; text: string }
                    parts[idx] = { type, text: p.text + chunk }
                  }
                }
                if (e.reasoning) appendTo('reasoning', e.reasoning)
                if (e.text) appendTo('text', e.text)
                return { ...m, parts }
              }),
            },
          }
        })
        break
      }
      case 'done':
        set((s) => ({
          messages: {
            ...s.messages,
            [e.conversationId]: upsert(s.messages[e.conversationId] ?? [], e.message),
          },
        }))
        break
    }
  },
}))
