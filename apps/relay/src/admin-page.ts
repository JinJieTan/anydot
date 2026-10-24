/** The relay admin page: one self-contained HTML file, no build step. */
export const ADMIN_PAGE = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>AnyDot 中继管理</title>
<style>
  :root { --bg:#f7f4ee; --card:#fffdf9; --fg:#2a2620; --soft:#6b645a; --line:#e6dfd3; --accent:#c2562f; --warn:#a15c00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1b1916; --card:#24211d; --fg:#ece6dc; --soft:#a39b8f; --line:#3a352e; --accent:#e07a50; --warn:#e0a24a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
  main { max-width:720px; margin:0 auto; padding:32px 16px 64px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0 0 12px; }
  .soft { color:var(--soft); }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-top:20px; }
  button, input, textarea { font:inherit; }
  input, textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
  textarea { min-height:84px; font-family:ui-monospace, Menlo, monospace; font-size:13px; }
  label.field { display:block; margin-bottom:10px; }
  label.field > span { display:block; margin-bottom:4px; color:var(--soft); }
  button { padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; white-space:nowrap; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:#c0392b; }
  .row { display:flex; gap:8px; align-items:center; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:520px) { .grid2 { grid-template-columns:1fr; } }
  .modes { display:grid; gap:10px; }
  .mode { display:flex; gap:12px; align-items:flex-start; padding:12px; border:1px solid var(--line); border-radius:10px; cursor:pointer; }
  .mode.on { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
  .mode input { width:auto; margin-top:4px; }
  .mode b { display:block; }
  .tokens > div { display:flex; gap:12px; align-items:center; padding:10px 0; border-top:1px solid var(--line); }
  .tokens > div:first-child { border-top:0; }
  .grow { flex:1; min-width:0; }
  code { font-family:ui-monospace, Menlo, monospace; font-size:13px; }
  .secret { margin-top:12px; padding:12px; border-radius:10px; border:1px dashed var(--accent); word-break:break-all; }
  .msg { margin-top:12px; color:var(--warn); }
  .stat { font-size:24px; font-weight:600; }
  .stats { display:flex; gap:32px; }
  .hidden { display:none; }
</style>
</head>
<body>
<main>
  <h1>AnyDot 中继管理</h1>
  <p class="soft">管理谁可以连接这个中继。内容是端到端加密的，中继看不到对话；手机能否控制某台电脑，仍需要在那台电脑上确认配对。</p>

  <section id="setup" class="hidden">
    <h2>创建管理员账号</h2>
    <p class="soft" style="margin-top:0">第一次使用，请设置管理员账号。设置码在中继的启动日志里（<code>docker logs anydot-relay</code>），用来确认你是服务器的主人。</p>
    <form id="setupForm">
      <label class="field"><span>设置码</span><input name="code" autocomplete="off" required></label>
      <label class="field"><span>用户名</span><input name="username" autocomplete="username" required></label>
      <label class="field"><span>密码（至少 8 位）</span><input name="password" type="password" autocomplete="new-password" required></label>
      <label class="field"><span>确认密码</span><input name="confirm" type="password" autocomplete="new-password" required></label>
      <button class="primary">创建并登录</button>
    </form>
  </section>

  <section id="login" class="hidden">
    <h2>登录</h2>
    <form id="loginForm">
      <label class="field"><span>用户名</span><input name="username" autocomplete="username" required></label>
      <label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary">登录</button>
    </form>
  </section>
  <div id="authMsg" class="msg"></div>

  <div id="app" class="hidden">
    <section>
      <div class="row"><h2 style="margin:0">在线设备</h2><span class="grow"></span><span class="soft" id="who"></span><button id="refresh">刷新</button><button id="logout">退出</button></div>
      <div class="stats" style="margin-top:12px">
        <div><div class="stat" id="desktops">0</div><div class="soft">电脑</div></div>
        <div><div class="stat" id="mobiles">0</div><div class="soft">手机</div></div>
      </div>
    </section>

    <section>
      <h2>准入模式</h2>
      <div class="modes" id="modes"></div>
      <p class="soft" style="margin-bottom:0">切换后立即生效，不再符合条件的连接会被断开。</p>
    </section>

    <section>
      <h2>访问令牌</h2>
      <p class="soft" style="margin-top:0">“仅限令牌”模式下，设备需要在 设置 → 手机连接（电脑）或 设置（手机）里填写其中一个令牌。建议每人一个，泄露了就单独吊销。</p>
      <form id="createForm" class="row">
        <input name="name" placeholder="令牌名称，比如：我的 MacBook、小王" maxlength="60">
        <button class="primary">新建令牌</button>
      </form>
      <div id="secret" class="secret hidden">
        <div>新令牌（只显示这一次，请马上复制）：</div>
        <code id="secretValue"></code>
        <div class="row" style="margin-top:8px"><button id="copy" type="button">复制</button><button id="hideSecret" type="button">我已保存</button></div>
      </div>
      <div class="tokens" id="tokens" style="margin-top:12px"></div>
    </section>

    <section>
      <h2>允许的服务商</h2>
      <p class="soft" style="margin-top:0">“仅限服务商用户”模式下，设备用这些服务商的有效 API Key 验证身份（中继会请求一次 <code>/v1/models</code>，不保存 Key）。每行一个 Base URL。</p>
      <form id="upstreamForm">
        <textarea name="upstreams" placeholder="https://api.example.com"></textarea>
        <div class="row" style="margin-top:8px"><button class="primary">保存</button></div>
      </form>
    </section>

    <section>
      <h2>限流</h2>
      <form id="limitsForm">
        <div class="grid2">
          <label class="field"><span>每个 IP 最多连接数</span><input name="maxConnectionsPerIp" type="number" min="1" max="10000" required></label>
          <label class="field"><span>每个连接每秒最多消息数</span><input name="messageRate" type="number" min="1" max="10000" required></label>
        </div>
        <button class="primary">保存</button>
      </form>
    </section>

    <section>
      <h2>管理员账号</h2>
      <form id="accountForm">
        <div class="grid2">
          <label class="field"><span>用户名</span><input name="username" autocomplete="username"></label>
          <label class="field"><span>当前密码</span><input name="current" type="password" autocomplete="current-password" required></label>
          <label class="field"><span>新密码（至少 8 位）</span><input name="password" type="password" autocomplete="new-password" required></label>
          <label class="field"><span>确认新密码</span><input name="confirm" type="password" autocomplete="new-password" required></label>
        </div>
        <button class="primary">修改</button>
        <span class="soft">修改后其它已登录的地方会退出。</span>
      </form>
    </section>
    <div id="msg" class="msg"></div>
  </div>
</main>
<script>
(function () {
  var api = location.pathname.replace(/\\/admin\\/?$/, '') + '/admin/api'
  var sid = sessionStorage.getItem('adminSession') || ''
  var MODES = {
    open: ['所有人都可以连接', '任何设备都能连上中继（有限流）。手机仍要在电脑上确认配对才能控制它。'],
    token: ['仅限令牌', '只有持有下方访问令牌的设备才能连接。'],
    upstream: ['仅限服务商用户', '只有持有下方服务商有效 API Key 的设备才能连接。'],
  }
  var $ = function (id) { return document.getElementById(id) }
  var fmt = function (t) { return t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '从未使用' }
  var el = function (tag, props, kids) {
    var e = document.createElement(tag)
    for (var k in props || {}) e[k] = props[k]
    ;(kids || []).forEach(function (c) { e.append(c) })
    return e
  }
  var fields = function (form) {
    var o = {}
    new FormData(form).forEach(function (v, k) { o[k] = v })
    return o
  }

  function call(method, path, body) {
    return fetch(api + path, {
      method: method,
      headers: { Authorization: 'Bearer ' + sid, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 401 && sid) { show('login', j.error); throw new Error(j.error) }
        if (!r.ok) throw new Error(j.error || r.statusText)
        return j
      })
    })
  }
  function fail(e) { $('msg').textContent = e.message }
  function ok(text) { $('msg').textContent = text || '' }

  function show(view, message) {
    if (view !== 'app') { sid = ''; sessionStorage.removeItem('adminSession') }
    ;['setup', 'login', 'app'].forEach(function (v) { $(v).classList.toggle('hidden', v !== view) })
    $('authMsg').textContent = message || ''
  }
  function enter(r) {
    sid = r.session
    sessionStorage.setItem('adminSession', sid)
    show('app')
    render(r.state)
  }

  function render(s) {
    $('who').textContent = s.username
    $('desktops').textContent = s.online.desktops
    $('mobiles').textContent = s.online.mobiles
    $('modes').replaceChildren.apply($('modes'), Object.keys(MODES).map(function (m) {
      var radio = el('input', { type: 'radio', name: 'mode', checked: s.mode === m })
      radio.onchange = function () {
        if (m !== 'open' && !confirm('切换后，不符合条件的设备会立即断开，确定吗？')) return render(s)
        call('PUT', '/mode', { mode: m }).then(function (n) { ok(); render(n) }).catch(function (e) { fail(e); render(s) })
      }
      return el('label', { className: 'mode' + (s.mode === m ? ' on' : '') }, [
        radio, el('div', {}, [el('b', { textContent: MODES[m][0] }), el('span', { className: 'soft', textContent: MODES[m][1] })]),
      ])
    }))
    var rows = s.tokens.map(function (t) {
      var del = el('button', { className: 'danger', textContent: '吊销' })
      del.onclick = function () {
        if (!confirm('吊销「' + t.name + '」？使用它的设备会立即断开。')) return
        call('DELETE', '/tokens/' + encodeURIComponent(t.id)).then(render).catch(fail)
      }
      return el('div', {}, [
        el('div', { className: 'grow' }, [
          el('div', { textContent: t.name }),
          el('div', { className: 'soft' }, [el('code', { textContent: t.prefix + '…' }),
            ' · 创建于 ' + fmt(t.createdAt) + ' · 最近使用 ' + fmt(t.lastUsedAt) + ' · 在线连接 ' + t.connections]),
        ]),
        del,
      ])
    })
    if (s.hasEnvToken) rows.unshift(el('div', {}, [el('div', { className: 'grow' }, [
      el('div', { textContent: '服务器默认令牌' }),
      el('div', { className: 'soft', textContent: '来自环境变量 AUTH_TOKEN，只能在服务器上修改' }),
    ])]))
    if (!rows.length) rows.push(el('div', { className: 'soft', textContent: '还没有访问令牌' }))
    $('tokens').replaceChildren.apply($('tokens'), rows)
    $('upstreamForm').upstreams.value = s.upstreams.join('\\n')
    $('limitsForm').maxConnectionsPerIp.value = s.limits.maxConnectionsPerIp
    $('limitsForm').messageRate.value = s.limits.messageRate
    $('accountForm').username.value = s.username
  }

  function load() { return call('GET', '/state').then(function (s) { show('app'); render(s) }) }

  $('setupForm').onsubmit = function (e) {
    e.preventDefault()
    var f = fields(e.target)
    if (f.password !== f.confirm) return show('setup', '两次输入的密码不一致')
    call('POST', '/setup', f).then(function (r) { e.target.reset(); enter(r) })
      .catch(function (err) { $('authMsg').textContent = err.message })
  }
  $('loginForm').onsubmit = function (e) {
    e.preventDefault()
    call('POST', '/login', fields(e.target)).then(function (r) { e.target.reset(); enter(r) })
      .catch(function (err) { $('authMsg').textContent = err.message })
  }
  $('createForm').onsubmit = function (e) {
    e.preventDefault()
    call('POST', '/tokens', fields(e.target)).then(function (r) {
      e.target.reset()
      $('secretValue').textContent = r.token
      $('secret').classList.remove('hidden')
      ok()
      render(r.state)
    }).catch(fail)
  }
  $('upstreamForm').onsubmit = function (e) {
    e.preventDefault()
    call('PUT', '/upstreams', { upstreams: e.target.upstreams.value.split(/\\s+/) })
      .then(function (s) { ok('已保存'); render(s) }).catch(fail)
  }
  $('limitsForm').onsubmit = function (e) {
    e.preventDefault()
    call('PUT', '/limits', fields(e.target)).then(function (s) { ok('已保存'); render(s) }).catch(fail)
  }
  $('accountForm').onsubmit = function (e) {
    e.preventDefault()
    var f = fields(e.target)
    if (f.password !== f.confirm) return fail(new Error('两次输入的新密码不一致'))
    call('PUT', '/account', f).then(function (r) {
      e.target.reset()
      enter(r)
      ok('管理员账号已更新')
    }).catch(fail)
  }
  $('copy').onclick = function () { navigator.clipboard.writeText($('secretValue').textContent) }
  $('hideSecret').onclick = function () { $('secretValue').textContent = ''; $('secret').classList.add('hidden') }
  $('refresh').onclick = function () { load().then(function () { ok() }).catch(fail) }
  $('logout').onclick = function () { call('POST', '/logout').catch(function () {}).then(function () { show('login') }) }

  fetch(api + '/status').then(function (r) { return r.json() }).then(function (st) {
    if (st.setup) return show('setup')
    if (sid) return load().catch(function () { show('login') })
    show('login')
  })
})()
</script>
</body>
</html>
`
