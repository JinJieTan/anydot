import { AppWindow, Monitor, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ComputerPermissions } from '../../../shared/ipc'
import { invoke } from '../lib/api'
import { attempt, useApp } from '../store/app'
import { Badge, Button, Toggle } from './ui'

function PermissionRow({
  label,
  hint,
  granted,
  onRequest,
}: {
  label: string
  hint: string
  granted: boolean
  onRequest: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-fg-faint">{hint}</div>
      </div>
      {granted ? (
        <Badge tone="accent">已授权</Badge>
      ) : (
        <>
          <Badge tone="warn">未授权</Badge>
          <Button size="sm" onClick={onRequest}>
            去授权
          </Button>
        </>
      )}
    </div>
  )
}

export function AutomationTab() {
  const { settings, updateSettings } = useApp()
  const [perms, setPerms] = useState<ComputerPermissions | null>(null)

  useEffect(() => {
    const refresh = () => void invoke('computer.permissions').then(setPerms)
    refresh()
    // Permissions are granted in System Settings; re-check when the user comes back.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const request = async (kind: 'accessibility' | 'screen') => {
    const next = await attempt(() => invoke('computer.requestPermission', kind))
    if (next) setPerms(next)
  }

  const isMac = navigator.userAgent.includes('Mac')

  return (
    <div className="max-w-2xl space-y-8 p-6">
      <section>
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-4 text-fg-soft" />
          <h2 className="text-base font-semibold">命令沙箱</h2>
          {!isMac && <Badge>当前系统暂不支持</Badge>}
          <div className="ml-auto">
            <Toggle
              checked={isMac && settings.sandbox}
              disabled={!isMac}
              label="在沙箱中运行 Agent 的命令"
              onChange={(sandbox) => void updateSettings({ sandbox })}
            />
          </div>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          Agent 运行的命令只能写入项目目录、临时目录和包管理器缓存，读不到 ~/.ssh、~/.aws
          等凭据，也改不了项目的 git hooks；可以正常联网。“全自动”模式下建议保持开启。
        </p>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          命令因沙箱限制失败时，Agent 可以申请在沙箱外重新运行，这一步无论哪种模式都需要你确认。
        </p>
      </section>

      <section>
        <div className="flex items-center gap-3">
          <AppWindow className="size-4 text-fg-soft" />
          <h2 className="text-base font-semibold">内置浏览器</h2>
          <div className="ml-auto">
            <Toggle
              checked={settings.browserTool}
              label="允许 Agent 使用内置浏览器"
              onChange={(browserTool) => void updateSettings({ browserTool })}
            />
          </div>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          项目对话中的 Agent 可以在一个独立的浏览器窗口里打开网页、点击、填写表单和截图，
          适合操作动态网页、验证本地开发服务器。这个窗口的登录状态和你的 Chrome 分开保存，
          需要登录的网站可以先打开窗口自己登录一次。
        </p>
        <div className="mt-3">
          <Button size="sm" onClick={() => void attempt(() => invoke('browser.show'))}>
            打开浏览器窗口
          </Button>
        </div>
      </section>

      <section>
        <div className="flex items-center gap-3">
          <Monitor className="size-4 text-fg-soft" />
          <h2 className="text-base font-semibold">电脑操作</h2>
          {perms && !perms.supported && <Badge>当前系统不支持</Badge>}
          <div className="ml-auto">
            <Toggle
              checked={settings.computerUse}
              disabled={!perms?.supported}
              label="允许 Agent 操作电脑"
              onChange={(computerUse) => void updateSettings({ computerUse })}
            />
          </div>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          开启后，项目对话中的 Agent 可以截取主屏幕，并控制真实的鼠标和键盘来操作其他应用。
          它看到的是你的整个屏幕，操作也会和你抢鼠标，建议在它工作时不要同时使用电脑。
        </p>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          除“全自动”模式外，Agent
          第一次截屏或操作前都会请求确认；选择“总是允许”后，本次会话内不再询问。
          从手机派发的任务始终需要确认。
        </p>
        {isMac && perms?.supported && (
          <div className="mt-4 space-y-2">
            <PermissionRow
              label="辅助功能"
              hint="控制鼠标和键盘"
              granted={perms.accessibility}
              onRequest={() => void request('accessibility')}
            />
            <PermissionRow
              label="录屏与系统录音"
              hint="截取屏幕；授权后可能需要重启 aitech"
              granted={perms.screen === 'granted'}
              onRequest={() => void request('screen')}
            />
          </div>
        )}
      </section>
    </div>
  )
}
