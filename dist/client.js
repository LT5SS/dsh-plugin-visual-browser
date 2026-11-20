window.__ModuleLoader__.load({
  id: "dsh-plugin-visual-browser",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const e = React.createElement;

    const NS = "visualBrowserSettings";
    const DEFAULT_PLUGIN_NS = "dsh-plugin-visual-browser";
    const MAX_CUSTOM_IMAGE_BYTES = 128 * 1024;
    const SAFE_IMAGE_URL_RE =
      /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);|https?:\/\/)/i;

    const SHAPE_PATHS = {
      arrow: "M3 3 L11 24 L14.8 15.2 L23.5 11.5 Z",
      crosshair:
        "M14 2 V9 M14 19 V26 M2 14 H9 M19 14 H26 M14 10 A4 4 0 1 0 14 18 A4 4 0 1 0 14 10 Z",
      dot: "M14 7 A7 7 0 1 0 14 21 A7 7 0 1 0 14 7 Z",
      star: "M14 2 L17.2 10.8 L26 14 L17.2 17.2 L14 26 L10.8 17.2 L2 14 L10.8 10.8 Z",
      ring:
        "M14 4 A10 10 0 1 0 14 24 A10 10 0 1 0 14 4 Z M14 9 A5 5 0 1 1 14 19 A5 5 0 1 1 14 9 Z",
    };

    const CUSTOM_SVG_TEMPLATES = [
      { id: "arrow", zh: "经典箭头", en: "Classic Arrow", d: SHAPE_PATHS.arrow },
      {
        id: "diamond",
        zh: "科幻菱形",
        en: "Cyber Diamond",
        d: "M14 2 L24 14 L14 26 L4 14 Z",
      },
      { id: "star", zh: "四角星芒", en: "Sparkle Star", d: SHAPE_PATHS.star },
      {
        id: "bolt",
        zh: "闪电指针",
        en: "Lightning Bolt",
        d: "M16 2 L6 15 H14 L11 26 L22 12 H14 Z",
      },
    ];

    const PRESETS = {
      "cyber-neon": {
        pointerShape: "arrow",
        pointerColor: "#ff3b28",
        pointerBorderColor: "#ffffff",
        pointerScale: 1.0,
        customPointerSvgPath: "",
        customPointerImageUrl: "",
        customPointerHotspotX: 3,
        customPointerHotspotY: 3,
        trailVariant: "dashed",
        trailColorStart: "#ff3b28",
        trailColorEnd: "#00f0ff",
        trailWidth: 2.8,
        trailLength: 24,
        trailGlow: true,
        rippleColor: "#00f0ff",
        showBadge: true,
        badgeTextPrefix: "DSH",
      },
      "comet-gold": {
        pointerShape: "arrow",
        pointerColor: "#ffb800",
        pointerBorderColor: "#1a0e00",
        pointerScale: 1.08,
        customPointerSvgPath: "",
        customPointerImageUrl: "",
        customPointerHotspotX: 3,
        customPointerHotspotY: 3,
        trailVariant: "comet",
        trailColorStart: "#ff3b00",
        trailColorEnd: "#ffe66d",
        trailWidth: 4.5,
        trailLength: 28,
        trailGlow: true,
        rippleColor: "#ffd000",
        showBadge: true,
        badgeTextPrefix: "DSH",
      },
      "laser-dots": {
        pointerShape: "dot",
        pointerColor: "#a855f7",
        pointerBorderColor: "#ffffff",
        pointerScale: 1.0,
        customPointerSvgPath: "",
        customPointerImageUrl: "",
        customPointerHotspotX: 14,
        customPointerHotspotY: 14,
        trailVariant: "dots",
        trailColorStart: "#ec4899",
        trailColorEnd: "#38bdf8",
        trailWidth: 3.6,
        trailLength: 20,
        trailGlow: true,
        rippleColor: "#e879f9",
        showBadge: true,
        badgeTextPrefix: "DSH",
      },
      "stealth-minimal": {
        pointerShape: "crosshair",
        pointerColor: "#111827",
        pointerBorderColor: "#ffffff",
        pointerScale: 0.9,
        customPointerSvgPath: "",
        customPointerImageUrl: "",
        customPointerHotspotX: 14,
        customPointerHotspotY: 14,
        trailVariant: "solid",
        trailColorStart: "#9ca3af",
        trailColorEnd: "#374151",
        trailWidth: 1.6,
        trailLength: 14,
        trailGlow: false,
        rippleColor: "#6b7280",
        showBadge: false,
        badgeTextPrefix: "DSH",
      },
      "clean-none": {
        pointerShape: "arrow",
        pointerColor: "#ff3b28",
        pointerBorderColor: "#ffffff",
        pointerScale: 1.0,
        customPointerSvgPath: "",
        customPointerImageUrl: "",
        customPointerHotspotX: 3,
        customPointerHotspotY: 3,
        trailVariant: "none",
        trailColorStart: "#ff3b28",
        trailColorEnd: "#00f0ff",
        trailWidth: 0,
        trailLength: 2,
        trailGlow: false,
        rippleColor: "#ff3b28",
        showBadge: true,
        badgeTextPrefix: "DSH",
      },
      custom: {
        pointerShape: "arrow",
        pointerColor: "#ff3b28",
        pointerBorderColor: "#ffffff",
        pointerScale: 1.0,
        customPointerSvgPath: "",
        customPointerImageUrl: "",
        customPointerHotspotX: 3,
        customPointerHotspotY: 3,
        trailVariant: "dashed",
        trailColorStart: "#ff3b28",
        trailColorEnd: "#00f0ff",
        trailWidth: 2.8,
        trailLength: 24,
        trailGlow: true,
        rippleColor: "#00f0ff",
        showBadge: true,
        badgeTextPrefix: "DSH",
      },
    };

    const en = {
      nav: "Visual Browser",
      title: "Visual Browser & Virtual Cursor",
      subtitle:
        "Customize preset or custom cursor shapes, trails, colors, and non-focus-stealing window behavior. Saved changes sync live to open shared browser windows.",
      previewTitle: "Interactive Live Preview",
      previewHint: "Move cursor across the stage to preview trails; click to preview ripple.",
      previewDark: "Dark Stage",
      previewLight: "Light Stage",
      presetsTitle: "Cursor Presets",
      presetCyberNeon: "Cyber Neon",
      presetCometGold: "Comet Gold",
      presetLaserDots: "Laser Dots",
      presetStealthMinimal: "Stealth Minimal",
      presetCleanNone: "Clean (No Trail)",
      presetCustom: "Custom Style",
      shapeSectionTitle: "Pointer Appearance & Custom Cursor",
      pointerShape: "Pointer shape",
      shapeArrow: "Arrow",
      shapeCrosshair: "Crosshair",
      shapeDot: "Glow Dot",
      shapeStar: "Sparkle Star",
      shapeRing: "Precision Ring",
      shapeCustomSvg: "Custom SVG Path",
      shapeCustomImage: "Custom Image / Icon",
      pointerColor: "Pointer fill",
      pointerBorderColor: "Pointer border",
      pointerScale: "Pointer scale",
      customSvgLabel: "SVG <path d=\"...\"> (28x28 viewBox)",
      customSvgTemplates: "Quick templates:",
      customImageLabel: "Upload PNG/SVG cursor (<= 128 KB) or enter http(s)/data URI",
      uploadImage: "Upload image…",
      clearImage: "Clear",
      hotspotX: "Hotspot X",
      hotspotY: "Hotspot Y",
      invalidImageUrl: "Image URL must start with https://, http://, or data:image/...",
      imageTooLarge: "Image exceeds 128 KB limit; choose a smaller file.",
      trailSectionTitle: "Motion Trail & HUD Badge",
      trailVariant: "Trail variant",
      variantDashed: "Dashed",
      variantSolid: "Solid",
      variantDots: "Dots",
      variantComet: "Comet",
      variantNone: "None",
      trailColorStart: "Trail tail color",
      trailColorEnd: "Trail tip color",
      trailWidth: "Trail width (px)",
      trailLength: "Trail length (pts)",
      trailGlow: "Outer neon glow",
      rippleColor: "Click ripple color",
      showBadge: "Show coordinate pill badge",
      badgeTextPrefix: "Badge prefix",
      windowSectionTitle: "Background Window & Takeover",
      windowMode: "Window mode",
      winVisibleBg: "Visible background (right half, no focus steal)",
      winMinimized: "Minimized (taskbar only)",
      winHeadless: "Headless (silent)",
      keepWindowOpen: "Keep single browser window open and reuse between tasks",
      showTakeoverControl: "Show top-layer takeover status pill (click-through while running)",
      takeoverHotkey: "Global takeover hotkey",
      recordHotkey: "Record key…",
      recordingHotkey: "Press key (Esc cancels)",
      save: "Save Changes",
      saving: "Saving…",
      saved: "Saved! Active shared browser windows updated.",
      saveFailed: "Failed to persist configuration changes.",
      discard: "Discard",
      resetDefaults: "Reset Defaults",
      readOnly: "Settings are read-only in this deployment.",
      loading: "Loading visual browser settings…",
      unavailable: "dsh-plugin-visual-browser is not active in this profile.",
      degradedTitle: "Host did not provide a live configuration form",
      degradedDesc:
        "The host did not inject a configuration form for this plugin slot (for example, DSH 0.2.1-rc.2 settings.section does not expose configForm or timed out). You can still click \"Open configuration file\" below to edit cordis.yml (restart required), or customize below and copy a browser_set_cursor_trail call for instant live updates.",
      openConfigFile: "Open configuration file",
      openConfigDone: "Opened configuration document request sent to host.",
      openConfigMissing:
        "Host remote.settings.openSettingsDocument is unavailable here; use the Settings modal top-right \"Open configuration file\" button or edit your profile cordis.yml.",
      copyToolCall: "Copy browser_set_cursor_trail call",
      copyYamlSnippet: "Copy cordis.yml snippet",
      copiedSnippet: "Copied to clipboard!",
      copyFallback: "Clipboard unavailable; copy the snippet manually below:",
      summary: "Configure virtual cursor styles, custom SVG/image pointers, and background window takeover options.",
    };

    const zh = {
      nav: "视觉浏览器",
      title: "视觉浏览器与虚拟鼠标",
      subtitle:
        "选择预设鼠标或自定义图形/图片指针、拖尾、颜色与后台不抢焦点窗口行为；保存后将实时同步至正在打开的共享浏览器窗口。",
      previewTitle: "实时交互预览画布",
      previewHint: "在下方画布移动鼠标查看拖尾效果，点击可预览点击波纹。",
      previewDark: "深色背景",
      previewLight: "浅色背景",
      presetsTitle: "快速预设模板",
      presetCyberNeon: "赛博霓虹",
      presetCometGold: "彗星流金",
      presetLaserDots: "激光粒子",
      presetStealthMinimal: "极简暗影",
      presetCleanNone: "纯净无拖尾",
      presetCustom: "自定义样式",
      shapeSectionTitle: "鼠标指针造型与自定义",
      pointerShape: "指针形状",
      shapeArrow: "经典箭头",
      shapeCrosshair: "精准十字准星",
      shapeDot: "荧光圆点",
      shapeStar: "星芒指针",
      shapeRing: "空心圆环",
      shapeCustomSvg: "自定义 SVG 路径",
      shapeCustomImage: "自定义图片 / 图标",
      pointerColor: "指针填充色",
      pointerBorderColor: "指针描边色",
      pointerScale: "指针缩放倍数",
      customSvgLabel: "自定义 SVG <path d=\"...\">（基于 28x28 坐标系）",
      customSvgTemplates: "快捷模板：",
      customImageLabel: "上传本地图标 (<= 128 KB) 或填入 http(s)/data URI",
      uploadImage: "上传图片…",
      clearImage: "清除",
      hotspotX: "点击热点 X",
      hotspotY: "点击热点 Y",
      invalidImageUrl: "仅支持 https://、http:// 或 data:image/... 图片地址",
      imageTooLarge: "图片超过 128 KB 限制，请选择更小的 PNG/SVG 文件。",
      trailSectionTitle: "运动拖尾与坐标徽标",
      trailVariant: "拖尾线条样式",
      variantDashed: "霓虹虚线",
      variantSolid: "丝滑实线",
      variantDots: "光点序列",
      variantComet: "彗星渐变",
      variantNone: "关闭拖尾",
      trailColorStart: "拖尾尾部颜色",
      trailColorEnd: "拖尾近端颜色",
      trailWidth: "拖尾粗细 (px)",
      trailLength: "拖尾点数",
      trailGlow: "开启外发光霓虹",
      rippleColor: "点击波纹颜色",
      showBadge: "显示光标旁实时坐标徽标",
      badgeTextPrefix: "徽标前缀文字",
      windowSectionTitle: "后台窗口与人工接管",
      windowMode: "窗口显示模式",
      winVisibleBg: "可见后台窗口（屏幕右侧、不抢焦点）",
      winMinimized: "启动即最小化（任务栏运行）",
      winHeadless: "无头全静默（Headless）",
      keepWindowOpen: "任务完成后保持单窗口开启并在后续任务复用",
      showTakeoverControl: "显示顶层状态悬浮条（运行中对页面点击透明）",
      takeoverHotkey: "随时暂停接管快捷键",
      recordHotkey: "录制按键…",
      recordingHotkey: "请按下按键（Esc 取消）",
      save: "保存设置",
      saving: "保存中…",
      saved: "已保存！已实时同步到当前打开的共享浏览器窗口。",
      saveFailed: "宿主拒绝或保存失败，请检查输入参数。",
      discard: "放弃修改",
      resetDefaults: "恢复默认",
      readOnly: "当前部署配置为只读，无法在线写入。",
      loading: "正在读取视觉浏览器配置…",
      unavailable: "当前 Profile 未激活 dsh-plugin-visual-browser 插件。",
      degradedTitle: "当前宿主未向本插件提供可视化配置表单",
      degradedDesc:
        "当前宿主未向本插件提供可视化配置表单（例如 DSH 0.2.1-rc.2 的 settings.section 未注入或等待超时）。你仍然可以：点击下方「打开配置文件」直接修改 cordis.yml 里的 config 段（改完重启生效），或在下方预览并调整样式后复制参数，让 Agent 调用 browser_set_cursor_trail 实时改光标（立即生效，无需重启）。",
      openConfigFile: "打开配置文件",
      openConfigDone: "已向宿主发送打开配置文件请求。",
      openConfigMissing:
        "当前插槽未暴露打开配置文件接口，请点弹窗右上角「打开配置文件」或手动编辑 profile 下的 cordis.yml。",
      copyToolCall: "复制 browser_set_cursor_trail 调用",
      copyYamlSnippet: "复制 cordis.yml 配置",
      copiedSnippet: "已复制到剪贴板！可直接粘贴给 Agent 执行或写入 cordis.yml。",
      copyFallback: "剪贴板不可用，请手动复制下方内容：",
      summary: "调整虚拟鼠标预设、自定义 SVG/图片指针、拖尾光效及可见后台窗口接管热键。",
    };

    const CSS_TEXT = `
.dshvb_wrap{max-width:780px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary,#e2e8f0);font-size:13px;line-height:1.5}
.dshvb_head h2{margin:0 0 4px 0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary,#f8fafc)}
.dshvb_head p{margin:0;color:var(--dsw-alias-label-tertiary,#94a3b8);font-size:13px}
.dshvb_card{border:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,0.22));background:var(--dsw-alias-bg-base,rgba(15,23,42,0.35));border-radius:var(--dsw-radius-md,10px);padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.dshvb_banner{border:1px solid rgba(245,158,11,0.45);background:rgba(245,158,11,0.1);border-radius:var(--dsw-radius-md,10px);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.dshvb_bannerTitle{margin:0;font-size:13px;font-weight:600;color:#fbbf24}
.dshvb_bannerText{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#cbd5e1);line-height:1.55}
.dshvb_diag{margin:0;padding:8px 10px;border-radius:6px;background:rgba(15,23,42,0.45);border:1px dashed var(--dsw-alias-border-l2,rgba(148,163,184,0.22));font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8);word-break:break-all}
.dshvb_cardTitle{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#f1f5f9);display:flex;align-items:center;justify-content:space-between;gap:8px}
.dshvb_stage{position:relative;height:210px;border-radius:8px;overflow:hidden;border:1px solid var(--dsw-alias-border-l4,rgba(148,163,184,0.28));cursor:none;user-select:none}
.dshvb_stage.dark{background:radial-gradient(circle at 20% 20%,rgba(0,240,255,0.08),transparent 45%),#0b0f19;background-image:linear-gradient(to right,rgba(148,163,184,0.08) 1px,transparent 1px),linear-gradient(to bottom,rgba(148,163,184,0.08) 1px,transparent 1px);background-size:24px 24px}
.dshvb_stage.light{background:#f8fafc;background-image:linear-gradient(to right,rgba(15,23,42,0.06) 1px,transparent 1px),linear-gradient(to bottom,rgba(15,23,42,0.06) 1px,transparent 1px);background-size:24px 24px}
.dshvb_presets{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.dshvb_presetBtn{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,0.25));background:transparent;color:var(--dsw-alias-label-primary,#e2e8f0);cursor:pointer;font:inherit;font-size:12px;font-weight:500;text-align:left}
.dshvb_presetBtn[data-active=true]{border-color:var(--dsw-alias-state-business-primary,#3b82f6);background:rgba(59,130,246,0.12)}
.dshvb_swatch{width:14px;height:14px;border-radius:50%;flex-shrink:0;border:1px solid rgba(255,255,255,0.4)}
.dshvb_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.dshvb_field{display:flex;flex-direction:column;gap:5px}
.dshvb_label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#cbd5e1);display:flex;justify-content:space-between;align-items:center}
.dshvb_input,.dshvb_select,.dshvb_textarea{border:1px solid var(--dsw-alias-border-l4,rgba(148,163,184,0.32));border-radius:6px;background:var(--dsw-alias-bg-base,rgba(15,23,42,0.6));color:var(--dsw-alias-label-primary,#f1f5f9);padding:6px 9px;font:inherit;font-size:12px}
.dshvb_textarea{min-height:58px;font-family:ui-monospace,Consolas,monospace;resize:vertical}
.dshvb_colorRow{display:flex;align-items:center;gap:8px}
.dshvb_colorRow input[type=color]{width:34px;height:28px;border:0;border-radius:6px;padding:0;background:transparent;cursor:pointer}
.dshvb_colorRow input[type=text]{flex:1;min-width:0}
.dshvb_checkRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0}
.dshvb_chips{display:flex;flex-wrap:wrap;gap:6px}
.dshvb_btn{border:1px solid var(--dsw-alias-border-l4,rgba(148,163,184,0.32));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e2e8f0);padding:5px 11px;font:inherit;font-size:12px;font-weight:500;cursor:pointer}
.dshvb_btn:disabled{opacity:0.45;cursor:not-allowed}
.dshvb_btn.primary{background:var(--dsw-alias-state-business-primary,#2563eb);border-color:var(--dsw-alias-state-business-primary,#2563eb);color:#ffffff}
.dshvb_actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:4px}
.dshvb_btnGroup{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshvb_status{font-size:12px;color:var(--dsw-alias-label-secondary,#94a3b8)}
.dshvb_status.ok{color:#10b981}
.dshvb_status.err{color:#ef4444}
`;

    function ensureStyles() {
      if (typeof document === "undefined") return;
      const tagId = "dsh-plugin-visual-browser/settings";
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
      const style = document.createElement("style");
      style.dataset.plugin = DEFAULT_PLUGIN_NS;
      style.dataset.pluginCss = tagId;
      style.textContent = CSS_TEXT;
      (document.head || document.documentElement).appendChild(style);
    }

    function normalizeHexColor(value, fallback) {
      if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
        return value.trim();
      }
      return fallback;
    }

    function resolvePreviewStyle(cfg = {}) {
      const preset = cfg.preset && PRESETS[cfg.preset] ? cfg.preset : "cyber-neon";
      const base = PRESETS[preset] || PRESETS["cyber-neon"];
      return {
        preset,
        pointerShape: cfg.pointerShape || base.pointerShape,
        pointerColor: cfg.pointerColor || base.pointerColor,
        pointerBorderColor: cfg.pointerBorderColor || base.pointerBorderColor,
        pointerScale:
          typeof cfg.pointerScale === "number" && Number.isFinite(cfg.pointerScale)
            ? cfg.pointerScale
            : base.pointerScale,
        customPointerSvgPath:
          typeof cfg.customPointerSvgPath === "string"
            ? cfg.customPointerSvgPath
            : base.customPointerSvgPath,
        customPointerImageUrl:
          typeof cfg.customPointerImageUrl === "string"
            ? cfg.customPointerImageUrl
            : base.customPointerImageUrl,
        customPointerHotspotX:
          typeof cfg.customPointerHotspotX === "number" && Number.isFinite(cfg.customPointerHotspotX)
            ? cfg.customPointerHotspotX
            : base.customPointerHotspotX,
        customPointerHotspotY:
          typeof cfg.customPointerHotspotY === "number" && Number.isFinite(cfg.customPointerHotspotY)
            ? cfg.customPointerHotspotY
            : base.customPointerHotspotY,
        trailVariant: cfg.trailVariant || base.trailVariant,
        trailColorStart: cfg.trailColorStart || base.trailColorStart,
        trailColorEnd: cfg.trailColorEnd || base.trailColorEnd,
        trailWidth:
          typeof cfg.trailWidth === "number" && Number.isFinite(cfg.trailWidth)
            ? cfg.trailWidth
            : base.trailWidth,
        trailLength:
          typeof cfg.trailLength === "number" && Number.isFinite(cfg.trailLength)
            ? cfg.trailLength
            : base.trailLength,
        trailGlow: typeof cfg.trailGlow === "boolean" ? cfg.trailGlow : base.trailGlow,
        rippleColor: cfg.rippleColor || base.rippleColor,
        showBadge: typeof cfg.showBadge === "boolean" ? cfg.showBadge : base.showBadge,
        badgeTextPrefix:
          typeof cfg.badgeTextPrefix === "string" && cfg.badgeTextPrefix
            ? cfg.badgeTextPrefix
            : base.badgeTextPrefix,
      };
    }

    function buildPreviewPath(pts) {
      if (!pts || pts.length < 2) return "";
      let d = "M " + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1);
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const mx = ((p0.x + p1.x) * 0.5).toFixed(1);
        const my = ((p0.y + p1.y) * 0.5).toFixed(1);
        d += " Q " + p0.x.toFixed(1) + " " + p0.y.toFixed(1) + " " + mx + " " + my;
      }
      const last = pts[pts.length - 1];
      d += " L " + last.x.toFixed(1) + " " + last.y.toFixed(1);
      return d;
    }

    function buildDraftFromServer(value) {
      const v = value && typeof value === "object" ? value : {};
      return {
        cursorStyle: resolvePreviewStyle(v.cursorStyle || {}),
        windowMode: v.windowMode || "visible-background",
        keepWindowOpen: typeof v.keepWindowOpen === "boolean" ? v.keepWindowOpen : true,
        showTakeoverControl:
          typeof v.showTakeoverControl === "boolean" ? v.showTakeoverControl : true,
        takeoverHotkey: typeof v.takeoverHotkey === "string" ? v.takeoverHotkey : "F8",
      };
    }

    function LiveCursorPreview({ style, t }) {
      const stageRef = React.useRef(null);
      const [dark, setDark] = React.useState(true);
      const [pos, setPos] = React.useState({ x: 240, y: 108 });
      const [trail, setTrail] = React.useState([
        { x: 75, y: 148 },
        { x: 112, y: 120 },
        { x: 158, y: 98 },
        { x: 202, y: 102 },
        { x: 240, y: 108 },
      ]);
      const [ripple, setRipple] = React.useState(null);

      React.useEffect(() => {
        if (!ripple) return;
        const timer = setTimeout(() => setRipple(null), 550);
        return () => clearTimeout(timer);
      }, [ripple]);

      const onMouseMove = (ev) => {
        if (!stageRef.current) return;
        const rect = stageRef.current.getBoundingClientRect();
        const x = Math.max(8, Math.min(rect.width - 8, ev.clientX - rect.left));
        const y = Math.max(8, Math.min(rect.height - 8, ev.clientY - rect.top));
        setPos({ x, y });
        setTrail((prev) => {
          const maxLen = Math.max(2, Math.min(60, Math.round(style.trailLength || 22)));
          const last = prev[prev.length - 1];
          if (last && Math.hypot(x - last.x, y - last.y) < 3) return prev;
          const next = [...prev, { x, y }];
          while (next.length > maxLen) next.shift();
          return next;
        });
      };

      const onStageClick = () => {
        setRipple({ x: pos.x, y: pos.y, key: Date.now() });
      };

      const d = buildPreviewPath(trail);
      const customPath = (style.customPointerSvgPath || "").trim();
      const pointerPath =
        style.pointerShape === "custom-svg" && customPath
          ? customPath
          : SHAPE_PATHS[style.pointerShape] || SHAPE_PATHS.arrow;
      const safeCustomImg =
        style.pointerShape === "custom-image" &&
        SAFE_IMAGE_URL_RE.test((style.customPointerImageUrl || "").trim())
          ? style.customPointerImageUrl.trim()
          : "";
      const centerHot = ["crosshair", "dot", "star", "ring"].includes(style.pointerShape);
      const hotX = style.pointerShape === "custom-image" ? style.customPointerHotspotX : centerHot ? 14 : style.customPointerHotspotX;
      const hotY = style.pointerShape === "custom-image" ? style.customPointerHotspotY : centerHot ? 14 : style.customPointerHotspotY;

      return e(
        "div",
        { className: "dshvb_card" },
        e(
          "div",
          { className: "dshvb_cardTitle" },
          e("span", null, t("previewTitle")),
          e(
            "button",
            {
              type: "button",
              className: "dshvb_btn",
              onClick: () => setDark((prev) => !prev),
            },
            dark ? t("previewLight") : t("previewDark")
          )
        ),
        e(
          "div",
          { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary,#94a3b8)" } },
          t("previewHint")
        ),
        e(
          "div",
          {
            ref: stageRef,
            className: "dshvb_stage " + (dark ? "dark" : "light"),
            onMouseMove,
            onClick: onStageClick,
          },
          e(
            "svg",
            {
              style: {
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              },
            },
            e(
              "defs",
              null,
              e(
                "linearGradient",
                { id: "dshvb_preview_grad", x1: "0%", y1: "0%", x2: "100%", y2: "0%" },
                e("stop", { offset: "0%", stopColor: style.trailColorStart, stopOpacity: 0.25 }),
                e("stop", { offset: "100%", stopColor: style.trailColorEnd, stopOpacity: 0.95 })
              )
            ),
            style.trailVariant !== "none" &&
              style.trailVariant !== "dots" &&
              d &&
              e(
                React.Fragment,
                null,
                style.trailGlow &&
                  e("path", {
                    d,
                    fill: "none",
                    stroke: style.trailColorEnd,
                    strokeOpacity: style.trailVariant === "comet" ? 0.42 : 0.26,
                    strokeWidth: (style.trailWidth || 2.8) * 3,
                    strokeLinecap: "round",
                  }),
                e("path", {
                  d,
                  fill: "none",
                  stroke: "url(#dshvb_preview_grad)",
                  strokeWidth:
                    style.trailVariant === "comet"
                      ? (style.trailWidth || 2.8) * 1.35
                      : style.trailWidth || 2.8,
                  strokeDasharray: style.trailVariant === "dashed" ? "5 3" : "none",
                  strokeLinecap: "round",
                })
              ),
            style.trailVariant === "dots" &&
              trail.map((pt, idx) => {
                const ratio = (idx + 1) / trail.length;
                return e("circle", {
                  key: idx,
                  cx: pt.x,
                  cy: pt.y,
                  r: 1.4 + ratio * (style.trailWidth || 2.8),
                  fill: ratio > 0.5 ? style.trailColorEnd : style.trailColorStart,
                  fillOpacity: 0.2 + ratio * 0.78,
                });
              }),
            ripple &&
              e(
                React.Fragment,
                { key: ripple.key },
                e("circle", {
                  cx: ripple.x,
                  cy: ripple.y,
                  r: 18,
                  fill: "rgba(255,59,40,0.18)",
                  stroke: style.rippleColor,
                  strokeWidth: 2.2,
                }),
                e("circle", {
                  cx: ripple.x,
                  cy: ripple.y,
                  r: 32,
                  fill: "none",
                  stroke: style.pointerColor,
                  strokeWidth: 1.4,
                  strokeDasharray: "4 3",
                })
              )
          ),
          e(
            "div",
            {
              style: {
                position: "absolute",
                left: 0,
                top: 0,
                transform: "translate3d(" + pos.x + "px," + pos.y + "px,0)",
                pointerEvents: "none",
              },
            },
            e("div", {
              style: {
                position: "absolute",
                left: "-7px",
                top: "-7px",
                width: "14px",
                height: "14px",
                borderRadius: "50%",
                border: "2px solid " + style.rippleColor,
                boxShadow: style.trailGlow ? "0 0 10px " + style.rippleColor : "none",
              },
            }),
            safeCustomImg
              ? e("img", {
                  src: safeCustomImg,
                  alt: "",
                  style: {
                    position: "absolute",
                    left: -hotX + "px",
                    top: -hotY + "px",
                    width: "28px",
                    height: "28px",
                    objectFit: "contain",
                    transformOrigin: hotX + "px " + hotY + "px",
                    transform: "scale(" + (style.pointerScale || 1) + ")",
                  },
                })
              : e(
                  "svg",
                  {
                    width: 28,
                    height: 28,
                    viewBox: "0 0 28 28",
                    style: {
                      position: "absolute",
                      left: -hotX + "px",
                      top: -hotY + "px",
                      transformOrigin: hotX + "px " + hotY + "px",
                      transform: "scale(" + (style.pointerScale || 1) + ")",
                    },
                  },
                  e("path", {
                    d: pointerPath,
                    fill: style.pointerShape === "crosshair" ? "none" : style.pointerColor,
                    stroke:
                      style.pointerShape === "crosshair"
                        ? style.pointerColor
                        : style.pointerBorderColor,
                    strokeWidth: style.pointerShape === "crosshair" ? 2.4 : 2,
                    strokeLinejoin: "round",
                    fillRule: "evenodd",
                  })
                ),
            style.showBadge &&
              e(
                "div",
                {
                  style: {
                    position: "absolute",
                    left: "22px",
                    top: "18px",
                    padding: "2px 8px",
                    borderRadius: "999px",
                    background: "rgba(12,14,20,0.9)",
                    border: "1px solid " + style.rippleColor,
                    color: "#f5f8ff",
                    fontSize: "10px",
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    fontFamily: "ui-monospace,Consolas,monospace",
                  },
                },
                (style.badgeTextPrefix || "DSH") +
                  " · (" +
                  Math.round(pos.x) +
                  ", " +
                  Math.round(pos.y) +
                  ") · PREVIEW"
              )
          )
        )
      );
    }

    function VisualBrowserSettingsPanel(props) {
      ensureStyles();
      const t = props.t || props.fallbackT || ((k) => zh[k] || k);

      if (props.view === "summary") {
        return t("summary");
      }

      if (typeof props.useConfigForm === "function") {
        return e(VisualBrowserSettingsHookWrapper, { ...props, t });
      }

      return e(VisualBrowserSettingsStoreWrapper, { ...props, t });
    }

    function VisualBrowserSettingsHookWrapper(props) {
      const liveSnap = props.useConfigForm((s) => s);
      return e(VisualBrowserSettingsBody, {
        ...props,
        liveSnap,
        hasProvider: true,
      });
    }

    function VisualBrowserSettingsStoreWrapper(props) {
      const store = props.configFormStore || props.hooks?.configForm || null;
      const [storeSnap, setStoreSnap] = React.useState(() =>
        props.form ? props.form.state : store?.getSnapshot?.() || null
      );

      React.useEffect(() => {
        if (props.form) {
          setStoreSnap(props.form.state);
          return;
        }
        if (!store || typeof store.subscribe !== "function") {
          setStoreSnap(null);
          return;
        }
        setStoreSnap(store.getSnapshot());
        return store.subscribe(() => {
          setStoreSnap(store.getSnapshot());
        });
      }, [props.form, store]);

      const liveSnap = props.form ? props.form.state : storeSnap;
      const hasProvider = Boolean(props.form || store);
      return e(VisualBrowserSettingsBody, {
        ...props,
        liveSnap,
        hasProvider,
      });
    }

    function buildToolCallSnippet(draft) {
      const cs = draft.cursorStyle;
      return (
        "browser_set_cursor_trail(" +
        JSON.stringify(
          {
            preset: cs.preset,
            pointer_shape: cs.pointerShape,
            pointer_color: cs.pointerColor,
            pointer_border_color: cs.pointerBorderColor,
            pointer_scale: cs.pointerScale,
            ...(cs.customPointerSvgPath ? { custom_svg_path: cs.customPointerSvgPath } : {}),
            ...(cs.customPointerImageUrl ? { custom_image_url: cs.customPointerImageUrl } : {}),
            trail_variant: cs.trailVariant,
            trail_color_start: cs.trailColorStart,
            trail_color_end: cs.trailColorEnd,
            trail_width: cs.trailWidth,
            trail_length: cs.trailLength,
            trail_glow: cs.trailGlow,
            ripple_color: cs.rippleColor,
            show_badge: cs.showBadge,
            badge_text_prefix: cs.badgeTextPrefix,
          },
          null,
          2
        ) +
        ")"
      );
    }

    function buildCordisYamlSnippet(draft) {
      const cs = draft.cursorStyle;
      const lines = [
        "config:",
        "  windowMode: '" + draft.windowMode + "'",
        "  keepWindowOpen: " + Boolean(draft.keepWindowOpen),
        "  showTakeoverControl: " + Boolean(draft.showTakeoverControl),
        "  takeoverHotkey: '" + draft.takeoverHotkey + "'",
        "  cursorStyle:",
        "    preset: '" + cs.preset + "'",
        "    pointerShape: '" + cs.pointerShape + "'",
        "    pointerColor: '" + cs.pointerColor + "'",
        "    pointerBorderColor: '" + cs.pointerBorderColor + "'",
        "    pointerScale: " + cs.pointerScale,
        "    trailVariant: '" + cs.trailVariant + "'",
        "    trailColorStart: '" + cs.trailColorStart + "'",
        "    trailColorEnd: '" + cs.trailColorEnd + "'",
        "    trailWidth: " + cs.trailWidth,
        "    trailLength: " + cs.trailLength,
        "    trailGlow: " + Boolean(cs.trailGlow),
        "    rippleColor: '" + cs.rippleColor + "'",
        "    showBadge: " + Boolean(cs.showBadge),
        "    badgeTextPrefix: '" + cs.badgeTextPrefix + "'",
      ];
      if (cs.customPointerSvgPath) {
        lines.push("    customPointerSvgPath: " + JSON.stringify(cs.customPointerSvgPath));
      }
      if (cs.customPointerImageUrl) {
        lines.push("    customPointerImageUrl: " + JSON.stringify(cs.customPointerImageUrl));
        lines.push("    customPointerHotspotX: " + cs.customPointerHotspotX);
        lines.push("    customPointerHotspotY: " + cs.customPointerHotspotY);
      }
      return lines.join("\n");
    }

    function VisualBrowserSettingsBody(props) {
      const t = props.t;
      const formSnap = props.liveSnap;
      const hasProvider = Boolean(props.hasProvider);
      const rawStatus = formSnap?.status;

      const [loadingTimedOut, setLoadingTimedOut] = React.useState(false);

      React.useEffect(() => {
        if (!hasProvider || (rawStatus && rawStatus !== "loading")) {
          setLoadingTimedOut(false);
          return;
        }
        const timer = setTimeout(() => {
          setLoadingTimedOut(true);
        }, 2500);
        return () => clearTimeout(timer);
      }, [hasProvider, rawStatus]);

      const [draft, setDraft] = React.useState(() => buildDraftFromServer(formSnap?.value));
      const [dirty, setDirty] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [statusMsg, setStatusMsg] = React.useState(null);
      const [snippetText, setSnippetText] = React.useState("");
      const [recordingKey, setRecordingKey] = React.useState(false);

      React.useEffect(() => {
        if (!dirty && formSnap?.value !== undefined) {
          setDraft(buildDraftFromServer(formSnap.value));
        }
      }, [formSnap?.value, formSnap?.revision, dirty]);

      React.useEffect(() => {
        if (!recordingKey || typeof window === "undefined") return;
        const onKey = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.key !== "Escape" && !["Control", "Shift", "Alt", "Meta"].includes(ev.key)) {
            setDraft((prev) => ({ ...prev, takeoverHotkey: ev.key }));
            setDirty(true);
            setStatusMsg(null);
          }
          setRecordingKey(false);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [recordingKey]);

      if (rawStatus === "unavailable") {
        return e("div", { className: "dshvb_wrap" }, e("p", { className: "dshvb_status err" }, t("unavailable")));
      }

      if (hasProvider && (!formSnap || rawStatus === "loading") && !loadingTimedOut) {
        return e("div", { className: "dshvb_wrap" }, e("p", { className: "dshvb_status" }, t("loading")));
      }

      const isDegraded =
        !hasProvider || !formSnap || rawStatus === "loading" || rawStatus === "degraded";
      const liveWritable = Boolean(formSnap?.writable) && !isDegraded;
      const controlsEditable = liveWritable || isDegraded;
      const writable = controlsEditable;
      const cs = draft.cursorStyle;
      const imgUrl = (cs.customPointerImageUrl || "").trim();
      const imageUrlError =
        cs.pointerShape === "custom-image" && imgUrl && !SAFE_IMAGE_URL_RE.test(imgUrl)
          ? t("invalidImageUrl")
          : null;

      const updateStyle = (patch) => {
        setDraft((prev) => ({
          ...prev,
          cursorStyle: {
            ...prev.cursorStyle,
            ...patch,
          },
        }));
        setDirty(true);
        setStatusMsg(null);
      };

      const applyPreset = (presetKey) => {
        const presetCfg = PRESETS[presetKey] || PRESETS["cyber-neon"];
        if (presetKey === "custom") {
          updateStyle({ preset: "custom" });
          return;
        }
        setDraft((prev) => ({
          ...prev,
          cursorStyle: { ...presetCfg, preset: presetKey },
        }));
        setDirty(true);
        setStatusMsg(null);
      };

      const onUploadImage = (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        if (file.size > MAX_CUSTOM_IMAGE_BYTES) {
          setStatusMsg({ kind: "err", text: t("imageTooLarge") });
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            updateStyle({
              preset: "custom",
              pointerShape: "custom-image",
              customPointerImageUrl: reader.result,
            });
          }
        };
        reader.readAsDataURL(file);
      };

      const onSave = async () => {
        if (!liveWritable || saving || imageUrlError) return;
        const mutateFn = props.form?.mutate || props.saveMutation;
        if (typeof mutateFn !== "function") return;
        setSaving(true);
        setStatusMsg(null);
        try {
          const ops = [
            { op: "set", path: ["cursorStyle"], value: draft.cursorStyle },
            { op: "set", path: ["windowMode"], value: draft.windowMode },
            { op: "set", path: ["keepWindowOpen"], value: draft.keepWindowOpen },
            { op: "set", path: ["showTakeoverControl"], value: draft.showTakeoverControl },
            { op: "set", path: ["takeoverHotkey"], value: draft.takeoverHotkey },
          ];
          const ok = await mutateFn(ops, formSnap?.revision);
          if (ok) {
            setDirty(false);
            setStatusMsg({ kind: "ok", text: t("saved") });
          } else {
            setStatusMsg({ kind: "err", text: t("saveFailed") });
          }
        } catch {
          setStatusMsg({ kind: "err", text: t("saveFailed") });
        } finally {
          setSaving(false);
        }
      };

      const onOpenConfigFile = async () => {
        if (typeof props.openConfigDocument !== "function") {
          setStatusMsg({ kind: "err", text: t("openConfigMissing") });
          return;
        }
        try {
          const res = await props.openConfigDocument();
          if (res && res.ok === false) {
            setStatusMsg({ kind: "err", text: res.error?.message || t("openConfigMissing") });
          } else {
            setStatusMsg({ kind: "ok", text: t("openConfigDone") });
          }
        } catch {
          setStatusMsg({ kind: "err", text: t("openConfigMissing") });
        }
      };

      const onCopySnippet = async (text) => {
        setSnippetText(text);
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            setStatusMsg({ kind: "ok", text: t("copiedSnippet") });
            return;
          }
        } catch {}
        setStatusMsg({ kind: "ok", text: t("copyFallback") });
      };

      const onDiscard = () => {
        setDraft(buildDraftFromServer(formSnap?.value));
        setDirty(false);
        setStatusMsg(null);
      };

      const onResetDefaults = () => {
        setDraft({
          cursorStyle: { ...PRESETS["cyber-neon"], preset: "cyber-neon" },
          windowMode: "visible-background",
          keepWindowOpen: true,
          showTakeoverControl: true,
          takeoverHotkey: "F8",
        });
        setDirty(true);
        setStatusMsg(null);
      };

      const presetList = [
        { key: "cyber-neon", label: t("presetCyberNeon"), c0: "#ff3b28", c1: "#00f0ff" },
        { key: "comet-gold", label: t("presetCometGold"), c0: "#ff3b00", c1: "#ffe66d" },
        { key: "laser-dots", label: t("presetLaserDots"), c0: "#ec4899", c1: "#38bdf8" },
        { key: "stealth-minimal", label: t("presetStealthMinimal"), c0: "#111827", c1: "#9ca3af" },
        { key: "clean-none", label: t("presetCleanNone"), c0: "#ff3b28", c1: "#cbd5e1" },
        { key: "custom", label: t("presetCustom"), c0: cs.pointerColor, c1: cs.trailColorEnd },
      ];

      const diagText =
        "宿主能力探测：props.form=" +
        String(Boolean(props.form)) +
        " · useConfigForm=" +
        typeof props.useConfigForm +
        " · hooks.configForm=" +
        typeof props.hooks?.configForm +
        " · configFormStore=" +
        typeof props.configFormStore +
        " · 插件已挂载=" +
        String(rawStatus !== "unavailable");

      return e(
        "div",
        { className: "dshvb_wrap" },
        e(
          "div",
          { className: "dshvb_head" },
          e("h2", null, t("title")),
          e("p", null, t("subtitle"))
        ),
        isDegraded &&
          e(
            "div",
            { className: "dshvb_banner", role: "status" },
            e("div", { className: "dshvb_bannerTitle" }, t("degradedTitle")),
            e("p", { className: "dshvb_bannerText" }, t("degradedDesc")),
            e(
              "div",
              { className: "dshvb_btnGroup" },
              e(
                "button",
                {
                  type: "button",
                  className: "dshvb_btn",
                  onClick: onOpenConfigFile,
                },
                t("openConfigFile")
              ),
              e(
                "button",
                {
                  type: "button",
                  className: "dshvb_btn primary",
                  onClick: () => onCopySnippet(buildToolCallSnippet(draft)),
                },
                t("copyToolCall")
              ),
              e(
                "button",
                {
                  type: "button",
                  className: "dshvb_btn",
                  onClick: () => onCopySnippet(buildCordisYamlSnippet(draft)),
                },
                t("copyYamlSnippet")
              )
            )
          ),
        e(LiveCursorPreview, { style: cs, t }),
        e(
          "div",
          { className: "dshvb_card" },
          e("h3", { className: "dshvb_cardTitle" }, t("presetsTitle")),
          e(
            "div",
            { className: "dshvb_presets" },
            presetList.map((item) =>
              e(
                "button",
                {
                  key: item.key,
                  type: "button",
                  className: "dshvb_presetBtn",
                  "data-active": cs.preset === item.key ? "true" : undefined,
                  disabled: !writable || saving,
                  onClick: () => applyPreset(item.key),
                },
                e("span", {
                  className: "dshvb_swatch",
                  style: { background: "linear-gradient(135deg," + item.c0 + "," + item.c1 + ")" },
                }),
                e("span", null, item.label)
              )
            )
          )
        ),
        e(
          "div",
          { className: "dshvb_card" },
          e("h3", { className: "dshvb_cardTitle" }, t("shapeSectionTitle")),
          e(
            "div",
            { className: "dshvb_grid" },
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("pointerShape")),
              e(
                "select",
                {
                  className: "dshvb_select",
                  disabled: !writable || saving,
                  value: cs.pointerShape,
                  onChange: (ev) => updateStyle({ preset: "custom", pointerShape: ev.target.value }),
                },
                e("option", { value: "arrow" }, t("shapeArrow")),
                e("option", { value: "crosshair" }, t("shapeCrosshair")),
                e("option", { value: "dot" }, t("shapeDot")),
                e("option", { value: "star" }, t("shapeStar")),
                e("option", { value: "ring" }, t("shapeRing")),
                e("option", { value: "custom-svg" }, t("shapeCustomSvg")),
                e("option", { value: "custom-image" }, t("shapeCustomImage"))
              )
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("pointerScale") + ": " + cs.pointerScale.toFixed(2) + "x"),
              e("input", {
                type: "range",
                min: 0.4,
                max: 3.0,
                step: 0.05,
                disabled: !writable || saving,
                value: cs.pointerScale,
                onChange: (ev) => updateStyle({ preset: "custom", pointerScale: Number(ev.target.value) }),
              })
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("pointerColor")),
              e(
                "div",
                { className: "dshvb_colorRow" },
                e("input", {
                  type: "color",
                  disabled: !writable || saving,
                  value: normalizeHexColor(cs.pointerColor, "#ff3b28"),
                  onChange: (ev) => updateStyle({ preset: "custom", pointerColor: ev.target.value }),
                }),
                e("input", {
                  type: "text",
                  className: "dshvb_input",
                  disabled: !writable || saving,
                  value: cs.pointerColor,
                  onChange: (ev) => updateStyle({ preset: "custom", pointerColor: ev.target.value }),
                })
              )
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("pointerBorderColor")),
              e(
                "div",
                { className: "dshvb_colorRow" },
                e("input", {
                  type: "color",
                  disabled: !writable || saving,
                  value: normalizeHexColor(cs.pointerBorderColor, "#ffffff"),
                  onChange: (ev) => updateStyle({ preset: "custom", pointerBorderColor: ev.target.value }),
                }),
                e("input", {
                  type: "text",
                  className: "dshvb_input",
                  disabled: !writable || saving,
                  value: cs.pointerBorderColor,
                  onChange: (ev) => updateStyle({ preset: "custom", pointerBorderColor: ev.target.value }),
                })
              )
            )
          ),
          cs.pointerShape === "custom-svg" &&
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("customSvgLabel")),
              e("textarea", {
                className: "dshvb_textarea",
                disabled: !writable || saving,
                value: cs.customPointerSvgPath,
                placeholder: SHAPE_PATHS.arrow,
                onChange: (ev) => updateStyle({ preset: "custom", customPointerSvgPath: ev.target.value }),
              }),
              e(
                "div",
                { className: "dshvb_chips" },
                e("span", { className: "dshvb_status" }, t("customSvgTemplates")),
                CUSTOM_SVG_TEMPLATES.map((tpl) =>
                  e(
                    "button",
                    {
                      key: tpl.id,
                      type: "button",
                      className: "dshvb_btn",
                      disabled: !writable || saving,
                      onClick: () => updateStyle({ preset: "custom", customPointerSvgPath: tpl.d }),
                    },
                    t("nav") === "视觉浏览器" ? tpl.zh : tpl.en
                  )
                )
              )
            ),
          cs.pointerShape === "custom-image" &&
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("customImageLabel")),
              e(
                "div",
                { className: "dshvb_btnGroup" },
                e(
                  "label",
                  { className: "dshvb_btn", style: { display: "inline-block" } },
                  t("uploadImage"),
                  e("input", {
                    type: "file",
                    accept: "image/png,image/jpeg,image/webp,image/svg+xml,image/gif",
                    style: { display: "none" },
                    disabled: !writable || saving,
                    onChange: onUploadImage,
                  })
                ),
                e("input", {
                  type: "text",
                  className: "dshvb_input",
                  style: { flex: 1, minWidth: "200px" },
                  disabled: !writable || saving,
                  value: cs.customPointerImageUrl,
                  placeholder: "https://... or data:image/png;base64,...",
                  onChange: (ev) => updateStyle({ preset: "custom", customPointerImageUrl: ev.target.value }),
                }),
                cs.customPointerImageUrl &&
                  e(
                    "button",
                    {
                      type: "button",
                      className: "dshvb_btn",
                      disabled: !writable || saving,
                      onClick: () => updateStyle({ preset: "custom", customPointerImageUrl: "" }),
                    },
                    t("clearImage")
                  )
              ),
              imageUrlError && e("div", { className: "dshvb_status err" }, imageUrlError),
              e(
                "div",
                { className: "dshvb_grid" },
                e(
                  "div",
                  { className: "dshvb_field" },
                  e("label", { className: "dshvb_label" }, t("hotspotX") + ": " + cs.customPointerHotspotX + "px"),
                  e("input", {
                    type: "range",
                    min: 0,
                    max: 28,
                    step: 1,
                    disabled: !writable || saving,
                    value: cs.customPointerHotspotX,
                    onChange: (ev) => updateStyle({ preset: "custom", customPointerHotspotX: Number(ev.target.value) }),
                  })
                ),
                e(
                  "div",
                  { className: "dshvb_field" },
                  e("label", { className: "dshvb_label" }, t("hotspotY") + ": " + cs.customPointerHotspotY + "px"),
                  e("input", {
                    type: "range",
                    min: 0,
                    max: 28,
                    step: 1,
                    disabled: !writable || saving,
                    value: cs.customPointerHotspotY,
                    onChange: (ev) => updateStyle({ preset: "custom", customPointerHotspotY: Number(ev.target.value) }),
                  })
                )
              )
            )
        ),
        e(
          "div",
          { className: "dshvb_card" },
          e("h3", { className: "dshvb_cardTitle" }, t("trailSectionTitle")),
          e(
            "div",
            { className: "dshvb_grid" },
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("trailVariant")),
              e(
                "select",
                {
                  className: "dshvb_select",
                  disabled: !writable || saving,
                  value: cs.trailVariant,
                  onChange: (ev) => updateStyle({ preset: "custom", trailVariant: ev.target.value }),
                },
                e("option", { value: "dashed" }, t("variantDashed")),
                e("option", { value: "solid" }, t("variantSolid")),
                e("option", { value: "dots" }, t("variantDots")),
                e("option", { value: "comet" }, t("variantComet")),
                e("option", { value: "none" }, t("variantNone"))
              )
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("badgeTextPrefix")),
              e("input", {
                type: "text",
                maxLength: 24,
                className: "dshvb_input",
                disabled: !writable || saving,
                value: cs.badgeTextPrefix,
                onChange: (ev) => updateStyle({ preset: "custom", badgeTextPrefix: ev.target.value }),
              })
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("trailWidth") + ": " + cs.trailWidth.toFixed(1)),
              e("input", {
                type: "range",
                min: 0,
                max: 12,
                step: 0.2,
                disabled: !writable || saving,
                value: cs.trailWidth,
                onChange: (ev) => updateStyle({ preset: "custom", trailWidth: Number(ev.target.value) }),
              })
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("trailLength") + ": " + cs.trailLength),
              e("input", {
                type: "range",
                min: 2,
                max: 60,
                step: 1,
                disabled: !writable || saving,
                value: cs.trailLength,
                onChange: (ev) => updateStyle({ preset: "custom", trailLength: Number(ev.target.value) }),
              })
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("trailColorStart")),
              e(
                "div",
                { className: "dshvb_colorRow" },
                e("input", {
                  type: "color",
                  disabled: !writable || saving,
                  value: normalizeHexColor(cs.trailColorStart, "#ff3b28"),
                  onChange: (ev) => updateStyle({ preset: "custom", trailColorStart: ev.target.value }),
                }),
                e("input", {
                  type: "text",
                  className: "dshvb_input",
                  disabled: !writable || saving,
                  value: cs.trailColorStart,
                  onChange: (ev) => updateStyle({ preset: "custom", trailColorStart: ev.target.value }),
                })
              )
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("trailColorEnd")),
              e(
                "div",
                { className: "dshvb_colorRow" },
                e("input", {
                  type: "color",
                  disabled: !writable || saving,
                  value: normalizeHexColor(cs.trailColorEnd, "#00f0ff"),
                  onChange: (ev) => updateStyle({ preset: "custom", trailColorEnd: ev.target.value }),
                }),
                e("input", {
                  type: "text",
                  className: "dshvb_input",
                  disabled: !writable || saving,
                  value: cs.trailColorEnd,
                  onChange: (ev) => updateStyle({ preset: "custom", trailColorEnd: ev.target.value }),
                })
              )
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("rippleColor")),
              e(
                "div",
                { className: "dshvb_colorRow" },
                e("input", {
                  type: "color",
                  disabled: !writable || saving,
                  value: normalizeHexColor(cs.rippleColor, "#00f0ff"),
                  onChange: (ev) => updateStyle({ preset: "custom", rippleColor: ev.target.value }),
                }),
                e("input", {
                  type: "text",
                  className: "dshvb_input",
                  disabled: !writable || saving,
                  value: cs.rippleColor,
                  onChange: (ev) => updateStyle({ preset: "custom", rippleColor: ev.target.value }),
                })
              )
            )
          ),
          e(
            "label",
            { className: "dshvb_checkRow" },
            e("span", null, t("trailGlow")),
            e("input", {
              type: "checkbox",
              disabled: !writable || saving,
              checked: Boolean(cs.trailGlow),
              onChange: (ev) => updateStyle({ preset: "custom", trailGlow: ev.target.checked }),
            })
          ),
          e(
            "label",
            { className: "dshvb_checkRow" },
            e("span", null, t("showBadge")),
            e("input", {
              type: "checkbox",
              disabled: !writable || saving,
              checked: Boolean(cs.showBadge),
              onChange: (ev) => updateStyle({ preset: "custom", showBadge: ev.target.checked }),
            })
          )
        ),
        e(
          "div",
          { className: "dshvb_card" },
          e("h3", { className: "dshvb_cardTitle" }, t("windowSectionTitle")),
          e(
            "div",
            { className: "dshvb_grid" },
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("windowMode")),
              e(
                "select",
                {
                  className: "dshvb_select",
                  disabled: !writable || saving,
                  value: draft.windowMode,
                  onChange: (ev) => {
                    setDraft((p) => ({ ...p, windowMode: ev.target.value }));
                    setDirty(true);
                    setStatusMsg(null);
                  },
                },
                e("option", { value: "visible-background" }, t("winVisibleBg")),
                e("option", { value: "minimized" }, t("winMinimized")),
                e("option", { value: "headless" }, t("winHeadless"))
              )
            ),
            e(
              "div",
              { className: "dshvb_field" },
              e("label", { className: "dshvb_label" }, t("takeoverHotkey")),
              e(
                "div",
                { className: "dshvb_btnGroup" },
                e("input", {
                  type: "text",
                  className: "dshvb_input",
                  style: { flex: 1 },
                  disabled: !writable || saving,
                  value: draft.takeoverHotkey,
                  onChange: (ev) => {
                    setDraft((p) => ({ ...p, takeoverHotkey: ev.target.value }));
                    setDirty(true);
                    setStatusMsg(null);
                  },
                }),
                e(
                  "button",
                  {
                    type: "button",
                    className: "dshvb_btn",
                    disabled: !writable || saving,
                    onClick: () => setRecordingKey((r) => !r),
                  },
                  recordingKey ? t("recordingHotkey") : t("recordHotkey")
                )
              )
            )
          ),
          e(
            "label",
            { className: "dshvb_checkRow" },
            e("span", null, t("keepWindowOpen")),
            e("input", {
              type: "checkbox",
              disabled: !writable || saving,
              checked: Boolean(draft.keepWindowOpen),
              onChange: (ev) => {
                setDraft((p) => ({ ...p, keepWindowOpen: ev.target.checked }));
                setDirty(true);
                setStatusMsg(null);
              },
            })
          ),
          e(
            "label",
            { className: "dshvb_checkRow" },
            e("span", null, t("showTakeoverControl")),
            e("input", {
              type: "checkbox",
              disabled: !writable || saving,
              checked: Boolean(draft.showTakeoverControl),
              onChange: (ev) => {
                setDraft((p) => ({ ...p, showTakeoverControl: ev.target.checked }));
                setDirty(true);
                setStatusMsg(null);
              },
            })
          )
        ),
        e(
          "div",
          { className: "dshvb_actions" },
          e(
            "div",
            {
              className:
                "dshvb_status" + (statusMsg?.kind === "ok" ? " ok" : statusMsg?.kind === "err" ? " err" : ""),
            },
            statusMsg?.text || (!isDegraded && !liveWritable ? t("readOnly") : "")
          ),
          e(
            "div",
            { className: "dshvb_btnGroup" },
            !isDegraded &&
              typeof props.openConfigDocument === "function" &&
              e(
                "button",
                {
                  type: "button",
                  className: "dshvb_btn",
                  onClick: onOpenConfigFile,
                },
                t("openConfigFile")
              ),
            e(
              "button",
              {
                type: "button",
                className: "dshvb_btn",
                disabled: !writable || saving,
                onClick: onResetDefaults,
              },
              t("resetDefaults")
            ),
            isDegraded
              ? e(
                  React.Fragment,
                  null,
                  e(
                    "button",
                    {
                      type: "button",
                      className: "dshvb_btn primary",
                      onClick: () => onCopySnippet(buildToolCallSnippet(draft)),
                    },
                    t("copyToolCall")
                  ),
                  e(
                    "button",
                    {
                      type: "button",
                      className: "dshvb_btn",
                      onClick: () => onCopySnippet(buildCordisYamlSnippet(draft)),
                    },
                    t("copyYamlSnippet")
                  )
                )
              : e(
                  React.Fragment,
                  null,
                  e(
                    "button",
                    {
                      type: "button",
                      className: "dshvb_btn",
                      disabled: !dirty || saving,
                      onClick: onDiscard,
                    },
                    t("discard")
                  ),
                  e(
                    "button",
                    {
                      type: "button",
                      className: "dshvb_btn primary",
                      disabled: !liveWritable || !dirty || saving || Boolean(imageUrlError),
                      onClick: onSave,
                    },
                    saving ? t("saving") : t("save")
                  )
                )
          )
        ),
        snippetText &&
          e("textarea", {
            readOnly: true,
            className: "dshvb_textarea",
            value: snippetText,
          }),
        isDegraded && e("p", { className: "dshvb_diag" }, diagText)
      );
    }

    function createTargetFormStore(ctx) {
      let currentNs = DEFAULT_PLUGIN_NS;
      let activeForm = ctx.configForms.get(currentNs);
      const listeners = new Set();
      let offForm = null;
      let offDescribe = null;

      const notify = () => {
        for (const l of listeners) {
          try {
            l();
          } catch {}
        }
      };

      const bindForm = (nextNs) => {
        if (nextNs === currentNs && offForm) return;
        if (offForm) offForm();
        currentNs = nextNs;
        activeForm = ctx.configForms.get(nextNs);
        offForm = activeForm.subscribe(notify);
        notify();
      };

      offForm = activeForm.subscribe(notify);
      const mirror = typeof ctx.configForms.describe === "function" ? ctx.configForms.describe() : null;
      const syncNamespace = () => {
        const snap = mirror?.getSnapshot?.();
        const namespaces = snap?.view?.namespaces;
        if (!Array.isArray(namespaces)) return;
        if (namespaces.some((n) => n.ns === DEFAULT_PLUGIN_NS)) {
          bindForm(DEFAULT_PLUGIN_NS);
          return;
        }
        const matched = namespaces.find(
          (n) =>
            (typeof n.ns === "string" && n.ns.includes("visual-browser")) ||
            (n.value && typeof n.value === "object" && "cursorStyle" in n.value) ||
            (n.schema && typeof n.schema === "object" && n.schema.dict && "cursorStyle" in n.schema.dict)
        );
        if (matched && matched.ns !== currentNs) {
          bindForm(matched.ns);
        }
      };

      if (mirror && typeof mirror.subscribe === "function") {
        offDescribe = mirror.subscribe(syncNamespace);
        syncNamespace();
      }

      return {
        getSnapshot: () => activeForm.getSnapshot(),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        mutate: (ops, expectedRevision) => activeForm.mutate(ops, expectedRevision),
        dispose: () => {
          if (offForm) offForm();
          if (offDescribe) offDescribe();
          listeners.clear();
        },
      };
    }

    const inject = ["slots", "locale", "configForms"];

    function apply(ctx) {
      const fallbackT = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "dsh-plugin-visual-browser: settings locale"
      );

      const targetFormStore = createTargetFormStore(ctx);
      ctx.effect(() => () => targetFormStore.dispose(), "dsh-plugin-visual-browser: settings store");

      let openConfigDocFn = null;
      if (typeof ctx.inject === "function") {
        try {
          ctx.inject(["remote.settings"], (sub) => {
            openConfigDocFn = async () => {
              const rs = sub?.["remote.settings"];
              if (rs && typeof rs.openSettingsDocument === "function") {
                return rs.openSettingsDocument();
              }
              return { ok: false, error: { message: "remote.settings unavailable" } };
            };
            return () => {
              openConfigDocFn = null;
            };
          });
        } catch {}
      }

      const makeInjected = () => ({
        hooks: { configForm: targetFormStore },
        configFormStore: targetFormStore,
        saveMutation: (ops, expectedRevision) => targetFormStore.mutate(ops, expectedRevision),
        openConfigDocument: () =>
          typeof openConfigDocFn === "function"
            ? openConfigDocFn()
            : Promise.resolve({ ok: false, error: { message: "remote.settings unavailable" } }),
        fallbackT,
      });

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "visual-browser",
            order: 40,
            label: () => fallbackT("nav"),
            locale: NS,
            inject: makeInjected,
          },
          VisualBrowserSettingsPanel
        )
      );

      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: DEFAULT_PLUGIN_NS,
            locale: NS,
            inject: makeInjected,
          },
          VisualBrowserSettingsPanel
        )
      );
    }

    exports.NS = NS;
    exports.inject = inject;
    exports.apply = apply;
    exports.VisualBrowserSettingsPanel = VisualBrowserSettingsPanel;
    return module.exports;
  },
});
