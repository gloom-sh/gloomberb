import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Jimp } from "jimp";
import { Cdp, evaluate } from "../pane-chrome/browser";
import { EXTRACTED_PLUGINS } from "../../src/plugins/extracted-plugins";
import * as win from "./win32";
import type { Bitmap, Point, Rect } from "./win32";
import type { CheckResult, CheckRun, CheckStatus } from "./results";

/**
 * Installs the Windows desktop app and drives it with real OS input
 * (SendInput), as a person with a mouse and keyboard does: the window resized
 * from every edge and corner, maximized and restored, snapped, minimized and
 * restored, the dock dividers, a floating pane moved and resized, a pane
 * dragged onto another, a popped-out window, typing in the command bar. Every
 * step is pictured and checked from outside (window rects, the cursor shape,
 * Windows hit tests, screen pixels) and from inside (the page's layout over
 * the DevTools port CEF opens on Windows).
 *
 *   bun scripts/windows-desktop-check/check.ts install --installer <GloomSetup.exe> --dir <install dir>
 *   bun scripts/windows-desktop-check/check.ts run --app <install dir> --out <dir> [--label <name>] [--only <text>]
 *
 * `run` writes results.json and the pictures under --out; report.ts turns
 * one or more runs into a summary. Windows only.
 */

const ARGS = process.argv.slice(2);
const COMMAND = ARGS[0];

function option(name: string): string | undefined {
  const index = ARGS.indexOf(`--${name}`);
  return index >= 0 ? ARGS[index + 1] : undefined;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const sleep = win.sleep;

// --- Install ---------------------------------------------------------------

async function install(installer: string, dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  const log = `${dir}.install.log`;
  // Inno Setup reads /DIR="..." itself; Bun must not quote the argument again.
  const command = `"${installer}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /DIR="${dir}" /LOG="${log}"`;
  const child = Bun.spawn([process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${command}"`], {
    stdout: "inherit", stderr: "inherit", windowsVerbatimArguments: true,
  });
  const code = await child.exited;
  if (code !== 0 || !existsSync(join(dir, "bin", "launcher.exe"))) {
    console.error(existsSync(log) ? await readFile(log, "utf8") : "(no install log)");
    throw new Error(`The installer exited ${code} and left no launcher in ${dir}`);
  }
  // No update checks during the run: the app under test must stay the one installed.
  const versionPath = join(dir, "Resources", "version.json");
  const version = JSON.parse((await readFile(versionPath, "utf8")).replace(/^\uFEFF/, ""));
  console.log(`Installed ${version.name ?? "Gloom"} ${version.version} into ${dir}`);
  await writeFile(versionPath, JSON.stringify({ ...version, channel: "dev", baseUrl: "" }, null, 2));
}

// --- Profile ---------------------------------------------------------------

/**
 * The first-run layout (a list, chat, research and trending, docked in two
 * columns), plus a floating watchlist and a research pane popped out to its
 * own window.
 */
interface Frame { x: number; y: number; width: number; height: number }

function seedLayout(detached: Frame) {
  const layout = {
    dockRoot: {
      kind: "split", axis: "horizontal", ratio: 0.34,
      first: {
        kind: "split", axis: "vertical", ratio: 0.6,
        first: { kind: "pane", instanceId: "portfolio-list:main" },
        second: { kind: "pane", instanceId: "chat:main" },
      },
      second: {
        kind: "split", axis: "vertical", ratio: 0.72,
        first: { kind: "pane", instanceId: "ticker-research:spy" },
        second: { kind: "pane", instanceId: "attention-trending:home" },
      },
    },
    instances: [
      { instanceId: "portfolio-list:main", paneId: "portfolio-list", params: { collectionId: "main" }, binding: { kind: "none" } },
      { instanceId: "chat:main", paneId: "chat", settings: { hideTabs: false }, binding: { kind: "none" } },
      {
        instanceId: "ticker-research:spy", paneId: "ticker-research",
        settings: { hideTabs: false, lockedTabId: "overview" }, binding: { kind: "fixed", symbol: "SPY" },
      },
      { instanceId: "attention-trending:home", paneId: "attention-trending", binding: { kind: "none" } },
      {
        instanceId: "portfolio-list:watchlist", paneId: "portfolio-list", title: "Floating Watchlist",
        params: { collectionId: "watchlist" }, binding: { kind: "none" },
      },
      {
        instanceId: "ticker-research:qqq", paneId: "ticker-research", title: "Popped Out QQQ",
        settings: { hideTabs: false, lockedTabId: "overview" }, binding: { kind: "fixed", symbol: "QQQ" },
      },
    ],
    floating: [{ instanceId: "portfolio-list:watchlist", x: 30, y: 8, width: 60, height: 16, zIndex: 60 }],
    detached: [{ instanceId: "ticker-research:qqq", ...detached }],
  };
  return layout;
}

/**
 * A fresh profile whose main window and popped-out window open where the
 * steps start from: placing them afterwards would resize them, which is
 * itself something under test.
 */
async function seedProfile(profile: string, frames: { main: Frame; detached: Frame }): Promise<void> {
  await rm(profile, { recursive: true, force: true });
  const dataDir = join(profile, "data");
  await mkdir(dataDir, { recursive: true });
  const layout = seedLayout(frames.detached);
  await writeFile(join(profile, "desktop-window.json"), JSON.stringify({ frame: frames.main, maximized: false, fullscreen: false }));
  await writeFile(join(profile, "config.json"), JSON.stringify({ dataDir }, null, 2));
  await writeFile(join(dataDir, "config.json"), JSON.stringify({
    dataDir,
    onboardingComplete: true,
    // Not black: an unpainted strip (black or white) stands out on it.
    theme: "dracula",
    telemetry: { crashReports: false, usage: false },
    // No plugin installs from the network while the window is under test.
    seededPlugins: EXTRACTED_PLUGINS.map((plugin) => plugin.id),
    layout,
    layouts: [{ name: "Windows check", layout, paneState: {}, focusedPaneId: "portfolio-list:main" }],
    activeLayoutIndex: 0,
  }, null, 2));
}

// --- The page --------------------------------------------------------------

/** Installed in every window's page: pointer bookkeeping and layout reads. */
const PAGE_HELPER = String.raw`(() => {
  if (window.__winCheck) return true;
  const state = { moves: 0, last: null, downs: 0, ups: 0, errors: [] };
  addEventListener("pointermove", (e) => { state.moves += 1; state.last = { x: e.clientX, y: e.clientY, buttons: e.buttons, at: Date.now() }; }, true);
  addEventListener("pointerdown", () => { state.downs += 1; }, true);
  addEventListener("pointerup", () => { state.ups += 1; }, true);
  addEventListener("error", (e) => { state.errors.push(String(e.message || e.error)); });
  addEventListener("unhandledrejection", (e) => { state.errors.push("unhandled rejection: " + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)); });
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const q = (selector) => document.querySelector(selector);
  const bare = (header, x, y) => {
    const hit = document.elementFromPoint(x, y);
    return hit && header.contains(hit) && !hit.closest("button, [role=button], [role=tab], input, textarea, a, [data-gloom-interactive=true], [data-gloom-role=window-controls], [data-gloom-role=pane-header-tabs]");
  };
  window.__winCheck = {
    state,
    layout() {
      const detached = q("[data-gloom-role=detached-pane-window]");
      return {
        innerWidth, innerHeight, dpr: devicePixelRatio,
        visibility: document.visibilityState,
        detached: detached ? detached.getAttribute("data-gloom-pane-id") : null,
        header: rect(q("[data-gloom-role=app-header]")),
        status: rect(q("[data-gloom-role=status-bar]")),
        controls: rect(q("[data-gloom-role=window-controls]")),
        maximize: rect(q("[data-window-control-action=toggle-maximize]")),
        minimize: rect(q("[data-window-control-action=minimize]")),
        close: rect(q("[data-window-control-action=close]")),
        prompt: rect(q("[data-gloom-role=header-command-prompt]")),
        root: rect(document.documentElement),
        panes: [...document.querySelectorAll("[data-gloom-role=pane-window]")].map((el) => ({
          id: el.getAttribute("data-gloom-pane-id"),
          floating: el.getAttribute("data-floating") === "true",
          rect: rect(el),
          title: rect(el.querySelector("[data-gloom-role=pane-title]")),
          resize: rect(el.querySelector(":scope > [data-gloom-role=resize-handle]")),
        })),
        dividers: [...document.querySelectorAll("[data-gloom-role=dock-divider]")].map((el) => ({ axis: el.getAttribute("data-axis"), rect: rect(el) })),
        detachedHeader: rect(q("[data-gloom-role=detached-pane-window] [data-gloom-role=pane-header]")),
        input: document.activeElement && "value" in document.activeElement ? String(document.activeElement.value) : null,
        inputRole: document.activeElement ? (document.activeElement.getAttribute("data-gloom-role") || document.activeElement.tagName) : null,
      };
    },
    /** A point on the title bar with nothing pressable under it. */
    titleBarPoint() {
      const header = q("[data-gloom-role=detached-pane-window] [data-gloom-role=pane-header]") || q("[data-gloom-role=app-header]");
      if (!header) return null;
      const h = header.getBoundingClientRect();
      const y = h.top + h.height / 2;
      for (let x = h.right - 150; x > h.left + 20; x -= 6) if (bare(header, x, y)) return { x, y };
      return null;
    },
    /** What a press at this point lands on, for the report. */
    whatIsAt(x, y) {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return "nothing";
      const named = hit.closest("[aria-label], [data-gloom-role]");
      if (!named) return hit.tagName.toLowerCase();
      const label = named.getAttribute("aria-label");
      return (named.getAttribute("data-gloom-role") || named.tagName.toLowerCase()) + (label ? ' "' + label + '"' : "");
    },
    /** A bare point on a pane's header bar, or its title. */
    paneHeaderPoint(id) {
      const pane = q('[data-gloom-role=pane-window][data-gloom-pane-id="' + id + '"]');
      const header = pane && pane.querySelector("[data-gloom-role=pane-header]");
      if (!header) return null;
      const title = pane.querySelector("[data-gloom-role=pane-title]");
      if (title) { const t = title.getBoundingClientRect(); return { x: t.left + Math.min(t.width / 2, 24), y: t.top + t.height / 2 }; }
      const h = header.getBoundingClientRect();
      return { x: h.left + 40, y: h.top + h.height / 2 };
    },
  };
  return true;
})()`;

interface PaneLayout { id: string; floating: boolean; rect: CssRect; title: CssRect | null; resize: CssRect | null }
interface CssRect { x: number; y: number; width: number; height: number }
interface PageLayout {
  innerWidth: number; innerHeight: number; dpr: number; visibility: string;
  detached: string | null;
  header: CssRect | null; status: CssRect | null; controls: CssRect | null;
  maximize: CssRect | null; minimize: CssRect | null; close: CssRect | null; prompt: CssRect | null;
  root: CssRect;
  panes: PaneLayout[];
  dividers: Array<{ axis: string; rect: CssRect }>;
  detachedHeader: CssRect | null;
  input: string | null; inputRole: string | null;
}

interface Page {
  cdp: Cdp;
  targetId: string;
  errors: string[];
}

interface AppWindow {
  hwnd: number;
  title: string;
  page: Page;
  /** Physical pixels per CSS pixel. */
  scale: number;
}

async function devtoolsTargets(): Promise<Array<{ id: string; url: string; type: string; webSocketDebuggerUrl: string }>> {
  for (let port = 9222; port <= 9232; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) continue;
      const targets = await response.json() as Array<{ id: string; url: string; type: string; webSocketDebuggerUrl: string }>;
      const pages = targets.filter((target) => target.type === "page" && target.url.startsWith("views://"));
      if (pages.length) return pages;
    } catch {
      // Intentional ignore: the port is closed or not CEF's; try the next.
    }
  }
  return [];
}

