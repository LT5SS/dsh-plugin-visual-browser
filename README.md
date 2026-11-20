# `dsh-plugin-visual-browser` (v1.2.0 — Visible Background Window & Live Takeover Release)

为 **DeepSeek Harness (`@deepseek-ai/dsh@0.2.x`)** 打造的 **“可视化虚拟鼠标 + 视觉多模态走查 + 独立子代理（Subagent）隔离 + 100% 后台静默无打扰”** 浏览器插件。

---

## ✨ 核心特性

1. **原生兼容 DSH 0.2.x (`@deepseek-ai/dsh-tools@0.2.x` & `@deepseek-ai/cordis@4.x`)**
   - 使用官方 `defineTool()` 构建全部 4 个工具定义，具备完整的 JSON Schema `parameters` 与 `output: { schema, render }` 声明（通过宿主 `assertSupportedJsonSchema` + `assertObjectJsonSchema` 真契约校验）；
   - **`dsh.bundle.patch` 标准 Bundle 清单**：支持通过 `dsh plugin --profile <profile> add link:<abs_path>` 直接写入 `dsh.profile.bundles`；
   - **`peerDependencies` 零副本冲突**：`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis` 声明为 `peerDependencies`，运行时直接复用 DSH 宿主实例的包与 Symbol，不产生私有副本分叉；
   - **原生对接 `ctx.llm` 与 `ctx.attachments`（Cordis 4.x 二级注入 + 自动降级诊断）**：通过 `ctx.inject(['llm'], ...)` 与 `ctx.inject(['attachments'], ...)` 惰性绑定宿主可选服务（服务未注册时不阻塞极简宿主启动）；若当前宿主模型拒绝图片附件会自动回退为纯文本重试，若遇到空流或非 JSON 输出则安全降级至 `builtin-inspector`，在工具渲染文本末尾直接输出 `— planner: ... | host services: ... | route: ...` 诊断摘要并将 `diagnostics.json` 落盘到同级截图目录；截图通过 `ctx.attachments.saveImage()` 登记为 `{ type: 'image', attachment }` 内容块；
   - **协作式取消（`exec.signal`）与生命周期清理（`ctx.effect`）**：用户在 DSH 中断对话时立即关闭后台浏览器进程；插件卸载时通过 `ctx.effect(() => disposer)` 自动回收所有挂起态会话。
2. **双模自适应 + 可见后台不抢焦点窗口（`visible-background`）**
   - **DSH Electron 桌面端模式**：检测到 `DSH_WEBVIEW_CDP_URL` 时自动挂载右侧边栏内置 `<webview>`；
   - **本地 Chrome/Edge 可见后台模式（默认 `windowMode: 'visible-background'`）**：基于 `playwright-core` 自动探测本机已安装的 **Google Chrome** 或 **Microsoft Edge**，在 Windows 上通过 Win32 `SW_SHOWMINNOACTIVE` → `SW_SHOWNOACTIVATE` + `SetWindowPos` 将窗口平铺在屏幕右半边并置于当前前景窗口之后——**用户全程可见 AI 操作且不会突然弹到最顶层抢占焦点**；同时支持持久化单窗口复用（`keepWindowOpen: true`）、页内右上角 **「⏸ 暂停并接管」** 悬浮按钮随时接管，或切换为 `minimized` / `headless`（`backgroundSilent: true`）静默模式。
3. **物理轨迹虚拟鼠标 + 自定义拖尾样式**
   - 三次贝塞尔弧线（Cubic Bezier）+ Ease-In-Out 速度曲线步进器，派发连续真实的 `pointermove` / `wheel` 事件；
   - 支持 **5 套内置预设**（`cyber-neon`、`comet-gold`、`laser-dots`、`stealth-minimal`、`clean-none`）以及任意自定义颜色、粗细、长度与形态（`dashed`、`solid`、`comet`、`dots`、`none`）；
   - 采用 Chromium `popover="manual"` Top-Layer 技术，即使网页弹出原生 `<dialog>` 模态框，虚拟鼠标和拖尾也始终浮在最顶层。
4. **独立 Browser Subagent 循环 + 截图滑动窗口（省 80%+ 视觉 Token）**
   - 子循环内部默认只保留最近 3 张高清截图，旧步骤自动压缩为单行文字轨迹，不污染主 Agent 上下文；
   - 宿主代码强制生成不可伪造的 `[BROWSER_HOST_FACTS]` 校验头；
   - 截图目录优先按 `config.artifactDir` → `DSH_BROWSER_ARTIFACT_DIR` → `DSH_HOME/artifacts/dsh-browser` → `~/.dsh/artifacts/dsh-browser` 解析（桌面 pack 模式下会跟随宿主注入的 `DSH_HOME`），不会落到找不到的外部目录。
5. **自动门禁检测与原位人工接管（Approval Cards & Resume）**
   - 自动检测登录墙、支付结算页或 CAPTCHA 人机验证（绝不尝试绕过验证码），在原标签页挂起会话并返回 `DSH_BROWSER_TAKEOVER_CARD`，用户完成后可通过 `browser_subagent_resume` 原位继续。

