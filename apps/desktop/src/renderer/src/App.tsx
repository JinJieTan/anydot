import clsx from 'clsx'
import { useCallback, useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { invoke, api } from './lib/api'
import { attempt, useApp } from './store/app'
import { useChat } from './store/chat'
import { ChatView } from './views/ChatView'
import { ImagesView } from './views/ImagesView'
import { SettingsView } from './views/SettingsView'

export function App() {
  const { view, loadConversations, loadModels, loadProviders, loadSettings, toast } = useApp()

  useEffect(() => {
    void loadSettings()
    void loadConversations()
    void loadProviders()
    void loadModels()
    void invoke('chat.running').then((ids) =>
      ids.forEach((id) => useApp.getState().setRunning(id, true)),
    )

    const offChat = api.on('chat', (e) => useChat.getState().apply(e))
    const offInvalidate = api.on('invalidate', ({ scope }) => {
      const app = useApp.getState()
      if (scope === 'providers' || scope === 'all') void app.loadProviders()
      if (scope === 'models' || scope === 'providers' || scope === 'all') void app.loadModels()
      if (scope === 'conversations' || scope === 'all') void app.loadConversations()
    })
    return () => {
      offChat()
      offInvalidate()
    }
  }, [loadConversations, loadModels, loadProviders, loadSettings])

  const newChat = useCallback(async () => {
    const c = await attempt(() => invoke('conversations.create'))
    if (!c) return
    useChat.getState().setConversation(c)
    useApp.getState().open(c.id)
  }, [])

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
      <Sidebar onNewChat={() => void newChat()} />
      <main className="relative flex min-w-0 flex-1 flex-col bg-surface">
        {view === 'chat' && <ChatView />}
        {view === 'images' && <ImagesView />}
        {view === 'settings' && <SettingsView />}
      </main>
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