async function connectPage(target: { id: string; webSocketDebuggerUrl: string }): Promise<Page> {
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const page: Page = { cdp, targetId: target.id, errors: [] };
  cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails;
    page.errors.push(`exception: ${details?.exception?.description ?? details?.text ?? "unknown"}`);
  });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    const text = (params.args ?? []).map((arg: any) => arg.value ?? arg.description ?? "").join(" ");
    page.errors.push(`console.error: ${text}`.slice(0, 600));
  });
  await cdp.send("Runtime.enable");
  await evaluate(cdp, PAGE_HELPER);
  return page;
}

const layoutOf = (page: Page) => evaluate<PageLayout>(page.cdp, "window.__winCheck.layout()", 5_000);

// --- Pictures --------------------------------------------------------------

class Shots {
  private pending: Array<{ path: string; bitmap: Bitmap }> = [];
  private count = 0;

  constructor(private readonly dir: string) {}

  /** Grabs the screen in `rect` now; the file is written by flush(). Returns its name. */
  take(label: string, rect: Rect): string | null {
    const screen = win.screenRect();
    const clipped = {
      left: Math.max(screen.left, rect.left), top: Math.max(screen.top, rect.top),
      right: Math.min(screen.right, rect.right), bottom: Math.min(screen.bottom, rect.bottom),
    };
    if (clipped.right - clipped.left < 2 || clipped.bottom - clipped.top < 2) return null;
    let bitmap: Bitmap;
    try {
      bitmap = win.captureScreen(clipped);
    } catch (error) {
      console.error(`Could not picture ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.count += 1;
    const name = `${String(this.count).padStart(3, "0")}-${label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}.png`;
    this.pending.push({ path: join(this.dir, name), bitmap });
    return name;
  }

  desktop(label: string): string | null {
    return this.take(label, win.screenRect());
  }

  async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    for (const { path, bitmap } of pending) {
      const image = new Jimp({ width: bitmap.width, height: bitmap.height, data: bitmap.data });
      await writeFile(path, await image.getBuffer("image/png"));
    }
  }
}

/**
 * How much of a strip along the window's right and bottom edges is flat
 * black or white: what an unpainted part of a window looks like on a theme
 * whose background is neither.
 */
function deadStrips(bitmap: Bitmap, strip = 10): { right: number; bottom: number } {
  const dead = (x: number, y: number) => {
    const offset = (y * bitmap.width + x) * 4;
    const r = bitmap.data[offset]!, g = bitmap.data[offset + 1]!, b = bitmap.data[offset + 2]!;
    return (r < 4 && g < 4 && b < 4) || (r > 251 && g > 251 && b > 251);
  };
  let right = 0, rightTotal = 0, bottom = 0, bottomTotal = 0;
  for (let y = 0; y < bitmap.height; y += 2) {
    for (let x = Math.max(0, bitmap.width - strip); x < bitmap.width; x += 1) {
      rightTotal += 1;
      if (dead(x, y)) right += 1;
    }
  }
  for (let y = Math.max(0, bitmap.height - strip); y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 2) {
      bottomTotal += 1;
      if (dead(x, y)) bottom += 1;
    }
  }
  return { right: rightTotal ? right / rightTotal : 0, bottom: bottomTotal ? bottom / bottomTotal : 0 };
}

/** Distinct colors on a fine grid: a line of text in an empty pane counts. */
function distinctColors(bitmap: Bitmap): number {
  const colors = new Set<number>();
  for (let y = 0; y < bitmap.height; y += 2) {
    for (let x = 0; x < bitmap.width; x += 2) {
      const offset = (y * bitmap.width + x) * 4;
      colors.add((bitmap.data[offset]! << 16) | (bitmap.data[offset + 1]! << 8) | bitmap.data[offset + 2]!);
    }
  }
  return colors.size;
}

// --- The run ---------------------------------------------------------------

const RESIZE_CURSORS: Record<string, string> = {
  left: "resize-ew", right: "resize-ew", top: "resize-ns", bottom: "resize-ns",
  "top-left": "resize-nwse", "bottom-right": "resize-nwse", "top-right": "resize-nesw", "bottom-left": "resize-nesw",
};

type Edge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

const fmt = (rect: Rect) => `${rect.left},${rect.top} ${win.rectWidth(rect)}x${win.rectHeight(rect)}`;
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

class Run {
  readonly results: CheckResult[] = [];
  readonly shots: Shots;
  launcher: ReturnType<typeof Bun.spawn> | null = null;
  main!: AppWindow;
  detached: AppWindow | null = null;
  knownWindows = new Set<number>();
  baseRect!: Rect;
  detachedRect!: Rect;
  profile = "";
  launches = 0;
  /** Page errors from apps this run already closed. */
  pastErrors: string[] = [];

  constructor(readonly app: string, readonly out: string, readonly only: string | undefined) {
    this.shots = new Shots(join(out, "shots"));
  }

  record(result: CheckResult): void {
    this.results.push(result);
    const mark = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : result.status.toUpperCase();
    console.log(`${mark.padEnd(5)} ${result.id}: ${result.detail}`);
  }

  async step(id: string, title: string, body: (shots: string[]) => Promise<{ status: CheckStatus; detail: string; data?: unknown }>): Promise<CheckStatus> {
    if (this.only && !id.includes(this.only) && !title.toLowerCase().includes(this.only.toLowerCase())) return "skip";
    const started = Date.now();
    const shots: string[] = [];
    let outcome: { status: CheckStatus; detail: string; data?: unknown };
    try {
      outcome = await body(shots);
    } catch (error) {
      outcome = { status: "fail", detail: `the step threw: ${error instanceof Error ? error.message : String(error)}` };
      const shot = this.shots.desktop(`${id}-error`);
      if (shot) shots.push(shot);
    }
    await this.shots.flush();
    this.record({ id, title, ...outcome, shots, ms: Date.now() - started });
    return outcome.status;
  }

  // --- Windows and pages ---

  appWindows(): win.WindowInfo[] {
    return win.topLevelWindows().filter((info) => info.visible && info.className === "BasicWindowClass" && !this.knownWindows.has(info.hwnd));
  }

  async launch(profile: string, timeoutMs = 120_000): Promise<void> {
    // A key left down by an earlier step or run would change what clicks do.
    for (const key of [win.VK.control, win.VK.shift, win.VK.alt, win.VK.win]) win.keyUp(key);
    for (const info of win.topLevelWindows()) this.knownWindows.add(info.hwnd);
    const bin = join(this.app, "bin");
    this.launcher = Bun.spawn([join(bin, "launcher.exe")], {
      cwd: bin,
      env: {
        ...process.env,
        GLOOMBERB_HOME: profile,
        ELECTROBUN_CONSOLE: "1",
        DO_NOT_TRACK: "1",
        GLOOMBERB_NO_TELEMETRY: "1",
      },
      stdout: Bun.file(join(this.out, `app-stdout-${this.launches}.log`)),
      stderr: Bun.file(join(this.out, `app-stderr-${this.launches}.log`)),
    });
    // The main window's page lays out its panes; the popped-out window follows.
    const deadline = Date.now() + timeoutMs;
    const launcher = this.launcher;
    const pages = new Map<string, Page>();
    let mainPage: Page | null = null;
    let detachedPage: Page | null = null;
    let mainReadyAt = 0;
    while (Date.now() < deadline) {
      for (const target of await devtoolsTargets()) {
        if (pages.has(target.id)) continue;
        const page = await connectPage(target).catch(() => null);
        if (page) pages.set(target.id, page);
      }
      for (const page of pages.values()) {
        const layout = await layoutOf(page).catch(() => null);
        if (!layout) continue;
        if (layout.detached) detachedPage = page;
        else if (layout.panes.length >= 4) mainPage = page;
      }
      if (mainPage && !mainReadyAt) mainReadyAt = Date.now();
      const windows = this.appWindows();
      if (mainPage && windows.length >= 1 && (detachedPage && windows.length >= 2 || Date.now() - mainReadyAt > 30_000)) break;
      if (launcher.exitCode !== null) break;
      await sleep(500);
    }
    const windows = this.appWindows();
    if (!mainPage || !windows.length) {
      const how = launcher.exitCode !== null ? `exited with code ${launcher.exitCode} after` : "in";
      throw new Error(`The app ${how} ${Math.round((Date.now() - deadline + timeoutMs) / 1000)} s with ${windows.length} window(s) and ${pages.size} page(s), ${mainPage ? "with" : "without"} the main layout`);
    }
    const mainInfo = windows.find((info) => info.title === "Gloom") ?? windows[0]!;
    const detachedInfo = windows.find((info) => info.hwnd !== mainInfo.hwnd) ?? null;
    // Steps hold these objects, so a relaunch updates them in place.
    const main: AppWindow = { hwnd: mainInfo.hwnd, title: mainInfo.title, page: mainPage, scale: await this.scaleOf(mainInfo.hwnd, mainPage) };
    if (this.main) Object.assign(this.main, main);
    else this.main = main;
    if (detachedInfo && detachedPage) {
      const detached: AppWindow = { hwnd: detachedInfo.hwnd, title: detachedInfo.title, page: detachedPage, scale: await this.scaleOf(detachedInfo.hwnd, detachedPage) };
      if (this.detached) Object.assign(this.detached, detached);
      else this.detached = detached;
    } else if (this.detached) {
      this.detached.hwnd = 0;
    }
    for (const page of pages.values()) if (page !== mainPage && page !== detachedPage) page.cdp.close();
    // Let the panes load what they show.
    await sleep(6_000);
  }

  /**
   * Physical pixels per CSS pixel: the page's own device pixel ratio, times
   * the stretch Windows applies to a window that is not DPI aware.
   */
  async scaleOf(hwnd: number, page: Page): Promise<number> {
    const layout = await layoutOf(page);
    const monitorDpi = win.monitorOf(hwnd).dpi;
    const windowDpi = win.windowDpi(hwnd).dpi || 96;
    return layout.dpr * (monitorDpi / windowDpi);
  }

  toScreen(window: AppWindow, point: { x: number; y: number }): Point {
    const client = win.clientRect(window.hwnd);
    return { x: Math.round(client.left + point.x * window.scale), y: Math.round(client.top + point.y * window.scale) };
  }

  centerOf(window: AppWindow, rect: CssRect): Point {
    return this.toScreen(window, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }

  /** Brings a window to the front with a click on its title bar, as a person does. */
  async focus(window: AppWindow): Promise<void> {
    if (win.isMinimized(window.hwnd)) win.showWindow(window.hwnd, "restore");
    if (win.foregroundWindow() === window.hwnd) return;
    const point = await evaluate<{ x: number; y: number } | null>(window.page.cdp, "window.__winCheck.titleBarPoint()", 3_000).catch(() => null);
    if (point) {
      await win.click(this.toScreen(window, point));
      await sleep(300);
    }
    if (win.foregroundWindow() !== window.hwnd) {
      // An Alt tap lets this process hand the foreground to another window.
      await win.pressKeys(win.VK.alt);
      win.bringToFront(window.hwnd);
      await sleep(300);
    }
  }

  /**
   * The frames to seed, in the app's own pixels: the release draws unaware
   * of the display scale, so Windows multiplies what it asks for.
   */
  seedFrames(): { main: Frame; detached: Frame } {
    const scale = win.primaryMonitor().dpi / 96;
    const frame = (rect: Rect): Frame => ({
      x: Math.round(rect.left / scale), y: Math.round(rect.top / scale),
      width: Math.round(win.rectWidth(rect) / scale), height: Math.round(win.rectHeight(rect) / scale),
    });
    return { main: frame(this.baseRect), detached: frame(this.detachedRect) };
  }

  /** Closes whatever is running and starts the app on a fresh profile. */
  async start(reason: string | null): Promise<void> {
    await this.close();
    this.launches += 1;
    this.profile = join(this.out, "..", `profile-${basename(this.out)}-${this.launches}`);
    await seedProfile(this.profile, this.seedFrames());
    await this.launch(this.profile);
    await this.place(this.main, this.baseRect);
    if (this.detached?.hwnd) await this.place(this.detached, this.detachedRect);
    if (reason) {
      console.log(`Started the app again: ${reason}`);
      this.record({ id: "relaunch", title: "The app was started again", status: "info", detail: reason, shots: [], ms: 0 });
    }
  }

  /** Puts a window where a step starts from, without input, if it is not there. */
  async place(window: AppWindow, rect: Rect): Promise<void> {
    if (win.isMaximized(window.hwnd) || win.isMinimized(window.hwnd)) {
      win.showWindow(window.hwnd, "restore");
      await sleep(500);
    }
    const now = win.windowRect(window.hwnd);
    const off = (["left", "top", "right", "bottom"] as const).some((side) => !near(now[side], rect[side], 3));
    if (off) {
      win.placeWindow(window.hwnd, rect);
      await sleep(400);
    }
  }

  /** Starts the app again when a step closed it or took its popped-out window. */
  async ensure(window: AppWindow): Promise<void> {
    const mainGone = !win.isWindow(this.main.hwnd);
    const windowGone = !win.isWindow(window.hwnd);
    if (!mainGone && !windowGone) return;
    await this.start(mainGone ? "the main window had closed" : `the ${window.title} window had gone`);
    if (!win.isWindow(window.hwnd)) throw new Error(`the ${window.title} window did not come back`);
  }

  /** Puts a window back where a step starts from and brings it to the front. */
  async reset(window: AppWindow, rect: Rect): Promise<void> {
    await this.ensure(window);
    await this.place(window, rect);
    await this.focus(window);
    await sleep(400);
  }

  /**
   * Whether the page fills the window: its viewport is the client area, the
   * window buttons end at the right edge, the status bar sits on the bottom,
   * and no strip along those edges is unpainted.
   */
  async contentFills(window: AppWindow, label: string, shots: string[]): Promise<{ ok: boolean; detail: string }> {
    await sleep(250);
    const client = win.clientRect(window.hwnd);
    const layout = await layoutOf(window.page);
    const problems: string[] = [];
    const cssWidth = win.rectWidth(client) / window.scale;
    const cssHeight = win.rectHeight(client) / window.scale;
    if (!near(layout.innerWidth, cssWidth, 2) || !near(layout.innerHeight, cssHeight, 2)) {
      problems.push(`the page is ${layout.innerWidth}x${layout.innerHeight} in a ${Math.round(cssWidth)}x${Math.round(cssHeight)} window`);
    }
    if (layout.controls && !near(layout.controls.x + layout.controls.width, cssWidth, 2)) {
      problems.push(`the window buttons end at ${Math.round(layout.controls.x + layout.controls.width)}, the window at ${Math.round(cssWidth)}`);
    }
    if (!layout.detached && layout.status && !near(layout.status.y + layout.status.height, cssHeight, 2)) {
      problems.push(`the status bar ends at ${Math.round(layout.status.y + layout.status.height)}, the window at ${Math.round(cssHeight)}`);
    }
    if (!win.isMinimized(window.hwnd)) {
      // Only what is on screen: off it, the capture is black whatever the app drew.
      const screen = win.monitorOf(window.hwnd).monitor;
      const visible = {
        left: Math.max(client.left, screen.left), top: Math.max(client.top, screen.top),
        right: Math.min(client.right, screen.right), bottom: Math.min(client.bottom, screen.bottom),
      };
      if (visible.right - visible.left > 20 && visible.bottom - visible.top > 20) {
        const bitmap = win.captureScreen(visible);
        const strips = deadStrips(bitmap);
        if (visible.right === client.right && strips.right > 0.6) problems.push(`${Math.round(strips.right * 100)}% of the right edge is flat black or white`);
        if (visible.bottom === client.bottom && strips.bottom > 0.6) problems.push(`${Math.round(strips.bottom * 100)}% of the bottom edge is flat black or white`);
        if (distinctColors(bitmap) < 6) problems.push("the window is blank");
      }
      const shot = this.shots.take(label, client);
      if (shot) shots.push(shot);
    }
    return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `the page fills the ${win.rectWidth(client)}x${win.rectHeight(client)} client area` };
  }

  // --- Steps ---

  async calibrate(): Promise<void> {
    await this.step("launch", "Launch with a popped-out window", async (shots) => {
      const desktop = this.shots.desktop("launch-desktop");
      if (desktop) shots.push(desktop);
      const lines = [];
      for (const window of [this.main, this.detached]) {
        if (!window?.hwnd || !win.isWindow(window.hwnd)) continue;
        const dpi = win.windowDpi(window.hwnd);
        const style = win.windowStyle(window.hwnd);
        lines.push(`${window.title}: ${fmt(win.windowRect(window.hwnd))}, ${dpi.awareness} at ${dpi.dpi} dpi, ${window.scale.toFixed(2)} px per CSS px, style ${style.flags.join(" ") || style.value}`);
      }
      const monitor = win.primaryMonitor();
      lines.push(`monitor ${fmt(monitor.monitor)}, work area ${fmt(monitor.work)}, ${monitor.dpi} dpi`);
      const popped = !!this.detached?.hwnd && win.isWindow(this.detached.hwnd);
      return { status: popped ? "info" : "fail", detail: (popped ? "" : "no popped-out window; ") + lines.join("; ") };
    });

    await this.step("dpi-awareness", "The windows draw at the display's scale", async () => {
      const lines: string[] = [];
      let blurry = false;
      for (const window of [this.main, this.detached]) {
        if (!window?.hwnd || !win.isWindow(window.hwnd)) continue;
        const dpi = win.windowDpi(window.hwnd);
        const monitorDpi = win.monitorOf(window.hwnd).dpi;
        if (dpi.awareness === "unaware" && monitorDpi > 96) blurry = true;
        lines.push(`${window.title}: ${dpi.awareness}, window ${dpi.dpi} dpi on a ${monitorDpi} dpi display, page device pixel ratio ${(await layoutOf(window.page)).dpr}`);
      }
      return {
        status: blurry ? "fail" : "pass",
        detail: `${blurry ? "Windows stretches the window's pixels to the display scale, so text is blurred: " : ""}${lines.join("; ")}`,
      };
    });

    await this.step("pointer-mapping", "The pointer lands where the page says", async () => {
      const layout = await layoutOf(this.main.page);
      const target = { x: Math.round(layout.innerWidth * 0.5), y: Math.round(layout.innerHeight * 0.55) };
      const before = await evaluate<number>(this.main.page.cdp, "window.__winCheck.state.moves");
      win.moveMouse(this.toScreen(this.main, target));
      await sleep(250);
      const state = await evaluate<{ moves: number; last: { x: number; y: number } | null }>(this.main.page.cdp, "window.__winCheck.state");
      if (state.moves <= before || !state.last) return { status: "fail", detail: "the page saw no pointer move" };
      const off = Math.hypot(state.last.x - target.x, state.last.y - target.y);
      return {
        status: off <= 2 ? "pass" : "fail",
        detail: `moved to CSS (${target.x}, ${target.y}), the page saw (${Math.round(state.last.x)}, ${Math.round(state.last.y)})`,
      };
    });
  }

  /** Where a person grabs an edge: the first point outside-in where Windows shows a resize cursor. */
  async grabPoint(window: AppWindow, edge: Edge): Promise<{ point: Point; cursor: string; hit: string }> {
    const rect = win.visibleRect(window.hwnd);
    const horizontal = edge.includes("left") ? "left" : edge.includes("right") ? "right" : null;
    const vertical = edge.includes("top") ? "top" : edge.includes("bottom") ? "bottom" : null;
    const centerX = Math.round((rect.left + rect.right) / 2);
    const centerY = Math.round((rect.top + rect.bottom) / 2);
    const candidates = [3, 1, 0, -1, -3].map((outward) => ({
      x: horizontal === "left" ? rect.left - outward : horizontal === "right" ? rect.right - 1 + outward : centerX,
      y: vertical === "top" ? rect.top - outward : vertical === "bottom" ? rect.bottom - 1 + outward : centerY,
    }));
    let fallback: { point: Point; cursor: string; hit: string } | null = null;
    for (const point of candidates) {
      win.moveMouse(point);
      await sleep(150);
      const cursor = win.cursorShape();
      const hit = win.hitTest(point);
      let what = "";
      if (hit.root === window.hwnd && hit.code === "client") {
        const client = win.clientRect(window.hwnd);
        const css = { x: (point.x - client.left) / window.scale, y: (point.y - client.top) / window.scale };
        what = await evaluate<string>(window.page.cdp, `window.__winCheck.whatIsAt(${css.x}, ${css.y})`, 3_000).catch(() => "");
      }
      const probe = { point, cursor, hit: `${hit.code}${what ? ` on ${what}` : ` on ${hit.window?.className ?? "nothing"}`}${hit.root === window.hwnd ? "" : " (another window)"}` };
      if (cursor === RESIZE_CURSORS[edge]) return probe;
      if (!fallback && hit.root === window.hwnd) fallback = probe;
    }
    return fallback ?? { point: candidates[candidates.length - 1]!, cursor: "arrow", hit: "none" };
  }

  /** Drags a window's edge or corner by `delta` and checks the window followed. */
  async resizeEdge(window: AppWindow, name: string, edge: Edge, delta: Point, start: Rect): Promise<void> {
    await this.step(`${name}-resize-${edge}`, `${name === "main" ? "Main window" : "Popped-out window"}: resize from the ${edge.replace("-", " ")} ${edge.includes("-") ? "corner" : "edge"}`, async (shots) => {
      await this.reset(window, start);
      const before = win.visibleRect(window.hwnd);
      const grab = await this.grabPoint(window, edge);
      const to = { x: grab.point.x + delta.x, y: grab.point.y + delta.y };
      let during: Rect | null = null;
      const area = {
        left: Math.min(before.left, before.left + delta.x) - 20, top: Math.min(before.top, before.top + delta.y) - 20,
        right: Math.max(before.right, before.right + delta.x) + 20, bottom: Math.max(before.bottom, before.bottom + delta.y) + 20,
      };
      await win.drag(grab.point, to, {
        whileHeld: async () => {
          during = win.visibleRect(window.hwnd);
          const shot = this.shots.take(`${name}-${edge}-during`, area);
          if (shot) shots.push(shot);
        },
      });
      await sleep(800);
      if (!win.isWindow(window.hwnd)) {
        const desktop = this.shots.desktop(`${name}-${edge}-closed`);
        if (desktop) shots.push(desktop);
        return { status: "fail", detail: `the window closed: the press at the ${edge.replace("-", " ")} landed on ${grab.hit}` };
      }
      const after = win.visibleRect(window.hwnd);
      const expected = {
        left: before.left + (edge.includes("left") ? delta.x : 0),
        right: before.right + (edge.includes("right") ? delta.x : 0),
        top: before.top + (edge.includes("top") ? delta.y : 0),
        bottom: before.bottom + (edge.includes("bottom") ? delta.y : 0),
      };
      const resized = (["left", "right", "top", "bottom"] as const).every((side) => near(after[side], expected[side], 6));
      const fills = await this.contentFills(window, `${name}-${edge}-after`, shots);
      const sizeChanged = win.rectWidth(after) !== win.rectWidth(before) || win.rectHeight(after) !== win.rectHeight(before);
      const moved = !sizeChanged && (after.left !== before.left || after.top !== before.top);
      const what = resized ? "resized"
        : moved ? "moved the window instead of resizing it"
        : sizeChanged ? `resized to ${fmt(after)} instead of ${fmt(expected)}`
        : "did nothing";
      const followed = during ? `, mid-drag ${fmt(during)}` : "";
      return {
        status: resized && fills.ok ? "pass" : "fail",
        detail: `cursor at the edge: ${grab.cursor} (${grab.hit}); dragging ${delta.x},${delta.y} ${what}: ${fmt(before)} -> ${fmt(after)}${followed}; ${fills.detail}`,
        data: { before, after, expected, during, grab },
      };
    });
  }

  async clickControl(window: AppWindow, control: "maximize" | "minimize" | "close"): Promise<boolean> {
    const layout = await layoutOf(window.page);
    const rect = layout[control];
    if (!rect) return false;
    await win.click(this.centerOf(window, rect));
    await sleep(900);
    return true;
  }

  async windowSteps(window: AppWindow, name: string, start: Rect): Promise<void> {
    const label = name === "main" ? "Main window" : "Popped-out window";
    const edges: Array<[Edge, Point]> = name === "main"
      ? [
        ["right", { x: 120, y: 0 }], ["bottom", { x: 0, y: 80 }], ["left", { x: 100, y: 0 }], ["top", { x: 0, y: 60 }],
        ["bottom-right", { x: -150, y: -100 }], ["top-left", { x: -80, y: -60 }], ["bottom-left", { x: -80, y: 60 }], ["top-right", { x: 80, y: -60 }],
      ]
      : [["right", { x: 100, y: 0 }], ["bottom-right", { x: 80, y: 60 }], ["left", { x: -80, y: 0 }]];
    for (const [edge, delta] of edges) await this.resizeEdge(window, name, edge, delta, start);

    await this.step(`${name}-maximize-button`, `${label}: maximize and restore with the window button`, async (shots) => {
      await this.reset(window, start);
      const before = win.visibleRect(window.hwnd);
      if (!await this.clickControl(window, "maximize")) return { status: "fail", detail: "no maximize button" };
      const maximized = win.isMaximized(window.hwnd);
      const rect = win.visibleRect(window.hwnd);
      const work = win.monitorOf(window.hwnd).work;
      const monitor = win.monitorOf(window.hwnd).monitor;
      const fillsWork = (["left", "top", "right", "bottom"] as const).every((side) => near(rect[side], work[side], 2));
      const coversTaskbar = (["left", "top", "right", "bottom"] as const).every((side) => near(rect[side], monitor[side], 2)) && win.rectHeight(work) < win.rectHeight(monitor);
      const fills = await this.contentFills(window, `${name}-maximized`, shots);
      const desktop = this.shots.desktop(`${name}-maximized-desktop`);
      if (desktop) shots.push(desktop);
      await this.clickControl(window, "maximize");
      const restored = win.visibleRect(window.hwnd);
      const restoredOk = !win.isMaximized(window.hwnd) && (["left", "top", "right", "bottom"] as const).every((side) => near(restored[side], before[side], 4));
      const restoredFills = await this.contentFills(window, `${name}-restored`, shots);
      const problems = [
        !maximized && "Windows does not report the window maximized",
        !fillsWork && (coversTaskbar ? "the maximized window covers the taskbar" : `maximized to ${fmt(rect)}, the work area is ${fmt(work)}`),
        !fills.ok && `maximized: ${fills.detail}`,
        !restoredOk && `restored to ${fmt(restored)}, it was ${fmt(before)}`,
        !restoredFills.ok && `restored: ${restoredFills.detail}`,
      ].filter(Boolean);
      return { status: problems.length ? "fail" : "pass", detail: problems.length ? problems.join("; ") : `maximized to the work area ${fmt(work)} and restored to ${fmt(restored)}` };
    });

    await this.step(`${name}-title-double-click`, `${label}: double-click the title bar to maximize`, async (shots) => {
      await this.reset(window, start);
      const point = await evaluate<{ x: number; y: number } | null>(window.page.cdp, "window.__winCheck.titleBarPoint()");
      if (!point) return { status: "fail", detail: "no bare spot on the title bar" };
      const before = win.visibleRect(window.hwnd);
      await win.click(this.toScreen(window, point), { double: true });
      await sleep(900);
      const maximized = win.isMaximized(window.hwnd);
      const after = win.visibleRect(window.hwnd);
      const fills = await this.contentFills(window, `${name}-title-double-click`, shots);
      if (maximized) {
        await win.click(this.toScreen(window, point), { double: true });
        await sleep(900);
      }
      const restored = !win.isMaximized(window.hwnd);
      return {
        status: maximized && restored && fills.ok ? "pass" : "fail",
        detail: maximized
          ? `maximized (${fmt(after)})${restored ? " and a second double-click restored it" : ", a second double-click did not restore it"}; ${fills.detail}`
          : `the window stayed ${fmt(after)} (was ${fmt(before)})`,
      };
    });

    await this.step(`${name}-drag-maximized`, `${label}: drag a maximized window by its title bar`, async (shots) => {
      await this.reset(window, start);
      await this.clickControl(window, "maximize");
      if (!win.isMaximized(window.hwnd)) return { status: "fail", detail: "the window did not maximize" };
      const point = await evaluate<{ x: number; y: number } | null>(window.page.cdp, "window.__winCheck.titleBarPoint()");
      if (!point) return { status: "fail", detail: "no bare spot on the title bar" };
      const from = this.toScreen(window, point);
      const to = { x: from.x - 60, y: from.y + 300 };
      await win.drag(from, to, { steps: 16 });
      await sleep(900);
      const after = win.visibleRect(window.hwnd);
      const stillMaximized = win.isMaximized(window.hwnd);
      const underPointer = to.x >= after.left && to.x <= after.right && to.y >= after.top && to.y <= after.top + 60 * window.scale;
      const fills = await this.contentFills(window, `${name}-dragged-from-maximized`, shots);
      const desktop = this.shots.desktop(`${name}-dragged-from-maximized-desktop`);
      if (desktop) shots.push(desktop);
      const ok = !stillMaximized && underPointer && fills.ok;
      return {
        status: ok ? "pass" : "fail",
        detail: `${stillMaximized ? "still reported maximized" : "restored"}, now ${fmt(after)}, title bar ${underPointer ? "under" : "not under"} the pointer at ${to.x},${to.y}; ${fills.detail}`,
      };
    });

    await this.step(`${name}-snap-keys`, `${label}: snap with Win+Left, Win+Right, Win+Up and Win+Down`, async (shots) => {
      await this.reset(window, start);
      const work = win.monitorOf(window.hwnd).work;
      const halfWidth = win.rectWidth(work) / 2;
      const results: string[] = [];
      let ok = true;
      const check = async (keys: number[], label: string, want: (rect: Rect) => boolean) => {
        await this.focus(window);
        await win.pressKeys(...keys);
        await sleep(900);
        // Snap Assist offers the other windows for the other half; dismiss it.
        await win.pressKeys(win.VK.escape);
        await sleep(400);
        const rect = win.visibleRect(window.hwnd);
        const fills = await this.contentFills(window, `${name}-${label}`, shots);
        const good = want(rect) && fills.ok;
        ok &&= good;
        results.push(`${label}: ${fmt(rect)}${good ? "" : ` (not as expected${fills.ok ? "" : `; ${fills.detail}`})`}`);
      };
      await check([win.VK.win, win.VK.left], "win-left", (rect) => near(rect.left, work.left, 3) && near(win.rectWidth(rect), halfWidth, 12) && near(win.rectHeight(rect), win.rectHeight(work), 3));
      await check([win.VK.win, win.VK.right], "win-right", (rect) => near(rect.right, work.right, 3) && near(win.rectWidth(rect), halfWidth, 12));
      await check([win.VK.win, win.VK.up], "win-up", () => win.isMaximized(window.hwnd));
      await check([win.VK.win, win.VK.down], "win-down", () => !win.isMaximized(window.hwnd) && !win.isMinimized(window.hwnd));
      return { status: ok ? "pass" : "fail", detail: results.join("; ") };
    });

    await this.step(`${name}-button-after-win-up`, `${label}: the maximize button restores a window maximized with Win+Up`, async (shots) => {
      await this.reset(window, start);
      await win.pressKeys(win.VK.win, win.VK.up);
      await sleep(900);
      if (!win.isMaximized(window.hwnd)) return { status: "fail", detail: "Win+Up did not maximize the window" };
      await this.clickControl(window, "maximize");
      const restored = !win.isMaximized(window.hwnd);
      const fills = await this.contentFills(window, `${name}-button-after-win-up`, shots);
      if (!restored) {
        // A second press, to see whether the button had the state backwards.
        await this.clickControl(window, "maximize");
      }
      return {
        status: restored && fills.ok ? "pass" : "fail",
        detail: `${restored ? "one press restored it" : `one press left it maximized; a second press ${win.isMaximized(window.hwnd) ? "did not restore it either" : "restored it"}`}: ${fmt(win.visibleRect(window.hwnd))}; ${fills.detail}`,
      };
    });

    // The main window snaps left; the popped-out one, which sits on the
    // right, snaps right, clear of the main window's edges.
    const side = name === "main" ? "left" : "right";
    await this.step(`${name}-snap-drag`, `${label}: drag the title bar to the screen's ${side} edge to snap`, async (shots) => {
      await this.reset(window, start);
      const point = await evaluate<{ x: number; y: number } | null>(window.page.cdp, "window.__winCheck.titleBarPoint()");
      if (!point) return { status: "fail", detail: "no bare spot on the title bar" };
      const work = win.monitorOf(window.hwnd).work;
      const from = this.toScreen(window, point);
      const to = { x: side === "left" ? work.left : work.right - 1, y: Math.round((work.top + work.bottom) / 2) };
      await win.drag(from, to, {
        steps: 20,
        whileHeld: async () => {
          await sleep(700);
          const shot = this.shots.desktop(`${name}-snap-drag-held`);
          if (shot) shots.push(shot);
        },
      });
      await sleep(1_000);
      await win.pressKeys(win.VK.escape);
      await sleep(300);
      const rect = win.visibleRect(window.hwnd);
      const edgeOk = side === "left" ? near(rect.left, work.left, 3) : near(rect.right, work.right, 3);
      const snapped = edgeOk && near(win.rectWidth(rect), win.rectWidth(work) / 2, 12) && near(win.rectHeight(rect), win.rectHeight(work), 3);
      const fills = await this.contentFills(window, `${name}-snap-drag`, shots);
      return { status: snapped && fills.ok ? "pass" : "fail", detail: `${snapped ? `snapped to the ${side} half` : "did not snap"}: ${fmt(rect)}; ${fills.detail}` };
    });

    await this.step(`${name}-minimize`, `${label}: minimize with the window button and restore from the taskbar`, async (shots) => {
      await this.reset(window, start);
      if (!await this.clickControl(window, "minimize")) return { status: "fail", detail: "no minimize button" };
      const minimized = win.isMinimized(window.hwnd);
      const desktop = this.shots.desktop(`${name}-minimized-desktop`);
      if (desktop) shots.push(desktop);
      let how = "from the taskbar";
      const button = minimized ? await taskbarButton(window.title) : null;
      if (button) {
        await win.click(button);
        await sleep(800);
      }
      if (win.isMinimized(window.hwnd)) {
        // Two windows of one app share a taskbar button, which then offers thumbnails.
        const offered = this.shots.desktop(`${name}-taskbar-click`);
        if (offered) shots.push(offered);
        await win.pressKeys(win.VK.escape);
        how = button ? "with ShowWindow (the taskbar button did not restore it)" : "with ShowWindow (no taskbar button found)";
        win.showWindow(window.hwnd, "restore");
      }
      await sleep(400);
      const early = win.isMinimized(window.hwnd) ? null : this.shots.take(`${name}-restored-early`, win.clientRect(window.hwnd));
      if (early) shots.push(early);
      await sleep(1_200);
      const restored = !win.isMinimized(window.hwnd);
      const fills = restored ? await this.contentFills(window, `${name}-restored-from-minimized`, shots) : { ok: false, detail: "still minimized" };
      const rect = win.windowRect(window.hwnd);
      const sameRect = (["left", "top", "right", "bottom"] as const).every((side) => near(rect[side], start[side], 12));
      return {
        status: minimized && restored && fills.ok && sameRect ? "pass" : "fail",
        detail: `${minimized ? "minimized" : "did not minimize"}; restored ${how}: ${restored ? fmt(rect) : "no"}${sameRect ? "" : ` (was ${fmt(start)})`}; ${fills.detail}`,
      };
    });
  }

