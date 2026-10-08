import { MessageSquarePlus, Settings, Sparkles, Trash2 } from 'lucide-react'
import { newId } from '@aitech/core'
import { Button, Empty, Header } from '../components/ui'
import { go } from '../lib/router'
import { useApp } from '../store/app'

export function ChatsScreen() {
  const { chats, settings, saveChat, deleteChat } = useApp()
  const configured = !!settings.baseUrl && !!settings.apiKey

  const create = async () => {
    const chat = {
      id: newId(),
      title: '新对话',
      modelId: null,
      messages: [],
      updatedAt: Date.now(),
    }
    await saveChat(chat)
    go(`/chat/${chat.id}`)
  }

  return (
    <div>
      <Header
        title="对话"
        right={
          configured && (
            <button
              type="button"
              aria-label="新对话"
              onClick={() => void create()}
              className="flex size-10 items-center justify-center rounded-full active:bg-muted"
            >
              <MessageSquarePlus className="size-5" />
            </button>
          )
        }
      />
      {!configured ? (
        <Empty icon={<Settings className="size-7" />} title="填写服务商后即可在手机上直接对话">
          在设置里填入 Base URL 和 API Key。对话直接发到你的服务商，保存在这台手机上。
          <div className="mt-5">
            <Button variant="primary" onClick={() => go('/settings')}>
              去设置
            </Button>
          </div>
        </Empty>
      ) : chats.length === 0 ? (
        <Empty icon={<Sparkles className="size-7" />} title="开始一段对话">
          支持 GPT、Claude，也可以选择 gpt-image 生成图片。
          <div className="mt-5">
            <Button variant="primary" onClick={() => void create()}>
              新对话
            </Button>
          </div>
        </Empty>
      ) : (
        <div className="m-4 overflow-hidden rounded-2xl border border-line bg-surface">
          {chats.map((c) => (
            <div key={c.id} className="flex items-center border-b border-line last:border-b-0">
              <button
                type="button"
                onClick={() => go(`/chat/${c.id}`)}
                className="min-w-0 flex-1 px-4 py-3 text-left active:bg-muted"
              >
                <div className="truncate text-[15px]">{c.title}</div>
                <div className="mt-0.5 truncate text-xs text-fg-faint">
                  {c.modelId ?? '未选择模型'} · {new Date(c.updatedAt).toLocaleDateString('zh-CN')}
                </div>
              </button>
              <button
                type="button"
                aria-label="删除"
                onClick={() => confirm('删除这段对话？') && void deleteChat(c.id)}
                className="flex size-12 items-center justify-center text-fg-faint"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
