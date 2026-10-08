# 技术方案与开发计划

> 状态：v1.1 · 2026-10-08（平台与接口已确认）

## 1. 产品定位

一个开源的 AI 桌面客户端和配套的手机端，参考 Claude 桌面端的体验：

- **填入 `base_url + key` 就能用**，兼容任何 OpenAI / Anthropic 协议的服务（自建中转站、new-api、官方 API 等）。
- 同时支持 **GPT 系列、Claude 系列** 对话与 Agent（写代码、操作文件），以及 **gpt-image-2 生图**，后续加入视频模型。
- **手机可以通过扫码与电脑配对**，远程派任务、查看进度、审批危险操作。
- **数据只存在本地**，不依赖账号体系，也不依赖任何特定后端。

## 2. 关键决策

| 主题     | 决策                                                                                                 | 理由                                                                |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 身份     | 模型调用用 `base_url + key`；远程控制用**设备密钥对 + 扫码配对**                                     | key 泄露不应等于电脑被控制；不需要账号体系                          |
| 后端     | 只有一个通用 **relay**（Go），不对接 new-api                                                         | 方便开源和自部署，不和任何模型服务耦合                              |
| 桌面端   | Electron + React + TypeScript                                                                        | Agent 生态（Playwright、MCP、node-pty、AI SDK）都在 Node 里         |
| 手机端   | 先做 PWA（React + Vite），以后用 Capacitor 打包成 App                                                | 先快速验证，以后代码近乎 100% 复用                                  |
| 模型适配 | Vercel AI SDK：Claude 走 `/v1/messages`，GPT 走 `/v1/responses`（退回方案是 `/v1/chat/completions`） | 保留 thinking、缓存、原生工具调用等能力，Agent 循环只写一份         |
| Agent    | 自研 agent loop，参考 Claude Code 的设计                                                             | 必须同时支持两个模型家族                                            |
| 平台     | **macOS + Windows 同步开发**，CI 双平台构建                                                          | 一次把跨平台问题暴露出来                                            |
| 数据     | 本地 SQLite（Electron 内置 `node:sqlite`），按“以后要同步”的标准设计表结构                           | 不需要原生 SQLite 模块，跨平台打包更省事；先不做云端，导出/导入兜底 |
| 加密     | libsodium（X25519 + Ed25519 + XChaCha20-Poly1305）                                                   | 桌面端和浏览器用同一套库，行为一致                                  |

## 3. 总体架构

```
┌──────────── 桌面端 (Electron) ─────────────┐      ┌── 手机端 (PWA → Capacitor) ──┐
│ Renderer: React UI                         │      │ 聊天 / 生图（直连 Provider）   │
│ utilityProcess: Agent Runtime              │      │ 远程：会话浏览 / 派任务 / 审批  │
│   ├ Provider 适配 (AI SDK)                  │      └──────┬───────────────┬──────┘
│   ├ 工具: bash / 文件 / 搜索 / 生图 / MCP    │             │ HTTPS         │ WSS (E2E)
│   └ 权限与审批                               │             ▼               ▼
│ 本地 SQLite + blobs 目录                     │     ┌ Provider(s) ┐  ┌ relay (Go) ──────┐
└──────┬──────────────────────┬──────────────┘     │ new-api /    │  │ 设备鉴权/转发      │
       │ HTTPS                │ WSS (E2E)          │ OpenAI /     │  │ Web Push          │
       └──────► Provider(s)   └───────────────────►│ Anthropic …  │  │ 准入模式可配置      │
                                                   └──────────────┘  └──────────────────┘
```

## 4. 工程结构

```
aitech/
├─ apps/
│  ├─ desktop/          Electron（main / preload / renderer / agent utilityProcess）
│  └─ mobile/           Vite PWA，以后用 Capacitor 打包
├─ packages/
│  ├─ core/             Provider 配置、模型适配、生图客户端、Agent loop、工具定义
│  ├─ db/               SQLite schema、迁移、数据访问（桌面端用）
│  ├─ protocol/         relay 消息格式、配对、加解密；PROTOCOL.md
│  └─ ui/               共享组件：消息流、Markdown、代码高亮、图片画廊、审批卡片
├─ apps/relay/          Node 中继（打包为单个 server.mjs）+ Dockerfile
└─ docs/
```

工具链：pnpm workspace、Turborepo、TypeScript strict、Vitest、ESLint + Prettier、electron-builder。

## 5. 模块设计

### 5.1 Provider 与模型

- 可以配置多个 Provider，每个包含 `name`、`base_url`、`key`、`type: auto | openai | anthropic`。
- key 用 Electron `safeStorage` 加密保存，**不参与导出和同步**。
- 模型列表：请求 `GET {base_url}/v1/models` 自动拉取，也支持手动添加；每个模型可以覆盖协议和能力标签（chat / vision / reasoning / image / video）。
- `type=auto` 时的路由规则：`claude*` 走 anthropic；`gpt-image*` / `dall-e*` 走生图；其余走 openai responses；请求失败时退回 chat completions，并把这个结果记录下来，以后直接用。
- 已确认自有 new-api 支持 `/v1/responses` 和 `/v1/images/edits`；chat completions 只作为兼容其他中转站的退路。