  async paneSteps(): Promise<void> {
    const main = this.main;

    await this.step("dock-divider", "Drag the dock divider between the columns", async (shots) => {
      await this.reset(main, this.baseRect);
      const before = await layoutOf(main.page);
      const divider = before.dividers.filter((entry) => entry.rect.height > entry.rect.width).sort((a, b) => b.rect.height - a.rect.height)[0];
      if (!divider) return { status: "fail", detail: "no vertical dock divider" };
      const from = this.centerOf(main, divider.rect);
      const dx = Math.round(140 * main.scale);
      let duringX: number | null = null;
      await win.drag(from, { x: from.x + dx, y: from.y }, {
        whileHeld: async () => {
          const layout = await layoutOf(main.page);
          const live = layout.dividers.filter((entry) => entry.rect.height > entry.rect.width).sort((a, b) => b.rect.height - a.rect.height)[0];
          duringX = live ? live.rect.x : null;
          const shot = this.shots.take("dock-divider-during", win.clientRect(main.hwnd));
          if (shot) shots.push(shot);
        },
      });
      await sleep(600);
      const after = await layoutOf(main.page);
      const moved = after.dividers.filter((entry) => entry.rect.height > entry.rect.width).sort((a, b) => b.rect.height - a.rect.height)[0];
      const shot = this.shots.take("dock-divider-after", win.clientRect(main.hwnd));
      if (shot) shots.push(shot);
      const want = divider.rect.x + 140;
      const cell = 12;
      const followed = duringX !== null && near(duringX, want, cell);
      const landed = !!moved && near(moved.rect.x, want, cell);
      return {
        status: followed && landed ? "pass" : "fail",
        detail: `divider at x ${Math.round(divider.rect.x)}, dragged +140 CSS px: mid-drag ${duringX === null ? "gone" : Math.round(duringX)}, after ${moved ? Math.round(moved.rect.x) : "gone"}`,
      };
    });

    await this.step("floating-move", "Move the floating pane by its title", async (shots) => {
      await this.reset(main, this.baseRect);
      const before = (await layoutOf(main.page)).panes.find((pane) => pane.floating);
      if (!before) return { status: "fail", detail: "no floating pane" };
      const point = await evaluate<{ x: number; y: number } | null>(main.page.cdp, `window.__winCheck.paneHeaderPoint(${JSON.stringify(before.id)})`);
      if (!point) return { status: "fail", detail: "no header on the floating pane" };
      const from = this.toScreen(main, point);
      const delta = { x: Math.round(-140 * main.scale), y: Math.round(90 * main.scale) };
      let during: CssRect | null = null;
      await win.drag(from, { x: from.x + delta.x, y: from.y + delta.y }, {
        whileHeld: async () => {
          during = (await layoutOf(main.page)).panes.find((pane) => pane.id === before.id)?.rect ?? null;
        },
      });
      await sleep(600);
      const after = (await layoutOf(main.page)).panes.find((pane) => pane.id === before.id);
      const shot = this.shots.take("floating-move-after", win.clientRect(main.hwnd));
      if (shot) shots.push(shot);
      const cell = 20;
      const landed = !!after && after.floating && near(after.rect.x, before.rect.x - 140, cell) && near(after.rect.y, before.rect.y + 90, cell);
      const duringRect = during as CssRect | null;
      const followed = !!duringRect && near(duringRect.x, before.rect.x - 140, cell) && near(duringRect.y, before.rect.y + 90, cell);
      return {
        status: landed && followed ? "pass" : "fail",
        detail: `from ${Math.round(before.rect.x)},${Math.round(before.rect.y)} by -140,+90 CSS px: mid-drag ${duringRect ? `${Math.round(duringRect.x)},${Math.round(duringRect.y)}` : "gone"}, after ${after ? `${Math.round(after.rect.x)},${Math.round(after.rect.y)}${after.floating ? "" : " (docked)"}` : "gone"}`,
      };
    });

    await this.step("floating-resize", "Resize the floating pane by its corner", async (shots) => {
      await this.reset(main, this.baseRect);
      const before = (await layoutOf(main.page)).panes.find((pane) => pane.floating);
      if (!before?.resize) return { status: "fail", detail: "no resize corner on the floating pane" };
      const from = this.centerOf(main, before.resize);
      let during: CssRect | null = null;
      await win.drag(from, { x: from.x + Math.round(120 * main.scale), y: from.y + Math.round(80 * main.scale) }, {
        whileHeld: async () => {
          during = (await layoutOf(main.page)).panes.find((pane) => pane.id === before.id)?.rect ?? null;
          const shot = this.shots.take("floating-resize-during", win.clientRect(main.hwnd));
          if (shot) shots.push(shot);
        },
      });
      await sleep(600);
      const after = (await layoutOf(main.page)).panes.find((pane) => pane.id === before.id);
      const shot = this.shots.take("floating-resize-after", win.clientRect(main.hwnd));
      if (shot) shots.push(shot);
      const cell = 20;
      const grew = !!after && near(after.rect.width, before.rect.width + 120, cell) && near(after.rect.height, before.rect.height + 80, cell);
      const duringRect = during as CssRect | null;
      const followed = !!duringRect && near(duringRect.width, before.rect.width + 120, cell);
      return {
        status: grew && followed ? "pass" : "fail",
        detail: `${Math.round(before.rect.width)}x${Math.round(before.rect.height)} dragged +120,+80 CSS px: mid-drag ${duringRect ? `${Math.round(duringRect.width)}x${Math.round(duringRect.height)}` : "gone"}, after ${after ? `${Math.round(after.rect.width)}x${Math.round(after.rect.height)}` : "gone"}`,
      };
    });

    await this.step("dock-swap", "Drag a docked pane onto another to swap them", async (shots) => {
      await this.reset(main, this.baseRect);
      const before = await layoutOf(main.page);
      const source = before.panes.find((pane) => pane.id === "portfolio-list:main");
      const target = before.panes.find((pane) => pane.id === "ticker-research:spy");
      if (!source || !target) return { status: "fail", detail: "the list or research pane is missing" };
      const point = await evaluate<{ x: number; y: number } | null>(main.page.cdp, `window.__winCheck.paneHeaderPoint(${JSON.stringify(source.id)})`);
      if (!point) return { status: "fail", detail: "no header on the list pane" };
      await win.drag(this.toScreen(main, point), this.centerOf(main, target.rect), {
        steps: 20,
        whileHeld: async () => {
          const shot = this.shots.take("dock-swap-held", win.clientRect(main.hwnd));
          if (shot) shots.push(shot);
        },
      });
      await sleep(800);
      const after = await layoutOf(main.page);
      const shot = this.shots.take("dock-swap-after", win.clientRect(main.hwnd));
      if (shot) shots.push(shot);
      const movedSource = after.panes.find((pane) => pane.id === source.id);
      const swapped = !!movedSource && near(movedSource.rect.x, target.rect.x, 4) && near(movedSource.rect.y, target.rect.y, 4);
      return {
        status: swapped ? "pass" : "fail",
        detail: `the list was at ${Math.round(source.rect.x)},${Math.round(source.rect.y)}, research at ${Math.round(target.rect.x)},${Math.round(target.rect.y)}; after the drop the list is at ${movedSource ? `${Math.round(movedSource.rect.x)},${Math.round(movedSource.rect.y)}${movedSource.floating ? " (floating)" : ""}` : "nowhere"}`,
      };
    });

    await this.step("command-bar-typing", "Type in the command bar", async (shots) => {
      await this.reset(main, this.baseRect);
      const layout = await layoutOf(main.page);
      if (!layout.prompt) return { status: "fail", detail: "no command prompt in the top bar" };
      await win.click(this.centerOf(main, layout.prompt));
      await sleep(500);
      await win.typeText("aapl");
      await sleep(700);
      const typed = await layoutOf(main.page);
      const shot = this.shots.take("command-bar-typed", win.clientRect(main.hwnd));
      if (shot) shots.push(shot);
      await win.pressKeys(win.VK.escape);
      await sleep(300);
      const ok = (typed.input ?? "").toLowerCase() === "aapl";
      return { status: ok ? "pass" : "fail", detail: `the focused field (${typed.inputRole ?? "none"}) holds ${JSON.stringify(typed.input)}` };
    });

    await this.step("pop-out", "Pop a docked pane out to a new window with Ctrl+Shift+O", async (shots) => {
      await this.reset(main, this.baseRect);
      const before = new Set(this.appWindows().map((info) => info.hwnd));
      const layout = await layoutOf(main.page);
      const pane = layout.panes.find((entry) => entry.id === "attention-trending:home");
      if (!pane) return { status: "fail", detail: "the trending pane is missing" };
      // Focus it with a click on its body, then the chord.
      await win.click(this.toScreen(main, { x: pane.rect.x + pane.rect.width / 2, y: pane.rect.y + Math.min(pane.rect.height - 8, 60) }));
      await sleep(400);
      await win.pressKeys(win.VK.control, win.VK.shift, "o");
      let opened: win.WindowInfo | undefined;
      const deadline = Date.now() + 15_000;
      while (!opened && Date.now() < deadline) {
        await sleep(500);
        opened = this.appWindows().find((info) => !before.has(info.hwnd));
      }
      if (!opened) {
        const desktop = this.shots.desktop("pop-out-missing");
        if (desktop) shots.push(desktop);
        return { status: "fail", detail: "no new window opened" };
      }
      // A new window paints its page once that has loaded.
      const openedAt = Date.now();
      let colors = 0;
      while (Date.now() - openedAt < 20_000) {
        await sleep(500);
        try { colors = distinctColors(win.captureScreen(win.clientRect(opened.hwnd))); } catch { colors = 0; }
        if (colors >= 6) break;
      }
      const painted = colors >= 6 ? `painted after ${((Date.now() - openedAt) / 1000).toFixed(1)} s` : "still blank after 20 s";
      const rect = win.windowRect(opened.hwnd);
      const mainRect = win.windowRect(main.hwnd);
      const overMain = rect.left < mainRect.right && rect.right > mainRect.left && rect.top < mainRect.bottom && rect.bottom > mainRect.top;
      const shot = this.shots.take("pop-out-window", rect);
      if (shot) shots.push(shot);
      const desktop = this.shots.desktop("pop-out-desktop");
      if (desktop) shots.push(desktop);
      // Out of the way of the steps after.
      this.knownWindows.add(opened.hwnd);
      win.showWindow(opened.hwnd, "minimize");
      return {
        status: colors >= 6 ? "pass" : "fail",
        detail: `opened "${opened.title}" at ${fmt(rect)}, ${overMain ? "over" : "away from"} the main window at ${fmt(mainRect)}; ${painted}`,
      };
    });
  }