---

## 🛠️ 环境要求与安装流程（实测可用）

### 1. 本机浏览器要求
> ⚠️ **`playwright-core` 不会自动下载几百 MB 的浏览器**，本机必须已安装 **Google Chrome** 或 **Microsoft Edge**（Windows 标准路径 `C:\Program Files\Google\Chrome\Application\chrome.exe` 与 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 会被自动探测）。

若浏览器安装在非标准路径，可通过环境变量 `DSH_BROWSER_EXECUTABLE` 指定：
- **Windows (PowerShell)**:
  ```powershell
  $env:DSH_BROWSER_EXECUTABLE="D:\CustomPath\Chrome\Application\chrome.exe"
  ```
- **macOS / Linux (Bash / Zsh)**:
  ```bash
  export DSH_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ```

### 2. 安装到 DSH Profile（推荐 `link:` Bundle 模式）

> 💡 本包目前通过 GitHub Releases 分发（尚未发布至公共 npm registry，请勿直接运行不带 `link:` 的 `dsh plugin add dsh-plugin-visual-browser`）。

```bash
# 1. 下载最新 Release zip (v1.2.0+) 并解压到你的插件目录，例如：
#    <DSH_HOME>/plugins/dsh-plugin-visual-browser

# 2. 进入插件目录，仅安装运行时依赖（playwright-core；dsh-tools 与 cordis 自动复用宿主版本，不要把私有副本装进 node_modules）
cd <DSH_HOME>/plugins/dsh-plugin-visual-browser
npm ci --omit=dev --omit=peer
# 注：使用 pnpm 或旧版 npm 遇到 peer 提示时，也可加 --legacy-peer-deps（效果等价）

# 3. 挂载到你的目标 profile（会自动校验 package.json 中的 dsh.bundle.patch 并写入 dsh.profile.bundles）
dsh plugin --profile <your-profile> add link:<插件目录的绝对路径>

# 4. 确认配置已成功合成（应能看到 dsh-plugin-visual-browser 配置块且无 skipping profile bundle 警告）
dsh --profile <your-profile> --dump-config

# 5. ⚠️ 重要：必须重启 DSH！
#    Bundle 工具是在 DSH 启动时合成的，安装后必须重启 DSH 实例，4 个 browser_* 工具才会出现在模型身上。
```

### 3. 本地源码开发与 `--patch` 调试

如果你想直接克隆源码修改并通过 `--patch` 临时挂载：
> ⚠️ **注意两点**：
> 1. DSH CLI 的 `--patch` 是 launcher 选项，**必须放在 `--profile` 之前**；
> 2. Cordis 解析 patch 文件中的相对路径时以 profile 目录（`baseUrl`）为基准，若未通过 `dsh plugin add link:...` 安装进 profile，请在 patch 文件的 `name` 中填写 `dist/index.js` 的**绝对路径**。

```bash
npm install
npm run build
npm run test:contract
dsh --patch ./cordis.yml --profile web
```

### 4. 可选环境变量

| 环境变量 | 说明 |
| :--- | :--- |
| `DSH_BROWSER_EXECUTABLE` | 自定义本机 Chrome / Edge 可执行文件绝对路径 |
| `DSH_BROWSER_WINDOW_MODE` | 可选：强制指定窗口模式（`visible-background` / `minimized` / `headless`） |
| `DSH_BROWSER_ARTIFACT_DIR` | 自定义截图保存目录绝对路径（未设置时依次回退 `DSH_HOME/artifacts/dsh-browser` 与 `~/.dsh/artifacts/dsh-browser`） |
| `DSH_WEBVIEW_CDP_URL` | 若需显式指定 DSH 内置 Webview 或外部浏览器的 CDP 调试端点 |
| `DSH_VISION_API_KEY` | 可选：若不走宿主 `ctx.llm`，可单独指定外部 OpenAI 兼容多模态 API Key |

---

## 🧰 注册到 DSH 的 4 个工具（安装后需重启 DSH 生效）

| 工具名 | 说明 |
| :--- | :--- |
| `browser_subagent_run` | 启动独立视觉浏览器子代理执行多步网页走查/交互（默认复用右侧可见后台窗口，支持 `window_mode` 覆写及页面右上角「暂停并接管」即时暂停），返回报告、`[BROWSER_HOST_FACTS]` 及最新截图附件 |
| `browser_subagent_resume` | 在用户手动点击「暂停并接管」或完成登录、支付、验证码接管后，在原窗口原标签页恢复已挂起（`PAUSED_FOR_TAKEOVER`）的子代理会话 |
| `browser_set_cursor_trail` | 实时切换虚拟鼠标与拖尾预设（`cyber-neon` / `comet-gold` / `laser-dots` / `stealth-minimal` / `clean-none`）或自定义颜色/粗细/长度 |
| `browser_quick_snapshot` | 对指定 URL 进行单次“视觉截图 + `#ref` 控件树 + 控制台健康度”快照（空闲时复用可见后台窗口，否则静默执行），并通过 `ctx.attachments` 返回 `ImageBlock` 让主模型直接看图 |
