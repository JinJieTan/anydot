import clsx from 'clsx'
import { useCallback, useEffect } from 'react'
import { PairRequestDialog, RemoteBanner } from './components/Remote'
import { Sidebar } from './components/Sidebar'
import { invoke, api } from './lib/api'
import { attempt, useApp } from './store/app'
import { useChat } from './store/chat'
import { ChatView } from './views/ChatView'
import { ImagesView } from './views/ImagesView'
import { SettingsView } from './views/SettingsView'

export function App() {
  const { view, loadConversations, loadModels, loadProviders, loadProjects, loadSettings, toast } =
    useApp()

  useEffect(() => {
    void loadSettings()
    void loadConversations()
    void loadProviders()
    void loadModels()
    void loadProjects()
    void useChat.getState().loadApprovals()
    void invoke('chat.running').then((ids) =>
      ids.forEach((id) => useApp.getState().setRunning(id, true)),
    )

    void invoke('remote.status').then((remote) => useApp.setState({ remote }))
    const offRemote = api.on('remote', (remote) => useApp.setState({ remote }))
    const offPair = api.on('remote-pair', (req) =>
      useApp.setState((s) => ({ pairRequests: [...s.pairRequests, req] })),
    )
    const offChat = api.on('chat', (e) => useChat.getState().apply(e))
    const offInvalidate = api.on('invalidate', ({ scope }) => {
      const app = useApp.getState()
      if (scope === 'providers' || scope === 'all') void app.loadProviders()
      if (scope === 'models' || scope === 'providers' || scope === 'all') void app.loadModels()
      if (scope === 'conversations' || scope === 'all') void app.loadConversations()
      if (scope === 'projects' || scope === 'all') void app.loadProjects()
    })
    return () => {
      offChat()
      offInvalidate()
      offRemote()
      offPair()
    }
  }, [loadConversations, loadModels, loadProviders, loadProjects, loadSettings])

  const newChat = useCallback(async (projectId?: string) => {
    const c = await attempt(() =>
      invoke('conversations.create', projectId ? { projectId } : undefined),
    )
    if (!c) return
    useChat.getState().setConversation(c)
    useChat.setState((s) => ({ messages: { ...s.messages, [c.id]: [] } }))
    useApp.getState().upsertConversation(c)
    useApp.getState().open(c.id)
  }, [])

  const newProject = useCallback(async () => {
    const p = await attempt(() => invoke('projects.create'))
    if (!p) return
    useApp.getState().upsertProject(p)
    await newChat(p.id)
  }, [newChat])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newChat()
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        useApp.getState().setView('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  return (
    <div className="flex h-full">
      <Sidebar
        onNewChat={() => void newChat()}
        onNewTask={(id) => void newChat(id)}
        onNewProject={() => void newProject()}
      />
      <main className="relative flex min-w-0 flex-1 flex-col bg-surface">
        <RemoteBanner />
        {view === 'chat' && <ChatView />}
        {view === 'images' && <ImagesView />}
        {view === 'settings' && <SettingsView />}
      </main>
      <PairRequestDialog />
      {toast && (
        <div
          role="status"
          className={clsx(
            'fixed bottom-5 left-1/2 z-50 max-w-[80vw] -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm shadow-lg',
            toast.kind === 'error' ? 'bg-red-600 text-white' : 'bg-fg text-surface',
          )}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