  /**
   * A popped-out window docks back into the main window when its title bar
   * comes within reach of the main window's edges. Restoring the main window
   * must not leave the app thinking the main window is somewhere else.
   */
  async detachedStaysOut(): Promise<void> {
    await this.step("detached-stays-out", "A popped-out window moved to the top of the screen stays out after the main window was maximized and restored", async (shots) => {
      const detached = this.detached;
      if (!detached?.hwnd) return { status: "fail", detail: "no popped-out window" };
      await this.reset(this.main, this.baseRect);
      await this.clickControl(this.main, "maximize");
      await this.clickControl(this.main, "maximize");
      const mainRect = win.visibleRect(this.main.hwnd);
      await this.reset(detached, this.detachedRect);
      const point = await evaluate<{ x: number; y: number } | null>(detached.page.cdp, "window.__winCheck.titleBarPoint()");
      if (!point) return { status: "fail", detail: "no bare spot on the popped-out window's title bar" };
      const work = win.monitorOf(detached.hwnd).work;
      const from = this.toScreen(detached, point);
      const now = win.windowRect(detached.hwnd);
      // Over the left part of the main window, its title bar well above the main window's top.
      const target = { left: mainRect.left + 80, top: work.top + 6 };
      await win.drag(from, { x: from.x + target.left - now.left, y: from.y + target.top - now.top }, { steps: 16 });
      await sleep(2_000);
      const desktop = this.shots.desktop("detached-stays-out");
      if (desktop) shots.push(desktop);
      if (!win.isWindow(detached.hwnd)) {
        return { status: "fail", detail: `the popped-out window docked back into the main window, whose top is ${mainRect.top - work.top - 6} px below where its title bar was dropped` };
      }
      const detail = `still its own window at ${fmt(win.windowRect(detached.hwnd))}; the main window is at ${fmt(mainRect)}`;
      // Out of the way of the main window's title bar for the steps after.
      await this.place(detached, this.detachedRect);
      return { status: "pass", detail };
    });
  }

