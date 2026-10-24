import { MessageSquareText } from 'lucide-react'
import { useState } from 'react'
import { invoke } from '../lib/api'
import { succeeded, useApp } from '../store/app'
import { Button, Field, IconButton, Input, Modal, Textarea } from './ui'

/** Sidebar footer button: send a note to the AnyDot team. */
export function FeedbackButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton label="反馈" onClick={() => setOpen(true)}>
        <MessageSquareText className="size-4" />
      </IconButton>
      <Modal open={open} onClose={() => setOpen(false)} title="反馈">
        {open && <FeedbackForm onClose={() => setOpen(false)} />}
      </Modal>
    </>
  )
}

function FeedbackForm({ onClose }: { onClose: () => void }) {
  const { notify } = useApp()
  const [message, setMessage] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <>
      <div className="space-y-4 p-5">
        <Field label="遇到了什么问题，或者希望有什么功能？">
          <Textarea
            autoFocus
            rows={6}
            maxLength={4000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="尽量写清楚怎么操作时出现的，方便我们复现。"
          />
        </Field>
        <Field
          label="联系方式（可选）"
          hint="邮箱或微信，需要追问时联系你。会一起发送应用版本和系统类型，不会发送对话内容。"
        >
          <Input value={contact} maxLength={200} onChange={(e) => setContact(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={!message.trim()}
          onClick={async () => {
            setBusy(true)
            const ok = await succeeded(() => invoke('feedback.send', { message, contact }))
            setBusy(false)
            if (!ok) return
            notify('已发送，谢谢你的反馈')
            onClose()
          }}
        >
          发送
        </Button>
      </div>
    </>
  )
}
