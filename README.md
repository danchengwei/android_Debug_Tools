# 安卓调试工具（本地 ADB + Web）

在浏览器内连接真机调试：**屏幕镜像（Scrcpy 视频流优先）**、**顶层 Activity**、**环境信息**、**WebView / H5 完整地址**、布局、日志、Trace、反编译、Scheme 跳转、AI 对话等。

- 前端默认 **http://127.0.0.1:3000**
- 命令与截图经本机 **ADB HTTP 桥接** **http://127.0.0.1:3003**（与页面同主机时可自动用局域网 IP，避免跨主机请求失败）
- **一键启动**：`npm start` → `scripts/start-all.mjs` 释端口后并行 **桥接 + scrcpy-server + Vite**

---

## 环境要求

| 项 | 说明 |
|----|------|
| **Node.js** | 18+（建议 LTS） |
| **ADB** | 本机已安装，`adb devices` 中设备状态须为 **`device`**（`offline` / `unauthorized` 时无法调试） |
| **scrcpy** | 建议安装（[Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)）。**`npm start` 默认会起 `scrcpy-server.js`**；若不需要视频流可用 **`npm run dev:lite`** |
| **浏览器** | 推荐 **Chrome / Edge**；镜像 **H.264 解码**依赖 **WebCodecs** |
| **Gemini AI** | 可选：项目根目录 `.env.local` 中配置 `GEMINI_API_KEY` |

**环境变量（可选）**

- **`ADB_PATH`**：显式指定 `adb` 可执行文件路径（如 Android SDK `platform-tools/adb`）。桥接启动日志会打印实际使用的路径。
- **`SCRCPY_PATH`**：显式指定 `scrcpy`。未设置时依次尝试 Homebrew、`/usr/local` 等，否则使用 PATH 中的 `scrcpy`。

---

## 启动服务

### 一键启动（推荐）

```bash
npm install
npm start
```

与 **`npm run dev` 完全等价**。执行流程：

1. 运行 **`scripts/start-all.mjs`**  
   - 尝试释放端口：**3000**（Vite）、**3003**（桥接）、**13377**（Scrcpy WebSocket）、**13378**（Scrcpy HTTP 健康检查）  
   - **macOS / Linux**：尽力 `pkill` 旧的 `adb-server.js` / `scrcpy-server.js`  
   - **Windows**：通过 `netstat` + `taskkill` 尽力释端口（若仍有占用可手动结束进程）
2. 并行启动：  
   - **bridge**：`node adb-server.js`  
   - **scrcpy**：`node scrcpy-server.js`（转发 H.264 至 `ws://主机:13377`）  
   - **vite**：`vite --host 127.0.0.1`

浏览器打开：**http://127.0.0.1:3000/**。终端中日志带 **`[bridge]`**、**`[vite]`**、**`[scrcpy]`** 前缀。

> **说明**：`concurrently` **未**使用 `-k`，任一侧进程异常退出时，其余服务可能仍在运行；修复后重新 **`npm start`** 即可。

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

| 模式 | 条件 | 说明 |
|------|------|------|
| **Scrcpy 视频流** | `ws://页面主机:13377` 连通且浏览器支持 **WebCodecs** | H.264 解码后绘制 Canvas，流畅度好。**`npm start` 默认启动 `scrcpy-server.js`**。 |
| **ADB 连续截图** | 桥接 **3003** 可用（`GET /api/screen`） | 与 Scrcpy **并行**；Scrcpy 未就绪时兜底。全屏 PNG，约 **5～9 帧/秒**，**延迟明显更高**。 |

- 顶栏会显示 **「Scrcpy · x FPS」** 或 **「ADB 截图…」**。  
- 镜像工具栏 **刷新** 可重连 WebSocket / 解码器。  
- 若长期只有 ADB 截图：查看 **`[scrcpy]`** 日志、本机是否安装 scrcpy、设备是否为 **`device`**。

---

## WebView / H5 调试（完整访问地址）

面板 **「WebView H5 调试」** 会从设备侧 **多段 `dumpsys` 输出** 聚合解析（包括但不限于）：

- `dumpsys activity top`  
- `dumpsys activity activities`（截断前若干行，避免过大）  
- `dumpsys window windows`（截断）  
- 若有前台包名：再 grep 该包相关片段（包名经校验，仅字母数字与 `_` `.`）

从中提取 **http(s) / file** 完整链接（尽量保留 **query、hash**），并识别常见字段如 **`mUrl` / `mOriginalUrl` / `HistoryUrl` / `loadedUrl`** 等，生成：

- **主地址 `currentUrl`**：优先关键字行中的 URL，否则取长匹配。  
- **`urlCandidates`**：去重后的候选列表，界面可展开逐条 **复制**。  
- **`webViewUserAgent`**：若 dumpsys 中能解析到 WebView **User-Agent** 会单独展示。  

> 地址来源仍为系统 dumpsys，**若 ROM 或壳包不把真实 URL 暴露在 activity 记录中**，可能仍不完整；可与 **`chrome://inspect`** 对照。  

连接设备并打开含 WebView 的页面后，点击该面板 **刷新** 拉取最新数据。AI 侧栏上下文会附带主 URL、WebView UA（若有）及候选地址列表。

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

## 常见问题

| 现象 | 处理 |
|------|------|
| **连不上设备 / Failed to fetch** | 确认已 **`npm start`**，桥接监听 **3003**；若用手机通过电脑 IP 打开页面，桥接需在同网段可达（桥接默认 `0.0.0.0`）。 |
| **`adb devices` 为 offline** | 换线/换口、USB 文件传输、撤销 USB 调试授权后重插、`adb kill-server && adb start-server`，直到变为 **device**。 |
| **端口占用** | 优先重新 **`npm start`**（会自动释端口）；或 `lsof -i :3000` 等手动查杀。 |
| **镜像卡、延迟高** | 多为 **ADB 截图兜底**；确认 **`[scrcpy]`** 无报错，顶栏应出现 **Scrcpy · FPS**。 |
| **截图 / 镜像失败** | 确认 **3003** 与设备 **device**；多机时核对顶栏 **序列号** 是否为当前手机。 |
| **H5 地址不准或没有** | 依赖 dumpsys 可见性；换 ROM/壳或 WebView 实现后字段可能不同，可看 **候选地址列表** 或 `chrome://inspect`。 |

---

## 许可证与说明

本项目为本地调试工具，请仅在 **合法授权** 的设备上使用。
