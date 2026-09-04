# DeepSeek Desktop

DeepSeek Harness（dsh）智能体的原生桌面客户端。采用 codex / zcode 风格 UI，完整复用 dsh 核心（everything-is-a-plugin、DeepSeek 模型适配、缓存命中），并内置实时插件市场。

**自包含发行**：安装包内置完整 DSH 运行时与 pnpm，终端用户无需安装 Node.js、无需检出 dsh 源码仓库。首次启动时桌面端将校验过的运行时展开到应用数据目录并复用。

## 功能特性

- **会话管理**：多会话切换、置顶、本地归档，自动同步远端 dsh 会话列表
- **任务对话**：流式输出、任务控制、转向（steer）、取消，支持图片附件（最多 20 张 / 单张 5 MB）
- **模型选择**：多 provider 路由、推理强度（reasoning effort）配置，模型目录懒加载并带加载/错误/空状态
- **项目集成**：选择本地项目目录、读取 Git 分支 / 改动 / **worktree 列表**、一键打开 PowerShell 终端
- **插件市场**：从 GitHub `topic:dsh-plugin` 实时拉取插件并一键安装到 web profile（通过内置 pnpm，用户无需自装）
- **自动化**：定时 / 周期任务调度视图
- **外观主题**：浅色 / 深色 / 跟随系统，自定义标题栏
- **设置热重载**：写入凭证 / 环境后自动重启 dsh host，无需重启应用
- **安全沙箱**：`contextIsolation` + `sandbox`，预加载桥接，禁用 `nodeIntegration`

## 技术栈

| 层 | 技术 |
| --- | --- |
| 壳 | Electron 43 |
| 渲染 | React 19 + TypeScript 5.9 |
| 构建 | electron-vite 5 / Vite 7 |
| 样式 | Tailwind CSS 3.4 + PostCSS |
| 状态 | Zustand 5 |
| 通信 | WebSocket（ws 8）+ Electron IPC |
| 打包 | electron-builder 26（NSIS） |
| 内置 | DSH 运行时（Brotli 压缩）+ pnpm 10 |

## 项目结构

```
deepseek-desktop/
├─ src/
│  ├─ main/            # Electron 主进程
│  │  ├─ index.ts      # 窗口、IPC、生命周期、host 热重启
│  │  ├─ dsh-host.ts   # 内置运行时物化、dsh web 子进程、pnpm shim、插件安装
│  │  └─ dsh-client.ts # dsh RPC / 流代理（token→cookie 交换）
│  ├─ preload/         # 预加载桥接（contextBridge）
│  └─ renderer/        # React UI
│     └─ src/
│        ├─ App.tsx
│        ├─ store.ts          # Zustand 全局状态
│        ├─ types.ts          # dsh API 类型定义
│        ├─ dsh-client.ts     # 渲染端 dsh 调用封装
│        └─ components/       # Sidebar / ChatView / PluginMarket /
│                           #   AutomationsView / SettingsView 等
├─ scripts/
│  ├─ ensure-electron.mjs
│  └─ sync-dsh-runtime.mjs    # 从相邻 DSH 源码生成本地内置运行时
├─ resources/dsh-runtime/     # 内置运行时资源（manifest + license；.br 由 sync 生成）
├─ electron.vite.config.ts
├─ electron-builder.yml
└─ package.json
```

## 环境要求

- **终端用户**：无前置要求，安装包自包含
- **开发者**：Node.js `^22.19.0` 或 `>=24.0.0`，pnpm（仓库附带 `pnpm-lock.yaml`）
- **生成内置运行时**（打包前）：需要相邻的 DSH 源码检出 `../deepseek-harness-clean` 并已产出 `dist-exe`，或通过 `DSH_RUNTIME_SOURCE` 指向已有运行时目录

## 快速开始

