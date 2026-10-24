import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { normalizePairingCode, pairingLink } from '@aitech/protocol'
import { Button, Header } from '../components/ui'
import { servingRelayUrl } from '../lib/storage'
import { useApp } from '../store/app'

/** Pair by typing the code shown on the desktop, for when scanning isn't handy. */
export function AddDesktopScreen() {
  const { hub } = useApp()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const raw = normalizePairingCode(code)

  const find = async () => {
    if (!hub) return
    setBusy(true)
    setError('')
    try {
      const payload = await hub.lookup(servingRelayUrl(), formatCode(raw))
      // Hand over to the same confirm screen a scanned QR opens.
      location.hash = new URL(pairingLink(location.href, payload)).hash
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Header title="添加电脑" backTo="/" />
      <div className="px-6 pt-10">
        <div className="flex flex-col items-center text-center">
          <div className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-accent/12 text-accent">
            <KeyRound className="size-8" />
          </div>
          <p className="text-sm leading-relaxed text-fg-soft">
            在电脑上打开 AnyDot → 设置 → 手机连接 → 绑定手机，
            <br />
            输入二维码下方的配对码。
          </p>
        </div>
        <form
          className="mt-8"
          onSubmit={(e) => {
            e.preventDefault()
            if (raw.length === 8 && !busy) void find()
          }}
        >
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(formatCode(normalizePairingCode(e.target.value).slice(0, 8)))}
            placeholder="XXXX-XXXX"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            className="h-14 w-full rounded-xl border border-line bg-surface text-center font-mono text-2xl tracking-[0.25em] outline-none placeholder:text-fg-faint/60 focus:border-accent"
          />
          {error && (
            <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
          <Button
            type="submit"
            variant="primary"
            className="mt-6 w-full"
            loading={busy}
            disabled={raw.length !== 8}
          >
            下一步
          </Button>
        </form>
      </div>
    </div>
  )
}

const formatCode = (raw: string) => (raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw)
