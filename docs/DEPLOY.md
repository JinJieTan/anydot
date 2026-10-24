# 部署中继服务（手机连接电脑）

中继服务（relay）负责让手机和电脑互相找到对方，并转发**端到端加密**的消息。它看不到对话内容，也不保存 API Key。
同一个服务还托管手机端网页（`/m/`），用户扫码后直接打开。

## 1. 运行

```bash
docker build -f apps/relay/Dockerfile -t aitech-relay .
docker run -d --name aitech-relay --restart unless-stopped \
  -p 127.0.0.1:8090:8090 -v aitech-relay-data:/data \
  -e PUBLIC_URL=https://api.example.com/ctl \
  -e AUTH_MODE=upstream \
  -e ALLOWED_UPSTREAMS=https://api.example.com \
  aitech-relay
```

不用 Docker 也可以：`pnpm --filter @aitech/relay build && node apps/relay/dist/server.mjs`（只有一个文件）。

## 2. 准入模式（`AUTH_MODE`）

| 模式       | 说明                                                                                                        | 需要的配置                    |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `open`     | 任何设备都能连接（有限流）。适合个人或内网                                                                  | 无                            |
| `token`    | 连接时必须提供令牌                                                                                          | `AUTH_TOKEN`                  |
| `upstream` | 只允许指定服务商的有效 Key 使用：中继会请求 `{base_url}/v1/models` 验证一次（结果缓存 10 分钟，只保存哈希） | `ALLOWED_UPSTREAMS`，逗号分隔 |

自有中转站推荐 `upstream`：只有你的用户能用远程功能，而且不需要和 new-api 做任何对接。

### 管理后台（`ADMIN_TOKEN`）

设置 `ADMIN_TOKEN`（至少 16 位）后，`{中继地址}/admin`（比如 `https://api.example.com/ctl/admin`）会开放一个管理页面，用这个令牌登录：

- **切换准入模式**：在“所有人都可以连接”和“仅限令牌”之间切换（配置了 `ALLOWED_UPSTREAMS` 时还可以选“仅限服务商用户”）。立即生效，不再符合条件的连接会被断开，不用重启。
- **管理访问令牌**：给每个人或每台设备单独建一个令牌，只显示一次；泄露了就单独吊销，使用它的设备会立刻断开。还能看到每个令牌的最近使用时间和在线连接数。
- `AUTH_TOKEN` 仍然有效，在后台显示为“服务器默认令牌”，只能在服务器上修改。
- 在后台改过的模式和令牌保存在 `DATA_DIR/access.json`（令牌只存哈希），优先于 `AUTH_MODE`。有了 `ADMIN_TOKEN`，`AUTH_MODE=token` 可以不设 `AUTH_TOKEN`，令牌在后台创建。

> 后台只管“谁能连上中继”。手机能否控制某台电脑，仍然要在那台电脑上确认配对。

## 3. 和中转站放在同一个域名下（推荐）

桌面端的“自动检测”会尝试 `{base_url}/ctl/info`。在 nginx 里加一段：

```nginx
location /ctl/ {
    proxy_pass http://127.0.0.1:8090/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;   # WebSocket 长连接
    proxy_send_timeout 3600s;
}
```

这样：

- 中继地址：`https://api.example.com/ctl`
- 手机网页：`https://api.example.com/ctl/m/`（`PUBLIC_URL` 要设为 `https://api.example.com/ctl`）

> 手机网页的 Service Worker 和推送通知需要 HTTPS。

## 4. 其它环境变量

| 变量                     | 默认                     | 说明                                      |
| ------------------------ | ------------------------ | ----------------------------------------- |
| `PORT` / `HOST`          | `8090` / `0.0.0.0`       | 监听地址                                  |
| `DATA_DIR`               | `./data`                 | 保存推送密钥（VAPID）、推送订阅和准入设置 |
| `MOBILE_DIR`             | 空                       | 手机网页的构建目录；为空则不托管          |
| `PUBLIC_URL`             | 空                       | 中继的公网地址，用于生成扫码链接          |
| `VAPID_SUBJECT`          | `mailto:admin@localhost` | Web Push 联系方式，建议改成你的邮箱       |
| `MAX_CONNECTIONS_PER_IP` | `20`                     | 每个 IP 的连接数上限                      |
| `MESSAGE_RATE`           | `50`                     | 每个连接每秒消息数上限                    |
| `ADMIN_TOKEN`            | 空                       | 管理后台的登录令牌；为空则不开放后台      |

## 5. 资源占用

单进程，内存几十 MB。连接空闲时只有心跳；流式输出的增量会在桌面端合并后再发（约每 120ms 一次）。
真正占带宽的只有手机上查看图片（按需拉取），生成的图片和视频不会经过中继。
