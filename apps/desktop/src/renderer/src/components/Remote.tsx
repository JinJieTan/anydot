import clsx from 'clsx'
import { Copy, Radar, ShieldCheck, Smartphone, Unplug } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { OFFICIAL_RELAY_URL, type RemoteStatusDTO, type Rpc } from '../../../shared/ipc'
import { invoke } from '../lib/api'
import { formatTime } from '../lib/format'
import { attempt, succeeded, useApp } from '../store/app'
import { Badge, Button, Field, Input, Modal, Select, Toggle } from './ui'

const STATE_LABEL: Record<
  RemoteStatusDTO['state'],
  { text: string; tone: 'neutral' | 'accent' | 'warn' }
> = {
  disabled: { text: '未启用', tone: 'neutral' },
  connecting: { text: '连接中…', tone: 'neutral' },
  online: { text: '已连接', tone: 'accent' },
  offline: { text: '已断开，正在重连', tone: 'warn' },
  unauthorized: { text: '未授权', tone: 'warn' },
  error: { text: '连接失败', tone: 'warn' },
}

export function RemoteTab() {
  const { remote, providers, notify } = useApp()
  const [relayUrl, setRelayUrl] = useState(remote?.relayUrl ?? '')
  const [token, setToken] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [showQr, setShowQr] = useState(false)

  if (!remote) return null
  const st = STATE_LABEL[remote.state]
  const configure = (input: Parameters<Rpc['remote.configure']>[0]) =>
    attempt(() => invoke('remote.configure', input))

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <section>
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold">手机连接</h2>
          <Badge tone={st.tone}>{st.text}</Badge>
          <div className="ml-auto">
            <Toggle
              checked={remote.enabled}
              label="启用手机连接"
              onChange={(enabled) => void configure({ enabled, relayUrl: relayUrl.trim() || null })}
            />
          </div>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          配对后，可以用手机给这台电脑派任务、查看进度、确认操作。通信经过中继服务转发，
          内容端到端加密，中继只能看到密文。只有在这台电脑上确认过的手机才能控制它。
        </p>
        {remote.detail && remote.state !== 'online' && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{remote.detail}</p>
        )}
      </section>

      <section className="space-y-4">
        <Field
          label="中继地址"
          hint={
            remote.relayUrl === OFFICIAL_RELAY_URL
              ? '默认使用 AnyDot 官方中继，不用改。也可以点“自动检测”找你的中转站上部署的中继，或填写自己部署的中继地址。'
              : '正在使用自定义中继。点“恢复默认”可以换回 AnyDot 官方中继。'
          }
        >
          <div className="flex gap-2">
            <Input
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder={OFFICIAL_RELAY_URL}
            />
            {remote.relayUrl !== OFFICIAL_RELAY_URL && (
              <Button
                onClick={async () => {
                  if (await configure({ relayUrl: null, enabled: true }))
                    setRelayUrl(OFFICIAL_RELAY_URL)
                }}
              >
                恢复默认
              </Button>
            )}
            <Button
              loading={detecting}
              onClick={async () => {
                setDetecting(true)
                const found = await attempt(() => invoke('remote.detect'))
                setDetecting(false)
                if (found) {
                  setRelayUrl(found.relayUrl)
                  notify(`找到中继：${found.relayUrl}`)
                } else if (found === null) notify('没有在已添加的服务商旁边找到中继', 'error')
              }}
            >
              <Radar className="size-4" />
              自动检测
            </Button>
            <Button
              variant="primary"
              disabled={!relayUrl.trim() || relayUrl.trim() === remote.relayUrl}
              onClick={() => void configure({ relayUrl: relayUrl.trim(), enabled: true })}
            >
              保存
            </Button>
          </div>
        </Field>

        {remote.authMode === 'token' && (
          <Field
            label="访问令牌"
            hint={remote.hasToken ? '已保存，留空表示不修改' : '该中继需要访问令牌'}
          >
            <div className="flex gap-2">
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="••••••"
              />
              <Button
                disabled={!token}
                onClick={async () => {
                  if (await configure({ token })) setToken('')
                }}
              >
                保存
              </Button>
            </div>
          </Field>
        )}
        {remote.authMode === 'upstream' && (
          <Field
            label="用于验证的服务商"
            hint="该中继只对指定中转站的用户开放，会用这个服务商的 Key 验证身份（中继不保存 Key）。"
          >
            <Select
              value={remote.providerId ?? ''}
              onChange={(e) => void configure({ providerId: e.target.value || null })}
            >
              <option value="">自动（与中继同域名的服务商）</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center">
          <h3 className="text-sm font-semibold">已配对的手机</h3>
          <Button
            className="ml-auto"
            variant="primary"
            disabled={remote.state !== 'online'}
            onClick={async () => {
              if (await attempt(() => invoke('remote.pair'))) setShowQr(true)
            }}
          >
            <Smartphone className="size-4" />
            绑定手机
          </Button>
        </div>
        <div className="overflow-hidden rounded-xl border border-line">
          {remote.devices.map((d) => (
            <div
              key={d.deviceId}
              className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
            >
              <span
                className={clsx(
                  'size-2 rounded-full',
                  d.online ? 'bg-emerald-500' : 'bg-line-strong',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm">{d.name}</div>
                <div className="text-xs text-fg-faint">
                  {d.platform && `${d.platform} · `}配对于 {formatTime(d.pairedAt)}
                  {d.lastSeen && ` · 最近活动 ${formatTime(d.lastSeen)}`}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-red-600 dark:text-red-400"
                onClick={async () => {
                  if (window.confirm(`解除与「${d.name}」的配对？它将无法再控制这台电脑。`)) {
                    await succeeded(() => invoke('remote.revoke', d.deviceId))
                  }
                }}
              >
                解除配对
              </Button>
            </div>
          ))}
          {!remote.devices.length && (
            <div className="px-4 py-6 text-center text-sm text-fg-faint">还没有配对的手机</div>
          )}
        </div>
        <p className="mt-2 text-xs text-fg-faint">本机设备 ID：{remote.deviceId}</p>
      </section>

      <PairModal
        open={showQr && !!remote.pairing}
        onClose={() => {
          setShowQr(false)
          void invoke('remote.pairCancel')
        }}
        pairing={remote.pairing}
      />
    </div>
  )
}

function PairModal({
  open,
  onClose,
  pairing,
}: {
  open: boolean
  onClose: () => void
  pairing: RemoteStatusDTO['pairing']
}) {
  const [qr, setQr] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const { notify } = useApp()

  useEffect(() => {
    if (!pairing) return
    void QRCode.toDataURL(pairing.link, { margin: 1, width: 280, errorCorrectionLevel: 'M' }).then(
      setQr,
    )
  }, [pairing])

  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0

  return (
    <Modal open={open} onClose={onClose} title="绑定手机">
      {pairing && (
        <div className="flex flex-col items-center p-6 text-center">
          {qr && left > 0 ? (
            <img
              src={qr}
              alt="配对二维码"
              className="size-64 rounded-xl border border-line bg-white p-2"
            />
          ) : (
            <div className="flex size-64 items-center justify-center rounded-xl border border-line text-sm text-fg-faint">
              二维码已过期
            </div>
          )}
          <p className="mt-4 text-sm text-fg-soft">用手机相机扫描二维码，在打开的网页中完成配对</p>
          <p className="mt-1 font-mono text-lg tracking-widest">{pairing.code}</p>
          <p className="mt-1 text-xs text-fg-faint">
            {left > 0 ? `${left} 秒后过期` : '请关闭后重新生成'}
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="mt-3"
            onClick={() =>
              void navigator.clipboard.writeText(pairing.link).then(() => notify('配对链接已复制'))
            }
          >
            <Copy className="size-3.5" />
            复制配对链接
          </Button>
          <p className="mt-4 flex items-start gap-1.5 text-left text-xs text-fg-faint">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            手机发起配对后，这台电脑会再次弹窗请你确认。配对码只能使用一次。
          </p>
        </div>
      )}
    </Modal>
  )
}

/** Confirm incoming pairing requests, wherever the user is in the app. */
export function PairRequestDialog() {
  const { pairRequests } = useApp()
  const req = pairRequests[0]
  const respond = async (accept: boolean) => {
    if (!req) return
    useApp.setState((s) => ({
      pairRequests: s.pairRequests.filter((r) => r.requestId !== req.requestId),
    }))
    await attempt(() => invoke('remote.pairRespond', { requestId: req.requestId, accept }))
  }
  return (
    <Modal open={!!req} onClose={() => void respond(false)} title="新设备请求配对">
      {req && (
        <div className="p-6">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-xl bg-accent/12 text-accent">
              <Smartphone className="size-5" />
            </div>
            <div>
              <div className="font-medium">{req.name}</div>
              <div className="text-xs text-fg-faint">{req.platform}</div>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-fg-soft">
            允许后，这台设备可以查看你的对话和项目、给这台电脑派任务，并确认 AI 的操作。
            如果这不是你刚刚扫码的手机，请拒绝。
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => void respond(false)}>
              拒绝
            </Button>
            <Button variant="primary" onClick={() => void respond(true)}>
              允许
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Always-visible notice while a phone is actively controlling this desktop. */
export function RemoteBanner() {
  const { remote } = useApp()
  if (!remote?.activeDevices.length) return null
  const names = remote.devices
    .filter((d) => remote.activeDevices.includes(d.deviceId))
    .map((d) => d.name)
    .join('、')
  return (
    <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-800 dark:text-amber-300">
      <Smartphone className="size-3.5" />
      <span className="flex-1">{names || '手机'} 正在远程操作这台电脑</span>
      <button
        type="button"
        className="flex items-center gap-1 rounded px-2 py-0.5 font-medium hover:bg-amber-500/15"
        onClick={() => void attempt(() => invoke('remote.configure', { enabled: false }))}
      >
        <Unplug className="size-3.5" />
        断开所有手机
      </button>
    </div>
  )
}
