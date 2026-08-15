#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile, open, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const EXTENSION_NAME = "Antigravity PDF Preview";
const BINDING_NAME = "__antigravityPdfPreviewRequest";
const LOG_PATH = `${process.env.HOME}/Library/Logs/Antigravity/language_server.log`;
const POLL_INTERVAL_MS = 1500;
const FILE_STABILITY_DELAY_MS = 500;
const MAX_PDF_BYTES = 2 * 1024 * 1024 * 1024;
const LOG_TAIL_BYTES = 1024 * 1024;
const ROUTE_MAX_AGE_MS = 60 * 60 * 1000;

const sessions = new Map();
const pdfRoutes = new Map();
let runtimeAssetsPromise;
let fileServer;
let fileServerPort;

function setCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (origin && (/^https:\/\/127\.0\.0\.1:\d+$/.test(origin) || origin === "null")) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Range");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Length, Content-Range",
  );
}

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function cleanPdfRoutes() {
  const now = Date.now();
  for (const [token, route] of pdfRoutes) {
    if (now - route.lastAccess > ROUTE_MAX_AGE_MS) pdfRoutes.delete(token);
  }
  while (pdfRoutes.size > 16) pdfRoutes.delete(pdfRoutes.keys().next().value);
}

function fileSignature(details) {
  return [details.dev, details.ino, details.size, details.mtimeMs, details.ctimeMs].join(":");
}

function registerPdfRoute(pdfPath, details) {
  cleanPdfRoutes();
  const signature = fileSignature(details);
  for (const [token, route] of pdfRoutes) {
    if (route.pdfPath === pdfPath && route.signature === signature) {
      route.lastAccess = Date.now();
      return {
        url: `http://127.0.0.1:${fileServerPort}/pdf/${token}/${encodeURIComponent(basename(pdfPath))}`,
        name: basename(pdfPath),
        size: details.size,
      };
    }
  }

  const token = randomUUID().replaceAll("-", "");
  pdfRoutes.set(token, {
    pdfPath,
    size: details.size,
    signature,
    lastAccess: Date.now(),
  });
  return {
    url: `http://127.0.0.1:${fileServerPort}/pdf/${token}/${encodeURIComponent(basename(pdfPath))}`,
    name: basename(pdfPath),
    size: details.size,
  };
}

