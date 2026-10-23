import { AppWindow, Monitor, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChromeExtStatus, ComputerPermissions, DisplayInfo } from '../../../shared/ipc'
import { api, invoke } from '../lib/api'
import { attempt, useApp } from '../store/app'
import { Badge, Button, Field, Select, Toggle } from './ui'

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

function ChromeExtensionPanel() {
  const [status, setStatus] = useState<ChromeExtStatus | null>(null)
  const [installed, setInstalled] = useState<{ dir: string; chromeOpened: boolean } | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  useEffect(() => {
    void invoke('chromeExt.status').then(setStatus)
    return api.on('chrome-ext', setStatus)
  }, [])

  const install = async () => {
    const r = await attempt(() => invoke('chromeExt.install'))
    if (r) setInstalled(r)
  }
  const exportZip = async () => {
    const r = await attempt(() => invoke('chromeExt.exportZip'))
    if (r) setExported(r.path)
  }

  const connected = !!status?.connected
  const outdated = connected && status.extensionVersion !== status.expectedVersion

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium">aitech 浏览器助手（Chrome 插件）</div>
        {connected ? (
          <Badge tone="accent">已连接 v{status.extensionVersion}</Badge>
        ) : (
          <Badge tone="warn">未连接</Badge>
        )}
      </div>
      {outdated && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          插件版本（{status.extensionVersion}）和 aitech 自带的版本（{status.expectedVersion}
          ）不一致，请在 chrome://extensions 里点一下插件的刷新按钮。
        </p>
      )}
      {status && !status.listening && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          aitech 没能在本机端口上等待插件连接，可能端口被占用了，可以尝试重启 aitech。
        </p>
      )}
      {!connected && (
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-fg-soft">
          <li>
            点击“安装到 Chrome”。aitech 会准备好插件文件夹并在
            {navigator.userAgent.includes('Mac') ? '访达' : '文件管理器'}
            里显示，同时打开 Chrome 的扩展程序页面（地址 chrome://extensions 已复制到剪贴板）。
          </li>
          <li>打开扩展程序页面右上角的“开发者模式”。</li>
          <li>
            点击“加载已解压的扩展程序”，选择 chrome-extension 文件夹，也可以直接把文件夹拖进页面。
          </li>
          <li>装好后插件会自动连接，这里会显示“已连接”。之后 aitech 更新时插件会自动跟着更新。</li>
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void install()}>
          {connected ? '重新安装' : '安装到 Chrome'}
        </Button>
        <Button size="sm" onClick={() => void exportZip()}>
          导出安装包（.zip）
        </Button>
      </div>
      {installed && (
        <div className="space-y-1 text-xs text-fg-faint">
          <div>
            插件文件夹：<span className="font-mono break-all select-text">{installed.dir}</span>
            （请不要移动或删除它）
          </div>
          {!installed.chromeOpened && (
            <div className="text-amber-700 dark:text-amber-400">
              没能自动打开 Chrome，请在 Chrome 地址栏里粘贴 chrome://extensions 并回车。
            </div>
          )}
        </div>
      )}
      {exported && (
        <div className="text-xs text-fg-faint">
          已导出到 <span className="font-mono break-all select-text">{exported}</span>
          。在其他电脑上先解压，再按上面第 2、3 步加载解压出来的文件夹。
        </div>
      )}
      <p className="text-xs leading-relaxed text-fg-faint">
        Agent 会使用你 Chrome 里已登录的账号，但只操作它自己打开的“aitech”标签组。操作期间 Chrome
        顶部会显示“正在调试此浏览器”的提示条。插件只和本机的 aitech 通信； 不用的时候可以在
        chrome://extensions 里关掉它。
      </p>
    </div>
  )
}