  /** Moves the main window, closes the app with its button, opens it again. */
  async remembersFrame(): Promise<void> {
    await this.step("remembers-frame", "Main window: reopens where it was left", async (shots) => {
      await this.reset(this.main, this.baseRect);
      const point = await evaluate<{ x: number; y: number } | null>(this.main.page.cdp, "window.__winCheck.titleBarPoint()");
      if (!point) return { status: "fail", detail: "no bare spot on the title bar" };
      const from = this.toScreen(this.main, point);
      await win.drag(from, { x: from.x + 140, y: from.y + 90 }, { steps: 12 });
      await sleep(1_000);
      const moved = win.windowRect(this.main.hwnd);
      await this.clickControl(this.main, "close");
      const deadline = Date.now() + 15_000;
      while (win.isWindow(this.main.hwnd) && Date.now() < deadline) await sleep(300);
      if (win.isWindow(this.main.hwnd)) return { status: "fail", detail: "the Close button did not close the app" };
      const closedAt = Date.now();
      this.pastErrors.push(...this.main.page.errors);
      for (const window of [this.main, this.detached]) window?.page.cdp.close();
      // Opening the app again only works once the last one has exited.
      const exited = await Promise.race([this.launcher!.exited.then(() => true), sleep(90_000).then(() => false)]);
      const exitDetail = exited ? `exited ${((Date.now() - closedAt) / 1000).toFixed(1)} s after its window closed` : "still running 90 s after its window closed";
      if (!exited) Bun.spawnSync(["taskkill", "/PID", String(this.launcher!.pid), "/T", "/F"]);
      const saved = await readFile(join(this.profile, "desktop-window.json"), "utf8").catch(() => "(none)");
      this.launches += 1;
      await this.launch(this.profile);
      await sleep(1_000);
      const reopened = win.windowRect(this.main.hwnd);
      const shot = this.shots.desktop("remembers-frame-reopened");
      if (shot) shots.push(shot);
      const same = (["left", "top", "right", "bottom"] as const).every((side) => near(reopened[side], moved[side], 4));
      return {
        status: same ? "pass" : "fail",
        detail: `moved to ${fmt(moved)}, closed with its button, reopened at ${fmt(reopened)}; the app ${exitDetail}; it saved ${saved.trim()}`,
      };
    });
  }

