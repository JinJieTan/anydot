const $ = (id) => document.getElementById(id)

function render(s) {
  $('status').className = s.connected ? 'row on' : 'row'
  $('label').textContent = s.connected ? `已连接 AnyDot${s.app ? ' ' + s.app : ''}` : '未连接'
  $('hint').textContent = s.connected
    ? 'Agent 会在标为 “AnyDot” 的标签组里操作网页。'
    : `${s.error ?? '正在寻找 AnyDot 桌面端'}。请先打开 AnyDot，并在 设置 → 自动化 里选择 “我的 Chrome”。`
}

chrome.runtime.sendMessage({ type: 'status' }, render)
$('reconnect').onclick = () => {
  $('label').textContent = '连接中…'
  chrome.runtime.sendMessage({ type: 'reconnect' }, render)
}
