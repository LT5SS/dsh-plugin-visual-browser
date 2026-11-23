# `dsh-plugin-visual-browser` 分阶段开发方案（v1.1 双模自适应 + 后台静默版）

> 目标：在 **DeepSeek Harness (DSH)** 中复刻 Google Antigravity 同款的 **“可视化虚拟鼠标 + 视觉多模态走查 + 独立子代理（Subagent）隔离 + 随时人工接管”** 浏览器插件。
>
> **核心体验原则**：**后台静默无感运行（Zero Focus Stealing）**——无论是接管 DSH 内置 `<webview>` 还是调用本地 Chrome/Chromium，全程在后台合成渲染并通过 CDP 协议注入虚拟鼠标事件，**绝不弹窗抢占用户当前窗口焦点，绝不干扰用户的物理鼠标与键盘工作**。

---

## 核心架构：双模自适应 + 后台静默驱动

```
                      ┌─────────────────────────────────────────────┐
                      │         BrowserSession (双模自适应驱动)       │
                      └──────────────────────┬──────────────────────┘
                                             │ 自动探测运行环境
                     ┌───────────────────────┴───────────────────────┐
                     ▼                                               ▼
   [ 模式 A: DSH Electron 桌面端内置模式 ]            [ 模式 B: 本地 Chrome/Chromium 后台静默模式 ]
  • 挂载 `@deepseek-ai/dsh-client-ui-sidebar-browser` • 默认采用 `--headless=new` 新版后台渲染引擎
    的 Electron `<webview>` (CDP Debugger)            （具备完整 GPU/WebGL/Canvas 渲染力，但 0 弹窗、0 抢焦点）
  • 在右侧边栏或后台标签静默合成事件，不抢输入框焦点     • 或通过 CDP 端口静默附着已开启的后台 Target
  • 虚拟鼠标与轨迹直接在页面 DOM 内渲染                • 仅在用户主动点“实时围观 (Screencast)”或触发
                                                      “人工接管 (Takeover)”时才按需展示画面
```

---

## 分阶段推进计划（共 4 个阶段，逐阶段交付验收）

### 🟢 阶段一（Stage 1）：双模自适应底座 + 后台静默“物理轨迹虚拟鼠标”引擎（当前阶段）
**目标**：实现完全在后台静默运行的双模浏览器驱动，注入可视化虚拟鼠标 HUD，并通过贝塞尔曲线步进器触发网页真实连续交互，产出一组带虚拟鼠标轨迹与状态角标的后台实测截图/录屏。
- **交付物**：
  1. `src/driver/types.ts`：双模驱动配置接口（`auto` | `electron-webview` | `local-background` | `cdp-attach`）。
  2. `src/driver/browser-session.ts`：
     - **双模自适应**：优先探测 DSH Electron `<webview>` CDP 通道；若在独立环境或 `dsh web` 下，则自动以 **`--headless=new` + 禁用焦点抢占参数** 启动本地 Chrome/Chromium 后台实例（支持自动寻找系统已安装的 Chrome/Edge，无需重复下载大体积浏览器）。
     - **零打扰保证**：所有鼠标移动、悬停、点击、滚轮均通过页面级 CDP `Input` 合成事件派发，完全在后台执行，不弹窗、不抢焦点。
  3. `src/injected/virtual-cursor.ts`：
     - 自动注入页面的最高层级（`z-index: 2147483647`）虚拟鼠标 HUD；
     - 包含：高对比度带阴影光标箭头、**平滑残影尾迹（Motion Trail）**、**点击扩散水波纹（Click Ripple）**、以及跟随光标的 **`(x, y) · 动作状态` 实时胶囊浮标**。
  4. `src/driver/human-motion.ts`：
     - **三次贝塞尔弧线（Cubic Bezier）+ Ease-Out-Cubic 速度曲线步进器**；
     - 支持 `moveTo(x, y)`、`hover(selector)`、`click(selector)`、`smoothScroll(deltaY)`，将动作拆分为 20–35 帧连续 `pointermove` / `wheel` 事件流。
  5. `scripts/verify-stage1.ts`：
     - 阶段一后台静默验收脚本：在后台悄悄打开测试页面，驱动虚拟鼠标划出弧线尾迹、触发悬停与点击波纹、平滑滚屏，并将带虚拟鼠标 HUD 的关键帧截图保存到 `artifacts/stage1/` 供直接查看。

---

