# 安卓调试工具（本地 ADB + Web）

在浏览器内连接真机调试：**屏幕镜像（自动打开本机 Scrcpy 流畅窗口 + 网页 ADB 预览）**、**顶层 Activity**、**环境信息**、**WebView（栈顶为 OtherProcessBrowserActivity 时一键打开 Chrome Inspect）**、布局、日志、Trace、反编译、Scheme 跳转、AI 对话等。

## 日常怎么用（不必记命令和端口号）

1. **准备环境（通常只做一次）**  
   - 安装 **Node.js 18+**（建议官网 LTS）  
   - 手机打开 **USB 调试**，本机安装 **ADB**；需要流畅投屏时再装 **scrcpy**（见下表）

2. **启动**  
   - **Windows**：双击项目里的 **`启动调试工具.bat`**  
   - **macOS**：双击 **`启动调试工具.command`**（若提示无法执行，在终端执行一次 `chmod +x 启动调试工具.command`）  
   - **Linux**：在终端进入项目目录后执行 `./启动调试工具.sh`（首次可 `chmod +x`）

3. **使用**  
   - 首次运行会自动 **`npm install`**  
   - 保持弹出的**命令行窗口不要关**；**浏览器会自动打开**调试界面，无需自己输入网址  
   - 若浏览器未弹出，可刷新或重新双击启动脚本

> 开发人员仍可用 **`npm start`** / **`npm run dev`**，与上述脚本等价；脚本会设置 **`ANDROID_DEBUG_TOOLS_OPEN_BROWSER=1`** 以自动打开浏览器。

---

**技术说明（可选读）**

- 页面由本地开发服务提供；命令与截图经本机 **ADB HTTP 桥接** 转发（与页面同主机时会自动匹配局域网访问场景）
- **`npm start`** 会运行 **`scripts/start-all.mjs`**：**释端口、二次清理旧进程**后并行 **桥接 + scrcpy-server + Vite**，并自检桥接与 H5 接口；**自检失败时会自动杀进程、释端口再拉起一轮**（无需你手动重启）。桥接进程使用 **`node --watch adb-server.js`**，改 `adb-server.js` 后会自动重启桥接。

---

## 环境要求

| 项 | 说明 |
|----|------|
| **Node.js** | 18+（建议 LTS） |
| **ADB** | 本机已安装，`adb devices` 中设备状态须为 **`device`**（`offline` / `unauthorized` 时无法调试） |
| **scrcpy** | 建议安装（[Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)）。**`npm start` 默认会起 `scrcpy-server.js`**；若不需要视频流可用 **`npm run dev:lite`** |
| **浏览器** | 推荐 **Chrome / Edge** |
| **Gemini AI** | 可选：项目根目录 `.env.local` 中配置 `GEMINI_API_KEY` |

**环境变量（可选）**

- **`ADB_PATH`**：显式指定 `adb` 可执行文件路径（如 Android SDK `platform-tools/adb`）。桥接启动日志会打印实际使用的路径。
- **`SCRCPY_PATH`**：显式指定 `scrcpy`。未设置时依次尝试 Homebrew、`/usr/local` 等，否则使用 PATH 中的 `scrcpy`。  
- **`SCRCPY_EXTRA_ARGS`**：传给 `scrcpy` 的额外参数（空格分隔），例如 `--stay-awake`。

---

## 启动服务

### 命令行一键启动（开发者）

与普通用户双击脚本等价；不会自动打开浏览器（除非自行设置环境变量 `ANDROID_DEBUG_TOOLS_OPEN_BROWSER=1`）。

```bash
npm install
npm start
```

与 **`npm run dev` 完全等价**。执行流程：

1. 运行 **`scripts/start-all.mjs`**  
   - 尝试释放端口：**3000**（Vite）、**3003**（桥接）、**13377**（`scrcpy-server` HTTP 控制/探测）  
   - **短暂间隔后**再跑一轮释端口（含 Windows）  
   - **macOS / Linux**：并 `pkill` 匹配 **`adb-server.js` / `scrcpy-server.js`** 的旧进程  
   - **Windows**：通过 `netstat` + `taskkill` 尽力释端口  
   - 子进程拉起后：后台轮询桥接健康与 **`/api/webview-pages`**（终端会打印 **✓ 桥接自检通过** 或 **⚠ 404 多为旧版 adb-server**）
