# `dsh-plugin-visual-browser`

为 **DeepSeek Harness (DSH)** 打造的 **“可视化虚拟鼠标 + 视觉多模态走查 + 独立子代理（Subagent）隔离 + 100% 后台静默无打扰”** 浏览器插件。

---

## ✨ 核心特性

1. **双模自适应 + 100% 后台静默（零焦点抢占）**
   - **DSH Electron 桌面端模式**：当检测到 `DSH_WEBVIEW_CDP_URL` 时，自动挂载右侧边栏内置 `<webview>`；
   - **本地 Chrome/Edge 后台静默模式**：自动寻找系统已安装的 Chrome 或 Edge，默认通过 `--headless=new` + 60fps 渲染保活参数在后台静默运行——**不弹任何窗口、不抢占你当前编辑器或聊天框焦点**，同时完整支持 WebGL、Canvas、GSAP 和 Lenis 平滑滚动。
2. **物理轨迹虚拟鼠标 + 自定义拖尾样式**
   - 三次贝塞尔弧线（Cubic Bezier）+ Ease-In-Out 速度曲线步进器，派发连续真实的 `pointermove` / `wheel` 事件；
   - 支持 **5 套内置预设**（`cyber-neon`、`comet-gold`、`laser-dots`、`stealth-minimal`、`clean-none`）以及任意自定义颜色、粗细、长度、发光与形态（`dashed` 虚线、`solid` 实线光带、`comet` 彗星宽尾、`dots` 粒子点阵、`none` 无拖尾）；
   - 采用 Chromium `popover="manual"` Top-Layer 技术，即使网页弹出原生 `<dialog>` 模态框，虚拟鼠标和拖尾也始终浮在最顶层。
3. **“视觉截图 + `#ref` 交互控件树 + DOM/控制台健康度”三合一采样器**
   - 每次动作后自动截取带虚拟鼠标位置与轨迹的视口快照，同时提取视口内可点击元素的 `#1 ~ #N` 编号、坐标、Canvas/SVG/Video 数量以及 `ConsoleError` / HTTP 失败请求计数。
4. **独立 Browser Subagent 循环 + 截图滑动窗口（省 80%+ 视觉 Token）**
   - 主 Agent 只需调用 `browser_subagent_run`；
   - 子循环内部默认只保留最近 3 张高清截图，旧步骤自动压缩为单行文字轨迹，不污染主 Agent 上下文；
   - 宿主代码强制生成不可伪造的 `[BROWSER_HOST_FACTS]` 校验头（记录真实访问域名、拦截域名、最新截图路径与报错计数）。
5. **自动门禁检测与原位人工接管（Approval Cards & Resume）**
   - 自动检测登录墙、支付结算页或 CAPTCHA 人机验证（绝不尝试绕过验证码），在原标签页挂起会话并返回 `DSH_BROWSER_TAKEOVER_CARD`，用户完成后可通过 `browser_subagent_resume` 原位继续。

---

## 🛠️ 在 DSH 中挂载使用

1. 构建插件：
   ```bash
   npm install
   npm run build
   ```
2. 使用 `cordis.yml` 补丁启动 DSH：
   ```bash
   pnpm dsh web --patch ./cordis.yml
   ```
3. （可选）配置多模态视觉大模型环境变量：
   ```bash
   export DSH_VISION_API_KEY="sk-..."
   export DSH_VISION_BASE_URL="https://api.openai.com/v1"
   export DSH_VISION_MODEL="gpt-4o"
   ```

---

## 🧰 注册到 DSH 的 4 个工具

| 工具名 | 说明 |
| :--- | :--- |
| `browser_subagent_run` | 启动独立视觉浏览器子代理执行多步网页走查/交互，返回结构化报告与 `[BROWSER_HOST_FACTS]` |
| `browser_subagent_resume` | 在用户完成登录、支付或验证码接管后，在原标签页恢复已挂起（`PAUSED_FOR_TAKEOVER`）的子代理会话 |
| `browser_set_cursor_trail` | 实时切换虚拟鼠标与拖尾预设（`cyber-neon` / `comet-gold` / `laser-dots` 等）或自定义颜色/粗细/长度 |
| `browser_quick_snapshot` | 在后台静默对指定 URL 进行单次“视觉截图 + `#ref` 控件树 + 控制台健康度”快照 |
