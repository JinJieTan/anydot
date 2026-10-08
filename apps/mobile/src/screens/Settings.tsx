import { Bell, CheckCircle2, Monitor, XCircle } from 'lucide-react'
import { useState } from 'react'
import { listModels, type ProviderType } from '@aitech/core'
import { fromB64url } from '@aitech/protocol'
import { Button, Field, Header, Input } from '../components/ui'
import { attempt, useApp } from '../store/app'

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)

export function SettingsScreen() {
  const { settings, updateSettings, desktops, removeDesktop, hub, notify } = useApp()
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [apiKey, setApiKey] = useState(settings.apiKey)
  const [type, setType] = useState<ProviderType>(settings.providerType)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [token, setToken] = useState(settings.relayToken)
  const [enabling, setEnabling] = useState(false)

  const relays = [...new Set(desktops.map((d) => d.relayUrl))]
  const needsToken = relays.some((r) => hub?.info.get(r)?.auth === 'token')

  const enablePush = async () => {
    if (!hub) return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      notify(
        isIOS() && !isStandalone()
          ? '请先“添加到主屏幕”，从主屏幕打开后再开启通知'
          : '这个浏览器不支持通知',
        true,
      )
      return
    }
    setEnabling(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') throw new Error('没有获得通知权限')
      const reg = await navigator.serviceWorker.ready
      for (const relay of relays) {
        const key = hub.info.get(relay)?.vapidPublicKey
        if (!key) continue
        const existing = await reg.pushManager.getSubscription()
        const sub =
          existing ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: fromB64url(key) as BufferSource,
          }))
        await hub.subscribePush(relay, sub.toJSON() as PushSubscriptionJSON)
      }
      await updateSettings({ notifications: true })
      notify('已开启通知')
    } catch (err) {
      notify((err as Error).message, true)
    } finally {
      setEnabling(false)
    }
  }

  return (
    <div className="pb-10">
      <Header title="设置" />
      <div className="space-y-8 p-4">
        <section className="space-y-4">
          <h2 className="px-1 text-[13px] font-medium text-fg-soft">在手机上直接对话（可选）</h2>
          <Field label="Base URL">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com"
              inputMode="url"
              autoCapitalize="off"
            />
          </Field>
          <Field label="API Key" hint="只保存在这台手机上">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
          </Field>
          <Field label="协议">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as ProviderType)}
              className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-[15px]"
            >
              <option value="auto">自动识别（推荐）</option>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic 兼容</option>
            </select>
          </Field>
          {test && (
            <div
              className={`flex items-center gap-2 text-sm ${test.ok ? 'text-emerald-600' : 'text-red-600'}`}
            >
              {test.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
              <span className="break-all">{test.text}</span>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              className="flex-1"
              loading={testing}
              disabled={!baseUrl || !apiKey}
              onClick={async () => {
                setTesting(true)
                try {
                  const models = await listModels(baseUrl, apiKey)
                  setTest({ ok: true, text: `连接成功，${models.length} 个模型` })
                } catch (err) {
                  setTest({ ok: false, text: (err as Error).message })
                }
                setTesting(false)
              }}
            >
              测试
            </Button>
            <Button
              variant="primary"
              className="flex-1"
              onClick={async () => {
                await updateSettings({
                  baseUrl: baseUrl.trim(),
                  apiKey: apiKey.trim(),
                  providerType: type,
                })
                notify('已保存')
              }}
            >
              保存
            </Button>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="px-1 text-[13px] font-medium text-fg-soft">已配对的电脑</h2>
          <div className="overflow-hidden rounded-2xl border border-line bg-surface">
            {desktops.map((d) => (
              <div
                key={d.deviceId}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <Monitor className="size-5 text-fg-faint" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{d.name}</div>
                  <div className="truncate text-xs text-fg-faint">{d.relayUrl}</div>
                </div>
                <button
                  type="button"
                  className="text-sm text-red-600"
                  onClick={() =>
                    confirm(`在这台手机上移除「${d.name}」？`) && void removeDesktop(d.deviceId)
                  }
                >
                  移除
                </button>
              </div>
            ))}
            {!desktops.length && (
              <div className="px-4 py-5 text-center text-sm text-fg-faint">暂无</div>
            )}
          </div>
          {needsToken && (
            <Field label="中继访问令牌" hint="你使用的中继需要令牌">
              <div className="flex gap-2">
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
                <Button onClick={() => void attempt(() => updateSettings({ relayToken: token }))}>
                  保存
                </Button>
              </div>
            </Field>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="px-1 text-[13px] font-medium text-fg-soft">通知</h2>
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-sm leading-relaxed text-fg-soft">
              电脑上的任务需要确认或完成时通知你。
              {isIOS() &&
                !isStandalone() &&
                ' iPhone 需要先在 Safari 中“分享 → 添加到主屏幕”，从主屏幕打开后才能开启。'}
            </p>
            <Button
              className="mt-3 w-full"
              variant={settings.notifications ? 'secondary' : 'primary'}
              loading={enabling}
              disabled={!desktops.length}
              onClick={() => void enablePush()}
            >
              <Bell className="size-4" />
              {settings.notifications ? '重新订阅通知' : '开启通知'}
            </Button>
          </div>
        </section>

        <section className="space-y-2 px-1 text-xs text-fg-faint">
          <div>本机名称：{settings.deviceName}</div>
          <div>本机 ID：{hub?.deviceId}</div>
        </section>
      </div>
    </div>
  )
}
