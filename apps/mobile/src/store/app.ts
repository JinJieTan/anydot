import { create } from 'zustand'
import type { RelayStatus } from '@aitech/protocol'
import { RemoteHub, type RemoteEvent } from '../lib/remote'
import {
  loadChats,
  loadDesktops,
  loadIdentity,
  loadSettings,
  saveChats,
  saveDesktops,
  saveSettings,
  DEFAULT_SETTINGS,
  type LocalChat,
  type MobileSettings,
  type PairedDesktop,
} from '../lib/storage'
import type { RApproval, RChatEvent, RConversation, RMessage, RSync } from '../lib/types'

export interface DesktopState {
  online: boolean | null
  sync: RSync | null
  error: string | null
  /** Loaded conversation details. */
  conversations: Record<string, { conversation: RConversation; messages: RMessage[] }>
  approvals: Record<string, RApproval>
  running: Set<string>
}

const emptyDesktop = (): DesktopState => ({
  online: null,
  sync: null,
  error: null,
  conversations: {},
  approvals: {},
  running: new Set(),
})

interface AppState {
  ready: boolean
  hub: RemoteHub | null
  settings: MobileSettings
  desktops: PairedDesktop[]
  remote: Record<string, DesktopState>
  relayStatus: Record<string, RelayStatus>
  chats: LocalChat[]
  toast: { id: number; text: string; error: boolean } | null

  init: () => Promise<void>
  updateSettings: (patch: Partial<MobileSettings>) => Promise<void>
  addDesktop: (d: PairedDesktop) => Promise<void>
  removeDesktop: (id: string) => Promise<void>
  refresh: (desktopId: string) => Promise<void>
  loadConversation: (desktopId: string, conversationId: string) => Promise<void>
  saveChat: (chat: LocalChat) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  notify: (text: string, error?: boolean) => void
}

let toastSeq = 0

function patchDesktop(id: string, fn: (d: DesktopState) => DesktopState) {
  useApp.setState((s) => ({ remote: { ...s.remote, [id]: fn(s.remote[id] ?? emptyDesktop()) } }))
}

