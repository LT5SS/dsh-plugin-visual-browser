# `dsh-plugin-visual-browser` (v1.1.0 — DSH 0.2.x Compatible)

为 **DeepSeek Harness (`@deepseek-ai/dsh@0.2.x`)** 打造的 **“可视化虚拟鼠标 + 视觉多模态走查 + 独立子代理（Subagent）隔离 + 100% 后台静默无打扰”** 浏览器插件。

---

## ✨ 核心特性

1. **原生兼容 DSH 0.2.x (`@deepseek-ai/dsh-tools@0.2.x` & `@deepseek-ai/cordis@4.x`)**
   - 使用官方 `defineTool()` 构建全部 4 个工具定义，具备完整的 JSON Schema `parameters` 与 `output: { schema, render }` 声明（通过 `assertSupportedJsonSchema` 真契约校验）；
   - **原生对接 `ctx.llm` 与 `ctx.attachments`**：子代理默认直接复用 DSH 宿主当前配置的模型路由（无需额外配置 API Key），且截图自动通过 `ctx.attachments.saveImage()` 登记为 `{ type: 'image', attachment }` 内容块，让主模型真正“看”到画面；
   - **协作式取消（`exec.signal`）与生命周期清理（`ctx.effect`）**：用户在 DSH 中断对话时立即关闭后台浏览器进程；插件卸载时通过 `ctx.effect(() => disposer)` 自动回收所有挂起态会话。
2. **双模自适应 + 100% 后台静默（零焦点抢占）**
   - **DSH Electron 桌面端模式**：检测到 `DSH_WEBVIEW_CDP_URL` 时自动挂载右侧边栏内置 `<webview>`；
   - **本地 Chrome/Edge 后台静默模式**：基于 `playwright-core` 自动探测本机已安装的 **Google Chrome** 或 **Microsoft Edge**（也可通过环境变量 `DSH_BROWSER_EXECUTABLE` 指定浏览器路径），默认通过 `--headless=new` + 60fps 渲染保活参数在后台静默运行——**零弹窗、零焦点抢占**。
3. **物理轨迹虚拟鼠标 + 自定义拖尾样式**
   - 三次贝塞尔弧线（Cubic Bezier）+ Ease-In-Out 速度曲线步进器，派发连续真实的 `pointermove` / `wheel` 事件；
   - 支持 **5 套内置预设**（`cyber-neon`、`comet-gold`、`laser-dots`、`stealth-minimal`、`clean-none`）以及任意自定义颜色、粗细、长度与形态（`dashed`、`solid`、`comet`、`dots`、`none`）；
   - 采用 Chromium `popover="manual"` Top-Layer 技术，即使网页弹出原生 `<dialog>` 模态框，虚拟鼠标和拖尾也始终浮在最顶层。
4. **独立 Browser Subagent 循环 + 截图滑动窗口（省 80%+ 视觉 Token）**
   - 子循环内部默认只保留最近 3 张高清截图，旧步骤自动压缩为单行文字轨迹，不污染主 Agent 上下文；
   - 宿主代码强制生成不可伪造的 `[BROWSER_HOST_FACTS]` 校验头；
   - 默认截图产物保存在绝对路径 `$DSH_HOME/artifacts/dsh-browser`（或 `~/.dsh/artifacts/dsh-browser`），不会随启动目录漂移。
5. **自动门禁检测与原位人工接管（Approval Cards & Resume）**
   - 自动检测登录墙、支付结算页或 CAPTCHA 人机验证（绝不尝试绕过验证码），在原标签页挂起会话并返回 `DSH_BROWSER_TAKEOVER_CARD`，用户完成后可通过 `browser_subagent_resume` 原位继续。

---

## 🛠️ 环境要求与安装

### 1. 本机浏览器要求
本插件使用轻量的 `playwright-core`，不会重复下载几百 MB 的捆绑浏览器，而是自动寻找本机已安装的 **Google Chrome** 或 **Microsoft Edge**。若浏览器安装在非标准路径，可设置环境变量：
```bash
export DSH_BROWSER_EXECUTABLE="C:/Program Files/Google/Chrome/Application/chrome.exe"
```

### 2. 在 DSH 0.2.x 中安装与启动

**方式 A：安装到 DSH Profile（推荐）**
```bash
dsh plugin --profile web add dsh-plugin-visual-browser
dsh --patch ./cordis.yml --profile web
```

**方式 B：本地源码构建与绝对路径挂载**
> ⚠️ **注意**：
> 1. DSH CLI 的 `--patch` 是 launcher 选项，**必须放在 `--profile` 之前**；
> 2. Cordis 解析 `cordis.yml` 中的相对路径时是以 profile 目录（`baseUrl`）为基准，若直接挂载本地未安装的构建目录，请在 `cordis.yml` 的 `name` 中填写 `dist/index.js` 的**绝对路径**（例如 `E:/AI_Work/Antigravity/dsh-plugin-visual-browser/dist/index.js`）。

```bash
npm install
npm run build
npm run test:contract
dsh --patch ./cordis.yml --profile web
```

---

## 🧰 注册到 DSH 的 4 个工具

| 工具名 | 说明 |
| :--- | :--- |
| `browser_subagent_run` | 启动独立视觉浏览器子代理执行多步网页走查/交互（优先使用宿主 `ctx.llm`，其次 `DSH_VISION_API_KEY`，无配置时自动启用内置自主走查巡检器），返回报告、`[BROWSER_HOST_FACTS]` 及最新截图附件 |
| `browser_subagent_resume` | 在用户完成登录、支付或验证码接管后，在原标签页恢复已挂起（`PAUSED_FOR_TAKEOVER`）的子代理会话 |
| `browser_set_cursor_trail` | 实时切换虚拟鼠标与拖尾预设（`cyber-neon` / `comet-gold` / `laser-dots` / `stealth-minimal` / `clean-none`）或自定义颜色/粗细/长度 |
| `browser_quick_snapshot` | 在后台静默对指定 URL 进行单次“视觉截图 + `#ref` 控件树 + 控制台健康度”快照，并通过 `ctx.attachments` 返回 `ImageBlock` 让主模型直接看图 |
