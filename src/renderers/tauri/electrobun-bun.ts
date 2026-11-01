/**
 * Prototype: the part of Electrobun's main-process API the desktop backend
 * uses, implemented over a Tauri shell. The backend runs unchanged in a Bun
 * sidecar; this module stands in for `electrobun/bun` in its bundle.
 *
 * - Windows are made and driven by the Rust shell. Commands go out as JSON
 *   lines on stdout (prefixed so stray output is ignored), window events and
 *   the display list come back as JSON lines on stdin.
 * - Each window's page talks RPC to this process over a WebSocket on
 *   127.0.0.1 (the view's `electrobun/view` stand-in, electroview.ts), with
 *   Electrobun's own transport-agnostic RPC on both ends.
 * - Getters Electrobun answers synchronously (frame, maximized, displays)
 *   are answered from the state the shell last reported.
 */
import { spawn } from "child_process";
import { defineElectrobunRPC } from "../../../node_modules/electrobun/dist/api/shared/rpc";

const COMMAND_PREFIX = "\u0001GLOOM ";

type Frame = { x: number; y: number; width: number; height: number };
type Display = { id: number; bounds: Frame; workArea: Frame; scaleFactor: number; isPrimary: boolean };
type Listener = (event: { data: Record<string, unknown> }) => void;

let displays: Display[] = [];
const windows = new Map<number, BrowserWindow>();
let nextWindowId = 1;

function send(command: Record<string, unknown>): void {
  process.stdout.write(`${COMMAND_PREFIX}${JSON.stringify(command)}\n`);
}

// ---------------------------------------------------------------------------
// Shell events

type ShellEvent = { event: string; id?: number; frame?: Frame; displays?: Display[]; maximized?: boolean; minimized?: boolean; fullscreen?: boolean; focused?: boolean };

let helloResolve: (() => void) | null = null;
const hello = new Promise<void>((resolve) => { helloResolve = resolve; });

function onShellEvent(message: ShellEvent): void {
  if (message.displays) displays = message.displays;
  if (message.event === "hello") {
    helloResolve?.();
    return;
  }
  const window = message.id !== undefined ? windows.get(message.id) : undefined;
  if (!window) return;
  window.applyShellEvent(message);
}

(async () => {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try { onShellEvent(JSON.parse(line)); } catch (error) { console.error("[tauri-shim] bad shell event", error); }
      }
      newline = buffer.indexOf("\n");
    }
  }
  // The shell is gone: so is the app.
  process.exit(0);
})();

// The display list comes with the shell's hello, before any window is made.
await Promise.race([hello, new Promise((resolve) => setTimeout(resolve, 3000))]);

// ---------------------------------------------------------------------------
// RPC over WebSocket

const rpcToken = crypto.randomUUID();
type Socket = { send(data: string): void; readyState: number };
const sockets = new Map<number, Socket>();
const handlers = new Map<number, (message: unknown) => void>();
const queued = new Map<number, string[]>();

const rpcServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/rpc" && url.searchParams.get("token") === rpcToken) {
      const id = Number(url.searchParams.get("window"));
      if (server.upgrade(request, { data: { id } })) return undefined;
    }
    return new Response("", { status: 404 });
  },
  websocket: {
    maxPayloadLength: 256 * 1024 * 1024,
    open(ws) {
      const id = (ws.data as { id: number }).id;
      sockets.set(id, ws as unknown as Socket);
      for (const message of queued.get(id) ?? []) ws.send(message);
      queued.delete(id);
    },
    message(ws, raw) {
      const id = (ws.data as { id: number }).id;
      try { handlers.get(id)?.(JSON.parse(String(raw))); } catch (error) { console.error("[tauri-shim] bad rpc message", error); }
    },
    close(ws) {
      const id = (ws.data as { id: number }).id;
      if (sockets.get(id) === (ws as unknown as Socket)) sockets.delete(id);
    },
  },
});

function transportFor(id: number) {
  return {
    send(message: unknown) {
      const text = JSON.stringify(message);
      const socket = sockets.get(id);
      if (socket && socket.readyState === 1) socket.send(text);
      else {
        const list = queued.get(id) ?? [];
        list.push(text);
        queued.set(id, list);
      }
    },
    registerHandler(handler: (message: unknown) => void) { handlers.set(id, handler); },
    unregisterHandler() { handlers.delete(id); },
  };
}