### 5.2 对话

- 流式输出、Markdown + 代码高亮、思考过程折叠、停止生成 / 重新生成 / 编辑后重发（消息形成分支树）。
- 附件支持图片和 PDF（视觉模型）、文本文件。
- 每个会话可以单独选择模型，切换模型后历史消息依然保留。
- 系统提示词、温度、最大 token 等参数可以按会话或按项目设置。

### 5.3 生图

- **生图模式**：提示词、尺寸、质量、数量；支持上传参考图做编辑（`/v1/images/edits`）；画廊里可以查看历史、重新生成、下载。
- **Agent 工具** `generate_image(prompt, size, n, out_dir?)`：生成的图片保存到项目目录或 blobs 目录。
- 视频模型（M4）：异步任务模型，流程是“提交 → 轮询 → 通知”。

### 5.4 Agent

- **项目（Project）**：绑定一个本地文件夹作为工作目录，附带项目级的指令文件（类似 `CLAUDE.md`）。
- **循环**：调用模型 → 执行工具（需要时先审批）→ 把结果追加进上下文 → 重复，直到模型不再调用工具；支持中断、上下文压缩、token 和费用统计。
- **跨平台 shell**：macOS 用 `zsh/bash`；Windows 优先用 PowerShell，检测到 Git Bash 时可选；工具描述按平台动态生成，让模型知道当前是什么系统。
- **第一批工具**：`bash`（node-pty，带超时）、`read_file`、`write_file`、`edit_file`（字符串替换）、`glob`、`grep`（ripgrep）、`web_fetch`、`generate_image`、`todo`。
- **权限模式**：每次询问 / 自动接受文件修改 / 只规划不执行。工作目录以外的写操作和危险命令永远需要审批。
- UI 上展示工具调用卡片、文件 diff 视图和终端输出。

### 5.5 Relay（M3）

| 接口                   | 说明                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `GET /info`            | 版本、准入模式、能力                                            |
| `WS /ws`               | challenge-response 签名鉴权，按 `device_id` 转发 E2E 加密的数据 |
| `POST /push/subscribe` | Web Push 订阅                                                   |
| `/m/*`                 | 可选：托管手机 PWA                                              |

- **准入模式**：`open`（配合限流）/ `token`（共享令牌）/ `upstream`（用 base_url 白名单 + `/v1/models` 校验 key，这是你自己的站点使用的模式）。
- relay 不存储消息内容；在线连接表放内存，推送订阅存 SQLite。
- 客户端发现 relay 的方式：请求 `{base_url}/ctl/info` 自动探测，或者手动填写。

### 5.6 配对与远程控制（M3）

1. 电脑首次启动时生成 Ed25519/X25519 密钥对，`device_id = hash(pubkey)`。
2. 电脑点击“绑定手机”，显示二维码，内容为 `{relay_url, desktop_id, desktop_pubkey, pair_code}`，2 分钟后过期；可选附带 Provider 配置。
3. 手机扫码后生成自己的密钥对，发起配对请求；电脑上必须点击“允许”。
4. 双方保存对方公钥，之后所有消息都加密并签名，用 nonce + 时间戳防重放。
5. 电脑端可以查看和移除已配对的手机；远程会话期间常驻“正在被远程控制”标识，并提供急停按钮。

远程能力：浏览电脑上的会话、派发任务（在电脑上执行，用电脑上配置的 key）、查看实时进度、审批危险操作、接收推送。

## 6. 数据模型（本地 SQLite）

通用约定：主键用 **UUIDv7**；每张表都有 `created_at`、`updated_at`、`deleted_at`（软删除）、`device_id`。

```
providers(id, name, base_url, type, key_ref, ...)
models(id, provider_id, model_id, protocol, capabilities, display_name, ...)
projects(id, name, root_path, instructions, default_model_id, permission_mode, ...)
conversations(id, project_id?, title, model_id, system_prompt, params_json, ...)
messages(id, conversation_id, parent_id, role, parts_json, model_id, usage_json, status, ...)
        -- parts: text | image(blob) | file(blob) | reasoning | tool_call | tool_result
blobs(sha256, mime, size, path)                -- 文件存在 blobs/ab/cd/<sha256>，内容寻址
image_jobs(id, prompt, params_json, model_id, result_blob_ids, status, ...)
settings(key, value_json)
trusted_devices(device_id, name, pubkey, paired_at, last_seen)   -- M3
```

- 消息**只追加**：编辑或重新生成都创建新消息，用 `parent_id` 形成分支。
- 导出格式：一个 zip，包含会话 JSON 和引用到的 blobs；导入时按 ID 去重。

