import { create } from 'zustand'
import type {
  ConversationDTO,
  ModelDTO,
  PairRequestDTO,
  ProjectDTO,
  ProviderDTO,
  RemoteStatusDTO,
  Settings,
} from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/ipc'
import { invoke } from '../lib/api'

export type View = 'chat' | 'images' | 'settings'
/** Which sidebar tab is showing: plain chats (plus image/video) or project-scoped coding tasks. */
export type Mode = 'chat' | 'code'

const MODE_KEY = 'sidebar-mode'
function initialMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'code' ? 'code' : 'chat'
  } catch {
    return 'chat'
  }
}

interface AppState {
  view: View
  mode: Mode
  activeId: string | null
  conversations: ConversationDTO[]
  search: string
  providers: ProviderDTO[]
  models: ModelDTO[]
  projects: ProjectDTO[]
  remote: RemoteStatusDTO | null
  pairRequests: PairRequestDTO[]
  settings: Settings
  running: Set<string>
  toast: { id: number; text: string; kind: 'info' | 'error' } | null

  setView: (view: View) => void
  setMode: (mode: Mode) => void
  open: (id: string | null) => void
  setSearch: (q: string) => void
  loadConversations: () => Promise<void>
  loadProviders: () => Promise<void>
  loadProjects: () => Promise<void>
  upsertProject: (p: ProjectDTO) => void
  loadModels: () => Promise<void>
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  upsertConversation: (c: ConversationDTO) => void
  removeConversation: (id: string) => void
  setRunning: (id: string, running: boolean) => void
  notify: (text: string, kind?: 'info' | 'error') => void
}

let toastSeq = 0

/** The conversation last opened in each sidebar tab, restored when switching back. */
const lastActive: Record<Mode, string | null> = { chat: null, code: null }

function rememberMode(mode: Mode) {
  useApp.setState({ mode })
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // Storage unavailable; the tab just won't be remembered.
  }
}

export const useApp = create<AppState>((set, get) => ({
  view: 'chat',
  mode: initialMode(),
  activeId: null,
  conversations: [],
  search: '',
  providers: [],
  models: [],
  projects: [],
  remote: null,
  pairRequests: [],
  settings: DEFAULT_SETTINGS,
  running: new Set(),
  toast: null,

  setView: (view) => {
    set({ view })
    if (view === 'images') rememberMode('chat')
  },
  setMode: (mode) => {
    if (mode === get().mode) return
    rememberMode(mode)
    // Each tab shows its own conversation: the last one opened there, else its newest.
    const { conversations, activeId } = get()
    const inMode = (c: ConversationDTO) => (mode === 'code') === !!c.projectId
    const current = conversations.find((c) => c.id === activeId)
    if (current && inMode(current)) return
    const last = conversations.find((c) => c.id === lastActive[mode])
    set({ activeId: (last ?? conversations.find(inMode))?.id ?? null })
  },
  open: (id) => {
    set({ activeId: id, view: 'chat' })
    const c = id ? get().conversations.find((x) => x.id === id) : undefined
    if (c) {
      const mode = c.projectId ? 'code' : 'chat'
      lastActive[mode] = c.id
      rememberMode(mode)
    }
  },
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
  loadProjects: async () => set({ projects: await invoke('projects.list') }),
  upsertProject: (p) => set((s) => ({ projects: [p, ...s.projects.filter((x) => x.id !== p.id)] })),
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