// ---------------------------------------------------------------------------
// Windows

type RpcLike = { setTransport(transport: ReturnType<typeof transportFor>): void };

interface WindowOptions {
  title?: string;
  frame?: Partial<Frame>;
  url?: string | null;
  preload?: string | null;
  rpc?: RpcLike;
  titleBarStyle?: string;
  minSize?: { width: number; height: number };
  [key: string]: unknown;
}

class Emitter {
  private readonly listeners = new Map<string, Set<Listener>>();
  on(name: string, listener: Listener): void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
  }
  off(name: string, listener: Listener): void { this.listeners.get(name)?.delete(listener); }
  emit(name: string, data: Record<string, unknown>): void {
    for (const listener of this.listeners.get(name) ?? []) {
      try { listener({ data }); } catch (error) { console.error(`[tauri-shim] ${name} listener failed`, error); }
    }
  }
}

function bootScript(id: number, preload: string | null | undefined): string {
  return [
    `window.__electrobunWindowId = ${id};`,
    `window.__electrobunWebviewId = ${id};`,
    `window.__gloomTauriRpc = { port: ${rpcServer.port}, token: ${JSON.stringify(rpcToken)} };`,
    // The view's window-move helper posts Electrobun's internal messages; the
    // shell's own drag does the move.
    `window.__electrobunInternalBridge = { postMessage(batch) { try { for (const raw of JSON.parse(batch)) { const message = JSON.parse(raw); if (message.id === "startWindowMove") window.__TAURI_INTERNALS__?.invoke("plugin:window|start_dragging", { label: "w${id}" }); } } catch {} } };`,
    preload ?? "",
  ].join("\n");
}

class WebviewHandle extends Emitter {
  constructor(private readonly owner: BrowserWindow) { super(); }
  get rpc() { return this.owner.rpc; }
  loadURL(_url: string): void { /* the page is the app's own; reloads are not needed by the shell */ }
  executeJavascript(js: string): void { send({ cmd: "window.eval", id: this.owner.id, js }); }
  openDevTools(): void { send({ cmd: "window.devtools", id: this.owner.id }); }
  closeDevTools(): void {}
  toggleDevTools(): void {}
  setPageZoom(_zoom: number): void {}
}

export class BrowserWindow extends Emitter {
  readonly id: number;
  readonly ptr: undefined = undefined;
  frame: Frame;
  title: string;
  rpc?: RpcLike;
  readonly webview: WebviewHandle;
  private maximized = false;
  private minimized = false;
  private fullscreen = false;
  private closed = false;

  constructor(options: WindowOptions = {}) {
    super();
    this.id = nextWindowId++;
    this.title = options.title ?? "Gloom";
    this.frame = {
      x: options.frame?.x ?? 64,
      y: options.frame?.y ?? 48,
      width: options.frame?.width ?? 1440,
      height: options.frame?.height ?? 920,
    };
    this.rpc = options.rpc;
    this.webview = new WebviewHandle(this);
    windows.set(this.id, this);
    this.rpc?.setTransport(transportFor(this.id));
    send({
      cmd: "window.create",
      id: this.id,
      label: `w${this.id}`,
      title: this.title,
      frame: this.frame,
      minSize: (options.minSize as { width: number; height: number } | undefined) ?? null,
      titleBarStyle: options.titleBarStyle ?? "default",
      initScript: bootScript(this.id, options.preload),
    });
  }

  applyShellEvent(message: ShellEvent): void {
    if (message.maximized !== undefined) this.maximized = message.maximized;
    if (message.minimized !== undefined) this.minimized = message.minimized;
    if (message.fullscreen !== undefined) this.fullscreen = message.fullscreen;
    switch (message.event) {
      case "moved":
        if (message.frame) this.frame = { ...message.frame };
        this.emit("move", { id: this.id, ...this.frame });
        break;
      case "resized":
        if (message.frame) this.frame = { ...message.frame };
        this.emit("resize", { id: this.id, ...this.frame });
        break;
      case "focus":
        this.emit(message.focused === false ? "blur" : "focus", { id: this.id });
        break;
      case "close-requested":
        this.emit("close", { id: this.id });
        break;
      case "closed":
        this.closed = true;
        windows.delete(this.id);
        sockets.delete(this.id);
        handlers.delete(this.id);
        if (exitOnLastWindowClosed && windows.size === 0) Utils.quit();
        break;
      case "dom-ready":
        this.webview.emit("dom-ready", { id: this.id });
        break;
    }
  }