## 7. 安全基线

- key 只保存在本机（safeStorage），日志和导出中做脱敏处理。
- Agent 默认被限制在项目目录内；危险命令走黑名单 + 审批；远程发起的任务默认使用更严格的模式。
- Artifacts / HTML 预览放在沙箱 iframe 中，并配置 CSP。
- Electron：`contextIsolation`、关闭 `nodeIntegration`、preload 只暴露白名单 API。
- relay 能看到的只有密文和在线状态；协议公开写在 `PROTOCOL.md` 中，方便审计。

## 8. 开发计划

### M0 · 工程骨架

- [x] monorepo（pnpm + Turborepo）、TS / ESLint / Prettier / Vitest
- [x] Electron 壳：main / preload / renderer / agent utilityProcess 能跑通
- [x] SQLite（node:sqlite）接入 + 迁移机制，schema v1
- [x] CI：macOS + Windows 双平台 lint、类型检查、测试、打包（配置已写，需推到 GitHub 后验证）

### M1 · 聊天与生图（第一个可用版本）

- [x] Provider 管理界面 + `/v1/models` 拉取 + 手动添加模型
- [x] `core` 适配层：anthropic / openai-responses / openai-chat 三条路径
- [x] 流式聊天、Markdown、代码高亮、思考过程折叠、停止 / 重新生成 / 编辑（分支）
- [x] 附件：图片 / PDF / 文本
- [x] 生图模式（generations + edits）+ 画廊
- [x] 会话列表、搜索、重命名、删除
- [x] 导出 / 导入
- [x] 验证：本地模拟网关跑通三种协议 + 生图（`pnpm --filter @aitech/core mock`）
- [ ] 验证：用真实 new-api 跑通 Claude、GPT、gpt-image-2（需要测试 Key）

### M2 · Agent（写代码）

- [x] 项目 = 文件夹 + 项目说明（另外自动读取 AGENTS.md / CLAUDE.md）
- [x] Agent loop（`@aitech/agent`）：工具调用、中断、旧工具输出截断、每步用量统计
- [x] 工具：read_file / write_file / edit_file / list_files / grep / bash / web_fetch / generate_image / todo_write
- [x] 权限模式：每次询问 / 自动改文件 / 全自动 / 只读规划；危险命令和项目外路径始终确认；“总是允许”按命令族记忆
- [x] 审批卡片、工具调用卡片、diff 视图、命令输出、任务列表
- [x] 登录 shell 环境解析（解决 GUI 启动时 PATH 不完整）、超时与停止时终止整个进程树
- [x] HTML / SVG 代码块在隔离窗口预览
- [ ] 上下文自动摘要（目前是截断旧工具输出；长任务可能需要摘要压缩）
- [ ] 真实模型验证（需要测试 Key）

### M3 · Relay 与手机端

- [x] `@aitech/protocol`：设备身份（Ed25519）、端到端加密（X25519 + XChaCha20-Poly1305，收发双方绑定在 AAD）、防重放、配对链接
- [x] Relay（Node，单文件）：签名登录、密文转发、在线状态、三种准入模式、限流、Web Push、托管手机网页、Docker 镜像（见 docs/DEPLOY.md）
- [x] 桌面端：设备身份（钥匙串加密）、配对二维码、电脑上二次确认、信任列表与解除配对、远程控制提示条与一键断开
- [x] 手机 PWA：扫码配对、电脑列表 / 项目 / 对话、远程派任务、实时进度、审批、停止；直连服务商对话与生图；加密推送通知
- [x] 手机发起的任务不会以“全自动”模式运行
- [ ] 新设备迁移（从老设备拉取历史）—— 推迟到同步功能一起做
- [ ] 真机验证：iOS 添加到主屏幕后的推送、Android Chrome

### M4 · 增强

- [ ] MCP 客户端
- [ ] 浏览器工具（Playwright）、computer use（截屏 + 键鼠）
- [ ] 视频模型
- [ ] Capacitor 打包 iOS / Android
- [ ] 自动更新、macOS 签名与公证、Windows 签名
- [ ] E2E 加密同步（WebDAV / S3）

## 9. 风险与待确认事项

- [ ] 项目名称、开源许可证（建议：客户端 Apache-2.0；relay 可以考虑 AGPL-3.0）
- [x] 自有 new-api 支持 `/v1/responses` 和 `/v1/images/edits`
- [x] 平台：macOS + Windows 一起做
- [ ] Apple 开发者账号（签名、公证、以后上架 App）；Windows 代码签名证书（建议 Azure Trusted Signing），否则会被 SmartScreen 拦截
- [ ] 不同中转站对协议的兼容程度参差不齐，需要一组兼容性测试用例
- [ ] iOS PWA 的推送需要用户先“添加到主屏幕”，需要做产品引导