### 🔵 阶段二（Stage 2）：“视觉 + 精简 DOM + 控制台”三合一采样器 & 原子工具集
**目标**：让后台浏览器每做完一个动作，都能自动打包一份多模态模型能看懂的“现场快照包”。
- **交付物**：
  1. `src/sampler/page-snapshot.ts`：视口截图（含虚拟鼠标位置与滚动进度条）+ 可交互元素编号摘要 + 只读 DOM 统计（`<canvas>`/`<video>`/`<svg>`）+ `ConsoleError` 与 `404/500` 网络异常收集。
  2. `src/tools/atomic-tools.ts`：封装供 Agent 调用的原子工具（`navigate`, `move_mouse`, `click`, `hover`, `type_text`, `smooth_scroll`, `inspect_dom`）。

---

### 🟣 阶段三（Stage 3）：独立 Browser Subagent 循环 + `BROWSER_HOST_FACTS` 宿主校验
**目标**：实现独立上下文的多模态子代理循环（图片滑动窗口淘汰，不撑爆主对话 Token）与宿主级事实校验。
- **交付物**：
  1. `src/subagent/runner.ts`：独立多模态子代理循环与图片滑动窗口管理。
  2. `src/subagent/host-facts.ts`：宿主强制记录 `visited_origins`、`blocked_origins`、`latest_screenshot`。

---

### 🟠 阶段四（Stage 4）：DSH (Cordis) 插件标准封装 + 按需围观与人工接管
**目标**：按 `@deepseek-ai/cordis` 规范封装插件入口，并实现遇到登录/验证码时的按需唤醒接管。
- **交付物**：
  1. `src/index.ts` & `cordis.yml`：标准 DSH 插件入口。
  2. `src/guardrails/takeover.ts`：平时 100% 后台静默；仅当遇到登录、支付或验证码时，通过 DSH Approval Card 提示用户，并支持一键弹出该页面或通过 Screencast 画面流完成人工接管，完成后再次退回后台。

---

## v1.4.0 已交付（设计感知 HUD + 跨步累积 `findings`）

- **`## Design` 设计与结构 HUD 块**：在原有 10 个观察字段及 `#ref` 列表之后追加严格受 `≤1200` 字符预算约束的 `## Design` 块（`title`、`headings`、`sections`、`palette`、`fonts`、`cssVars`、`layout`、`media`、`motion`、`bodyText`），每项独立 `try/catch` 降级且不破坏既有 HUD 输出格式；当 `<canvas>` 覆盖 `≥90%` 视口时，`palette` 自动标为被 `<canvas>` 覆盖并提示以截图视觉配色为准。
- **独立跨步 `findings` 账本**：`FindingsLedger`（`≤12` 条、单条 `≤120` 字符、总长 `≤1200` 字符）独立于 `SlidingWindowHistory`，每步自动记录路径/滚动/控件/Canvas 变化并支持动作 JSON 可选 `note?: string`，注入 `## Findings so far`（含第 1–3 步压缩摘要）并持久化至 `diagnostics.json`。

---

## v1.4.1 已交付（文本保真 + 滚轮驱动区分 + `inspect_motion` + JSON 纠偏重试）

- **逐字动画文本归一化与几何标题分行**：`normSplit` 仅折叠单字母连续拆分与跑马灯，完整保留 `collaborate` 等正常词汇及中文混排；`headings` 按元素 `top/left` 几何分行与词间距重组，准确还原 `CREATIVE DEVELOPER` 词间空格。
- **`headings: n/a` 原因码与 0 控件中性提示**：区分 `视口内无 h1-h3` / `标题被裁切` / `标题可能在 <canvas> 内`；控件为 0 时输出中性说明，避免模型误判为被插件 UI 遮挡。
- **`ScrollDiagnostic.driver` & `inspect_motion` 动作**：区分 `wheel` 与 `programmatic`（拦截时给出 Lenis 提示）；子代理新增只读 `inspect_motion` 动作采集指针悬停前后 `transform`/`opacity`/尺寸/`getAnimations()` 差分。
- **`INVALID_JSON_DECISION` 纠偏重试与诊断落盘**：非 JSON 输出自动附加裸 JSON 格式约束与 `temperature=0` 重试 1 次；仍失败时将前 200 字原始片段写入 `planner_detail.fallback_reason`。

---

## v1.4.2 已交付（坐标级 `inspect_motion` 像素差 + 控件过滤归因 + 截图 `visualPalette` + `TRUNCATED_JSON` 按步归因）

