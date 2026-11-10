# AnyDot 网页版

浏览器里的 AnyDot：对话、生图 / 视频、Artifacts 预览、数据导入导出。写代码、终端、电脑操作、MCP、定时任务、手机连接这些需要本机的能力只在桌面端。

## 怎么做到的

界面就是桌面端的 renderer（`apps/desktop/src/renderer`），一行没复制。renderer 只通过 `window.api` 的 `invoke` / `on` 和后端说话，桌面端由 Electron 主进程实现，网页版换成：

| 桌面端                        | 网页版                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| 主进程                        | `src/backend/worker.ts`（Web Worker）                              |
| `node:sqlite`                 | SQLite WASM，存在 OPFS（`opfs-sahpool`，不需要 COOP/COEP）         |
| `blobs/` 文件夹               | OPFS `blobs/<sha256>`，由 Service Worker 以 `__blob/<sha256>` 提供 |
| 系统钥匙串                    | AES-GCM，不可导出的密钥存在 IndexedDB                              |
| `aitech-artifact://` 独立协议 | `artifact.html` + 带 `sandbox` 的 CSP（不透明 origin，读不到存储） |
| 文件对话框                    | 浏览器下载 / 文件选择（`src/page.ts`）                             |

两端共用的代码：`@aitech/core`（模型调用）、`@aitech/db/browser`（表结构、迁移、查询）、`apps/desktop/src/shared/handlers.ts`（服务商与模型）、`shared/chat.ts`、`main/image-service.ts`、`main/data-transfer.ts`。导出的 zip 两端可以互相导入。

## 新增 RPC 方法时

`src/protocol.ts` 的 `WEB_SUPPORT` 按 `Rpc` 的每个方法分类（worker / stub / page / desktop）。在 `apps/desktop/src/shared/ipc.ts` 加了方法而没在这里分类，`pnpm typecheck` 会失败；分到 worker 或 page 却没实现，也会失败。界面上的桌面专属入口用 `isWeb`（`renderer/src/lib/api.ts`）隐藏。

## 开发

```bash
pnpm --filter @aitech/web dev
```

打开 http://localhost:5173/app/ 。没有 Key 可以先起模拟网关（`pnpm --filter @aitech/core mock`），服务商填它打印的地址和 `sk-test`。

手机宽度（< 768px）下侧栏变成抽屉、Artifacts 全屏显示；桌面端窗口最小 860px，不受影响。设置 → 通用里的“关闭页面后忘记 Key”适合公用电脑。

浏览器限制：同一个浏览器一次只能一个标签页打开（Web Locks + 独占的 OPFS 文件），另一个标签页可以“在这里使用”接管；无痕模式等没有 OPFS 时数据只在内存里，页面会提示。

## 部署

```bash
pnpm --filter @aitech/web build
```

把 `apps/web/dist/` 放到 anydot.app 服务器的 `/var/www/anydot.app/app/`。nginx 需要两条额外规则：

```nginx
location = /app/artifact.html {
    # 与 src/artifact-csp.ts 保持一致：模型生成的页面在不透明 origin 里运行，不能联网
    add_header Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; sandbox allow-scripts allow-popups allow-forms allow-modals" always;
}
location = /app/sw.js {
    add_header Cache-Control "no-cache" always;
}
```

`assets/` 下的文件名带哈希，可以长缓存。

请求从用户浏览器直接发往用户自己填的 Base URL，不经过 anydot.app，所以服务商需要允许跨域（new-api、OpenAI、Anthropic 都允许）。

## 内置的「AnyDot 默认」服务商

第一次打开时，worker 请求 `https://anydot.app/ctl/llm/v1/models`；中继开放了默认服务就自动加上「AnyDot 默认」服务商（每个浏览器只加一次，用户删了不会再加）。这个服务商的请求发到中继的 `/llm/v1/*`，由中继换上服务器上的 Key 再转发（`apps/relay/src/default-llm.ts`），Key 不会出现在浏览器里。地址、Key、允许的模型、每个 IP 每分钟和每天的次数在中继后台「网页版默认服务商」里配置。本地调试用 `VITE_DEFAULT_LLM_URL` 指向本地中继。桌面端用同一段代码（`apps/desktop/src/shared/default-provider.ts`），后台勾了「同时开放给桌面端」才会加上；没勾时中继只认 anydot.app 页面发来的请求（看 `Sec-Fetch-Site` / `Origin` / `Referer`，脚本可以伪装，靠次数限制和令牌额度兜底）。

nginx 里 `/ctl/llm/` 需要关掉缓冲，否则流式输出会被攒成一整块：

```nginx
location /ctl/llm/ {
    proxy_pass http://127.0.0.1:8090/llm/;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 600s;
    client_max_body_size 30m;
}
```
