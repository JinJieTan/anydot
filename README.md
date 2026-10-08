# aitech

开源的 AI 桌面客户端 + 手机端。填入 `base_url + key` 即可使用 GPT、Claude 和 gpt-image-2，桌面端可以像 Claude 桌面端一样写代码、操作文件，手机扫码配对后可以远程派任务。

方案与计划见 [docs/PLAN.md](docs/PLAN.md)。

## 开发

需要 Node.js 24+ 和 pnpm 10+。

```bash
pnpm install
pnpm dev
```

国内网络下载 Electron 较慢时，可以设置镜像：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

常用命令：

| 命令                                     | 说明                 |
| ---------------------------------------- | -------------------- |
| `pnpm dev`                               | 启动桌面端（热更新） |
| `pnpm test`                              | 运行单元测试         |
| `pnpm typecheck`                         | 类型检查             |
| `pnpm lint` / `pnpm format`              | 代码检查 / 格式化    |
| `pnpm --filter @aitech/desktop dist:mac` | 打包 macOS（dmg）    |
| `pnpm --filter @aitech/desktop dist:win` | 打包 Windows（nsis） |

## 目录结构

```
apps/desktop      Electron 桌面端（main / preload / renderer / agent 进程）
packages/core     Provider 配置、模型路由、ID 生成（后续：模型适配、Agent loop）
packages/db       本地 SQLite schema 与迁移（node:sqlite）
docs/             设计文档
```