- **坐标级 `inspect_motion({ x, y })` 与 32×32 前后帧像素差**：不依赖 `#ref` 或 DOM 节点即可对 `<canvas>` 区域探测悬停反应；探针隐藏 `#__dsh_vc_root__` 后抓取 32×32 PNG 切片并用纯 Node `node:zlib` 解码器计算 `pixelDiffMean` / `pixelChanged` 与 `topElement`，保留既有 `cssChanged` 行为。
- **HUD 控件过滤统计（只加可观测性，不改判定）**：在 `Visible Interactive Controls` 区块存在被过滤控件或 0 控件时追加 `- Controls filtered: hidden=... · zero-size=... · clipped=... · offscreen=... · plugin-ui=...`。
- **`## Design` 视觉主色 `visualPalette`**：仅当 `canvasCoversViewport === true` 时，从已有整页截图执行 32×32 网格量化采样提取 Top3 `#rrggbb` 视觉主色（不新增额外截图），受既有 `≤1200` 字符预算管线裁剪保护。
- **按步 `decision_parse` 与 `TRUNCATED_JSON` 诊断**：引号感知大括号扫描识别未闭合截断 JSON，自动携带 `report <= 600` 约束与 `temperature=0` 重试 1 次；记录 `decision_parse`、`usage`、`max_tokens` 与 `finish_reason`；若仍 fallback 则在 `subagent_report` 末尾追加显式降级提示。

---

## v1.4.3 已交付（状态条默认 `idle` + 固定三态文案与按钮可见性 + 退出主动复位）

- **注入与重注入默认 `idle`**：`buildVirtualCursorInitScript` 与 `HumanMotionController` 新增 `activeSession`（默认 `false`）与 `takeoverMode` 状态同步，彻底消除 DSH 重启、`browser_quick_snapshot`、`browser_set_cursor_trail` 或页面手动刷新重注入时无任务却误显示「DSH Agent 运行中」的问题；`F8` 热键与按钮点击仅在 `running` 态生效；附着外部 CDP 页面时在 `start()` 立即同步状态覆盖残留 `running`。
- **固定三态文案与按钮可见性**：`running` 显示 `DSH Agent 运行中 · 按 F8 接管` + 红色「按 F8 接管」按钮；`paused` 显示 `已暂停 · 等待人工接管` + 「继续执行」按钮；`idle` 显示 `DSH 待命 · 窗口保持打开（无任务）` 并**隐藏接管按钮**只留状态圆点。
- **卸载与关闭前主动收尾**：`BrowserSubagentRunner` 跟踪全部活跃会话并在 `closeAllSessions()` 与 `BrowserSession.close()` 中先解除 `beforeunload` 守卫、将非隐藏窗体置回 `idle`，避免残留 `running` 状态跨进程继承。

---

## v1.4.4 已交付（暂停态「继续执行」按钮真恢复 + F8 提示 + 暂停/恢复诊断落盘）

- **方案 C（绑定即时通知 + 500ms 插件侧 watcher 兜底）**：页面在 `paused` 态点击「继续执行」触发 `window.__dshResumeRequested = true` 与 `__dshRequestResume()` 并立即将状态条切回 `running`；宿主 `BrowserSubagentRunner` 通过 `resumeWatchers` 接管后在 1 秒内调用 `resumeTask` 真正推进后续 `llm_steps`；仍完全兼容不点按钮而通过 `browser_subagent_resume` 恢复的原有通道（若按钮先完成，`browser_subagent_resume` 返回已缓存结果），并在窗口断连、恢复或 `closeAllSessions()` 时彻底清除定时器与监听器。
- **F8 暂停防误解文案与诊断增强**：`paused` 态状态条提示 `已暂停 · 等待人工接管（再按 F8 无效果，请点右侧或说「继续」）`；`diagnostics.json` 在暂停/恢复/完成阶段串行写入 `paused_at`、`paused_by`（`'f8' | 'button' | 'gate'`）、`resumed_at`、`resumed_by`（`'button' | 'tool'`）与完整 `llm_steps`。

---

## v2.0.0 规划（TODO）

- **其余 4 + 1 固定只读探针与架构升级**：`inspect_dom`、`inspect_styles`、`extract_outline`、`inspect_media` 与 `inspect_region(x, y, radius, zoom)` 局部 2× 放大能力，并辅以相邻帧区域差异文本补偿。
- **Win32 `HWND_NOTOPMOST` 置顶自愈（v1.3.4 遗留）**：启动后及复用窗口前纠正意外 `WS_EX_TOPMOST` 状态。
- **明确不做（历史记录）**：不在 LLM 思考期间冻结浏览器页面（`Emulation.setVirtualTimePolicy` 无法冻结网络流且恢复易触发 timer 风暴；`Animation.setPlaybackRate(0)` 对 rAF 无效；可见后台模式下会带来假死感），统一通过快速 `REF_STALE` 重采样 + 错误预算保证鲁棒性；不做任意 `evaluate_probe` JS 执行；不在 HUD 中对“虚拟滚动”下绝对判断；不从 WebGL canvas 帧缓冲读取像素/对象内容。
