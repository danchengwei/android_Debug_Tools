# 安卓调试工具（本地 ADB + Web）

浏览器内连接真机调试：投屏、顶层 Activity、环境信息、布局、日志、Trace、反编译、AI 对话等。当前默认通过 **本机 ADB HTTP 桥接**（`localhost:3003`）执行命令，与前端（`localhost:3000`）分离。

## 环境要求

- **Node.js** 18+（建议 LTS）
- **本机已安装 ADB**，且 `adb devices` 能看到设备（已开 USB 调试）
- **本机已安装 [scrcpy](https://github.com/Genymobile/scrcpy)**（**默认 `npm start` 会起视频流服务**，无 scrcpy 时请看下方 `dev:lite`）
- **Chrome / Edge**（推荐；镜像视频流依赖 **WebCodecs**）
- 使用 **Gemini AI** 时：在项目根目录配置 `.env.local`，设置 `GEMINI_API_KEY`

> 桥接服务启动时会打印实际使用的 **ADB 路径**。也可设置环境变量 **`ADB_PATH`** 指向你的 `adb`（例如 Android SDK `platform-tools/adb`）。  
> **scrcpy** 路径可通过 **`SCRCPY_PATH`** 指定；未设置时会尝试 Homebrew 等常见路径，否则使用 PATH 中的 `scrcpy`。

## 启动服务

### 推荐：一键启动（释放端口 + 所需服务）

```bash
npm install
npm start
```

与 **`npm run dev` 等价**。会先执行 **`scripts/start-all.mjs`**：

1. **释放端口** **3000 / 3003 / 13377 / 13378**（及 macOS/Linux 下尽力结束旧的 `adb-server` / `scrcpy-server` 进程），避免「端口被占用」导致起不来。  
2. **并行**拉起下列服务：

- **bridge**：`adb-server.js`（端口 **3003**，`adb`、ADB 截图兜底等）
- **scrcpy**：`scrcpy-server.js`（端口 **13377**，**H.264 视频流**；健康检查 **13378**）
- **vite**：前端（端口 **3000**）

终端里应能看到 `[bridge]`、`[vite]`、`[scrcpy]` 前缀日志。浏览器访问：**http://127.0.0.1:3000/**  

按 **Ctrl+C** 一般会结束上述进程（视终端与 concurrently 行为而定）。**未使用 `-k`**：若 scrcpy 进程异常退出，桥接与前端仍可继续，便于先看其它功能；修复 scrcpy 后重新 **`npm start`** 即可。

> **镜像说明**：**默认以 Scrcpy 视频流为主**；仅当 **13377 不可用 / 解码失败** 时，才用 **ADB 连续截图**兜底（卡、延迟高属正常）。

| 脚本 | 说明 |
|------|------|
| **`npm start`** / **`npm run dev`** | **一键**：释端口 + **桥接 3003 + scrcpy-server + Vite 3000**（默认） |
| **`npm run dev:run`** | **不**先释端口，直接起三服务（已由其它脚本占用端口排查时用） |
| **`npm run dev:lite`** | 一键释端口 + 仅桥接 + Vite（**不**起 scrcpy） |
| **`npm run dev:lite:run`** | 仅桥接 + Vite，不释端口 |
| `npm run dev:raw` | **仅**前端，不启桥接（你已单独起 `dev:bridge` 时用） |
| `npm run dev:bridge` | **仅** HTTP 桥接 |
| `npm run dev:local` | Bash 脚本：含 pkill / 端口清理（与 Node 一键逻辑类似，可选） |

桥接正常时会出现：`ADB server running on http://127.0.0.1:3003`。scrcpy 侧会打印 `[scrcpy-server] 使用 scrcpy: ...`。

前端连接前会请求 **`GET /api/health`**。若你长期未重启，重新执行 **`npm start`** 即可。

### 重启

在运行 **`npm start`** 的终端 **Ctrl+C** 后，再执行 **`npm start`**。

## 屏幕镜像（实时画面）

| 模式 | 条件 | 说明 |
|------|------|------|
| **Scrcpy 流** | `ws://localhost:13377` 可用且浏览器支持 **WebCodecs** | H.264 解码后绘制到 Canvas，帧率更高、更流畅。**`npm start`** 会起 `scrcpy-server.js`；亦可按需使用 `npm run dev:local`。 |
| **ADB 连续截图** | 至少 **3003** 桥接正常（`/api/screen`） | 与 Scrcpy **并行**：串行 `exec-out screencap` PNG，约 **5～9 帧/秒**，**延迟明显高于视频流**，属正常现象。Scrcpy 就绪后自动切 Canvas。 |

**最低要求（能看见画面）**：**3003** 桥接可用。使用 **`npm start`** 时会自动启动；若只用 `dev:raw`，需另起 `dev:bridge` 或 `node adb-server.js`。

**觉得卡、延迟高**：说明当前多为 **ADB 截图兜底**（13377 未连上或解码失败）。请确认 **`npm start`** 已起 **`scrcpy-server`**，顶栏应出现 **「Scrcpy · x FPS」**；可看 `[scrcpy]` 终端日志是否报错。

顶栏会显示当前模式：**「Scrcpy · x FPS」** 或 **「ADB 截图（约 5～9 帧/秒）」**。点击工具栏 **刷新** 可重置连接并重试 Scrcpy。

### 其他脚本

| 命令 | 说明 |
|------|------|
| `npm run dev:suppress-adb` | 启动 Vite 前会反复 `adb kill-server`，用于需要 **WebUSB 独占设备** 的旧流程（macOS/Linux） |
| `npm run build` | 生产构建 |
| `npm run preview` | 预览构建结果 |
| `npm run lint` | TypeScript 检查 |

## 顶层 Activity 获取

工具内「顶层 Activity」与下列命令等价（在 **设备 shell** 内管道，首行即栈顶相关输出）：

```bash
adb shell "dumpsys activity | grep -E 'topActivity|mResumedActivity' | head -1"
```

界面会展示解析后的包名、Activity 类名、任务 ID，以及 **dumpsys 原始首行**（便于对照真机输出）。

连接后点击面板右上角 **刷新** 可重新拉取。

## Scheme 跳转测试

独立面板 **「Scheme 跳转测试」**（与栈顶 Activity 无关）：

1. 输入 **scheme / App Link / https** 等（如 `myapp://detail/123`）。
2. 点 **「跳转」**：先在前端 **解析并规范化** URI，再执行 `am start -a VIEW -d "…"`。
3. **限定包名（可选）**：填写合法包名时追加 `-p`，由指定应用接收 Intent。

结果区会显示解析摘要与设备端返回信息。

## 常见问题

- **页面能开但一直连不上设备**：确认 `adb-server.js` 已在跑、3003 未被防火墙拦截，`adb devices` 为 **`device`** 状态。
- **`adb devices` 里是 offline**：电脑已识别 USB，但 ADB 会话异常；**工具与命令行一样无法调试**。请换线/换口、USB 模式改为文件传输、撤销 USB 调试授权后重插、`adb kill-server && adb start-server`，直到变为 **device**。
- **3000 端口报错**：重新执行 **`npm start`**（会自动尝试释端口），或手动 `lsof -i :3000` 查进程。
- **截图失败 / 镜像一直转圈**：确认 3003 已启动；仅跑 Vite 没有桥接时无法截图。可等待自动切换 ADB 截图，或先起 `dev:local` 再试 Scrcpy。
- **有 Scrcpy 仍无画面**：看浏览器控制台是否有 WebSocket / 解码错误；可点镜像区 **刷新** 或暂时依赖 ADB 截图模式。

---

## 许可证与说明

本项目为本地调试工具，请仅在合法授权的设备上使用。
