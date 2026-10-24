import clsx from 'clsx'
import { MessageSquare, Monitor, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
import { parsePairing, type PairingPayload } from '@aitech/protocol'
import { Spinner } from './components/ui'
import { AddDesktopScreen } from './screens/AddDesktop'
import { go, useRoute } from './lib/router'
import { ChatsScreen } from './screens/Chats'
import { DesktopScreen } from './screens/Desktop'
import { DesktopsScreen } from './screens/Desktops'
import { LocalChatScreen } from './screens/LocalChat'
import { PairScreen } from './screens/Pair'
import { RemoteConversationScreen } from './screens/RemoteConversation'
import { SettingsScreen } from './screens/Settings'
import { useApp } from './store/app'

export function App() {
  const { ready, init, toast, refresh, desktops } = useApp()
  const route = useRoute()
  // A pairing link opened from the camera: #pair=…
  const [pairing, setPairing] = useState<PairingPayload | null>(() => parsePairing(location.hash))

  useEffect(() => {
    void init()
  }, [init])

  // Also catch pairing links opened while the app is already running.
  useEffect(() => {
    const on = () => {
      const p = parsePairing(location.hash)
      if (p) setPairing(p)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  useEffect(() => {
    // Drop the code from the URL so it isn't left in history.
    if (pairing) history.replaceState(null, '', location.pathname)
  }, [pairing])

  // Coming back to the app (e.g. from a notification): refresh state.
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === 'visible') for (const d of desktops) void refresh(d.deviceId)
    }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [desktops, refresh])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (pairing) return <PairScreen payload={pairing} onDone={() => setPairing(null)} />

  const [a, b, c, d] = route
  let screen: React.ReactNode
  let tab: 'desktops' | 'chats' | 'settings' | null = null
  if (a === 'd' && b && c === 'c' && d)
    screen = <RemoteConversationScreen desktopId={b} conversationId={d} />
  else if (a === 'd' && b) screen = <DesktopScreen desktopId={b} />
  else if (a === 'chat' && b) screen = <LocalChatScreen chatId={b} />
  else if (a === 'add') screen = <AddDesktopScreen />
  else if (a === 'chats') {
    screen = <ChatsScreen />
    tab = 'chats'
  } else if (a === 'settings') {
    screen = <SettingsScreen />
    tab = 'settings'
  } else {
    screen = <DesktopsScreen />
    tab = 'desktops'
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col">
      <main className={clsx('flex flex-1 flex-col', tab && 'pb-20')}>{screen}</main>
      {tab && (
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 backdrop-blur">
          <div className="mx-auto flex max-w-2xl">
            {(
              [
                ['desktops', '/', '电脑', Monitor],
                ['chats', '/chats', '对话', MessageSquare],
                ['settings', '/settings', '设置', Settings],
              ] as const
            ).map(([id, path, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => go(path, true)}
                className={clsx(
                  'flex flex-1 flex-col items-center gap-0.5 pt-2 text-[11px]',
                  tab === id ? 'text-accent' : 'text-fg-faint',
                )}
              >
                <Icon className="size-5.5" />
                {label}
              </button>
            ))}
          </div>
        </nav>
      )}
      {toast && (
        <div
          role="status"
          className={clsx(
            'fixed inset-x-4 bottom-24 z-50 mx-auto max-w-md rounded-xl px-4 py-3 text-center text-sm shadow-lg',
            toast.error ? 'bg-red-600 text-white' : 'bg-fg text-surface',
          )}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