function applyChatEvent(desktopId: string, e: RChatEvent) {
  patchDesktop(desktopId, (d) => {
    const convs = { ...d.conversations }
    const withMessage = (cid: string, msg: RMessage) => {
      const c = convs[cid]
      if (!c) return
      const i = c.messages.findIndex((m) => m.id === msg.id)
      const messages =
        i === -1 ? [...c.messages, msg] : c.messages.map((m) => (m.id === msg.id ? msg : m))
      convs[cid] = {
        conversation: i === -1 ? { ...c.conversation, activeLeafId: msg.id } : c.conversation,
        messages,
      }
    }
    switch (e.type) {
      case 'message':
      case 'done':
        withMessage(e.conversationId, e.message)
        return { ...d, conversations: convs }
      case 'delta': {
        const c = convs[e.conversationId]
        if (!c) return d
        convs[e.conversationId] = {
          ...c,
          messages: c.messages.map((m) => {
            if (m.id !== e.messageId) return m
            const parts = [...m.parts]
            const add = (type: 'text' | 'reasoning', chunk?: string) => {
              if (!chunk) return
              const idx = parts.findIndex((p) => p.type === type)
              if (idx === -1) parts.push({ type, text: chunk })
              else parts[idx] = { type, text: (parts[idx] as { text: string }).text + chunk }
            }
            add('reasoning', e.reasoning)
            add('text', e.text)
            return { ...m, parts }
          }),
        }
        return { ...d, conversations: convs }
      }
      case 'conversation': {
        const c = convs[e.conversation.id]
        if (c) convs[e.conversation.id] = { ...c, conversation: e.conversation }
        const list = d.sync?.conversations ?? []
        const sync = d.sync && {
          ...d.sync,
          conversations: [e.conversation, ...list.filter((x) => x.id !== e.conversation.id)],
        }
        return { ...d, conversations: convs, sync }
      }
      case 'run': {
        const running = new Set(d.running)
        if (e.running) running.add(e.conversationId)
        else running.delete(e.conversationId)
        if (e.error) useApp.getState().notify(e.error, true)
        return { ...d, running }
      }
      case 'approval':
        return { ...d, approvals: { ...d.approvals, [e.approval.toolCallId]: e.approval } }
      case 'approval-resolved': {
        const approvals = { ...d.approvals }
        delete approvals[e.toolCallId]
        return { ...d, approvals }
      }
    }
  })
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  hub: null,
  settings: DEFAULT_SETTINGS,
  desktops: [],
  remote: {},
  relayStatus: {},
  chats: [],
  toast: null,

  init: async () => {
    const [identity, settings, desktops, chats] = await Promise.all([
      loadIdentity(),
      loadSettings(),
      loadDesktops(),
      loadChats(),
    ])
    const hub = new RemoteHub(
      identity,
      (info) => {
        const s = get().settings
        if (info?.auth === 'token') return { token: s.relayToken }
        if (info?.auth === 'upstream') return { baseUrl: s.baseUrl, apiKey: s.apiKey }
        return undefined
      },
      (e: RemoteEvent) => {
        if (e.name === 'chat') applyChatEvent(e.desktopId, e.data as RChatEvent)
        patchDesktop(e.desktopId, (d) => ({ ...d, online: true }))
      },
      () => set({ relayStatus: Object.fromEntries(hub.status) }),
      (desktopId) => {
        const d = get().desktops.find((x) => x.deviceId === desktopId)
        if (d) get().notify(`「${d.name}」已解除与本机的配对`, true)
        void get().removeDesktop(desktopId)
      },
    )
    set({ ready: true, hub, settings, desktops, chats })
    for (const url of new Set(desktops.map((d) => d.relayUrl))) void hub.connect(url)
  },

  updateSettings: async (patch) => {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    await saveSettings(next)
    if ('relayToken' in patch || 'apiKey' in patch || 'baseUrl' in patch) get().hub?.reconnectAll()
  },

  addDesktop: async (d) => {
    const desktops = [...get().desktops.filter((x) => x.deviceId !== d.deviceId), d]
    set({ desktops })
    await saveDesktops(desktops)
  },

  removeDesktop: async (id) => {
    const desktops = get().desktops.filter((x) => x.deviceId !== id)
    set((s) => {
      const remote = { ...s.remote }
      delete remote[id]
      return { desktops, remote }
    })
    await saveDesktops(desktops)
  },

  refresh: async (desktopId) => {
    const { hub, desktops } = get()
    const desktop = desktops.find((d) => d.deviceId === desktopId)
    if (!hub || !desktop) return
    try {
      const sync = await hub.rpc<RSync>(desktop, 'sync')
      patchDesktop(desktopId, (d) => ({
        ...d,
        online: true,
        error: null,
        sync,
        running: new Set(sync.running),
        approvals: Object.fromEntries(sync.approvals.map((a) => [a.toolCallId, a])),
      }))
    } catch (err) {
      patchDesktop(desktopId, (d) => ({ ...d, online: false, error: (err as Error).message }))
    }
  },

  loadConversation: async (desktopId, conversationId) => {
    const { hub, desktops } = get()
    const desktop = desktops.find((d) => d.deviceId === desktopId)
    if (!hub || !desktop) return
    const detail = await hub.rpc<{ conversation: RConversation; messages: RMessage[] }>(
      desktop,
      'conversation.get',
      {
        id: conversationId,
      },
    )
    patchDesktop(desktopId, (d) => ({
      ...d,
      conversations: { ...d.conversations, [conversationId]: detail },
    }))
  },

  saveChat: async (chat) => {
    const chats = [chat, ...get().chats.filter((c) => c.id !== chat.id)].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )
    set({ chats })
    await saveChats(chats)
  },

  deleteChat: async (id) => {
    const chats = get().chats.filter((c) => c.id !== id)
    set({ chats })
    await saveChats(chats)
  },

  notify: (text, error = false) => {
    const id = ++toastSeq
    set({ toast: { id, text, error } })
    setTimeout(() => get().toast?.id === id && set({ toast: null }), error ? 5000 : 2500)
  },
}))

/** Run and toast failures. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    useApp.getState().notify((err as Error).message, true)
    return undefined
  }
}