export function AutomationTab() {
  const { settings, updateSettings } = useApp()
  const [perms, setPerms] = useState<ComputerPermissions | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])

  useEffect(() => {
    if (!settings.computerUse) return
    void invoke('computer.displays').then(setDisplays, () => setDisplays([]))
  }, [settings.computerUse])

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
  const isWindows = navigator.userAgent.includes('Windows')

  return (
    <div className="max-w-2xl space-y-8 p-6">
      <section>
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-4 text-fg-soft" />
          <h2 className="text-base font-semibold">命令沙箱</h2>
          {isWindows && <Badge tone="warn">实验性</Badge>}
          {!isMac && !isWindows && <Badge>当前系统暂不支持</Badge>}
          <div className="ml-auto">
            <Toggle
              checked={isWindows ? settings.windowsSandbox : isMac && settings.sandbox}
              disabled={!isMac && !isWindows}
              label="在沙箱中运行 Agent 的命令"
              onChange={(on) =>
                void updateSettings(isWindows ? { windowsSandbox: on } : { sandbox: on })
              }
            />
          </div>
        </div>
        {isWindows ? (
          <p className="mt-2 text-sm leading-relaxed text-fg-soft">
            Agent 运行的命令只能写入项目目录、临时目录和包管理器缓存，也改不了项目的 git
            hooks；可以正常联网。Windows 版目前只限制写入，读取不受限制（比如 ~/.ssh
            仍然可读）。开启时会给这些目录添加一条只对沙箱生效的权限记录。
          </p>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-fg-soft">
            Agent 运行的命令只能写入项目目录、临时目录和包管理器缓存，读不到 ~/.ssh、~/.aws
            等凭据，也改不了项目的 git hooks；可以正常联网。“全自动”模式下建议保持开启。
          </p>
        )}
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          命令因沙箱限制失败时，Agent 可以申请在沙箱外重新运行，这一步无论哪种模式都需要你确认。
        </p>
      </section>

      <section>
        <div className="flex items-center gap-3">
          <AppWindow className="size-4 text-fg-soft" />
          <h2 className="text-base font-semibold">浏览器</h2>
          <div className="ml-auto">
            <Toggle
              checked={settings.browserTool}
              label="允许 Agent 操作网页"
              onChange={(browserTool) => void updateSettings({ browserTool })}
            />
          </div>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          项目对话中的 Agent
          可以打开网页、点击、填写表单和截图，适合操作动态网页、验证本地开发服务器。
        </p>
        <div className="mt-4">
          <Field label="在哪里操作网页">
            <Select
              value={settings.browserBackend}
              disabled={!settings.browserTool}
              onChange={(e) =>
                void updateSettings({ browserBackend: e.target.value as 'builtin' | 'chrome' })
              }
            >
              <option value="builtin">aitech 内置浏览器（登录状态独立，推荐）</option>
              <option value="chrome">我的 Chrome（需要安装插件，使用已登录的账号）</option>
            </Select>
          </Field>
        </div>
        {settings.browserBackend === 'chrome' ? (
          <ChromeExtensionPanel />
        ) : (
          <>
            <p className="mt-3 text-sm leading-relaxed text-fg-soft">
              内置浏览器是一个独立窗口，登录状态和你的 Chrome
              分开保存，需要登录的网站可以先打开窗口自己登录一次。
            </p>
            <div className="mt-3">
              <Button size="sm" onClick={() => void attempt(() => invoke('browser.show'))}>
                打开浏览器窗口
              </Button>
            </div>
          </>
        )}
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
          开启后，项目对话中的 Agent 可以截取屏幕，并控制真实的鼠标和键盘来操作其他应用。
          它一次看一块显示器，操作会和你抢鼠标；有多块显示器时，可以让它在副屏上工作。
        </p>
        <p className="mt-2 text-sm leading-relaxed text-fg-soft">
          除“全自动”模式外，Agent
          第一次截屏或操作前都会请求确认；选择“总是允许”后，本次会话内不再询问。
          从手机派发的任务始终需要确认。
        </p>
        {settings.computerUse && displays.length > 1 && (
          <div className="mt-4">
            <Field
              label="默认显示器"
              hint="Agent 默认在这块屏幕上工作（比如副屏），你可以继续用另一块；它也可以在任务中自己切换"
            >
              <Select
                value={settings.computerDisplay ?? ''}
                onChange={(e) => void updateSettings({ computerDisplay: e.target.value || null })}
              >
                <option value="">主显示器</option>
                {displays.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}（{d.bounds.width}×{d.bounds.height}
                    {d.main ? '，主显示器' : ''}）
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
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
