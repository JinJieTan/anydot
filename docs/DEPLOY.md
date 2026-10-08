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

| 变量                     | 默认                     | 说明                                |
| ------------------------ | ------------------------ | ----------------------------------- |
| `PORT` / `HOST`          | `8090` / `0.0.0.0`       | 监听地址                            |
| `DATA_DIR`               | `./data`                 | 保存推送密钥（VAPID）和推送订阅     |
| `MOBILE_DIR`             | 空                       | 手机网页的构建目录；为空则不托管    |
| `PUBLIC_URL`             | 空                       | 中继的公网地址，用于生成扫码链接    |
| `VAPID_SUBJECT`          | `mailto:admin@localhost` | Web Push 联系方式，建议改成你的邮箱 |
| `MAX_CONNECTIONS_PER_IP` | `20`                     | 每个 IP 的连接数上限                |
| `MESSAGE_RATE`           | `50`                     | 每个连接每秒消息数上限              |

## 5. 资源占用

单进程，内存几十 MB。连接空闲时只有心跳；流式输出的增量会在桌面端合并后再发（约每 120ms 一次）。
真正占带宽的只有手机上查看图片（按需拉取），生成的图片和视频不会经过中继。
