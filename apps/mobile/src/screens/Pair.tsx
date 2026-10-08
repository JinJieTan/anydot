import { CheckCircle2, Monitor, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { PairingPayload } from '@aitech/protocol'
import { Button, Field, Input, Spinner } from '../components/ui'
import { go } from '../lib/router'
import { useApp } from '../store/app'

export function PairScreen({ payload, onDone }: { payload: PairingPayload; onDone: () => void }) {
  const { hub, settings, updateSettings, addDesktop, desktops } = useApp()
  const [name, setName] = useState(settings.deviceName)
  const [state, setState] = useState<'idle' | 'waiting' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const already = desktops.some((d) => d.deviceId === payload.d)
  const expired = payload.e < Date.now()

  const start = async () => {
    if (!hub) return
    setState('waiting')
    setError('')
    try {
      await updateSettings({ deviceName: name.trim() || settings.deviceName })
      const desktop = await hub.pair(
        payload,
        name.trim() || settings.deviceName,
        navigator.platform || 'web',
      )
      await addDesktop(desktop)
      setState('done')
      setTimeout(() => {
        onDone()
        go(`/d/${desktop.deviceId}`, true)
      }, 800)
    } catch (err) {
      setError((err as Error).message)
      setState('error')
    }
  }

  return (
    <div className="safe-top flex min-h-full flex-col px-6 pt-12 pb-10">
      <div className="flex flex-col items-center text-center">
        <div className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Monitor className="size-8" />
        </div>
        <h1 className="text-xl font-semibold">连接到「{payload.n}」</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          配对后，可以用这台手机查看电脑上的对话、派发任务，并确认 AI 的操作。
        </p>
        <p className="mt-3 font-mono text-sm tracking-widest text-fg-faint">{payload.c}</p>
      </div>

      <div className="mt-8 space-y-4">
        <Field label="这台手机的名称" hint="会显示在电脑上，方便你确认">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={state === 'waiting'}
          />
        </Field>
      </div>

      <div className="mt-auto pt-8">
        {state === 'waiting' && (
          <div className="mb-4 flex items-center justify-center gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
            <Spinner className="text-current" />
            请在电脑上点击「允许」
          </div>
        )}
        {state === 'done' && (
          <div className="mb-4 flex items-center justify-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="size-5" />
            配对成功
          </div>
        )}
        {state === 'error' && (
          <div className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        {already && state === 'idle' && (
          <p className="mb-3 text-center text-xs text-fg-faint">
            已经配对过这台电脑，可以重新配对。
          </p>
        )}
        <Button
          variant="primary"
          className="w-full"
          disabled={expired || state === 'waiting' || state === 'done'}
          onClick={() => void start()}
        >
          {expired ? '二维码已过期，请在电脑上重新生成' : state === 'error' ? '重试' : '发起配对'}
        </Button>
        <Button variant="ghost" className="mt-2 w-full" onClick={onDone}>
          取消
        </Button>
        <p className="mt-4 flex items-start gap-1.5 text-xs leading-relaxed text-fg-faint">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          通信端到端加密。中继服务器只转发密文，看不到你的对话和指令。
        </p>
      </div>
    </div>
  )
}
