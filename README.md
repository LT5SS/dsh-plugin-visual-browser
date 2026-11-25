# dsh-plugin-visual-browser

DeepSeek Harness (`@deepseek-ai/dsh@0.2.x`) 的可视化浏览器子代理插件，基于 `playwright-core`。

## 特性

- **后台不抢焦点**：Windows 下以无焦点可见窗口运行并复用单窗口（也可切换为 `minimized` / `headless`），或通过 `DSH_WEBVIEW_CDP_URL` 接入外部桌面端 Webview。
- **虚拟鼠标与人工接管**：三次贝塞尔移动轨迹、滚动/拖拽视觉指示与设置预览；支持按 `F8`（或点击页面右上角状态条）随时暂停接管并一键继续。
- **多模态走查与护栏**：只保留最近 3 张截图的滑动窗口，提供紧凑 HUD（DOM、设计指标、`## Findings`、原生弹窗回显）及动效悬停探测；支持按需 `set_viewport` / DPR 放大、`wait_for` 条件等待、键盘与下拉选择、历史跳转与 `mailto:` / `javascript:` 协议拦截。
- **原生接入 DSH 0.2.x**：通过 `dsh.bundle.patch`、`peerDependencies` 与 Cordis 二级注入复用宿主 `ctx.llm` / `ctx.attachments`，并支持持久化设置同步。

## 安装

需要本机已安装 Google Chrome 或 Microsoft Edge（`playwright-core` 不会内置浏览器二进制文件）。

从 GitHub Releases 下载并解压压缩包后执行：

```bash
cd <DSH_HOME>/plugins/dsh-plugin-visual-browser
npm ci --omit=dev --omit=peer
dsh plugin --profile <your-profile> add link:<插件目录的绝对路径>
```

安装完成后重启 DSH，使 `browser_*` 工具生效。

## 工具

| 工具 | 说明 |
| :--- | :--- |
| `browser_subagent_run` | 启动浏览器子代理执行多步走查或页面交互，返回结构化报告与最新截图 |
| `browser_subagent_resume` | 在用户完成登录、支付或人工核验后，恢复已暂停的会话并继续执行 |
| `browser_set_cursor_trail` | 实时调整并保存虚拟鼠标预设、自定义指针图标与拖尾样式 |
| `browser_quick_snapshot` | 抓取目标 URL 的单次页面截图与控件 HUD 摘要，不启动长程子代理 |

## 环境变量（可选）

| 变量 | 说明 |
| :--- | :--- |
| `DSH_BROWSER_EXECUTABLE` | 自定义本地 Chrome / Edge 可执行文件绝对路径 |
| `DSH_BROWSER_WINDOW_MODE` | 强制窗口模式：`visible-background` / `minimized` / `headless` |
| `DSH_BROWSER_ARTIFACT_DIR` | 自定义截图与诊断输出目录 |
| `DSH_WEBVIEW_CDP_URL` | 指定内置 Webview 或外部浏览器的 CDP 调试端点 |
| `DSH_VISION_API_KEY` | 独立多模态 API Key（未走宿主 `ctx.llm` 时使用） |

## 本地开发

```bash
npm install
npm run build
npm run test:contract
dsh --patch ./cordis.yml --profile web
```

使用 `--patch` 调试时，`--patch` 参数必须位于 `--profile` 之前；若未安装到 profile，需在 `cordis.yml` 的 `name` 字段填写 `dist/index.js` 的绝对路径。

## 版本记录

迭代历史与规划见 [ROADMAP.md](./ROADMAP.md) 及 [GitHub Releases](https://github.com/LT5SS/dsh-plugin-visual-browser/releases)。
