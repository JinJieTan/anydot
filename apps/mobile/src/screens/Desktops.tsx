import clsx from 'clsx'
import { ChevronRight, Monitor, QrCode } from 'lucide-react'
import { useEffect } from 'react'
import { Empty, Header } from '../components/ui'
import { go } from '../lib/router'
import { useApp } from '../store/app'

export function DesktopsScreen() {
  const { desktops, remote, refresh } = useApp()

  useEffect(() => {
    for (const d of desktops) void refresh(d.deviceId)
  }, [desktops, refresh])

  return (
    <div>
      <Header title="我的电脑" />
      {desktops.length === 0 ? (
        <Empty icon={<QrCode className="size-7" />} title="还没有配对电脑">
          在电脑上打开 AnyDot → 设置 → 手机连接 → 绑定手机，
          <br />
          然后用手机相机扫描二维码。
        </Empty>
      ) : (
        <div className="space-y-3 p-4">
          {desktops.map((d) => {
            const st = remote[d.deviceId]
            const approvals = Object.keys(st?.approvals ?? {}).length
            return (
              <button
                key={d.deviceId}
                type="button"
                onClick={() => go(`/d/${d.deviceId}`)}
                className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left active:bg-muted"
              >
                <div className="flex size-11 items-center justify-center rounded-xl bg-muted">
                  <Monitor className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{d.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-faint">
                    <span
                      className={clsx(
                        'size-1.5 rounded-full',
                        st?.online
                          ? 'bg-emerald-500'
                          : st?.online === false
                            ? 'bg-line-strong'
                            : 'bg-amber-400',
                      )}
                    />
                    {st?.online ? '在线' : st?.online === false ? (st.error ?? '离线') : '连接中…'}
                    {st?.running.size ? ` · ${st.running.size} 个任务进行中` : ''}
                  </div>
                </div>
                {approvals > 0 && (
                  <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-medium text-white">
                    {approvals} 待确认
                  </span>
                )}
                <ChevronRight className="size-5 text-fg-faint" />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