  /** Closes the app with its button and opens it again two seconds later, as someone restarting it does. */
  async reopenRightAway(): Promise<void> {
    await this.step("reopen-right-away", "Close with the window button and open again two seconds later", async (shots) => {
      await this.reset(this.main, this.baseRect);
      await this.clickControl(this.main, "close");
      const deadline = Date.now() + 15_000;
      while (win.isWindow(this.main.hwnd) && Date.now() < deadline) await sleep(200);
      if (win.isWindow(this.main.hwnd)) return { status: "fail", detail: "the Close button did not close the app" };
      for (const window of [this.main, this.detached]) window?.page.cdp.close();
      const previous = this.launcher!;
      await sleep(2_000);
      const stillRunning = previous.exitCode === null;
      this.launches += 1;
      let opened = true;
      let failure = "";
      try {
        await this.launch(this.profile, 45_000);
      } catch (error) {
        opened = false;
        failure = error instanceof Error ? error.message : String(error);
      }
      const desktop = this.shots.desktop("reopened-right-away");
      if (desktop) shots.push(desktop);
      const log = await readFile(join(this.out, `app-stdout-${this.launches}.log`), "utf8").catch(() => "");
      const crashLog = await readFile(join(this.out, `app-stderr-${this.launches}.log`), "utf8").catch(() => "");
      const signs = [
        log.includes("Failed to initialize CEF") ? "CEF failed to start" : "",
        log.includes("Opening in existing browser session") ? "Chromium handed off to the closing app" : "",
        /panic|Segmentation fault/.test(crashLog) ? "the new app crashed" : "",
      ].filter(Boolean);
      if (!opened) {
        await this.close();
        const exited = await Promise.race([previous.exited.then(() => true), sleep(60_000).then(() => false)]);
        if (!exited) Bun.spawnSync(["taskkill", "/PID", String(previous.pid), "/T", "/F"]);
      }
      return {
        status: opened ? "pass" : "fail",
        detail: `the closed app was ${stillRunning ? "still running" : "gone"} 2 s after its window closed; ${opened ? "the app opened again" : `no window: ${failure.slice(0, 160)}`}${signs.length ? `; ${signs.join(", ")}` : ""}`,
      };
    });
  }

