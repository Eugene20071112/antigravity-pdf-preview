(() => {
  const VERSION = 5;
  const BINDING_NAME = "__antigravityPdfPreviewRequest";
  const OVERLAY_ID = "__antigravity_pdf_preview";
  const existing = globalThis.__antigravityPdfPreviewBridge;

  if (existing?.version === VERSION) {
    existing.requestedUri = null;
    existing.ensure();
    return;
  }

  if (existing) {
    clearInterval(existing.timer);
    existing.observer?.disconnect?.();
    existing.resizeObserver?.disconnect?.();
    if (existing.keyHandler) window.removeEventListener("keydown", existing.keyHandler, true);
    existing.ensure = () => {};
    document.getElementById(OVERLAY_ID)?.remove();
  }

  const I18N = {
    en: {
      previous: "Previous page",
      next: "Next page",
      zoomOut: "Zoom out",
      zoomIn: "Zoom in",
      fitWidth: "Fit to width",
      fitPage: "Fit whole page",
      rotate: "Rotate clockwise",
      thumbnails: "Thumbnail sidebar",
      fullscreen: "Full preview",
      exitFullscreen: "Exit full preview",
      reset: "Reset view",
      pageNumber: "Page number",
      pdfPages: "PDF pages",
      pageThumbnails: "Page thumbnails",
      pagePreview: "Page previews",
      loading: "Streaming and preparing a sharp preview…",
      cannotPreview: "Unable to preview: {message}",
      pageAria: "Page {page}",
      goToPage: "Go to page {page}",
      readerLabel: "PDF viewer: {name}",
      hint: "Pinch to zoom",
    },
    "zh-CN": {
      previous: "上一页",
      next: "下一页",
      zoomOut: "缩小",
      zoomIn: "放大",
      fitWidth: "适合宽度",
      fitPage: "显示整页",
      rotate: "顺时针旋转",
      thumbnails: "缩略图侧栏",
      fullscreen: "全图预览",
      exitFullscreen: "退出全图预览",
      reset: "恢复默认",
      pageNumber: "页码",
      pdfPages: "PDF 页面",
      pageThumbnails: "页面缩略图",
      pagePreview: "页面预览",
      loading: "正在按需读取并准备清晰预览…",
      cannotPreview: "无法预览：{message}",
      pageAria: "第 {page} 页",
      goToPage: "跳到第 {page} 页",
      readerLabel: "PDF 阅读器：{name}",
      hint: "捏合手势缩放",
    },
    "zh-TW": {
      previous: "上一頁",
      next: "下一頁",
      zoomOut: "縮小",
      zoomIn: "放大",
      fitWidth: "符合寬度",
      fitPage: "顯示整頁",
      rotate: "順時針旋轉",
      thumbnails: "縮圖側欄",
      fullscreen: "全圖預覽",
      exitFullscreen: "退出全圖預覽",
      reset: "恢復預設",
      pageNumber: "頁碼",
      pdfPages: "PDF 頁面",
      pageThumbnails: "頁面縮圖",
      pagePreview: "頁面預覽",
      loading: "正在串流並準備清晰預覽…",
      cannotPreview: "無法預覽：{message}",
      pageAria: "第 {page} 頁",
      goToPage: "前往第 {page} 頁",
      readerLabel: "PDF 閱讀器：{name}",
      hint: "捏合手勢縮放",
    },
  };

  const detectLocale = () => {
    const language = (document.documentElement.lang || navigator.language || "en").toLowerCase();
    if (language.startsWith("zh")) {
      return /(?:hant|tw|hk|mo)/.test(language) ? "zh-TW" : "zh-CN";
    }
    return "en";
  };

  const translate = (key, parameters = {}, locale = state?.locale ?? detectLocale()) => {
    let text = I18N[locale]?.[key] ?? I18N.en[key] ?? key;
    for (const [name, value] of Object.entries(parameters)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };

  const state = {
    version: VERSION,
    uri: null,
    requestedUri: null,
    pdf: null,
    loadingTask: null,
    overlay: null,
    nodes: {},
    pages: [],
    visiblePages: new Set(),
    renderQueue: new Set(),
    thumbnailQueue: new Set(),
    activeRenders: 0,
    activeThumbnailRenders: 0,
    renderGeneration: 0,
    scale: 1,
    rotation: 0,
    fitMode: "width",
    currentPage: 1,
    timer: null,
    observer: null,
    resizeObserver: null,
    intersectionObserver: null,
    thumbnailObserver: null,
    scrollFrame: null,
    zoomTimer: null,
    loadGeneration: 0,
    sidebarOpen: localStorage.getItem("antigravityPdfPreview.sidebar") === "open",
    fullscreen: false,
    source: null,
    keyHandler: null,
    locale: detectLocale(),
    errorMessage: null,
  };

  const currentPdfUri = () => {
    try {
      const tab = new URL(location.href).searchParams.get("tab") || "";
      if (!tab.startsWith("file__file://")) return null;
      const uri = tab.slice("file__".length);
      const url = new URL(uri);
      return url.protocol === "file:" && url.pathname.toLowerCase().endsWith(".pdf")
        ? url.href
        : null;
    } catch {
      return null;
    }
  };

  const fileName = (uri) => {
    try {
      return decodeURIComponent(new URL(uri).pathname.split("/").pop()) || "PDF";
    } catch {
      return "PDF";
    }
  };

  const hostElement = () => document.querySelector('[aria-label="File Viewer"]');
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** power;
    return `${value >= 100 || power === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
  };

  const icon = (path, viewBox = "0 0 24 24") =>
    `<svg viewBox="${viewBox}" aria-hidden="true"><path d="${path}"/></svg>`;

  const icons = {
    previous: icon("M15.5 5.5 9 12l6.5 6.5-1.4 1.4L6.2 12l7.9-7.9 1.4 1.4Z"),
    next: icon("m8.5 18.5 6.5-6.5-6.5-6.5 1.4-1.4 7.9 7.9-7.9 7.9-1.4-1.4Z"),
    minus: icon("M5 11h14v2H5z"),
    plus: icon("M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"),
    fitWidth: icon("M3 6h18v12H3V6Zm2 2v8h14V8H5Zm2.5 3h9v2h-9v2L4.5 12l3-3v2Zm9 0v-2l3 3-3 3v-2h-9v-2h9Z"),
    fitPage: icon("M6 2h9l5 5v15H6V2Zm2 2v16h10V8h-4V4H8Zm7 1.4V7h1.6L15 5.4ZM10 11h6v2h-6v-2Zm0 4h6v2h-6v-2Z"),
    rotate: icon("M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.3L13 11h8V3l-3.3 3.3Z"),
    thumbnails: icon("M3 4h5v5H3V4Zm2 2v1h1V6H5Zm5-2h11v2H10V4Zm0 3h8v2h-8V7ZM3 11h5v5H3v-5Zm2 2v1h1v-1H5Zm5-2h11v2H10v-2Zm0 3h8v2h-8v-2ZM3 18h5v3H3v-3Zm2 2h1v-1H5v1Zm5-2h11v2H10v-2Z"),
    fullscreen: icon("M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"),
    exitFullscreen: icon("M8 4h2v6H4V8h4V4Zm6 0h2v4h4v2h-6V4ZM4 14h6v6H8v-4H4v-2Zm10 0h6v2h-4v4h-2v-6Z"),
    reset: icon("M12 5a7 7 0 1 1-6.3 4H3l3.5-4L10 9H7.8A5 5 0 1 0 12 7V5Z"),
  };

  function button(labelKey, svg, onClick, extraClass = "") {
    const label = translate(labelKey);
    const control = document.createElement("button");
    control.type = "button";
    control.className = `agpdf-button ${extraClass}`;
    control.title = label;
    control.setAttribute("aria-label", label);
    control.dataset.i18n = labelKey;
    control.dataset.tooltip = label;
    control.innerHTML = svg;
    control.addEventListener("click", onClick);
    return control;
  }

  function applyLocale(force = false) {
    const nextLocale = detectLocale();
    if (!force && nextLocale === state.locale) return;
    state.locale = nextLocale;
    if (!state.overlay) return;

    for (const control of state.overlay.querySelectorAll("button[data-i18n]")) {
      const label = translate(control.dataset.i18n);
      control.title = label;
      control.setAttribute("aria-label", label);
      control.dataset.tooltip = label;
    }
    state.overlay.setAttribute(
      "aria-label",
      translate("readerLabel", { name: fileName(state.uri) }),
    );
    state.nodes.pageInput?.setAttribute("aria-label", translate("pageNumber"));
    if (state.nodes.pageInput) state.nodes.pageInput.title = translate("pageNumber");
    state.nodes.scroll?.setAttribute("aria-label", translate("pdfPages"));
    state.nodes.sidebar?.setAttribute("aria-label", translate("pageThumbnails"));
    if (state.nodes.sidebarTitle) state.nodes.sidebarTitle.textContent = translate("pagePreview");
    if (state.nodes.hint) state.nodes.hint.textContent = translate("hint");
    if (state.nodes.stageText) {
      state.nodes.stageText.textContent = state.errorMessage
        ? translate("cannotPreview", { message: state.errorMessage })
        : translate("loading");
    }
    for (const pageState of state.pages) {
      const page = pageState.index + 1;
      pageState.slot.setAttribute("aria-label", translate("pageAria", { page }));
      pageState.thumbnail.setAttribute("aria-label", translate("goToPage", { page }));
    }
  }

  function viewerStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #${OVERLAY_ID} {
        --agpdf-bg: #151617;
        --agpdf-surface: rgba(35, 36, 38, .96);
        --agpdf-surface-hover: #34363a;
        --agpdf-border: rgba(255, 255, 255, .09);
        --agpdf-text: #e7e8ea;
        --agpdf-muted: #9da1a8;
        --agpdf-accent: #8ab4f8;
        --agpdf-accent-soft: rgba(138, 180, 248, .14);
        position: absolute;
        inset: 0;
        z-index: 2147483000;
        display: grid;
        grid-template-rows: 46px minmax(0, 1fr);
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--agpdf-bg);
        color: var(--agpdf-text);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        contain: layout paint style;
      }
      #${OVERLAY_ID}, #${OVERLAY_ID} * { box-sizing: border-box; }
      #${OVERLAY_ID}.fullscreen {
        position: fixed;
        inset: 30px 0 0;
        z-index: 2147483646;
        contain: layout paint style;
      }
      #${OVERLAY_ID} .agpdf-toolbar {
        position: relative;
        z-index: 5;
        display: grid;
        grid-template-columns: minmax(120px, 1fr) auto minmax(80px, 1fr);
        align-items: center;
        gap: 12px;
        padding: 0 12px;
        border-bottom: 1px solid var(--agpdf-border);
        background: linear-gradient(180deg, rgba(42, 43, 46, .98), rgba(31, 32, 34, .98));
        box-shadow: 0 1px 12px rgba(0, 0, 0, .24);
        user-select: none;
        -webkit-user-select: none;
      }
      #${OVERLAY_ID} .agpdf-file {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 9px;
      }
      #${OVERLAY_ID} .agpdf-left {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 9px;
      }
      #${OVERLAY_ID} .agpdf-file-icon {
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        flex: 0 0 24px;
        border: 1px solid rgba(255, 123, 133, .24);
        border-radius: 7px;
        color: #ff8a94;
        background: rgba(255, 105, 120, .10);
        font-size: 9px;
        font-weight: 750;
        letter-spacing: .35px;
      }
      #${OVERLAY_ID} .agpdf-file-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #d9dade;
        font-weight: 520;
      }
      #${OVERLAY_ID} .agpdf-controls,
      #${OVERLAY_ID} .agpdf-control-group {
        display: flex;
        align-items: center;
      }
      #${OVERLAY_ID} .agpdf-controls { gap: 7px; }
      #${OVERLAY_ID} .agpdf-control-group {
        height: 30px;
        padding: 2px;
        gap: 1px;
        border: 1px solid var(--agpdf-border);
        border-radius: 8px;
        background: rgba(255, 255, 255, .035);
      }
      #${OVERLAY_ID} .agpdf-button {
        position: relative;
        display: grid;
        place-items: center;
        width: 25px;
        height: 24px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        color: #c4c7cc;
        background: transparent;
        cursor: default;
        transition: color 100ms ease, background 100ms ease, transform 100ms ease;
      }
      #${OVERLAY_ID} .agpdf-button:hover {
        color: #fff;
        background: var(--agpdf-surface-hover);
      }
      #${OVERLAY_ID} .agpdf-button:active { transform: scale(.92); }
      #${OVERLAY_ID} .agpdf-button:focus-visible,
      #${OVERLAY_ID} .agpdf-page-input:focus-visible {
        outline: 2px solid var(--agpdf-accent);
        outline-offset: 1px;
      }
      #${OVERLAY_ID} .agpdf-button.active {
        color: var(--agpdf-accent);
        background: var(--agpdf-accent-soft);
      }
      #${OVERLAY_ID} .agpdf-button svg {
        width: 15px;
        height: 15px;
        fill: currentColor;
      }
      #${OVERLAY_ID} .agpdf-button[data-tooltip]::after {
        content: attr(data-tooltip);
        position: absolute;
        top: calc(100% + 9px);
        left: 50%;
        z-index: 30;
        max-width: 220px;
        padding: 5px 8px;
        border: 1px solid rgba(255, 255, 255, .12);
        border-radius: 6px;
        color: #f2f3f5;
        background: rgba(20, 21, 23, .98);
        box-shadow: 0 6px 18px rgba(0, 0, 0, .38);
        font-size: 11px;
        font-weight: 500;
        line-height: 1.25;
        letter-spacing: 0;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transform: translate(-50%, -3px);
        transition: opacity 120ms ease, transform 120ms ease;
      }
      #${OVERLAY_ID} .agpdf-button[data-tooltip]:hover::after,
      #${OVERLAY_ID} .agpdf-button[data-tooltip]:focus-visible::after {
        opacity: 1;
        transform: translate(-50%, 0);
        transition-delay: 320ms;
      }
      #${OVERLAY_ID} .agpdf-left .agpdf-button[data-tooltip]::after {
        left: 0;
        transform: translate(0, -3px);
      }
      #${OVERLAY_ID} .agpdf-left .agpdf-button[data-tooltip]:hover::after,
      #${OVERLAY_ID} .agpdf-left .agpdf-button[data-tooltip]:focus-visible::after {
        transform: translate(0, 0);
      }
      #${OVERLAY_ID} .agpdf-right .agpdf-button[data-tooltip]::after {
        right: 0;
        left: auto;
        transform: translate(0, -3px);
      }
      #${OVERLAY_ID} .agpdf-right .agpdf-button[data-tooltip]:hover::after,
      #${OVERLAY_ID} .agpdf-right .agpdf-button[data-tooltip]:focus-visible::after {
        transform: translate(0, 0);
      }
      #${OVERLAY_ID} .agpdf-page-input {
        width: 31px;
        height: 23px;
        padding: 0 4px;
        border: 0;
        border-radius: 5px;
        color: var(--agpdf-text);
        background: rgba(0, 0, 0, .24);
        font: 600 12px/23px ui-monospace, SFMono-Regular, Menlo, monospace;
        text-align: center;
        appearance: textfield;
      }
      #${OVERLAY_ID} .agpdf-page-input::-webkit-inner-spin-button { display: none; }
      #${OVERLAY_ID} .agpdf-page-count,
      #${OVERLAY_ID} .agpdf-zoom-label {
        color: var(--agpdf-muted);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      #${OVERLAY_ID} .agpdf-page-count { min-width: 25px; padding-right: 4px; }
      #${OVERLAY_ID} .agpdf-zoom-label {
        min-width: 39px;
        text-align: center;
        color: #d4d6da;
        font-weight: 600;
      }
      #${OVERLAY_ID} .agpdf-right {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      #${OVERLAY_ID} .agpdf-hint {
        overflow: hidden;
        color: #777b82;
        font-size: 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${OVERLAY_ID} .agpdf-body {
        display: grid;
        grid-template-columns: 0 minmax(0, 1fr);
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        transition: grid-template-columns 180ms cubic-bezier(.2,.8,.2,1);
      }
      #${OVERLAY_ID}.sidebar-open .agpdf-body {
        grid-template-columns: 164px minmax(0, 1fr);
      }
      #${OVERLAY_ID} .agpdf-sidebar {
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        border-right: 1px solid var(--agpdf-border);
        background: #1d1e20;
        opacity: 0;
        transform: translateX(-12px);
        transition: opacity 150ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
      }
      #${OVERLAY_ID}.sidebar-open .agpdf-sidebar {
        opacity: 1;
        transform: translateX(0);
      }
      #${OVERLAY_ID} .agpdf-sidebar-inner {
        width: 164px;
        height: 100%;
        overflow: auto;
        padding: 12px 10px 24px;
        scrollbar-color: #55585e transparent;
        scrollbar-width: thin;
      }
      #${OVERLAY_ID} .agpdf-sidebar-title {
        padding: 0 5px 9px;
        color: #858990;
        font-size: 10px;
        font-weight: 650;
        letter-spacing: .5px;
        text-transform: uppercase;
      }
      #${OVERLAY_ID} .agpdf-thumbnails {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      #${OVERLAY_ID} .agpdf-thumbnail {
        display: grid;
        justify-items: center;
        gap: 5px;
        width: 136px;
        padding: 7px;
        border: 1px solid transparent;
        border-radius: 8px;
        color: #8f939a;
        background: transparent;
        cursor: default;
        transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
      }
      #${OVERLAY_ID} .agpdf-thumbnail:hover {
        color: #d8dade;
        background: rgba(255,255,255,.045);
      }
      #${OVERLAY_ID} .agpdf-thumbnail.active {
        color: var(--agpdf-accent);
        border-color: rgba(138,180,248,.32);
        background: var(--agpdf-accent-soft);
      }
      #${OVERLAY_ID} .agpdf-thumbnail-paper {
        display: grid;
        place-items: center;
        width: 112px;
        min-height: 72px;
        overflow: hidden;
        border-radius: 2px;
        background: linear-gradient(135deg,#f8f8f8,#e9e9e9);
        box-shadow: 0 4px 12px rgba(0,0,0,.34);
      }
      #${OVERLAY_ID} .agpdf-thumbnail canvas {
        display: block;
        max-width: 112px;
        height: auto;
      }
      #${OVERLAY_ID} .agpdf-thumbnail-label {
        font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      #${OVERLAY_ID} .agpdf-scroll {
        position: relative;
        overflow: auto;
        min-width: 0;
        min-height: 0;
        padding: 24px 30px 42px;
        background:
          radial-gradient(circle at 50% -20%, rgba(112, 130, 156, .09), transparent 42%),
          #171819;
        overscroll-behavior: contain;
        scroll-behavior: smooth;
        scrollbar-color: #55585e transparent;
        scrollbar-width: thin;
      }
      #${OVERLAY_ID} .agpdf-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
      #${OVERLAY_ID} .agpdf-scroll::-webkit-scrollbar-thumb {
        border: 3px solid transparent;
        border-radius: 10px;
        background: #565960;
        background-clip: padding-box;
      }
      #${OVERLAY_ID} .agpdf-document {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 20px;
        width: max-content;
        min-width: 100%;
        margin: 0 auto;
      }
      #${OVERLAY_ID} .agpdf-page {
        position: relative;
        flex: 0 0 auto;
        overflow: hidden;
        border: 1px solid rgba(0, 0, 0, .45);
        border-radius: 4px;
        background: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .35), 0 12px 36px rgba(0, 0, 0, .28);
        transform: translateZ(0);
        transition: width 120ms cubic-bezier(.2,.8,.2,1), height 120ms cubic-bezier(.2,.8,.2,1), box-shadow 140ms ease;
      }
      #${OVERLAY_ID} .agpdf-page.current {
        box-shadow: 0 0 0 1px rgba(138, 180, 248, .32), 0 16px 42px rgba(0, 0, 0, .34);
      }
      #${OVERLAY_ID} .agpdf-page canvas {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        opacity: 1;
        transition: opacity 120ms ease;
      }
      #${OVERLAY_ID} .agpdf-page.rendering canvas { opacity: .72; }
      #${OVERLAY_ID} .agpdf-page-number {
        position: absolute;
        right: 8px;
        bottom: 7px;
        z-index: 2;
        padding: 2px 6px;
        border-radius: 10px;
        color: rgba(255,255,255,.8);
        background: rgba(0,0,0,.46);
        font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
        opacity: 0;
        transition: opacity 120ms ease;
        pointer-events: none;
      }
      #${OVERLAY_ID} .agpdf-page:hover .agpdf-page-number { opacity: 1; }
      #${OVERLAY_ID} .agpdf-stage {
        position: absolute;
        inset: 46px 0 0;
        z-index: 10;
        display: grid;
        place-items: center;
        background: rgba(21, 22, 23, .92);
        backdrop-filter: blur(8px);
        transition: opacity 180ms ease;
      }
      #${OVERLAY_ID} .agpdf-stage.hidden { opacity: 0; pointer-events: none; }
      #${OVERLAY_ID} .agpdf-stage-card {
        display: grid;
        justify-items: center;
        gap: 13px;
        max-width: 420px;
        padding: 26px 30px;
        color: var(--agpdf-muted);
        text-align: center;
      }
      #${OVERLAY_ID} .agpdf-spinner {
        width: 24px;
        height: 24px;
        border: 2px solid rgba(255,255,255,.12);
        border-top-color: var(--agpdf-accent);
        border-radius: 50%;
        animation: agpdf-spin .75s linear infinite;
      }
      #${OVERLAY_ID} .agpdf-error { color: #ff9b9b; }
      @keyframes agpdf-spin { to { transform: rotate(360deg); } }
      @media (max-width: 760px) {
        #${OVERLAY_ID} .agpdf-toolbar { grid-template-columns: minmax(70px, 1fr) auto; }
        #${OVERLAY_ID} .agpdf-right { display: none; }
        #${OVERLAY_ID} .agpdf-control-group.fit-controls { display: none; }
        #${OVERLAY_ID} .agpdf-scroll { padding-inline: 16px; }
        #${OVERLAY_ID}.sidebar-open .agpdf-body { grid-template-columns: 138px minmax(0, 1fr); }
        #${OVERLAY_ID} .agpdf-sidebar-inner { width: 138px; padding-inline: 5px; }
        #${OVERLAY_ID} .agpdf-thumbnail { width: 126px; }
      }
    `;
    return style;
  }

  function mount(uri, source = state.source) {
    const host = hostElement();
    if (!host) return null;
    state.errorMessage = null;
    document.getElementById(OVERLAY_ID)?.remove();

    const overlay = document.createElement("section");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "region");
    overlay.setAttribute("aria-label", translate("readerLabel", { name: fileName(uri) }));
    overlay.tabIndex = -1;
    overlay.classList.toggle("sidebar-open", state.sidebarOpen);
    overlay.append(viewerStyles());

    const toolbar = document.createElement("header");
    toolbar.className = "agpdf-toolbar";

    const file = document.createElement("div");
    file.className = "agpdf-file";
    const fileIcon = document.createElement("span");
    fileIcon.className = "agpdf-file-icon";
    fileIcon.textContent = "PDF";
    const fileLabel = document.createElement("span");
    fileLabel.className = "agpdf-file-name";
    fileLabel.textContent = fileName(uri);
    fileLabel.title = fileName(uri);
    file.append(fileIcon, fileLabel);

    const left = document.createElement("div");
    left.className = "agpdf-left";
    const sidebarGroup = document.createElement("div");
    sidebarGroup.className = "agpdf-control-group agpdf-sidebar-control";
    const thumbnails = button("thumbnails", icons.thumbnails, toggleSidebar);
    thumbnails.classList.toggle("active", state.sidebarOpen);
    sidebarGroup.append(thumbnails);
    left.append(sidebarGroup, file);

    const controls = document.createElement("div");
    controls.className = "agpdf-controls";

    const pageGroup = document.createElement("div");
    pageGroup.className = "agpdf-control-group";
    const previous = button("previous", icons.previous, () => goToPage(state.currentPage - 1));
    const pageInput = document.createElement("input");
    pageInput.className = "agpdf-page-input";
    pageInput.type = "number";
    pageInput.min = "1";
    pageInput.value = "1";
    pageInput.setAttribute("aria-label", translate("pageNumber"));
    pageInput.title = translate("pageNumber");
    const pageCount = document.createElement("span");
    pageCount.className = "agpdf-page-count";
    pageCount.textContent = "/ —";
    const next = button("next", icons.next, () => goToPage(state.currentPage + 1));
    pageGroup.append(previous, pageInput, pageCount, next);

    const zoomGroup = document.createElement("div");
    zoomGroup.className = "agpdf-control-group";
    const zoomOut = button("zoomOut", icons.minus, () => stepZoom(-1));
    const zoomLabel = document.createElement("span");
    zoomLabel.className = "agpdf-zoom-label";
    zoomLabel.textContent = "—";
    const zoomIn = button("zoomIn", icons.plus, () => stepZoom(1));
    zoomGroup.append(zoomOut, zoomLabel, zoomIn);

    const fitGroup = document.createElement("div");
    fitGroup.className = "agpdf-control-group fit-controls";
    const fitWidth = button("fitWidth", icons.fitWidth, () => applyFit("width"), "active");
    const fitPage = button("fitPage", icons.fitPage, () => applyFit("page"));
    const rotate = button("rotate", icons.rotate, rotatePages);
    const reset = button("reset", icons.reset, resetView);
    fitGroup.append(fitWidth, fitPage, rotate, reset);

    controls.append(pageGroup, zoomGroup, fitGroup);

    const right = document.createElement("div");
    right.className = "agpdf-right";
    const hint = document.createElement("span");
    hint.className = "agpdf-hint";
    hint.textContent = [formatBytes(source?.size), translate("hint")].filter(Boolean).join(" · ");
    const fullscreen = button("fullscreen", icons.fullscreen, toggleFullscreen);
    right.append(hint, fullscreen);

    toolbar.append(left, controls, right);

    const scroll = document.createElement("main");
    scroll.className = "agpdf-scroll";
    scroll.setAttribute("aria-label", translate("pdfPages"));
    const documentNode = document.createElement("div");
    documentNode.className = "agpdf-document";
    scroll.append(documentNode);

    const sidebar = document.createElement("aside");
    sidebar.className = "agpdf-sidebar";
    sidebar.setAttribute("aria-label", translate("pageThumbnails"));
    const sidebarInner = document.createElement("div");
    sidebarInner.className = "agpdf-sidebar-inner";
    const sidebarTitle = document.createElement("div");
    sidebarTitle.className = "agpdf-sidebar-title";
    sidebarTitle.textContent = translate("pagePreview");
    const thumbnailList = document.createElement("div");
    thumbnailList.className = "agpdf-thumbnails";
    sidebarInner.append(sidebarTitle, thumbnailList);
    sidebar.append(sidebarInner);

    const body = document.createElement("div");
    body.className = "agpdf-body";
    body.append(sidebar, scroll);

    const stage = document.createElement("div");
    stage.className = "agpdf-stage";
    const stageCard = document.createElement("div");
    stageCard.className = "agpdf-stage-card";
    const spinner = document.createElement("div");
    spinner.className = "agpdf-spinner";
    const stageText = document.createElement("div");
    stageText.textContent = translate("loading");
    stageCard.append(spinner, stageText);
    stage.append(stageCard);

    overlay.append(toolbar, body, stage);
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.append(overlay);

    state.overlay = overlay;
    state.nodes = {
      toolbar,
      body,
      sidebar,
      sidebarInner,
      sidebarTitle,
      thumbnails: thumbnailList,
      scroll,
      document: documentNode,
      stage,
      stageCard,
      stageText,
      spinner,
      pageInput,
      pageCount,
      zoomLabel,
      fitWidth,
      fitPage,
      reset,
      thumbnailToggle: thumbnails,
      fullscreen,
      hint,
    };

    pageInput.addEventListener("change", () => goToPage(Number(pageInput.value)));
    pageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        goToPage(Number(pageInput.value));
        pageInput.blur();
      }
    });
    scroll.addEventListener("scroll", scheduleScrollUpdate, { passive: true });
    scroll.addEventListener("wheel", onWheel, { passive: false });

    state.resizeObserver = new ResizeObserver(() => {
      if (!state.pdf || state.fitMode === "custom") return;
      clearTimeout(state.zoomTimer);
      state.zoomTimer = setTimeout(() => applyFit(state.fitMode, false), 90);
    });
    state.resizeObserver.observe(scroll);
    return overlay;
  }

  function showError(message) {
    if (!state.overlay) return;
    state.errorMessage = message;
    state.nodes.spinner.remove();
    state.nodes.stageText.className = "agpdf-error";
    state.nodes.stageText.textContent = translate("cannotPreview", { message });
    state.nodes.stage.classList.remove("hidden");
  }

  function hideStage() {
    state.nodes.stage?.classList.add("hidden");
    setTimeout(() => {
      if (state.nodes.stage?.classList.contains("hidden")) state.nodes.stage.remove();
    }, 220);
  }

  async function disposeDocument() {
    state.loadGeneration += 1;
    state.renderGeneration += 1;
    clearTimeout(state.zoomTimer);
    cancelAnimationFrame(state.scrollFrame);
    state.intersectionObserver?.disconnect();
    state.thumbnailObserver?.disconnect();
    state.resizeObserver?.disconnect();
    for (const pageState of state.pages) {
      pageState.renderTask?.cancel?.();
      pageState.thumbnailTask?.cancel?.();
    }
    state.renderQueue.clear();
    state.thumbnailQueue.clear();
    state.visiblePages.clear();
    try { await state.loadingTask?.destroy?.(); } catch {}
    try { await state.pdf?.destroy?.(); } catch {}
    state.pdf = null;
    state.loadingTask = null;
    state.source = null;
    state.errorMessage = null;
    state.pages = [];
    state.activeRenders = 0;
    state.activeThumbnailRenders = 0;
    state.fullscreen = false;
    state.overlay?.remove();
    state.overlay = null;
    state.nodes = {};
  }

  function pageViewport(pageState, scale = state.scale) {
    if (pageState.page) {
      return pageState.page.getViewport({
        scale,
        rotation: (pageState.page.rotate + state.rotation) % 360,
      });
    }
    const sideways = state.rotation % 180 !== 0;
    return {
      width: (sideways ? pageState.baseHeight : pageState.baseWidth) * scale,
      height: (sideways ? pageState.baseWidth : pageState.baseHeight) * scale,
    };
  }

  function sizePage(pageState) {
    const viewport = pageViewport(pageState);
    pageState.slot.style.width = `${Math.round(viewport.width)}px`;
    pageState.slot.style.height = `${Math.round(viewport.height)}px`;
  }

  function setScale(nextScale, mode = "custom", render = true) {
    if (!state.pdf) return;
    const previousScale = state.scale;
    const scroll = state.nodes.scroll;
    const anchor = {
      x: (scroll.scrollLeft + scroll.clientWidth / 2) / previousScale,
      y: (scroll.scrollTop + scroll.clientHeight / 2) / previousScale,
    };

    state.scale = clamp(nextScale, 0.2, 4);
    state.fitMode = mode;
    state.nodes.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
    state.nodes.fitWidth.classList.toggle("active", mode === "width");
    state.nodes.fitPage.classList.toggle("active", mode === "page");
    state.pages.forEach(sizePage);

    requestAnimationFrame(() => {
      const ratio = state.scale / previousScale;
      scroll.scrollLeft = Math.max(0, anchor.x * state.scale - scroll.clientWidth / 2);
      scroll.scrollTop = Math.max(0, anchor.y * state.scale - scroll.clientHeight / 2 + (ratio - 1) * 10);
    });

    if (render) scheduleRerender();
  }

  function applyFit(mode, render = true) {
    if (!state.pdf || !state.pages[0]) return;
    const scroll = state.nodes.scroll;
    const pageState = state.pages[Math.max(0, state.currentPage - 1)] || state.pages[0];
    const sideways = state.rotation % 180 !== 0;
    const baseWidth = sideways ? pageState.baseHeight : pageState.baseWidth;
    const baseHeight = sideways ? pageState.baseWidth : pageState.baseHeight;
    const widthScale = (scroll.clientWidth - 58) / baseWidth;
    const nextScale = mode === "page"
      ? Math.min(widthScale, (scroll.clientHeight - 48) / baseHeight)
      : widthScale;
    setScale(clamp(nextScale, 0.2, 3), mode, render);
  }

  function stepZoom(direction) {
    const stops = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const index = direction > 0
      ? stops.findIndex((value) => value > state.scale + 0.01)
      : stops.findLastIndex((value) => value < state.scale - 0.01);
    setScale(index >= 0 ? stops[index] : direction > 0 ? 4 : 0.25);
  }

  function resetView() {
    if (!state.pdf) return;
    if (state.fullscreen) toggleFullscreen(false);
    if (state.sidebarOpen) toggleSidebar();
    state.rotation = 0;
    state.pages.forEach(sizePage);
    goToPage(1);
    requestAnimationFrame(() => applyFit("width"));
  }

  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    localStorage.setItem(
      "antigravityPdfPreview.sidebar",
      state.sidebarOpen ? "open" : "closed",
    );
    state.overlay?.classList.toggle("sidebar-open", state.sidebarOpen);
    state.nodes.thumbnailToggle?.classList.toggle("active", state.sidebarOpen);
    if (state.sidebarOpen) queueThumbnail(Math.max(0, state.currentPage - 1));
    clearTimeout(state.zoomTimer);
    state.zoomTimer = setTimeout(() => {
      if (state.fitMode !== "custom") applyFit(state.fitMode);
    }, 200);
  }

  function toggleFullscreen(force) {
    const next = typeof force === "boolean" ? force : !state.fullscreen;
    if (!state.overlay || next === state.fullscreen) return;
    state.fullscreen = next;
    if (next) document.body.append(state.overlay);
    else hostElement()?.append(state.overlay);
    state.overlay.classList.toggle("fullscreen", next);
    state.nodes.fullscreen.innerHTML = next ? icons.exitFullscreen : icons.fullscreen;
    const labelKey = next ? "exitFullscreen" : "fullscreen";
    const label = translate(labelKey);
    state.nodes.fullscreen.dataset.i18n = labelKey;
    state.nodes.fullscreen.title = label;
    state.nodes.fullscreen.setAttribute("aria-label", label);
    state.nodes.fullscreen.dataset.tooltip = label;
    requestAnimationFrame(() => {
      if (state.fitMode !== "custom") applyFit(state.fitMode);
      else scheduleRerender();
    });
  }

  function rotatePages() {
    state.rotation = (state.rotation + 90) % 360;
    state.pages.forEach(sizePage);
    if (state.fitMode !== "custom") applyFit(state.fitMode);
    else scheduleRerender();
  }

  function onWheel(event) {
    if (!(event.metaKey || event.ctrlKey) || !state.pdf) return;
    event.preventDefault();
    const delta = clamp(event.deltaY, -50, 50);
    const factor = Math.exp(-delta * 0.009);
    setScale(state.scale * factor, "custom", false);
    clearTimeout(state.zoomTimer);
    state.zoomTimer = setTimeout(scheduleRerender, 120);
  }

  function onKeyDown(event) {
    if (!state.pdf || event.target === state.nodes.pageInput) return;
    if (event.key === "Escape" && state.fullscreen) {
      event.preventDefault();
      toggleFullscreen(false);
      return;
    }
    if (!state.overlay?.contains(event.target)) return;
    if (event.key === "PageDown" || event.key === "ArrowRight") {
      event.preventDefault();
      goToPage(state.currentPage + 1);
    } else if (event.key === "PageUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      goToPage(state.currentPage - 1);
    }
  }

  function goToPage(pageNumber) {
    if (!state.pdf) return;
    const next = clamp(Math.round(pageNumber || 1), 1, state.pdf.numPages);
    state.pages[next - 1]?.slot.scrollIntoView({ behavior: "smooth", block: "start" });
    updateCurrentPage(next);
  }

  function updateCurrentPage(pageNumber) {
    if (!state.pdf) return;
    const next = clamp(pageNumber, 1, state.pdf.numPages);
    if (next === state.currentPage && state.nodes.pageInput.value === String(next)) return;
    state.pages[state.currentPage - 1]?.slot.classList.remove("current");
    state.pages[state.currentPage - 1]?.thumbnail?.classList.remove("active");
    state.currentPage = next;
    state.pages[next - 1]?.slot.classList.add("current");
    state.pages[next - 1]?.thumbnail?.classList.add("active");
    state.nodes.pageInput.value = String(next);
    if (state.sidebarOpen) {
      state.pages[next - 1]?.thumbnail?.scrollIntoView({ block: "nearest" });
      queueThumbnail(next - 1);
    }
  }

  function scheduleScrollUpdate() {
    if (state.scrollFrame) return;
    state.scrollFrame = requestAnimationFrame(() => {
      state.scrollFrame = null;
      const scrollRect = state.nodes.scroll.getBoundingClientRect();
      const center = scrollRect.top + scrollRect.height * 0.42;
      let nearest = state.currentPage;
      let distance = Infinity;
      for (const pageState of state.pages) {
        const rect = pageState.slot.getBoundingClientRect();
        const candidate = Math.abs(rect.top + Math.min(rect.height, scrollRect.height) / 2 - center);
        if (candidate < distance) {
          distance = candidate;
          nearest = pageState.index + 1;
        }
      }
      updateCurrentPage(nearest);
    });
  }

  function scheduleRerender() {
    state.renderGeneration += 1;
    state.renderQueue.clear();
    for (const pageState of state.pages) {
      if (pageState.renderTask) pageState.renderTask.cancel?.();
    }
    const candidates = state.visiblePages.size
      ? [...state.visiblePages]
      : [Math.max(0, state.currentPage - 1)];
    candidates.forEach(queueRender);
  }

  function queueRender(index) {
    if (!state.pdf || index < 0 || index >= state.pages.length) return;
    state.renderQueue.add(index);
    pumpRenderQueue();
  }

  function pumpRenderQueue() {
    while (state.activeRenders < 2 && state.renderQueue.size) {
      const nextIndex = [...state.renderQueue].sort(
        (a, b) => Math.abs(a - state.currentPage + 1) - Math.abs(b - state.currentPage + 1),
      )[0];
      state.renderQueue.delete(nextIndex);
      state.activeRenders += 1;
      renderPage(nextIndex, state.renderGeneration)
        .catch(() => {})
        .finally(() => {
          state.activeRenders -= 1;
          pumpRenderQueue();
        });
    }
  }

  function queueThumbnail(index) {
    const pageState = state.pages[index];
    if (!state.pdf || !pageState || pageState.thumbnailCanvas) return;
    state.thumbnailQueue.add(index);
    pumpThumbnailQueue();
  }

  function pumpThumbnailQueue() {
    while (state.activeThumbnailRenders < 2 && state.thumbnailQueue.size) {
      const nextIndex = [...state.thumbnailQueue].sort(
        (a, b) => Math.abs(a - state.currentPage + 1) - Math.abs(b - state.currentPage + 1),
      )[0];
      state.thumbnailQueue.delete(nextIndex);
      state.activeThumbnailRenders += 1;
      renderThumbnail(nextIndex)
        .catch(() => {})
        .finally(() => {
          state.activeThumbnailRenders -= 1;
          pumpThumbnailQueue();
        });
    }
  }

  async function renderThumbnail(index) {
    const pageState = state.pages[index];
    if (!pageState || pageState.thumbnailCanvas || !state.pdf) return;
    if (!pageState.page) pageState.page = await state.pdf.getPage(index + 1);
    const base = pageState.page.getViewport({ scale: 1, rotation: pageState.page.rotate });
    const scale = 112 / base.width;
    const viewport = pageState.page.getViewport({ scale, rotation: pageState.page.rotate });
    const outputScale = Math.min(devicePixelRatio || 1, 1.5);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${Math.round(viewport.width)}px`;
    canvas.style.height = `${Math.round(viewport.height)}px`;
    const task = pageState.page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    });
    pageState.thumbnailTask = task;
    await task.promise;
    pageState.thumbnailTask = null;
    pageState.thumbnailCanvas = canvas;
    pageState.thumbnailPaper.replaceChildren(canvas);
  }

  async function renderPage(index, generation) {
    const pageState = state.pages[index];
    if (!pageState || generation !== state.renderGeneration) return;
    if (!pageState.page) pageState.page = await state.pdf.getPage(index + 1);
    if (generation !== state.renderGeneration) return;

    const baseViewport = pageState.page.getViewport({ scale: 1, rotation: pageState.page.rotate });
    pageState.baseWidth = baseViewport.width;
    pageState.baseHeight = baseViewport.height;
    const viewport = pageViewport(pageState);
    sizePage(pageState);

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    const maxRatio = Math.min(devicePixelRatio || 1, 2);
    const dimensionRatio = Math.min(1, 8192 / Math.max(viewport.width, viewport.height));
    const outputScale = Math.max(1, maxRatio * dimensionRatio);
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));

    const renderTask = pageState.page.render({
      canvasContext: context,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    });
    pageState.renderTask = renderTask;
    pageState.slot.classList.add("rendering");

    try {
      await renderTask.promise;
      if (generation !== state.renderGeneration) return;
      pageState.canvas?.remove();
      pageState.canvas = canvas;
      pageState.slot.prepend(canvas);
    } finally {
      if (pageState.renderTask === renderTask) pageState.renderTask = null;
      pageState.slot.classList.remove("rendering");
    }
  }

  async function loadPdf(uri, source) {
    const loadGeneration = ++state.loadGeneration;
    state.source = source;
    mount(uri, source);

    const pdfjs = globalThis.__antigravityPdfjs;
    if (!pdfjs) throw new Error("PDF.js 运行时未加载");

    let documentSource;
    if (typeof source === "string") {
      const binary = atob(source);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      documentSource = { data: bytes };
    } else {
      documentSource = {
        url: source.url,
        rangeChunkSize: 1024 * 1024,
        disableRange: false,
        disableStream: false,
        disableAutoFetch: false,
      };
    }

    state.loadingTask = pdfjs.getDocument({ ...documentSource, enableHWA: true });
    const pdf = await state.loadingTask.promise;
    if (loadGeneration !== state.loadGeneration || currentPdfUri() !== uri) {
      await state.loadingTask.destroy();
      return;
    }

    state.pdf = pdf;
    state.currentPage = 1;
    state.nodes.pageCount.textContent = `/ ${pdf.numPages}`;
    state.nodes.pageInput.max = String(pdf.numPages);

    const firstPage = await pdf.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1, rotation: firstPage.rotate });
    const pageFragment = document.createDocumentFragment();
    const thumbnailFragment = document.createDocumentFragment();
    for (let index = 0; index < pdf.numPages; index += 1) {
      const slot = document.createElement("article");
      slot.className = `agpdf-page${index === 0 ? " current" : ""}`;
      slot.dataset.page = String(index + 1);
      slot.setAttribute("aria-label", translate("pageAria", { page: index + 1 }));
      const pageNumber = document.createElement("span");
      pageNumber.className = "agpdf-page-number";
      pageNumber.textContent = String(index + 1);
      slot.append(pageNumber);
      pageFragment.append(slot);

      const thumbnail = document.createElement("button");
      thumbnail.type = "button";
      thumbnail.className = `agpdf-thumbnail${index === 0 ? " active" : ""}`;
      thumbnail.dataset.page = String(index + 1);
      thumbnail.setAttribute("aria-label", translate("goToPage", { page: index + 1 }));
      const thumbnailPaper = document.createElement("span");
      thumbnailPaper.className = "agpdf-thumbnail-paper";
      thumbnailPaper.style.aspectRatio = `${firstViewport.width} / ${firstViewport.height}`;
      const thumbnailLabel = document.createElement("span");
      thumbnailLabel.className = "agpdf-thumbnail-label";
      thumbnailLabel.textContent = String(index + 1);
      thumbnail.append(thumbnailPaper, thumbnailLabel);
      thumbnail.addEventListener("click", () => goToPage(index + 1));
      thumbnailFragment.append(thumbnail);

      state.pages.push({
        index,
        slot,
        thumbnail,
        thumbnailPaper,
        page: index === 0 ? firstPage : null,
        canvas: null,
        renderTask: null,
        thumbnailTask: null,
        thumbnailCanvas: null,
        baseWidth: firstViewport.width,
        baseHeight: firstViewport.height,
      });
    }
    state.nodes.document.append(pageFragment);
    state.nodes.thumbnails.append(thumbnailFragment);

    applyFit("width", false);
    state.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.page) - 1;
          if (entry.isIntersecting) {
            state.visiblePages.add(index);
            queueRender(index);
          } else {
            state.visiblePages.delete(index);
          }
        }
      },
      { root: state.nodes.scroll, rootMargin: "900px 300px", threshold: 0.01 },
    );
    state.pages.forEach((pageState) => state.intersectionObserver.observe(pageState.slot));
    state.thumbnailObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) queueThumbnail(Number(entry.target.dataset.page) - 1);
        }
      },
      { root: state.nodes.sidebarInner, rootMargin: "500px 0px", threshold: 0.01 },
    );
    state.pages.forEach((pageState) => state.thumbnailObserver.observe(pageState.thumbnail));
    queueRender(0);
    if (pdf.numPages > 1) queueRender(1);
    queueThumbnail(0);
    hideStage();
    state.overlay.focus({ preventScroll: true });
  }

  async function resetViewer() {
    await disposeDocument();
    state.uri = null;
    state.requestedUri = null;
  }

  globalThis.__antigravityPdfPreviewApply = async (uri, source) => {
    if (currentPdfUri() !== uri) return false;
    await disposeDocument();
    state.uri = uri;
    state.requestedUri = uri;
    try {
      await loadPdf(uri, source);
      return true;
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  globalThis.__antigravityPdfPreviewError = async (uri, message) => {
    if (uri && currentPdfUri() !== uri) return false;
    await disposeDocument();
    state.uri = uri;
    state.requestedUri = uri;
    mount(uri);
    showError(message);
    return true;
  };

  state.ensure = () => {
    applyLocale();
    const uri = currentPdfUri();
    if (!uri) {
      if (state.uri || state.requestedUri || state.overlay) resetViewer();
      return;
    }

    const host = hostElement();
    if (state.overlay && host && !state.overlay.isConnected) host.append(state.overlay);
    if (state.requestedUri !== uri) {
      state.requestedUri = uri;
      state.uri = null;
      disposeDocument().then(() => {
        if (currentPdfUri() !== uri) return;
        state.requestedUri = uri;
        try {
          globalThis[BINDING_NAME](JSON.stringify({ uri }));
        } catch {
          state.requestedUri = null;
        }
      });
    }
  };

  state.destroy = resetViewer;
  state.keyHandler = onKeyDown;
  window.addEventListener("keydown", state.keyHandler, true);
  globalThis.__antigravityPdfPreviewBridge = state;
  state.timer = setInterval(state.ensure, 900);
  let ensureScheduled = false;
  state.observer = new MutationObserver(() => {
    if (ensureScheduled) return;
    ensureScheduled = true;
    requestAnimationFrame(() => {
      ensureScheduled = false;
      state.ensure();
    });
  });
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  state.ensure();
})();
