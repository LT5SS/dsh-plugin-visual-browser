# `dsh-plugin-visual-browser` (v1.4.2 — Coordinate `inspect_motion` Pixel Diff, Controls Filter Stats, `visualPalette` & `TRUNCATED_JSON` Diagnostics)

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
3. **物理轨迹虚拟鼠标 + DSH 原生可视化设置页（预设 / 自定义指针 & 拖尾）**
   - 三次贝塞尔弧线（Cubic Bezier）+ Ease-In-Out 速度曲线步进器，派发连续真实的 `pointermove` / `wheel` 事件；
   - 支持 **5 套内置预设**（`cyber-neon`、`comet-gold`、`laser-dots`、`stealth-minimal`、`clean-none`）+ `custom`，以及 **7 种指针造型**（`arrow`、`crosshair`、`dot`、`star`、`ring`、`custom-svg` 自定义路径、`custom-image` 上传本地图标或图片 URL + 热点偏移）；
   - 通过 `dsh.client` 与 live `.volatile()` Schema 在 DSH **设置 → 视觉浏览器**（以及 **插件 → dsh-plugin-visual-browser** 详情页）提供实时交互预览画布与全部参数调色板；当宿主 `settings.section` 未注入可写 `configForm`（如 DSH `0.2.1-rc.2`）时，自动通过插件自有持久化通道（`$DSH_HOME/artifacts/dsh-browser/settings.json` + `/__dsh_visual_browser/settings` HTTP 端点）写入落盘并在重启 DSH 后继续生效，同时实时热更新所有已打开的窗口与跨导航状态；
   - **拖动与滚动视觉区分**：子代理新增 `drag` 动作（`mouse.move` → `down` → 贝塞尔插值 → `up`），呈现按下收缩 `scale(0.86)` + 加粗边框、反向渐变加粗拖尾、起点虚线锚点圈与 `DRAG`/`DROP` 徽标；拖动期间自动抑制原生 `dragstart` 与整页误选并在释放后清理选区（可选 `keepSelection: true` 保留选区），同时在约 50% 进度处自动抓取 `*_drag_mid.png` 过程证据帧写入 `diagnostics.json` (`mid_frame`)；设置预览画布同步支持移动拖尾、点击波纹与按住拖动演示；`scroll` 动作在指针旁显示上下分向高亮 `▲`/`▼` 指示器（向下滚高亮 `▼`、向上滚高亮 `▲`）+ 竖直方向短脉冲并在结束后 400ms 自动恢复；
   - **HUD 徽标防裁切、CSS 隔离与坐标同步**：顶层注入 UI 带作用域 CSS Reset（不受页面全局 `svg`/`div` margin/width 规则干扰），光标光环与箭头精确对齐落点，导航后宿主 `Virtual Cursor` 与页面徽标坐标实时保持一致；
   - 采用 Chromium `popover="manual"` Top-Layer 与 **点击前 `elementsFromPoint` 穿透层级命中测试**（穿透 Shadow DOM 与同源 iframe）：运行期右上角接管提示条默认 `pointer-events: none` 不挡下方 `Menu` 等站点元素；一旦任意点击落点命中处于顶层且可交互的插件 UI，立即拒绝派发真实 `mouse.click` 并返回 `{ ok: false, blocked: 'PLUGIN_UI_LAYER', hit }` 记录入 `diagnostics.json`；默认支持按 `F8`（可在设置自定义热键）随时触发人工接管。
   - **运行/暂停期关窗保护与 `SESSION_LOST` 安全恢复**：任务执行或 `PAUSED_FOR_TAKEOVER` 期间自动启用 `beforeunload` 守卫，回到 `idle` 或插件主动关闭会话前自动卸载；监听 `browser.on('disconnected')` 在窗口被手动关闭后清理挂起会话并向 `diagnostics.json` 追加 `browser_disconnected` 事件，后续调用 `browser_subagent_resume` 返回结构化 `SESSION_LOST` / `SESSION_NOT_FOUND` 状态而不再抛出裸 `Target closed` 异常。
     > ⚠️ **Chrome `beforeunload` 说明（非插件缺陷）**：Chrome 要求页面有过用户激活（如点击页面或按 `F8`）后才会弹出「离开此网站？」系统确认框，确认框文案由浏览器决定不可自定义，纯 headless 无窗口会话也不会弹窗；无论是否弹窗，关闭窗口后插件都会安全认账清理并在下次快照/运行自动重开窗口。
   - 支持 `?__dsh_test_center_pill=1` 测试开关，可将插件状态条临时居中用于验证 Top-Layer 遮挡拒点行为。