  async detachedSteps(): Promise<void> {
    const window = this.detached;
    if (!window?.hwnd) return;
    await this.step("detached-move", "Popped-out window: move by its title bar", async (shots) => {
      await this.reset(window, this.detachedRect);
      const point = await evaluate<{ x: number; y: number } | null>(window.page.cdp, "window.__winCheck.titleBarPoint()");
      if (!point) return { status: "fail", detail: "no bare spot on the title bar" };
      const before = win.visibleRect(window.hwnd);
      const from = this.toScreen(window, point);
      const delta = { x: -90, y: 70 };
      let during: Rect | null = null;
      await win.drag(from, { x: from.x + delta.x, y: from.y + delta.y }, {
        whileHeld: async () => { during = win.visibleRect(window.hwnd); },
      });
      await sleep(700);
      const after = win.visibleRect(window.hwnd);
      const fills = await this.contentFills(window, "detached-moved", shots);
      const ok = near(after.left, before.left + delta.x, 4) && near(after.top, before.top + delta.y, 4) && win.rectWidth(after) === win.rectWidth(before);
      const duringRect = during as Rect | null;
      return { status: ok && fills.ok ? "pass" : "fail", detail: `${fmt(before)} -> ${fmt(after)} for a ${delta.x},${delta.y} drag${duringRect ? `, mid-drag ${fmt(duringRect)}` : ""}; ${fills.detail}` };
    });
    await this.windowSteps(window, "detached", this.detachedRect);
  }