2. 并行启动：  
   - **bridge**：`node adb-server.js`  
   - **scrcpy**：`node scrcpy-server.js`（**自动 `spawn` 本机 `scrcpy` 打开系统窗口**；HTTP **`GET http://主机:13377/`** 供页面探测是否在跑，已设 **CORS**）  
   - **vite**：`vite`（监听 **0.0.0.0:3000**，便于手机通过局域网 IP 访问；`/api` 由配置代理到本机桥接）

开发时本地页面一般为 **`http://127.0.0.1:3000/`**（命令行启动时请自行打开）。终端中日志带 **`[bridge]`**、**`[vite]`**、**`[scrcpy]`** 前缀。

> **说明**：`concurrently` **未**使用 `-k`，任一侧进程异常退出时，其余服务可能仍在运行；修复后重新启动即可。

### npm 脚本一览

| 命令 | 说明 |
|------|------|
| **`npm start`** / **`npm run dev`** | 释端口 + 桥接 + scrcpy-server + Vite（**默认全流程**） |
| **`npm run dev:run`** | 不释端口，直接启动上述三个子进程 |
| **`npm run dev:lite`** | 释端口 + 仅桥接 + Vite（**无** Scrcpy，适合未装 scrcpy 或只要 ADB） |
| **`npm run dev:lite:run`** | 仅桥接 + Vite，不释端口 |
| **`npm run dev:raw`** | 仅 Vite（需自行已起桥接） |
| **`npm run dev:bridge`** | 仅 HTTP 桥接 |
| **`npm run dev:local`** | Bash：`start-local.sh`，含端口清理后桥接 + Scrcpy + Vite（与 Node 一键类似，可按习惯选用） |
| **`npm run build`** | 生产构建 |
| **`npm run preview`** | 预览构建产物 |
| **`npm run lint`** | `tsc --noEmit` |
| **`npm run dev:suppress-adb`** | 旧流程：启动前反复 `adb kill-server`（WebUSB 独占等场景，macOS/Linux） |

### 健康检查

- 桥接：**`GET /api/health`**（或旧版桥接无该接口时会 fallback `adb version`）  
- **Scrcpy 服务**：**`GET http://127.0.0.1:13377/`** 返回 JSON（含 `nativeScrcpyRunning`、`mode: native_window`）  
- 连接设备前前端会探测桥接是否可用；失败时请确认已 **`npm start`** 且终端出现 **`ADB server running`**。

---

## 连接设备

1. 手机开启 **USB 调试**，USB 模式建议 **文件传输 / MTP**。  
2. 终端执行 **`adb devices`**，须为 **`序列号    device`**。  
3. 在页面点击 **连接设备**。  

**行为说明**

- 会解析 **`adb devices`**，**无 `device` 状态设备时会报错**（避免「假连接」）。  
- **多机**时自动为当前选中设备带上 **`-s 序列号`**（命令与 **`/api/screen?serial=`** 截图一致）。  
- 顶栏展示 **设备名称 / 型号 / ADB 序列号**；镜像区显示 **画面来源**，便于确认当前操作的是哪一台。

---

## 屏幕镜像

| 模式 | 说明 |
|------|------|
| **本机 Scrcpy 系统窗口（流畅）** | **`npm start` 后由 `scrcpy-server.js` 自动执行 `scrcpy`**，弹出 **操作系统原生窗口**，高帧率、低延迟，**无需用户再在终端手动输入 scrcpy**。无设备或 scrcpy 退出时，约 **5 秒** 后自动重试拉起。 |
| **网页内预览** | 桥接 **`GET /api/screen`** 连续截图，约 **5～9 帧/秒**，用于在页面里大致看画面、配合 **触控按钮**；与系统 Scrcpy 窗口 **同时** 工作。 |

- 顶栏在探测到 **`nativeScrcpyRunning`** 时会显示 **「Scrcpy 系统窗口 · 流畅」**（数据来自 **`http://主机:13377/`**）。  
- **请勿**再在 Node 里连接 **27183** 去「抢」视频隧道，否则会干扰 Scrcpy 正常工作（旧版已移除该逻辑）。  
- 若未出现 Scrcpy 窗口：检查 **`adb devices`**、是否安装 **scrcpy**、终端 **`[scrcpy]`** 报错。

---

## WebView / H5 调试

主界面**不再**单独展示 H5 解析面板。当 **顶层 Activity** 类名包含 **`OtherProcessBrowserActivity`**（常见内置浏览器 / WebView 容器）时，**「顶层 Activity」** 卡片标题行右侧会出现 **「打开 Chrome Inspect」**：由本机桥接唤起 Chrome 的 **`chrome://inspect`**，与手动打开 Inspect 一致，用于审查 WebView、看网络等。