4. **独立 Browser Subagent 循环 + 截图滑动窗口（省 80%+ 视觉 Token）**
   - 子循环内部默认只保留最近 3 张高清截图，旧步骤自动压缩为单行文字轨迹，不污染主 Agent 上下文；
   - 宿主代码强制生成不可伪造的 `[BROWSER_HOST_FACTS]` 校验头；
   - **稳健导航等待与诊断（`domcontentloaded` + settle）**：默认等待条件为 `'domcontentloaded'` 并追加 5s 上限 `load` settle + 600ms 首屏渲染缓冲，支持通过 `browser_subagent_run` / `browser_quick_snapshot` 的可选参数 `wait_until`（`'domcontentloaded' | 'load' | 'networkidle'`）与 `timeout_ms`（`1000..120000`）按需覆写；对 `ERR_NETWORK_CHANGED` / `ERR_CONNECTION_RESET` / `ERR_CONNECTION_ABORTED` / `ERR_CONNECTION_CLOSED` / `ERR_TIMED_OUT` 等瞬时网络错误自动退避重试 1 次并记录 `retries` / `recovered_from`；即使长轮询/WebGL 常驻动画站点触发 `goto` 超时，只要页面已实质加载提交即不中止取证，并将 `navigation: { wait_until, timed_out, elapsed_ms, final_url }` 写入 HUD 与 `diagnostics.json`；当页面存在 `<canvas>` 时，HUD 自动补充 `tech: WebGL canvas` 交互提示；
   - **自推进站点鲁棒性与结构化失败恢复（v1.3.3）**：点击/悬停 `#ref` 前通过瞬时 `isVisible + boundingBox + computedStyle` 探针校验新鲜度，目标已隐藏/消失时立即返回 `blocked: 'REF_STALE'` 并重采样，不再枯等 8s 抛错中止整轮；支持可选 `{ type: 'click', target, if_present: true }` 条件点击（目标已消退时视为跳过完成）；单步可恢复错误进入统一观察反馈与错误预算（不同目标首次 `REF_STALE` 零消耗，同一目标连续两次 stale 计 1 次，其它可恢复错误连续 3 次优雅止损输出已采集报告）；HUD 提取仅取可见且未被 `overflow: hidden/clip` 裁切的节点文本并对整行重复自动折叠为 `(×N)`；`scroll` 额外返回 `{ attempted, effective_dom_delta, dom_scrollable, visual_changed, at_boundary, locked }` 以区分真实锁死与边界到达或 WebGL 虚拟滚轮；
   - **设计系统与结构感知 HUD + 跨步累积 `findings` 账本（v1.4.0 → v1.4.2）**：
     - 在既有 10 个 HUD 字段之后追加严格控长（`≤1200` 字符）的 `## Design` 块（`title` / 视口 `headings` / `sections` 边界 / `palette` 主色与强调色 / `fonts` 字体组 / `cssVars` / `layout` / `media` / `motion` / 视口可见 `bodyText` 及 `<canvas>` 主体提示；当 `<canvas>` 覆盖 `≥90%` 视口时，`palette` 自动标注 DOM 背景被覆盖并提示以截图为准）；
     - 独立于截图滑动窗口的 `FindingsLedger`（每步自动记录 + 支持模型可选 `note` 字段，注入 `## Findings so far` 与 `第1–3步：` 早期摘要，并将 `findings` 写入 `diagnostics.json`，上限 `≤12` 条 / `≤1200` 字符）；
     - **v1.4.1 新增**：`normSplit` 折叠逐字跑马灯并按几何位置重组 `h1–h3` 词距；`headings: n/a` 附带具体原因码（`视口内无 h1-h3` / `标题被裁切` / `标题可能在 <canvas> 内`）；0 控件时给出中性说明防止误判遮挡；`Scroll Result` 新增 `driver`（`wheel` / `programmatic`）与 Lenis 拦截提示；新增只读 `inspect_motion` 动作探针（悬停前后计算样式与 `getAnimations()` 差分）；宿主模型返回非 JSON 时自动带格式纠偏与 `temperature=0` 重试 1 次，并把原始片段写入 `diagnostics.json` `planner_detail.fallback_reason`；
     - **v1.4.2 新增**：`inspect_motion({ x, y })` 支持任意坐标与 `<canvas>` 区域探测，返回 `topElement` 与屏蔽插件层后的 32×32 PNG 前后帧像素差（`pixelChanged` / `pixelDiffMean` / `cssChanged`）；HUD 控件区块在存在过滤元素或 0 控件时输出 `Controls filtered: hidden=... · zero-size=... · clipped=... · offscreen=... · plugin-ui=...` 过滤归因计数；当 `<canvas>` 覆盖视口时 `## Design` 从既有截图 32×32 采样生成 `- visualPalette: #...`；子代理决策解析新增 `TRUNCATED_JSON` / `NOT_JSON` / `SCHEMA_MISMATCH` 归因、按步 `decision_parse` / `usage` / `max_tokens` 诊断落盘，以及降级时在报告末尾显式标注降级提示；
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
# 1. 下载最新 Release zip (v1.4.2+) 并解压到你的插件目录，例如：
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
| `browser_set_cursor_trail` | 实时切换虚拟鼠标预设（`cyber-neon` / `comet-gold` / `laser-dots` / `stealth-minimal` / `clean-none` / `custom`）、指针造型/自定义 SVG 或图片、拖尾光效及配色，并同步更新共享窗口 |
| `browser_quick_snapshot` | 对指定 URL 进行单次“视觉截图 + `#ref` 控件树 + 控制台健康度”快照（空闲时复用可见后台窗口，否则静默执行），并通过 `ctx.attachments` 返回 `ImageBlock` 让主模型直接看图 |

---

## 📌 v2.0.0 规划（TODO）

- **其余 4 + 1 固定只读探针与架构升级**：`inspect_dom`、`inspect_styles`、`extract_outline`、`inspect_media` 与 `inspect_region(x, y, radius?, zoom?)` 局部 2× 放大及前后帧区域差异文本补偿。
- **Win32 窗口置顶自愈**：启动后与复用前通过 `SetWindowPos(HWND_NOTOPMOST)` 纠正意外置顶状态。
