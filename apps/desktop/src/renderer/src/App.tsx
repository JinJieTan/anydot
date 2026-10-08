import { useEffect, useState } from 'react'
import type { AgentPong, AppInfo } from '../../shared/ipc'

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [pong, setPong] = useState<AgentPong | null>(null)

  useEffect(() => {
    void window.api.appInfo().then(setInfo)
    void window.api.agentPing().then(setPong)
  }, [])

  return (
    <div className="flex h-screen">
      <aside className="w-60 shrink-0 border-r border-neutral-200 bg-neutral-50 p-4 pt-10 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="text-sm font-semibold">aitech</div>
        <div className="mt-1 text-xs text-neutral-500">会话列表（M1）</div>
      </aside>

      <main className="flex-1 overflow-auto p-8 pt-10">
        <h1 className="text-xl font-semibold">M0 · 工程骨架</h1>
        <p className="mt-1 text-sm text-neutral-500">
          主进程、预加载、渲染进程、Agent 进程和本地数据库的连通性检查。
        </p>

        <dl className="mt-6 grid max-w-xl grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
          <Row label="版本" value={info?.version} />
          <Row label="平台" value={info?.platform} />
          <Row label="Electron" value={info?.versions.electron} />
          <Row label="Node" value={info?.versions.node} />
          <Row label="数据库" value={info && `schema v${info.db.schemaVersion}`} />
          <Row label="数据目录" value={info?.db.path} mono />
          <Row
            label="Agent 进程"
            value={
              pong &&
              (pong.ok ? `运行中 · pid ${pong.pid} · ${pong.latencyMs}ms` : `异常：${pong.error}`)
            }
          />
        </dl>
      </main>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value?: string | null | false
  mono?: boolean
}) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className={mono ? 'font-mono text-xs break-all' : ''}>{value || '…'}</dd>
    </>
  )
}