```bash
# 安装依赖（会自动确保 electron 下载）
pnpm install

# 开发模式（热更新；开发模式下若相邻 DSH 源码存在则直接使用其 bin.js）
pnpm dev

# 类型检查
pnpm typecheck

# 构建产物到 out/
pnpm build

# 预览构建产物
pnpm preview
```

### 打包 Windows 安装包

打包前会自动执行 `runtime:sync` 把内置 DSH 运行时同步进 `resources/dsh-runtime/`。

```bash
# 仅打包到目录（不生成安装器）
pnpm pack:win

# 生成 NSIS 安装包到 release/
pnpm dist:win
```

产物命名：`DeepSeek-Desktop-<version>-x64.exe`，支持自定义安装路径、创建桌面与开始菜单快捷方式。安装包通过 `extraResources` 携带 `resources/dsh-runtime`，运行时在用户机器上展开到应用数据目录。

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `DSH_ROOT` | 开发模式回退用的 dsh 源码根目录 | `../deepseek-harness-clean` |
| `DSH_HOME` | dsh home 目录（会话、配置、运行时展开） | 打包：`<userData>/dsh`；开发：`<repo>/.dsh-home` |
| `DSH_DESKTOP_NODE` | 开发模式拉起 dsh 用的 node 可执行文件 | `node.exe` / `node` |
| `DSH_RUNTIME_EXECUTABLE` | 直接指定一个 DSH 可执行文件（测试未发布运行时） | — |
| `DSH_RUNTIME_SOURCE` | `runtime:sync` 从该目录读取运行时 | 相邻 DSH 源码的 `dist-exe` |

### API 密钥

DeepSeek API Key 等凭证通过 `Settings` 视图形化配置，写入 `<DSH_HOME>/desktop.env`，启动时注入 dsh 子进程环境。写入后桌面端会**自动重启 dsh host** 使新配置生效。也可手动编辑该文件：

```env
DEEPSEEK_API_KEY=sk-xxxxxxxx
```

## 架构说明

启动流程：

1. 主进程 `bootstrap()` 调用 `startDshHost()`：
   - `resolveDshLaunch()` 优先用 `DSH_RUNTIME_EXECUTABLE`；开发模式回退到相邻源码的 `bin.js`；否则物化内置运行时——读取 `manifest.json`，按 sha256 校验后 Brotli 解压到 `<DSH_HOME>/desktop-runtime/<hash前16位>/`，已存在且校验通过则直接复用。
   - 以 `dsh web --port 0 --no-open` 拉起 dsh 子进程，解析其标准输出中公告的 `http://127.0.0.1:<port>` URL。
   - `ensureBundledPnpmOnPath()` 将内置 pnpm 以 shim 形式注入子进程 PATH，供插件安装使用。
2. `createDshApiProxy()` 与该 URL 做 token→cookie 交换，建立 RPC / 流通道。
3. 创建 `BrowserWindow`，加载渲染层；渲染层通过 preload 暴露的 `window.desktop` 调用 IPC，再由主进程转发至 dsh。
4. 会话控制流（`dsh:stream:frame`）持续推送 projection / jobs / queue 增量，渲染层据此更新 Zustand 状态。
5. 设置写入触发 `restartDshHost()`：停旧 host、起新 host、重建代理，失败则回滚 env。

dsh 核心完全在子进程内运行（模型适配器、agent 循环、工具、缓存、插件加载均在内置运行时中），桌面端仅做 UI 与桥接，不重复实现 agent 逻辑，也不对 provider / model / 参数做任何过滤或降级。

## 插件市场

插件市场视图通过 GitHub Search API 查询 `topic:dsh-plugin` 仓库（按 star 排序）。安装时主进程执行 `dsh plugin --profile web add <spec>`，将插件写入 web profile，依赖由内置 pnpm 解析。

发布插件：在 GitHub 仓库添加 topic `dsh-plugin` 即可被市场收录。

## 许可证

MIT（桌面端）；内置 DSH 运行时随附 `resources/dsh-runtime/DSH-LICENSE.txt`。