  async finish(): Promise<void> {
    await this.step("alive", "The app is still running, with no page errors", async () => {
      const alive = win.isWindow(this.main.hwnd);
      const errors = [...this.pastErrors, ...await this.pageErrors()];
      this.pastErrors = errors;
      await writeFile(join(this.out, "page-errors.txt"), errors.join("\n"));
      return {
        status: alive ? (errors.length ? "info" : "pass") : "fail",
        detail: `${alive ? "the main window is open" : "the main window is gone"} after ${this.launches} launch(es); ${errors.length} page error(s)${errors.length ? `, first: ${errors[0]!.slice(0, 300)}` : ""}`,
      };
    });
  }

  async pageErrors(): Promise<string[]> {
    const errors: string[] = [];
    for (const window of [this.main, this.detached]) {
      if (!window) continue;
      errors.push(...window.page.errors.map((error) => `${window.title}: ${error}`));
      window.page.errors.length = 0;
      if (!window.hwnd || !win.isWindow(window.hwnd)) continue;
      const pageErrors = await evaluate<string[]>(window.page.cdp, "window.__winCheck.state.errors.splice(0)", 3_000).catch(() => []);
      errors.push(...pageErrors.map((error) => `${window.title}: ${error}`));
    }
    return errors;
  }

  /** Stops the app this run started, if it is still running. */
  async close(): Promise<void> {
    if (!this.launcher) return;
    this.pastErrors.push(...await this.pageErrors());
    for (const window of [this.main, this.detached]) window?.page.cdp.close();
    const pids = new Set(win.topLevelWindows().filter((info) => info.className === "BasicWindowClass" && (!this.knownWindows.has(info.hwnd) || info.hwnd === this.main?.hwnd || info.hwnd === this.detached?.hwnd)).map((info) => info.pid));
    // The launcher's tree holds the app's Bun process even once its windows are gone.
    Bun.spawnSync(["taskkill", "/PID", String(this.launcher.pid), "/T", "/F"]);
    this.launcher.kill();
    for (const pid of pids) Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]);
    this.launcher = null;
    await sleep(1_500);
  }
}

/** The app's taskbar button, through UI Automation. */
async function taskbarButton(title: string): Promise<Point | null> {
  const script = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "Shell_TrayWnd")
$tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if (-not $tray) { exit 0 }
$buttons = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($button in $buttons) {
  $name = $button.Current.Name
  if ($name -and $name -like "*${title.replace(/"/g, "")}*") {
    $rect = $button.Current.BoundingRectangle
    if (-not $rect.IsEmpty) { Write-Output ("{0},{1}" -f [int]($rect.Left + $rect.Width / 2), [int]($rect.Top + $rect.Height / 2)); exit 0 }
  }
}
`;
  const child = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30_000 });
  const match = child.stdout.toString().trim().match(/^(\d+),(\d+)/m);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

async function run(): Promise<void> {
  const app = resolve(required("app"));
  const out = resolve(required("out"));
  const label = option("label") ?? "app";
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "shots"), { recursive: true });
  const display = win.primaryMonitor();
  const runner = new Run(app, out, option("only"));
  // The windows start from the same place for every step: the main window
  // on the left of the work area, the popped-out one clear of it on the
  // right. The main window sits well below the top: a popped-out window
  // whose title bar comes within 72 px of its edges docks back into it, and
  // a popped-out window snapped or maximized has its title bar at the top.
  const work = display.work;
  const workWidth = win.rectWidth(work);
  const workHeight = win.rectHeight(work);
  const mainWidth = Math.round(workWidth * 0.56);
  const mainTop = work.top + Math.round(workHeight * 0.17);
  runner.baseRect = { left: work.left + 60, top: mainTop, right: work.left + 60 + mainWidth, bottom: mainTop + Math.round(workHeight * 0.7) };
  const detachedWidth = Math.min(Math.round(workWidth * 0.3), workWidth - mainWidth - 160);
  runner.detachedRect = {
    left: work.right - detachedWidth - 40, top: work.top + Math.round(workHeight * 0.3),
    right: work.right - 40, bottom: work.top + Math.round(workHeight * 0.8),
  };
  const started = new Date().toISOString();
  let fatal: string | null = null;
  try {
    // First the popped-out window, while the main window has not been resized.
    await runner.start(null);
    await runner.calibrate();
    await runner.detachedSteps();
    // Then the main window, the panes and the window's memory, on a fresh app.
    await runner.start(null);
    await runner.detachedStaysOut();
    await runner.windowSteps(runner.main, "main", runner.baseRect);
    await runner.paneSteps();
    await runner.finish();
    await runner.reopenRightAway();
    await runner.ensure(runner.main);
    await runner.remembersFrame();
  } catch (error) {
    fatal = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(fatal);
    const shot = runner.shots.desktop("fatal");
    await runner.shots.flush();
    runner.record({ id: "run", title: "The run", status: "fail", detail: `stopped: ${fatal.split("\n")[0]}`, shots: shot ? [shot] : [], ms: 0 });
  } finally {
    await runner.close();
  }
  const version = await readFile(join(app, "Resources", "version.json"), "utf8").then((text) => JSON.parse(text.replace(/^\uFEFF/, "")).version as string).catch(() => "unknown");
  const result: CheckRun = {
    label,
    version,
    started,
    scale: Math.round((display.dpi * 100) / 96),
    screen: `${win.rectWidth(display.monitor)}x${win.rectHeight(display.monitor)}`,
    results: runner.results,
    fatal,
  };
  await writeFile(join(out, "results.json"), JSON.stringify(result, null, 2));
  for (let launch = 1; launch <= runner.launches; launch += 1) {
    await rm(join(out, "..", `profile-${basename(out)}-${launch}`), { recursive: true, force: true }).catch(() => {});
  }
  console.log(`${runner.results.filter((entry) => entry.status === "fail").length} of ${runner.results.length} checks failed; results in ${out}`);
}

if (COMMAND === "install") await install(resolve(required("installer")), resolve(required("dir")));
else if (COMMAND === "run") await run();
else {
  console.error("Usage: check.ts install --installer <GloomSetup.exe> --dir <dir> | run --app <dir> --out <dir> [--label <name>] [--only <text>]");
  process.exit(2);
}
