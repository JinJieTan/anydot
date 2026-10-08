import { create } from 'zustand'
import type { ConversationDTO, ModelDTO, ProviderDTO, Settings } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/ipc'
import { invoke } from '../lib/api'

export type View = 'chat' | 'images' | 'settings'

interface AppState {
  view: View
  activeId: string | null
  conversations: ConversationDTO[]
  search: string
  providers: ProviderDTO[]
  models: ModelDTO[]
  settings: Settings
  running: Set<string>
  toast: { id: number; text: string; kind: 'info' | 'error' } | null

  setView: (view: View) => void
  open: (id: string | null) => void
  setSearch: (q: string) => void
  loadConversations: () => Promise<void>
  loadProviders: () => Promise<void>
  loadModels: () => Promise<void>
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  upsertConversation: (c: ConversationDTO) => void
  removeConversation: (id: string) => void
  setRunning: (id: string, running: boolean) => void
  notify: (text: string, kind?: 'info' | 'error') => void
}

let toastSeq = 0

export const useApp = create<AppState>((set, get) => ({
  view: 'chat',
  activeId: null,
  conversations: [],
  search: '',
  providers: [],
  models: [],
  settings: DEFAULT_SETTINGS,
  running: new Set(),
  toast: null,

  setView: (view) => set({ view }),
  open: (id) => set({ activeId: id, view: 'chat' }),
  setSearch: (search) => {
    set({ search })
    void get().loadConversations()
  },

  loadConversations: async () => {
    const q = get().search
    const list = await invoke('conversations.list', q ? { search: q } : undefined)
    // Ignore stale responses if the search changed meanwhile.
    if (get().search === q) set({ conversations: list })
  },
  loadProviders: async () => set({ providers: await invoke('providers.list') }),
  loadModels: async () => set({ models: await invoke('models.available') }),
  loadSettings: async () => set({ settings: await invoke('settings.get') }),
  updateSettings: async (patch) => set({ settings: await invoke('settings.set', patch) }),

  upsertConversation: (c) =>
    set((s) => {
      const rest = s.conversations.filter((x) => x.id !== c.id)
      return {
        conversations: [c, ...rest].sort(
          (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
        ),
      }
    }),
  removeConversation: (id) =>
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    })),
  setRunning: (id, running) =>
    set((s) => {
      const next = new Set(s.running)
      if (running) next.add(id)
      else next.delete(id)
      return { running: next }
    }),
  notify: (text, kind = 'info') => {
    const id = ++toastSeq
    set({ toast: { id, text, kind } })
    setTimeout(
      () => {
        if (get().toast?.id === id) set({ toast: null })
      },
      kind === 'error' ? 6000 : 3000,
    )
  },
}))

/** Run a call that returns nothing; true on success, failures shown as a toast. */
export async function succeeded(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    useApp.getState().notify((err as Error).message, 'error')
    return false
  }
}

/** Run an IPC call and surface failures as a toast. Resolves undefined on failure. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    useApp.getState().notify((err as Error).message, 'error')
    return undefined
  }
}