**需应用开启 WebView 调试**（`debuggable` 调试包或正式包在调试环境调用 `WebView.setWebContentsDebuggingEnabled(true)`）。**腾讯 X5 / UC 等非 Chromium 内核**在 Inspect 中同样无法列出。

桥接仍保留 **`/api/webview-pages`** 等接口供内部/扩展使用；前端默认不再调用 **`getH5Info`**。

---

## 顶层 Activity

与在设备上执行（示意）等价：

```bash
adb shell "dumpsys activity | grep -E 'topActivity|mResumedActivity' | head -1"
```

界面展示解析后的 **包名、Activity、任务 ID** 及 **原始首行**，便于与真机输出对照。连接后点面板 **刷新** 更新。

---

## Scheme / Deep Link 测试

在 **「Scheme 跳转测试」** 区域：

1. 输入 **自定义 scheme / App Link / https** 等。  
2. **跳转**：前端解析规范化后执行 `am start -a android.intent.action.VIEW -d "…"`。  
3. **可选包名**：填写合法包名时追加 **`-p`**，限定由指定应用处理。

结果区展示解析摘要与设备返回信息。

---

## 扩展调试（工具箱 Tab）

在 **工具箱** 底部 **「扩展调试」** 区域可一键使用（均需桥接与本机 ADB）：

| 能力 | 说明 |
|------|------|
| **安装 APK** | `POST /api/install-apk?serial=`，正文为 APK 原始字节（覆盖安装 `-r -t -d`）。 |
| **从项目路径安装** | `POST /api/install-apk-from-path`，body 为项目根下相对路径（如 `app/build/outputs/apk/debug/app-debug.apk`），禁止 `..`。 |
| **强制停止 / 仅清缓存** | 强停走 `am force-stop`；清缓存走 `cmd package clear-cache`（部分系统不支持会报错）。 |
| **崩溃线索** | `POST /api/debug-artifacts`：ANR 目录列表、tombstone 抽样、crash buffer、dropbox 尾部（权限不足时对应段落会失败）。 |
| **全局 HTTP 代理** | `GET/POST /api/http-proxy`：读写 `settings global http_proxy`（`host:port` 或清除）。 |
| **权限摘要** | `GET /api/package-permissions`：`dumpsys package` 后过滤权限相关行。 |
| **run-as** | `GET /api/run-as-list`、`GET /api/run-as-file`：仅 **debuggable** 包；下载路径限定 `databases/*` 与 `shared_prefs/*.xml`。 |
| **Monkey** | `POST /api/monkey`：事件数与节流有上限，耗时与事件量相关。 |
| **WebView 摘要** | `GET /api/webview-summary`：DevTools 套接字数与可调试页面数（与 `chrome://inspect` 同源枚举）。 |
| **Issue 模板** | 一键复制 Markdown（设备、序列号、栈顶、版本等），便于贴飞书/Jira。 |

大体积 APK 上传请保持 **启动脚本 / npm start** 打开的桥接与前端代理窗口不关；若安装超时，可在项目根用命令行 `adb install -r` 对照。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| **连不上设备 / Failed to fetch** | 确认已 **`npm start`**。开发时页面在 **:3000**，接口已 **经 Vite 代理到本机 3003**，浏览器只需能访问 **3000**；勿依赖手机直连 **电脑IP:3003**（易被本机防火墙拦）。 |
| **`adb devices` 为 offline** | 换线/换口、USB 文件传输、撤销 USB 调试授权后重插、`adb kill-server && adb start-server`，直到变为 **device**。 |
| **端口占用** | 优先重新 **`npm start`**（会自动释端口）；或 `lsof -i :3000` 等手动查杀。 |
| **镜像卡、延迟高** | **网页内**仅为 ADB 截图预览，略卡属正常；**流畅画面请看自动弹出的本机 Scrcpy 窗口**。若未弹出，看 **`[scrcpy]`** 日志与 **`adb devices`**。 |
| **截图 / 镜像失败** | 确认 **3003** 与设备 **device**；多机时核对顶栏 **序列号** 是否为当前手机。 |
| **WebView 在 Inspect 里看不到** | 确认已 **`WebView.setWebContentsDebuggingEnabled(true)`**、非 X5/UC 等内核；用 **「打开 Chrome Inspect」** 或手动开 **`chrome://inspect`**。若 **未走 3000 代理**导致桥接异常，请 **重启 `npm start`**。 |

---

## 许可证与说明

本项目为本地调试工具，请仅在 **合法授权** 的设备上使用。
