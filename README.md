# Antigravity PDF Preview

An unofficial, native-feeling PDF preview helper for the **Antigravity desktop app on macOS**. It replaces the raw PDF source view with a fast PDF.js reader without modifying or re-signing `Antigravity.app`.

## Features

- Smooth trackpad pinch zoom with a more useful sensitivity (about 9.4% for a small `deltaY = 10` gesture)
- No global `+`, `-`, or `0` zoom shortcuts, so typing elsewhere in Antigravity is never intercepted
- One-click **Reset view**: page 1, 0° rotation, sidebar closed, full preview exited, fit to width
- Left-side thumbnail toggle, fit-width, fit-page, rotation, page navigation, and full-document preview
- Clear localized hover tooltips for every toolbar icon
- Automatic refresh when the PDF at the open path is regenerated or replaced
- Full-preview safe area for the macOS traffic-light controls
- English by default; follows Antigravity's Simplified Chinese or Traditional Chinese language dynamically
- Lazy HiDPI page and thumbnail rendering in a PDF.js worker
- HTTP Range streaming for large PDFs instead of loading the whole file as Base64
- Up to 2 GB per PDF
- Local-only operation: PDF data is served only on a tokenized `127.0.0.1` URL

## Requirements

- macOS
- Antigravity desktop app (tested with 2.8.1)
- Node.js 22 or later

## Install

Download or clone this repository, then run:

```bash
chmod +x install.sh uninstall.sh
./install.sh
```

Fully quit and reopen Antigravity. Open a PDF in Antigravity's File Viewer; the reader appears automatically.

The installer creates only user-level files:

- `~/Library/Application Support/Antigravity/PdfPreviewExtension/`
- `~/Library/LaunchAgents/com.eugenesia.antigravity-pdf-preview.plist`

It does **not** modify `/Applications/Antigravity.app`.

## Uninstall

```bash
./uninstall.sh
```

## Controls

- Pinch on the trackpad to zoom around the pointer
- Use **Reset view** to restore the default reading mode
- Use **Thumbnail sidebar** for fast navigation
- Use **Full preview** for an immersive document view; press `Esc` to exit
- `⌘ + mouse wheel` also zooms continuously

## 中文说明

这是一个适用于 macOS 版 Antigravity 的非官方 PDF 预览插件。运行 `./install.sh` 后，彻底退出并重新打开 Antigravity 即可。插件默认显示英文；当 Antigravity 切换为简体或繁体中文时，插件界面会自动同步。触控板捏合缩放已增强，并提供“一键恢复默认”、缩略图侧栏、适合宽度、显示整页、旋转、全图预览和大文件按需读取。

## How it works

The user LaunchAgent watches Antigravity's local DevTools endpoint, injects the bundled PDF.js viewer into matching PDF tabs, and exposes each selected local PDF through a temporary tokenized localhost route with byte-range support. Routes expire after inactivity, and no external server receives the document.

## License

Project code is released under the MIT License. Bundled PDF.js assets are provided by Mozilla under the Apache License 2.0; see `THIRD_PARTY_NOTICES.md`.

Antigravity is a Google product. This community project is not affiliated with or endorsed by Google.