  private command(cmd: string, extra: Record<string, unknown> = {}): void {
    if (this.closed) return;
    send({ cmd, id: this.id, ...extra });
  }

  getFrame(): Frame { return { ...this.frame }; }
  setFrame(x: number, y: number, width: number, height: number): void {
    this.frame = { x, y, width, height };
    this.command("window.setFrame", { frame: this.frame });
  }
  setPosition(x: number, y: number): void { this.setFrame(x, y, this.frame.width, this.frame.height); }
  setSize(width: number, height: number): void { this.setFrame(this.frame.x, this.frame.y, width, height); }
  setTitle(title: string): void { this.title = title; this.command("window.setTitle", { title }); }
  minimize(): void { this.minimized = true; this.command("window.minimize"); }
  unminimize(): void { this.minimized = false; this.command("window.unminimize"); }
  maximize(): void { this.maximized = true; this.command("window.maximize"); }
  unmaximize(): void { this.maximized = false; this.command("window.unmaximize"); }
  isMaximized(): boolean { return this.maximized; }
  isMinimized(): boolean { return this.minimized; }
  isFullScreen(): boolean { return this.fullscreen; }
  setFullScreen(value: boolean): void { this.fullscreen = value; this.command("window.setFullScreen", { value }); }
  isAlwaysOnTop(): boolean { return false; }
  setAlwaysOnTop(value: boolean): void { this.command("window.setAlwaysOnTop", { value }); }
  focus(): void { this.command("window.focus"); }
  activate(): void { this.command("window.focus"); }
  show(): void { this.command("window.show"); }
  showInactive(): void { this.command("window.show"); }
  hide(): void { this.command("window.hide"); }
  close(): void { this.command("window.close"); }
}

export class BrowserView {
  static defineRPC(config: Parameters<typeof defineElectrobunRPC>[1]) {
    return defineElectrobunRPC("bun", config);
  }
}

// ---------------------------------------------------------------------------
// The rest of the API the backend touches

const exitOnLastWindowClosed = true;

function openWithSystem(target: string): boolean {
  const command = process.platform === "darwin" ? ["open", target]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", target]
    : ["xdg-open", target];
  try {
    spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

export const Utils = {
  quit(code = 0): void {
    send({ cmd: "app.quit", code });
    setTimeout(() => process.exit(code), 200);
  },
  openExternal: openWithSystem,
  openPath: openWithSystem,
  showItemInFolder: openWithSystem,
  showNotification(_options: unknown): void {},
  clipboardWriteText(text: string): void { send({ cmd: "clipboard.writeText", text }); },
  clipboardReadText(): string | null { return null; },
  clipboardWriteImage(_png: Uint8Array): void {},
};

export const Screen = {
  getAllDisplays(): Display[] { return displays; },
  getPrimaryDisplay(): Display | undefined { return displays.find((display) => display.isPrimary) ?? displays[0]; },
};

const appMenuEmitter = new Emitter();
export const ApplicationMenu = {
  setApplicationMenu(_items: unknown): void {},
  on(name: string, listener: Listener): void { appMenuEmitter.on(name, listener); },
};

export const ContextMenu = {
  showContextMenu(_items: unknown): void {},
};

const unsupported = async () => { throw new Error("Updates are not part of the shell prototype"); };
export const Updater = {
  localInfo: { channel: () => "stable", baseUrl: () => "", version: () => "0.0.0", hash: () => "" },
  appDataFolder: async () => null,
  checkForUpdate: async () => ({ updateAvailable: false, error: "not in the prototype" }),
  downloadUpdate: unsupported,
  applyUpdate: unsupported,
  updateInfo: () => null,
  getStatusHistory: () => [],
  clearStatusHistory: () => {},
  onStatusChange: (_listener: unknown) => {},
  setUpdateSource: (_source: unknown) => {},
};

const events = new Emitter();
const Electrobun = { events, BrowserWindow, BrowserView, Utils, Screen, ApplicationMenu, ContextMenu, Updater };
export default Electrobun;