async function startFileServer() {
  if (fileServer) return;
  fileServer = createServer(async (request, response) => {
    try {
      setCorsHeaders(request, response);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405);
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      const route = parts[0] === "pdf" ? pdfRoutes.get(parts[1]) : null;
      if (!route) {
        response.writeHead(404);
        response.end();
        return;
      }

      const details = await stat(route.pdfPath);
      if (!details.isFile() || fileSignature(details) !== route.signature) {
        response.writeHead(410);
        response.end();
        return;
      }
      route.lastAccess = Date.now();

      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, no-store");
      const range = parseRange(request.headers.range, route.size);

      if (request.headers.range && !range) {
        response.writeHead(416, { "Content-Range": `bytes */${route.size}` });
        response.end();
        return;
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? route.size - 1;
      const headers = { "Content-Length": end - start + 1 };
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${route.size}`;
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }

      const stream = createReadStream(route.pdfPath, { start, end });
      stream.on("error", () => response.destroy());
      request.on("aborted", () => stream.destroy());
      stream.pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });

  await new Promise((resolve, reject) => {
    fileServer.once("error", reject);
    fileServer.listen(0, "127.0.0.1", resolve);
  });
  fileServerPort = fileServer.address().port;
  log("Local PDF streaming server listening on", `127.0.0.1:${fileServerPort}`);
}

async function loadRuntimeAssets() {
  if (!runtimeAssetsPromise) {
    runtimeAssetsPromise = Promise.all([
      readFile(new URL("./pdfjs.bundle.js", import.meta.url), "utf8"),
      readFile(new URL("./pdf.worker.bundle.mjs", import.meta.url)),
      readFile(new URL("./page-viewer.js", import.meta.url), "utf8"),
    ]).then(([pdfjsBundle, workerBundle, pageBridge]) => {
      const pdfjsSource = `if (!globalThis.__antigravityPdfjs) {\n${pdfjsBundle}\n}`;
      const workerBase64 = workerBundle.toString("base64");
      const workerSource = `(() => {
        if (!globalThis.__antigravityPdfWorkerUrl) {
          const binary = atob(${JSON.stringify(workerBase64)});
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          globalThis.__antigravityPdfWorkerUrl = URL.createObjectURL(
            new Blob([bytes], { type: "text/javascript" }),
          );
        }
        if (globalThis.__antigravityPdfjs) {
          globalThis.__antigravityPdfjs.GlobalWorkerOptions.workerSrc = globalThis.__antigravityPdfWorkerUrl;
        }
      })();`;
      return { pdfjsSource, workerSource, pageBridge };
    });
  }
  return runtimeAssetsPromise;
}

function log(message, extra = "") {
  const suffix = extra ? ` ${extra}` : "";
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLogTail() {
  const details = await stat(LOG_PATH);
  const length = Math.min(details.size, LOG_TAIL_BYTES);
  const offset = Math.max(0, details.size - length);
  const handle = await open(LOG_PATH, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function findDebugPort() {
  const logText = await readLogTail();
  const matches = [
    ...logText.matchAll(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[^\s]+/g),
  ];
  const port = Number(matches.at(-1)?.[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function fetchTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) {
    throw new Error(`CDP target discovery returned HTTP ${response.status}`);
  }
  return response.json();
}

class CdpSession {
  constructor(target) {
    this.target = target;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.preview = null;
    this.refreshing = false;
  }

  async connect() {
    this.socket = new WebSocket(this.target.webSocketDebuggerUrl);
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("close", () => this.close());
    this.socket.addEventListener("error", () => this.close());

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out connecting to Antigravity")),
        3000,
      );
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Could not connect to Antigravity"));
        },
        { once: true },
      );
    });

    await this.call("Runtime.enable");
    await this.call("Page.enable");

    try {
      await this.call("Runtime.addBinding", { name: BINDING_NAME });
    } catch (error) {
      if (!String(error).includes("already exists")) throw error;
    }

    const runtime = await loadRuntimeAssets();
    for (const source of [runtime.pdfjsSource, runtime.workerSource, runtime.pageBridge]) {
      await this.call("Page.addScriptToEvaluateOnNewDocument", { source });
      const result = await this.call("Runtime.evaluate", {
        expression: source,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || "Viewer injection failed");
      }
    }
  }

  call(method, params = {}) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Antigravity connection is closed"));
    }

    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10000);

      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (
      message.method === "Runtime.bindingCalled" &&
      message.params?.name === BINDING_NAME
    ) {
      await this.onPreviewRequest(
        message.params.payload,
        message.params.executionContextId,
      );
    }
  }

  async onPreviewRequest(payload, contextId) {
    let uri;
    try {
      ({ uri } = JSON.parse(payload));
      if (typeof uri !== "string") throw new Error("Missing file URI");
      const url = new URL(uri);
      if (url.protocol !== "file:" || !url.pathname.toLowerCase().endsWith(".pdf")) {
        throw new Error("Only local PDF files can be previewed");
      }

      const pdfPath = fileURLToPath(url);
      const details = await stat(pdfPath);
      if (await this.applyPreview(uri, pdfPath, details, contextId)) {
        log("Previewed", pdfPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.call("Runtime.evaluate", {
        expression: `globalThis.__antigravityPdfPreviewError?.(${JSON.stringify(uri ?? "")},${JSON.stringify(message)})`,
        contextId,
        awaitPromise: true,
      }).catch(() => {});
      log("Preview failed:", message);
    }
  }

  async applyPreview(uri, pdfPath, details, contextId) {
    if (!details.isFile()) throw new Error("PDF path is not a file");
    if (details.size > MAX_PDF_BYTES) {
      throw new Error("PDF is larger than the 2 GB preview limit");
    }

    const source = registerPdfRoute(pdfPath, details);
    const evaluation = await this.call("Runtime.evaluate", {
      expression: `globalThis.__antigravityPdfPreviewApply?.(${JSON.stringify(uri)},${JSON.stringify(source)})`,
      contextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluation.result?.value !== true) return false;
    this.preview = {
      uri,
      pdfPath,
      contextId,
      signature: fileSignature(details),
    };
    return true;
  }

  async refreshIfChanged() {
    if (!this.preview || this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      const firstDetails = await stat(this.preview.pdfPath);
      const firstSignature = fileSignature(firstDetails);
      if (firstSignature === this.preview.signature) return;

      await delay(FILE_STABILITY_DELAY_MS);
      const stableDetails = await stat(this.preview.pdfPath);
      const stableSignature = fileSignature(stableDetails);
      if (stableSignature !== firstSignature || stableSignature === this.preview.signature) return;

      const { uri, pdfPath, contextId } = this.preview;
      if (await this.applyPreview(uri, pdfPath, stableDetails, contextId)) {
        log("Refreshed changed PDF", pdfPath);
      }
    } catch {
      // A generator may briefly remove or replace the file. Retry on the next poll.
    } finally {
      this.refreshing = false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Antigravity connection closed"));
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {}
  }
}

async function discoverAndAttach() {
  const port = await findDebugPort();
  if (!port) return;

  const targets = await fetchTargets(port);
  const eligible = new Map(
    targets
      .filter(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          /^https:\/\/127\.0\.0\.1:\d+\//.test(target.url ?? ""),
      )
      .map((target) => [target.webSocketDebuggerUrl, target]),
  );

  for (const [url, session] of sessions) {
    if (!eligible.has(url) || session.closed) {
      session.close();
      sessions.delete(url);
    }
  }

  for (const [url, target] of eligible) {
    if (sessions.has(url)) continue;
    const session = new CdpSession(target);
    sessions.set(url, session);
    try {
      await session.connect();
      log("Attached to Antigravity window:", target.title || target.url);
    } catch (error) {
      session.close();
      sessions.delete(url);
      log("Attach failed:", error instanceof Error ? error.message : String(error));
    }
  }

  for (const session of sessions.values()) {
    await session.refreshIfChanged();
  }
}

await startFileServer();
log(`${EXTENSION_NAME} started`);

while (true) {
  try {
    await discoverAndAttach();
  } catch {
    // Antigravity is closed or starting. The next poll will reconnect automatically.
  }
  await delay(POLL_INTERVAL_MS);
}
