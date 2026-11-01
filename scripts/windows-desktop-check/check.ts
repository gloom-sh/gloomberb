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

/**
 * A release opens no DevTools port; the check drives the page through one,
 * so it opens it again in its own install, after `ports` has looked at the
 * build as shipped.
 */
async function enableDevtools(dir: string): Promise<void> {
  const buildPath = join(dir, "Resources", "build.json");
  const build = JSON.parse((await readFile(buildPath, "utf8")).replace(/^\uFEFF/, "")) as { chromiumFlags?: Record<string, unknown> };
  const flags = { ...build.chromiumFlags };
  delete flags["remote-debugging-port"];
  delete flags["remote-allow-origins"];
  if (Object.keys(flags).length) build.chromiumFlags = flags;
  else delete build.chromiumFlags;
  await writeFile(buildPath, JSON.stringify(build));
  console.log(`DevTools port open for the check (Chromium flags now ${JSON.stringify(build.chromiumFlags ?? {})})`);
}

/** The TCP ports a process and everything it started listen on. */
function listeningSockets(rootPid: number): Array<{ address: string; port: number; process: string }> {
  const script = String.raw`
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$ids = @(${rootPid})
do {
  $added = @($all | Where-Object { $ids -contains $_.ParentProcessId -and -not ($ids -contains $_.ProcessId) } | ForEach-Object { $_.ProcessId })
  $ids += $added
} while ($added.Count -gt 0)
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object {
  $owner = $_.OwningProcess
  $name = ($all | Where-Object { $_.ProcessId -eq $owner } | Select-Object -First 1).Name
  Write-Output ("{0}|{1}|{2}" -f $_.LocalAddress, $_.LocalPort, $name)
}
`;
  const child = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 60_000 });
  return child.stdout.toString().split(/\r?\n/).filter(Boolean).map((line) => {
    const [address, port, name] = line.trim().split("|");
    return { address: address!, port: Number(port), process: name ?? "" };
  });
}

/** Lets the Task Scheduler keep its own log, which says what a restart task did. */
function keepTaskSchedulerLog(): void {
  Bun.spawnSync(["wevtutil", "sl", "Microsoft-Windows-TaskScheduler/Operational", "/e:true"], { timeout: 30_000 });
}

/**
 * Ends a restart the app scheduled and every process run from the app's
 * folder: an app a restart opens after a run holds Chromium's profile, and the
 * next run's app then exits as it opens. Returns what it stopped.
 */
function stopApp(app: string): string[] {
  const script = String.raw`
$ErrorActionPreference = 'Continue'
$App = $env:GLOOM_CHECK_APP.TrimEnd([char]92) + [char]92
# The script first, so it cannot open the app once the app is gone.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.ProcessId -ne $PID -and ([string]$_.CommandLine) -like '*gloom-restart-*' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  'stopped the restart script ' + $_.ProcessId
}
Get-ScheduledTask -TaskName 'GloomRestart-*' -ErrorAction SilentlyContinue | ForEach-Object {
  Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue
  'removed the task ' + $_.TaskName
}
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($App, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  'stopped ' + $_.Name + ' ' + $_.ProcessId
}
`;
  const child = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, GLOOM_CHECK_APP: app }, timeout: 60_000 });
  return child.stdout.toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * Why a restart brought no window back: the restart task as the Task Scheduler
 * has it and what its log says it did, the restart script's own log, and the
 * app's processes and the shells around them, with the session each runs in.
 */
async function restartReport(out: string, oldPid: number): Promise<string> {
  const script = String.raw`
$ErrorActionPreference = 'Continue'
"this check runs in session " + (Get-Process -Id $PID).SessionId
"the old app (" + ${oldPid} + ") is " + $(if (Get-Process -Id ${oldPid} -ErrorAction SilentlyContinue) { 'still running' } else { 'gone' })
$query = schtasks /Query /TN "GloomRestart-${oldPid}" /V /FO LIST 2>&1
"task: " + (($query | Where-Object { $_ -match '^(Status|Last Run Time|Last Result|Task To Run|ERROR)' } | ForEach-Object { ([string]$_).Trim() }) -join ' | ')
$log = Join-Path $env:TEMP "gloom-restart-${oldPid}.log"
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log | ForEach-Object { "script: " + $_ } } else { "script: no log at " + $log }
Get-WinEvent -LogName Microsoft-Windows-TaskScheduler/Operational -MaxEvents 200 -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -like '*GloomRestart*' } | Sort-Object TimeCreated | ForEach-Object {
    "event {0:HH:mm:ss} {1}: {2}" -f $_.TimeCreated, $_.Id, ($_.Message -replace '\s+', ' ')
  }
Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='launcher.exe' OR Name='powershell.exe'" | ForEach-Object {
  $line = [string]$_.CommandLine
  if ($line.Length -gt 200) { $line = $line.Substring(0, 200) + '...' }
  "process {0} {1} (parent {2}, session {3}): {4}" -f $_.Name, $_.ProcessId, $_.ParentProcessId, $_.SessionId, $line
}
`;
  const path = join(out, "restart-report.ps1");
  await writeFile(path, script);
  const child = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-File", path], { timeout: 120_000 });
  const lines = `${child.stdout.toString()}\n${child.stderr.toString()}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (child.exitCode !== 0) lines.push(`the report exited ${child.exitCode ?? "on its timeout"}`);
  const windows = win.topLevelWindows().filter((info) => info.className === "BasicWindowClass")
    .map((info) => `window "${info.title}" of ${info.pid}, ${info.visible ? "visible" : "hidden"}`);
  return [...lines, ...(windows.length ? windows : ["no app window on this desktop, hidden or not"])].join("; ");
}

/**
 * Starts the app as installed, before the check opens anything up, and lists
 * what it listens on: only this machine (127.0.0.1, ::1) may reach it. A
 * listener on every interface is what makes Windows Firewall ask on first launch.
 */
async function ports(app: string, out: string, label: string): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "shots"), { recursive: true });
  const profile = join(out, "..", `profile-${basename(out)}`);
  await seedProfile(profile, { main: { x: 60, y: 120, width: 1100, height: 720 }, detached: { x: 1200, y: 200, width: 600, height: 480 } });
  const known = new Set(win.topLevelWindows().map((info) => info.hwnd));
  const bin = join(app, "bin");
  const started = new Date().toISOString();
  const launcher = Bun.spawn([join(bin, "launcher.exe")], {
    cwd: bin,
    env: { ...process.env, GLOOMBERB_HOME: profile, ELECTROBUN_CONSOLE: "1", DO_NOT_TRACK: "1", GLOOMBERB_NO_TELEMETRY: "1" },
    stdout: Bun.file(join(out, "app-stdout.log")),
    stderr: Bun.file(join(out, "app-stderr.log")),
  });
  // Every server is up once the main window's page has loaded.
  await sleep(25_000);
  const sockets = listeningSockets(launcher.pid);
  const newWindows = win.topLevelWindows().filter((info) => info.visible && !known.has(info.hwnd));
  const prompts = newWindows.filter((info) => info.className !== "BasicWindowClass").map((info) => `"${info.title}" (${info.className})`);
  const shots = new Shots(join(out, "shots"));
  const shot = shots.desktop("as-shipped");
  await shots.flush();
  Bun.spawnSync(["taskkill", "/PID", String(launcher.pid), "/T", "/F"]);
  await sleep(1_500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  const loopback = (address: string) => address === "127.0.0.1" || address === "::1";
  const open = sockets.filter((socket) => !loopback(socket.address));
  const devtools = sockets.filter((socket) => socket.port >= 9222 && socket.port <= 9232);
  const list = sockets.map((socket) => `${socket.address}:${socket.port} (${socket.process})`).join(", ") || "nothing";
  const results: CheckResult[] = [
    {
      id: "listens-locally",
      title: "As shipped, it listens only on this machine",
      status: !sockets.length ? "fail" : open.length ? "fail" : "pass",
      detail: !sockets.length ? "found no listening socket at all, so nothing was checked" : `${open.length ? `${open.length} on every interface or the network; ` : ""}listening on ${list}${prompts.length ? `; other windows: ${prompts.join(", ")}` : ""}`,
      shots: shot ? [shot] : [],
      ms: 25_000,
    },
    {
      id: "no-devtools-port",
      title: "As shipped, no DevTools port",
      status: devtools.length ? "fail" : "pass",
      detail: devtools.length ? `DevTools on ${devtools.map((socket) => `${socket.address}:${socket.port}`).join(", ")}` : "none in 9222-9232",
      shots: [],
      ms: 0,
    },
  ];
  // The names Windows shows for the processes, in Task Manager and its prompts.
  const named = ["bun.exe", "launcher.exe"].map((exe) => {
    const child = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command",
      `(Get-Item -LiteralPath '${join(bin, exe).replace(/'/g, "''")}').VersionInfo | Select-Object FileDescription, ProductName, CompanyName, ProductVersion | ConvertTo-Json -Compress`], { timeout: 30_000 });
    const info = (() => { try { return JSON.parse(child.stdout.toString()) as Record<string, string | null>; } catch { return {}; } })();
    return { exe, info };
  });
  results.push({
    id: "exe-names",
    title: "Windows names the app's processes Gloom",
    // The runtime is the app's process, the one Windows names in Task Manager
    // and its prompts; Electrobun's launcher carries no version details at all.
    status: named.filter(({ exe }) => exe === "bun.exe").every(({ info }) => /gloom/i.test(info.FileDescription ?? "") && !/oven/i.test(info.CompanyName ?? "")) ? "pass" : "fail",
    detail: named.map(({ exe, info }) => `${exe}: "${info.FileDescription ?? ""}" by "${info.CompanyName ?? ""}", ${info.ProductName ?? ""} ${info.ProductVersion ?? ""}`).join("; "),
    shots: [],
    ms: 0,
  });
  const display = win.primaryMonitor();
  const version = await readFile(join(app, "Resources", "version.json"), "utf8").then((text) => JSON.parse(text.replace(/^\uFEFF/, "")).version as string).catch(() => "unknown");
  const result: CheckRun = {
    label: `${label} as shipped`, version, started,
    scale: Math.round((display.dpi * 100) / 96),
    screen: `${win.rectWidth(display.monitor)}x${win.rectHeight(display.monitor)}`,
    results, fatal: null,
  };
  await writeFile(join(out, "results.json"), JSON.stringify(result, null, 2));
  for (const entry of results) console.log(`${entry.status.toUpperCase().padEnd(5)} ${entry.id}: ${entry.detail}`);
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
  // What the page was pressed with, to say what opened something it should not have.
  const inputs = [];
  const describe = (el) => {
    const named = el && el.closest ? el.closest("[data-gloom-role], [aria-label]") : null;
    if (!named) return el && el.tagName ? el.tagName.toLowerCase() : "page";
    const label = named.getAttribute("aria-label");
    return (named.getAttribute("data-gloom-role") || named.tagName.toLowerCase()) + (label ? ' "' + label + '"' : "");
  };
  const note = (e) => {
    inputs.push({ at: Date.now(), type: e.type, x: Math.round(e.clientX || 0), y: Math.round(e.clientY || 0), detail: e.detail || 0, key: e.key || "", ctrl: !!e.ctrlKey, target: describe(e.target) });
    if (inputs.length > 80) inputs.shift();
  };
  for (const type of ["mousedown", "mouseup", "keydown"]) addEventListener(type, note, true);
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
    inputsSince(at) { return inputs.filter((entry) => entry.at >= at); },
    /** The command prompt in the top bar holds its field while the command bar is open. */
    commandBarOpen() { return !!q("[data-gloom-role=header-command-prompt] input, [data-gloom-role=header-command-prompt] textarea"); },
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
    /**
     * A point on a docked pane's body that nothing covers, such as a floating
     * pane, and that takes no typing, which would keep a shortcut from the app.
     */
    panePoint(id) {
      const pane = [...document.querySelectorAll("[data-gloom-role=pane-window]")].find((el) => el.getAttribute("data-gloom-pane-id") === id);
      if (!pane) return null;
      const r = pane.getBoundingClientRect();
      const title = pane.querySelector("[data-gloom-role=pane-title]");
      const top = title ? title.getBoundingClientRect().bottom + 12 : r.top + 32;
      for (let y = top; y < r.bottom - 12; y += 12) {
        for (let x = r.left + 16; x < r.right - 16; x += 24) {
          const hit = document.elementFromPoint(x, y);
          if (hit && pane.contains(hit) && !hit.closest("input, textarea, [contenteditable=true], button, a, [role=button]")) return { x, y };
        }
      }
      return null;
    },
    /** A point on the tallest vertical dock divider that nothing covers, such as a floating pane. */
    dividerPoint() {
      const dividers = [...document.querySelectorAll("[data-gloom-role=dock-divider]")]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.height > r.width)
        .sort((a, b) => b.r.height - a.r.height);
      const divider = dividers[0];
      if (!divider) return null;
      const x = divider.r.left + divider.r.width / 2;
      for (let y = divider.r.bottom - 24; y > divider.r.top + 24; y -= 8) {
        const hit = document.elementFromPoint(x, y);
        if (hit && divider.el.contains(hit)) return { x, y };
      }
      return null;
    },
    /**
     * The cells of the drop grid shown over a docked pane while another pane
     * is dragged over it. They carry no name: absolute boxes, the center one
     * stacked above the rest.
     */
    dropGrid() {
      return [...document.querySelectorAll("div")]
        .filter((el) => el.style.position === "absolute" && (el.style.zIndex === "97" || el.style.zIndex === "98"))
        .map((el) => ({ center: el.style.zIndex === "98", r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.width < 400 && r.height < 400)
        .map(({ center, r }) => ({ center, x: r.left, y: r.top, width: r.width, height: r.height }));
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

/** A press or key the page saw, as `inputsSince` lists them. */
interface PageInput { at: number; type: string; x: number; y: number; detail: number; key: string; ctrl: boolean; target: string }

const inputsSince = (page: Page, since: number) =>
  evaluate<PageInput[]>(page.cdp, `window.__winCheck.inputsSince(${since})`, 3_000).catch((): PageInput[] => []);

/** The last presses and keys a page saw, for a report. */
function describeInputs(inputs: PageInput[], since: number): string {
  const said = inputs.slice(-12).map((entry) => entry.type === "keydown"
    ? `+${((entry.at - since) / 1000).toFixed(2)}s key ${entry.ctrl ? "Ctrl+" : ""}${entry.key} on ${entry.target}`
    : `+${((entry.at - since) / 1000).toFixed(2)}s ${entry.type} ${entry.detail} at ${entry.x},${entry.y} on ${entry.target}`);
  return said.length ? said.join(", ") : "no press or key";
}

// --- Pictures --------------------------------------------------------------

class Shots {
  private pending: Array<{ path: string; bitmap: Bitmap }> = [];
  private count = 0;

  constructor(private readonly dir: string) {}

  /**
   * Grabs the screen in `rect` now; the file is written by flush(). Returns its
   * name. A `zoom` above 1 blows every pixel up into a square, for looking at
   * a frame's edge pixel by pixel.
   */
  take(label: string, rect: Rect, zoom = 1): string | null {
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
    if (zoom > 1) bitmap = enlarge(bitmap, zoom);
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

function enlarge(bitmap: Bitmap, zoom: number): Bitmap {
  const width = bitmap.width * zoom;
  const height = bitmap.height * zoom;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = Math.floor(y / zoom) * bitmap.width;
    for (let x = 0; x < width; x += 1) {
      bitmap.data.copy(data, (y * width + x) * 4, (sourceRow + Math.floor(x / zoom)) * 4, (sourceRow + Math.floor(x / zoom)) * 4 + 4);
    }
  }
  return { width, height, data };
}

function pixel(bitmap: Bitmap, x: number, y: number): [number, number, number] {
  const offset = (y * bitmap.width + x) * 4;
  return [bitmap.data[offset]!, bitmap.data[offset + 1]!, bitmap.data[offset + 2]!];
}

const hex = (rgb: [number, number, number]) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
const colorDistance = (a: [number, number, number], b: [number, number, number]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** The color most of a row holds, and how much of the row holds it. */
function rowColor(bitmap: Bitmap, y: number, from = 0, to = bitmap.width): { color: [number, number, number]; share: number } {
  const counts = new Map<number, number>();
  let total = 0;
  for (let x = from; x < to; x += 1) {
    const [r, g, b] = pixel(bitmap, x, y);
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  let best = 0, bestCount = 0;
  for (const [key, count] of counts) if (count > bestCount) { best = key; bestCount = count; }
  return { color: [(best >> 16) & 255, (best >> 8) & 255, best & 255], share: total ? bestCount / total : 0 };
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

/** The picture's commonest color and its share: a page that never loaded is one flat white. */
function commonestColor(bitmap: Bitmap): { color: number; share: number } {
  const counts = new Map<number, number>();
  let total = 0;
  for (let y = 0; y < bitmap.height; y += 2) {
    for (let x = 0; x < bitmap.width; x += 2) {
      const offset = (y * bitmap.width + x) * 4;
      const color = (bitmap.data[offset]! << 16) | (bitmap.data[offset + 1]! << 8) | bitmap.data[offset + 2]!;
      counts.set(color, (counts.get(color) ?? 0) + 1);
      total += 1;
    }
  }
  let color = 0;
  let most = 0;
  for (const [value, count] of counts) if (count > most) { color = value; most = count; }
  return { color, share: total ? most / total : 1 };
}

const isLight = (color: number) => ((color >> 16) & 0xff) > 230 && ((color >> 8) & 0xff) > 230 && (color & 0xff) > 230;

/**
 * Waits for a new window to paint its page. Before it does, it can show what
 * was behind it for a moment, so its page counts as drawn once two looks a
 * second apart agree.
 */
async function waitForPaint(hwnd: number, timeoutMs = 20_000): Promise<{ drawn: boolean; said: string }> {
  const openedAt = Date.now();
  let colors = 0;
  let drawnLooks = 0;
  let commonest = { color: 0xffffff, share: 1 };
  while (Date.now() - openedAt < timeoutMs && drawnLooks < 2) {
    await sleep(1_000);
    try {
      const bitmap = win.captureScreen(win.clientRect(hwnd));
      colors = distinctColors(bitmap);
      commonest = commonestColor(bitmap);
    } catch { colors = 0; commonest = { color: 0xffffff, share: 1 }; }
    const blank = commonest.share > 0.97 && isLight(commonest.color);
    drawnLooks = colors >= 6 && !blank ? drawnLooks + 1 : 0;
  }
  const drawn = drawnLooks >= 2;
  return {
    drawn,
    said: drawn
      ? `painted after ${((Date.now() - openedAt) / 1000).toFixed(1)} s`
      : `still blank after ${timeoutMs / 1000} s (${Math.round(commonest.share * 100)}% #${commonest.color.toString(16).padStart(6, "0")})`,
  };
}

// --- The run ---------------------------------------------------------------

const RESIZE_CURSORS: Record<string, string> = {
  left: "resize-ew", right: "resize-ew", top: "resize-ns", bottom: "resize-ns",
  "top-left": "resize-nwse", "bottom-right": "resize-nwse", "top-right": "resize-nesw", "bottom-left": "resize-nesw",
};

type Edge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

const fmt = (rect: Rect) => `${rect.left},${rect.top} ${win.rectWidth(rect)}x${win.rectHeight(rect)}`;
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
/** Rounds of maximizing and restoring a window each way, in the cycles step. */
const MAXIMIZE_ROUNDS = 4;

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
  /** Chromium GPU process exits already reported, by launch. */
  gpuExitsSeen = new Map<number, number>();
  /** Windows reported with a native title bar, by launch and window, until it goes. */
  captionsSeen = new Set<string>();

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
    // Its own result, not on the known list even where the step is.
    const barShots: string[] = [];
    const opened = id === "command-bar-typing" ? null : await this.commandBarOpenedSince(started, id, barShots);
    const gpuExit = await this.gpuProcessExited();
    const captionShots: string[] = [];
    const captions = this.captionsAfter(id, captionShots);
    await this.shots.flush();
    this.record({ id, title, ...outcome, shots, ms: Date.now() - started });
    if (opened) this.record({ id: `${id}-opened-command-bar`, title: `${title}: the command bar stays closed`, status: "fail", detail: opened, shots: barShots, ms: 0 });
    if (captions.length) this.record({ id: `${id}-native-caption`, title: `${title}: no native title bar over the page`, status: "fail", detail: captions.join("; "), shots: captionShots, ms: 0 });
    if (gpuExit) this.record({ id: `${id}-gpu-process-exited`, title: `${title}: Chromium's GPU process keeps running`, status: "fail", detail: gpuExit, shots: [], ms: 0 });
    return outcome.status;
  }

  /**
   * A native title bar on a window that draws its own: Windows then keeps a
   * caption's height between the top of the frame (of the work area, when
   * maximized) and the page. Null without one.
   */
  nativeCaption(window: AppWindow | null): string | null {
    if (!window?.hwnd || !win.isWindow(window.hwnd) || win.isMinimized(window.hwnd)) return null;
    const client = win.clientRect(window.hwnd);
    let where: string;
    if (win.isMaximized(window.hwnd)) {
      const work = win.monitorOf(window.hwnd).work;
      const gap = client.top - work.top;
      if (gap <= 2) return null;
      where = `maximized, its page starts ${gap} px below the top of the work area (page ${fmt(client)}, work area ${fmt(work)})`;
    } else {
      const frame = win.visibleRect(window.hwnd);
      const border = Math.max(1, Math.min(client.left - frame.left, frame.right - client.right));
      const gap = client.top - frame.top;
      if (gap <= border + 2) return null;
      where = `a ${gap} px gap between the top of the frame and the page, ${border} px at the sides (frame ${fmt(frame)}, page ${fmt(client)})`;
    }
    const style = win.windowStyle(window.hwnd);
    const procedures = win.windowProcedures(window.hwnd);
    return `${where}; style ${style.flags.join(" ") || style.value}; window data ${win.hasWindowData(window.hwnd) ? "set" : "gone"}; window procedure ${procedures.window}, its class's ${procedures.windowClass}${win.isHung(window.hwnd) ? "; not responding" : ""}`;
  }

  /** The windows that came out of a step with a native title bar, each once until it goes. */
  captionsAfter(id: string, shots: string[]): string[] {
    const found: string[] = [];
    for (const window of [this.main, this.detached]) {
      if (!window?.hwnd) continue;
      const key = `${this.launches}:${window.hwnd}`;
      try {
        const caption = this.nativeCaption(window);
        if (!caption) {
          this.captionsSeen.delete(key);
          continue;
        }
        if (this.captionsSeen.has(key)) continue;
        this.captionsSeen.add(key);
        found.push(`${window === this.main ? "main window" : `"${window.title}"`}: ${caption}`);
        const frame = win.visibleRect(window.hwnd);
        const shot = this.shots.take(`${id}-native-caption`, { left: frame.left - 8, top: frame.top - 8, right: frame.right + 8, bottom: frame.top + Math.round(90 * window.scale) });
        if (shot) shots.push(shot);
      } catch {
        // The window closed while it was read.
      }
    }
    return found;
  }

  /**
   * Chromium's GPU process exiting under the app since the last step, as its
   * log says. The windows can come out of it changed, so what the steps after
   * it find in this launch reads against it.
   */
  async gpuProcessExited(): Promise<string | null> {
    const log = await readFile(join(this.out, `app-stderr-${this.launches}.log`), "utf8").catch(() => "");
    const exits = log.split(/\r?\n/).filter((line) => line.includes("GPU process exited unexpectedly"));
    const seen = this.gpuExitsSeen.get(this.launches) ?? 0;
    if (exits.length <= seen) return null;
    this.gpuExitsSeen.set(this.launches, exits.length);
    return `during this step, in launch ${this.launches}: ${exits.slice(seen).map((line) => line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 200)).join("; ")}`;
  }

  /**
   * Nothing but the command bar's own step opens it. When one did, says what
   * the page was pressed with and closes it, so the next step starts as usual.
   */
  async commandBarOpenedSince(since: number, id: string, shots: string[]): Promise<string | null> {
    const main = this.main;
    if (!main || !win.isWindow(main.hwnd)) return null;
    const open = await evaluate<boolean>(main.page.cdp, "window.__winCheck.commandBarOpen()", 3_000).catch(() => false);
    if (!open) return null;
    const inputs = await inputsSince(main.page, since);
    const shot = this.shots.take(`${id}-command-bar-open`, win.clientRect(main.hwnd));
    if (shot) shots.push(shot);
    await this.focus(main);
    await win.pressKeys(win.VK.escape);
    await sleep(300);
    return `the command bar opened during this step; the main page saw: ${describeInputs(inputs, since)}`;
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
    // Read before the windows are placed: placing one makes Windows lay out its frame again.
    const shots: string[] = [];
    const captions = this.captionsAfter(`launch-${this.launches}`, shots);
    if (captions.length) this.record({ id: "launch-native-caption", title: "The windows open with no native title bar over the page", status: "fail", detail: `launch ${this.launches}: ${captions.join("; ")}`, shots, ms: 0 });
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
    const now = win.visibleRect(window.hwnd);
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
  async resizeEdge(window: AppWindow, name: string, edge: Edge, requested: Point, start: Rect): Promise<void> {
    await this.step(`${name}-resize-${edge}`, `${name === "main" ? "Main window" : "Popped-out window"}: resize from the ${edge.replace("-", " ")} ${edge.includes("-") ? "corner" : "edge"}`, async (shots) => {
      await this.reset(window, start);
      const before = win.visibleRect(window.hwnd);
      const grab = await this.grabPoint(window, edge);
      // The pointer stops at the screen's edge, and so does the drag.
      const screen = win.monitorOf(window.hwnd).monitor;
      const to = {
        x: Math.max(screen.left + 2, Math.min(screen.right - 3, grab.point.x + requested.x)),
        y: Math.max(screen.top + 2, Math.min(screen.bottom - 3, grab.point.y + requested.y)),
      };
      const delta = { x: to.x - grab.point.x, y: to.y - grab.point.y };
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

  /** Pictures the frame's corners, edges and buttons up close, from outside the window in. */
  frameCrops(window: AppWindow, label: string, shots: string[]): void {
    const frame = win.visibleRect(window.hwnd);
    const size = Math.round(36 * (win.windowDpi(window.hwnd).dpi / 96));
    const outside = Math.round(size / 3);
    const corner = (name: string, x: number, y: number) => {
      const rect = { left: x - outside, top: y - outside, right: x - outside + size, bottom: y - outside + size };
      const shot = this.shots.take(`${label}-${name}`, rect, 6);
      if (shot) shots.push(shot);
    };
    corner("top-left", frame.left, frame.top);
    corner("bottom-left", frame.left, frame.bottom - size + 2 * outside);
    corner("bottom-right", frame.right - size + 2 * outside, frame.bottom - size + 2 * outside);
    const buttons = { left: frame.right - Math.round(170 * window.scale), top: frame.top - outside, right: frame.right + outside, bottom: frame.top + Math.round(40 * window.scale) };
    const shot = this.shots.take(`${label}-buttons`, buttons, 3);
    if (shot) shots.push(shot);
  }

  /** Reads the frame: how far the page is from the window's edges, and what the top rows hold. */
  async frameReading(window: AppWindow): Promise<{ problems: string[]; facts: string[] }> {
    const frame = win.visibleRect(window.hwnd);
    const client = win.clientRect(window.hwnd);
    const problems: string[] = [];
    const facts: string[] = [];
    const insets = { left: client.left - frame.left, top: client.top - frame.top, right: frame.right - client.right, bottom: frame.bottom - client.bottom };
    facts.push(`frame ${fmt(frame)}, page ${fmt(client)}, insets ${insets.left}/${insets.top}/${insets.right}/${insets.bottom} px`);
    for (const [side, inset] of Object.entries(insets)) {
      if (inset > 2) problems.push(`a ${inset} px gap between the ${side} edge of the frame and the page`);
      if (inset < -1) problems.push(`the page runs ${-inset} px past the ${side} edge of the frame`);
    }
    const style = win.windowStyle(window.hwnd);
    facts.push(`style ${style.flags.join(" ") || style.value}`);
    // The top rows of the window against the header under them.
    const screen = win.monitorOf(window.hwnd).monitor;
    const top = { left: Math.max(frame.left, screen.left), top: Math.max(frame.top, screen.top), right: Math.min(frame.right, screen.right), bottom: Math.min(frame.top + Math.round(16 * window.scale), screen.bottom) };
    if (top.right - top.left > 40 && top.bottom - top.top > 6) {
      const bitmap = win.captureScreen(top);
      // Clear of the buttons and anything else on the header.
      const span = Math.round(bitmap.width * 0.4);
      const header = rowColor(bitmap, bitmap.height - 2, 0, span);
      const rows = [0, 1, 2].map((y) => rowColor(bitmap, y, 0, span));
      facts.push(`top rows ${rows.map((row) => hex(row.color)).join(" ")} over the header's ${hex(header.color)}`);
      // Windows draws its border over the top rows as thick as beside the
      // page: 1 px at 100%, 2 rows at 150%, the second blended darker.
      const border = Math.max(1, Math.min(insets.left, insets.right));
      rows.forEach((row, y) => {
        if (row.share > 0.8 && colorDistance(row.color, header.color) > 24 && y >= border) {
          problems.push(`row ${y} at the top is a ${hex(row.color)} strip over the ${hex(header.color)} header`);
        }
      });
    }
    // The buttons sit inside the window, on its top edge.
    const layout = await layoutOf(window.page);
    if (layout.controls) {
      const right = client.left + (layout.controls.x + layout.controls.width) * window.scale;
      const topEdge = client.top + layout.controls.y * window.scale;
      facts.push(`buttons end ${Math.round(client.right - right)} px from the right edge, ${Math.round(topEdge - client.top)} px from the top`);
      // Within one CSS pixel, which is more than one device pixel when scaled.
      const slack = Math.max(1, Math.ceil(window.scale));
      if (right > client.right + slack || right > screen.right + slack) problems.push("the window buttons are cut off on the right");
    }
    return { problems, facts };
  }

  async doubleClickTitle(window: AppWindow): Promise<boolean> {
    const point = await evaluate<{ x: number; y: number } | null>(window.page.cdp, "window.__winCheck.titleBarPoint()");
    if (!point) return false;
    await win.click(this.toScreen(window, point), { double: true });
    await sleep(900);
    return true;
  }

  /**
   * Maximizes and restores a window again and again, each way there is, and
   * reads its frame after each: now and then a window came out of a maximize
   * and restore with a native title bar above its page.
   */
  async maximizeCycles(window: AppWindow, name: string, start: Rect): Promise<void> {
    const label = name === "main" ? "Main window" : "Popped-out window";
    await this.step(`${name}-maximize-cycles`, `${label}: maximize and restore it ${MAXIMIZE_ROUNDS} times each way, and no native title bar comes`, async (shots) => {
      await this.reset(window, start);
      const ways: Array<{ way: string; maximize: () => Promise<unknown>; restore: () => Promise<unknown> }> = [
        { way: "the window button", maximize: () => this.clickControl(window, "maximize"), restore: () => this.clickControl(window, "maximize") },
        { way: "a double-click on the title bar", maximize: () => this.doubleClickTitle(window), restore: () => this.doubleClickTitle(window) },
        {
          way: "Win+Up and Win+Down",
          maximize: async () => {
            await this.focus(window);
            await win.pressKeys(win.VK.win, win.VK.up);
            await sleep(900);
          },
          restore: async () => {
            await win.pressKeys(win.VK.win, win.VK.down);
            await sleep(900);
          },
        },
      ];
      const caught = (when: string, caption: string) => {
        this.captionsSeen.add(`${this.launches}:${window.hwnd}`);
        const frame = win.visibleRect(window.hwnd);
        const shot = this.shots.take(`${name}-maximize-cycles-caption`, { left: frame.left - 8, top: frame.top - 8, right: frame.right + 8, bottom: frame.top + Math.round(90 * window.scale) });
        if (shot) shots.push(shot);
        const desktop = this.shots.desktop(`${name}-maximize-cycles-caption-desktop`);
        if (desktop) shots.push(desktop);
        return { status: "fail" as const, detail: `${when}: ${caption}` };
      };
      // A slow machine can take a few seconds more to act on a key.
      const settles = async (maximized: boolean) => {
        for (const until = Date.now() + 3_000; win.isMaximized(window.hwnd) !== maximized && Date.now() < until;) await sleep(250);
        return win.isMaximized(window.hwnd) === maximized;
      };
      let cycles = 0;
      for (let round = 1; round <= MAXIMIZE_ROUNDS; round += 1) {
        for (const { way, maximize, restore } of ways) {
          await maximize();
          if (!await settles(true)) return { status: "fail", detail: `round ${round}: ${way} did not maximize it, after ${cycles} cycles` };
          const maximized = this.nativeCaption(window);
          if (maximized) return caught(`round ${round}, maximized with ${way}, after ${cycles} cycles`, maximized);
          await restore();
          if (!await settles(false)) return { status: "fail", detail: `round ${round}: ${way} did not restore it, after ${cycles} cycles` };
          const restored = this.nativeCaption(window);
          if (restored) return caught(`round ${round}, restored with ${way}, after ${cycles} cycles`, restored);
          cycles += 1;
        }
      }
      const frame = win.visibleRect(window.hwnd);
      const client = win.clientRect(window.hwnd);
      return { status: "pass", detail: `${cycles} maximize and restore cycles, the page at the frame's top after each: frame ${fmt(frame)}, page ${fmt(client)}` };
    });
  }

  async frameSteps(window: AppWindow, name: string, start: Rect): Promise<void> {
    const label = name === "main" ? "Main window" : "Popped-out window";
    const other = window === this.main ? this.detached : this.main;
    await this.step(`${name}-frame`, `${label}: the frame, corners and buttons, active and inactive`, async (shots) => {
      await this.reset(window, start);
      // The pointer away from the buttons, which light up under it.
      win.moveMouse({ x: Math.round((start.left + start.right) / 2), y: Math.round((start.top + start.bottom) / 2) });
      await sleep(400);
      const active = await this.frameReading(window);
      this.frameCrops(window, `${name}-frame-active`, shots);
      const frame = win.visibleRect(window.hwnd);
      const whole = this.shots.take(`${name}-frame-active-whole`, { left: frame.left - 24, top: frame.top - 24, right: frame.right + 24, bottom: frame.bottom + 24 });
      if (whole) shots.push(whole);
      let inactive: { problems: string[]; facts: string[] } | null = null;
      if (other?.hwnd && win.isWindow(other.hwnd)) {
        await this.focus(other);
        await sleep(500);
        inactive = await this.frameReading(window);
        this.frameCrops(window, `${name}-frame-inactive`, shots);
        await this.focus(window);
      }
      const problems = [...active.problems, ...(inactive?.problems.map((problem) => `inactive: ${problem}`) ?? [])];
      return {
        status: problems.length ? "fail" : "pass",
        detail: [...problems, `active: ${active.facts.join("; ")}`, inactive ? `inactive: ${inactive.facts.slice(2).join("; ")}` : "no other window to make it inactive"].join("; "),
      };
    });
    await this.step(`${name}-frame-maximized`, `${label}: the frame and buttons when maximized`, async (shots) => {
      await this.reset(window, start);
      if (!await this.clickControl(window, "maximize")) return { status: "fail", detail: "no maximize button" };
      win.moveMouse({ x: Math.round((start.left + start.right) / 2), y: Math.round((start.top + start.bottom) / 2) });
      await sleep(400);
      const reading = await this.frameReading(window);
      const monitor = win.monitorOf(window.hwnd);
      const frame = win.visibleRect(window.hwnd);
      const client = win.clientRect(window.hwnd);
      if (client.top < monitor.monitor.top || client.left < monitor.monitor.left || client.right > monitor.monitor.right) reading.problems.push(`the page runs off the screen: ${fmt(client)} on ${fmt(monitor.monitor)}`);
      const top = this.shots.take(`${name}-maximized-top-left`, { left: monitor.work.left, top: monitor.work.top, right: monitor.work.left + Math.round(220 * window.scale), bottom: monitor.work.top + Math.round(40 * window.scale) }, 3);
      if (top) shots.push(top);
      const buttons = this.shots.take(`${name}-maximized-buttons`, { left: monitor.work.right - Math.round(220 * window.scale), top: monitor.work.top, right: monitor.work.right, bottom: monitor.work.top + Math.round(40 * window.scale) }, 3);
      if (buttons) shots.push(buttons);
      const bottom = this.shots.take(`${name}-maximized-bottom`, { left: monitor.work.left, top: monitor.work.bottom - Math.round(40 * window.scale), right: monitor.work.left + Math.round(300 * window.scale), bottom: monitor.monitor.bottom }, 2);
      if (bottom) shots.push(bottom);
      await this.clickControl(window, "maximize");
      return {
        status: reading.problems.length ? "fail" : "pass",
        detail: [...reading.problems, `frame ${fmt(frame)} on a ${fmt(monitor.work)} work area`, ...reading.facts].join("; "),
      };
    });
  }

  async windowSteps(window: AppWindow, name: string, start: Rect): Promise<void> {
    const label = name === "main" ? "Main window" : "Popped-out window";
    await this.frameSteps(window, name, start);
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
        // The header lays out anew at the maximized width: the same spot can be on the command prompt now.
        const again = await evaluate<{ x: number; y: number } | null>(window.page.cdp, "window.__winCheck.titleBarPoint()");
        await win.click(this.toScreen(window, again ?? point), { double: true });
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
        // A slow machine can still be drawing the snap: give it a few seconds.
        let rect = win.visibleRect(window.hwnd);
        for (const until = Date.now() + 3_000; !want(rect) && Date.now() < until; rect = win.visibleRect(window.hwnd)) await sleep(250);
        const fills = await this.contentFills(window, `${name}-${label}`, shots);
        const good = want(rect) && fills.ok;
        ok &&= good;
        results.push(`${label}: ${fmt(rect)}${good ? "" : ` (not as expected${fills.ok ? "" : `; ${fills.detail}`})`}`);
      };
      // Win+Right on a window snapped left puts it back, so each side starts
      // from the window as placed.
      await check([win.VK.win, win.VK.left], "win-left", (rect) => near(rect.left, work.left, 3) && near(win.rectWidth(rect), halfWidth, 12) && near(win.rectHeight(rect), win.rectHeight(work), 3));
      await this.reset(window, start);
      await check([win.VK.win, win.VK.right], "win-right", (rect) => near(rect.right, work.right, 3) && near(win.rectWidth(rect), halfWidth, 12));
      await this.reset(window, start);
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

    await this.maximizeCycles(window, name, start);
  }

  async paneSteps(): Promise<void> {
    const main = this.main;

    await this.step("dock-divider", "Drag the dock divider between the columns", async (shots) => {
      await this.reset(main, this.baseRect);
      const before = await layoutOf(main.page);
      const divider = before.dividers.filter((entry) => entry.rect.height > entry.rect.width).sort((a, b) => b.rect.height - a.rect.height)[0];
      if (!divider) return { status: "fail", detail: "no vertical dock divider" };
      const grip = await evaluate<{ x: number; y: number } | null>(main.page.cdp, "window.__winCheck.dividerPoint()");
      if (!grip) return { status: "fail", detail: "nothing of the dock divider is uncovered" };
      const from = this.toScreen(main, grip);
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
      const page = await layoutOf(main.page);
      const floor = page.status ? page.status.y : page.innerHeight;
      // Within the window, clear of its edges, where a drop snaps the pane to a half.
      const room = {
        left: before.rect.x - 60, right: page.innerWidth - 60 - (before.rect.x + before.rect.width),
        up: before.rect.y - 60, down: floor - 60 - (before.rect.y + before.rect.height),
      };
      let move = {
        x: room.left >= 40 ? -Math.min(80, room.left) : Math.min(80, Math.max(0, room.right)),
        y: room.down >= 30 ? Math.min(40, room.down) : -Math.min(40, Math.max(0, room.up)),
      };
      let during: CssRect | null = null;
      let to = { x: from.x + Math.round(move.x * main.scale), y: from.y + Math.round(move.y * main.scale) };
      await win.drag(from, to, {
        whileHeld: async () => {
          // A drop on the grid over a docked pane docks it: let go beside the
          // grid, a little higher or lower, as a person would.
          const fits = (dy: number) => before.rect.y + dy >= 30 && before.rect.y + before.rect.height + dy <= floor - 10;
          for (const nudge of [30, -30, 60, -60, 90, -90, 0]) {
            const at = { x: point.x + move.x, y: point.y + move.y };
            const grid = await evaluate<CssRect[]>(main.page.cdp, "window.__winCheck.dropGrid()");
            if (!grid.some((cell) => at.x >= cell.x - 4 && at.x <= cell.x + cell.width + 4 && at.y >= cell.y - 4 && at.y <= cell.y + cell.height + 4)) break;
            if (!nudge || !fits(move.y + nudge)) continue;
            move = { x: move.x, y: move.y + nudge };
            to = { x: from.x + Math.round(move.x * main.scale), y: from.y + Math.round(move.y * main.scale) };
            win.moveMouse(to);
            await sleep(250);
          }
          during = (await layoutOf(main.page)).panes.find((pane) => pane.id === before.id)?.rect ?? null;
        },
      });
      await sleep(600);
      const after = (await layoutOf(main.page)).panes.find((pane) => pane.id === before.id);
      const shot = this.shots.take("floating-move-after", win.clientRect(main.hwnd));
      if (shot) shots.push(shot);
      const cell = 20;
      const landed = !!after && after.floating && near(after.rect.x, before.rect.x + move.x, cell) && near(after.rect.y, before.rect.y + move.y, cell);
      const duringRect = during as CssRect | null;
      const followed = !!duringRect && near(duringRect.x, before.rect.x + move.x, cell) && near(duringRect.y, before.rect.y + move.y, cell);
      return {
        status: landed && followed ? "pass" : "fail",
        detail: `from ${Math.round(before.rect.x)},${Math.round(before.rect.y)} by ${move.x},${move.y >= 0 ? "+" : ""}${move.y} CSS px: mid-drag ${duringRect ? `${Math.round(duringRect.x)},${Math.round(duringRect.y)}` : "gone"}, after ${after ? `${Math.round(after.rect.x)},${Math.round(after.rect.y)}${after.floating ? "" : " (docked)"}` : "gone"}`,
      };
    });

    await this.step("floating-resize", "Resize the floating pane by its corner", async (shots) => {
      await this.reset(main, this.baseRect);
      const before = (await layoutOf(main.page)).panes.find((pane) => pane.floating);
      if (!before?.resize) return { status: "fail", detail: "no resize corner on the floating pane" };
      const from = this.centerOf(main, before.resize);
      const page = await layoutOf(main.page);
      const floor = page.status ? page.status.y : page.innerHeight;
      const grow = {
        x: Math.max(20, Math.min(120, Math.round(page.innerWidth - (before.rect.x + before.rect.width) - 30))),
        y: Math.max(10, Math.min(80, Math.round(floor - (before.rect.y + before.rect.height) - 30))),
      };
      let during: CssRect | null = null;
      await win.drag(from, { x: from.x + Math.round(grow.x * main.scale), y: from.y + Math.round(grow.y * main.scale) }, {
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
      const grew = !!after && near(after.rect.width, before.rect.width + grow.x, cell) && near(after.rect.height, before.rect.height + grow.y, cell);
      const duringRect = during as CssRect | null;
      const followed = !!duringRect && near(duringRect.width, before.rect.width + grow.x, cell);
      return {
        status: grew && followed ? "pass" : "fail",
        detail: `${Math.round(before.rect.width)}x${Math.round(before.rect.height)} dragged +${grow.x},+${grow.y} CSS px: mid-drag ${duringRect ? `${Math.round(duringRect.width)}x${Math.round(duringRect.height)}` : "gone"}, after ${after ? `${Math.round(after.rect.width)}x${Math.round(after.rect.height)}` : "gone"}`,
      };
    });

    // Dropped on another docked pane's title bar, a pane stacks there as a tab,
    // shown. Builds before tabs showed a drop grid over the pane instead, whose
    // center cell swapped the two.
    await this.step("dock-drop", "Drag a docked pane onto another's title bar to take its place", async (shots) => {
      await this.reset(main, this.baseRect);
      const before = await layoutOf(main.page);
      const source = before.panes.find((pane) => pane.id === "portfolio-list:main");
      const target = before.panes.find((pane) => pane.id === "ticker-research:spy");
      if (!source || !target) return { status: "fail", detail: "the list or research pane is missing" };
      const point = await evaluate<{ x: number; y: number } | null>(main.page.cdp, `window.__winCheck.paneHeaderPoint(${JSON.stringify(source.id)})`);
      const onto = await evaluate<{ x: number; y: number } | null>(main.page.cdp, `window.__winCheck.paneHeaderPoint(${JSON.stringify(target.id)})`);
      if (!point || !onto) return { status: "fail", detail: "no header on the list or research pane" };
      let way = "its title bar";
      await win.drag(this.toScreen(main, point), this.toScreen(main, onto), {
        steps: 20,
        whileHeld: async () => {
          // An older build's grid shows over the pane's body, where it has room
          // for it, not always at its middle.
          await sleep(300);
          win.moveMouse(this.centerOf(main, target.rect));
          await sleep(400);
          const grid = await evaluate<Array<CssRect & { center: boolean }>>(main.page.cdp, "window.__winCheck.dropGrid()");
          const center = grid.find((cell) => cell.center);
          if (center) {
            way = "the drop grid's center";
            win.moveMouse(this.centerOf(main, center));
          } else {
            win.moveMouse(this.toScreen(main, onto));
          }
          await sleep(600);
          const shot = this.shots.take("dock-drop-held", win.clientRect(main.hwnd));
          if (shot) shots.push(shot);
        },
      });
      await sleep(800);
      const after = await layoutOf(main.page);
      const shot = this.shots.take("dock-drop-after", win.clientRect(main.hwnd));
      if (shot) shots.push(shot);
      const movedSource = after.panes.find((pane) => pane.id === source.id);
      const movedTarget = after.panes.find((pane) => pane.id === target.id);
      const placed = !!movedSource && !movedSource.floating && near(movedSource.rect.x, target.rect.x, 4) && near(movedSource.rect.y, target.rect.y, 4);
      const where = (pane: PaneLayout | undefined) => pane ? `${Math.round(pane.rect.x)},${Math.round(pane.rect.y)}${pane.floating ? " (floating)" : ""}${pane.rect.width ? "" : " (hidden)"}` : "not shown";
      return {
        status: placed ? "pass" : "fail",
        detail: `the list was at ${Math.round(source.rect.x)},${Math.round(source.rect.y)}, research at ${Math.round(target.rect.x)},${Math.round(target.rect.y)}; dropped on ${way}, the list is at ${where(movedSource)} and research ${where(movedTarget)}`,
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
      // The trending pane, or another docked one where a floating pane left
      // none of it to click: a click on whatever covers it focuses that instead.
      const candidates = ["attention-trending:home", ...layout.panes.filter((entry) => !entry.floating).map((entry) => entry.id)];
      let target: { id: string; point: { x: number; y: number } } | null = null;
      for (const id of new Set(candidates)) {
        const point = await evaluate<{ x: number; y: number } | null>(main.page.cdp, `window.__winCheck.panePoint(${JSON.stringify(id)})`, 3_000).catch(() => null);
        if (point) { target = { id, point }; break; }
      }
      if (!target) return { status: "fail", detail: "no docked pane has a spot to click that nothing covers" };
      // Focus it with a click on its body, then the chord.
      const pressedAt = Date.now();
      await win.click(this.toScreen(main, target.point));
      await sleep(400);
      await win.pressChord([win.VK.control, win.VK.shift], "o", 600);
      let opened: win.WindowInfo | undefined;
      const deadline = Date.now() + 15_000;
      while (!opened && Date.now() < deadline) {
        await sleep(500);
        opened = this.appWindows().find((info) => !before.has(info.hwnd));
      }
      if (!opened) {
        const desktop = this.shots.desktop("pop-out-missing");
        if (desktop) shots.push(desktop);
        const seen = describeInputs(await inputsSince(main.page, pressedAt), pressedAt);
        return { status: "fail", detail: `no new window opened for ${target.id}, clicked at ${Math.round(target.point.x)},${Math.round(target.point.y)}; the main page saw: ${seen}` };
      }
      const { drawn, said: painted } = await waitForPaint(opened.hwnd);
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
        status: drawn ? "pass" : "fail",
        detail: `opened "${opened.title}" for ${target.id} at ${fmt(rect)}, ${overMain ? "over" : "away from"} the main window at ${fmt(mainRect)}; ${painted}`,
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

  /**
   * The app restarting itself, as the Restart button on its error screen
   * makes it: the page sends the same message the button does.
   */
  async restartsItself(): Promise<void> {
    await this.step("restart-itself", "The app restarts itself, as from the Restart button on its error screen", async (shots) => {
      await this.reset(this.main, this.baseRect);
      for (const info of win.topLevelWindows()) this.knownWindows.add(info.hwnd);
      keepTaskSchedulerLog();
      const mainHwnd = this.main.hwnd;
      const oldPid = win.topLevelWindows().find((info) => info.hwnd === mainHwnd)?.pid ?? 0;
      const sent = await evaluate<boolean>(this.main.page.cdp, `(() => {
        if (!window.__electrobunBunBridge) return false;
        window.__electrobunBunBridge.postMessage(JSON.stringify({ type: "message", id: "host.restart", payload: { reason: "windows-check", source: "windows-check" } }));
        return true;
      })()`, 5_000).catch(() => false);
      if (!sent) return { status: "fail", detail: "the page has no bridge to send the restart on" };
      const closing = Date.now();
      // The app gives its restart script 120 s to start before it stays open instead.
      while (win.isWindow(this.main.hwnd) && Date.now() - closing < 130_000) await sleep(200);
      if (win.isWindow(this.main.hwnd)) return { status: "fail", detail: `the app did not close to restart within 130 s; ${await restartReport(this.out, oldPid)}` };
      const closedIn = (Date.now() - closing) / 1000;
      for (const window of [this.main, this.detached]) window?.page.cdp.close();
      let opened: win.WindowInfo | undefined;
      while (!opened && Date.now() - closing < 60_000) {
        await sleep(500);
        opened = this.appWindows().find((info) => !this.knownWindows.has(info.hwnd));
      }
      if (!opened) {
        const desktop = this.shots.desktop("restart-missing");
        if (desktop) shots.push(desktop);
        return { status: "fail", detail: `no window came back within 60 s of the old one closing; ${await restartReport(this.out, oldPid)}` };
      }
      const took = (Date.now() - closing) / 1000;
      // Back means the app's page is on it, not only a window.
      const { drawn, said: painted } = await waitForPaint(opened.hwnd, 30_000);
      const shot = this.shots.take("restarted-window", win.windowRect(opened.hwnd));
      if (shot) shots.push(shot);
      const desktop = this.shots.desktop("restarted");
      if (desktop) shots.push(desktop);
      // Not this run's launch: stopped by its window.
      Bun.spawnSync(["taskkill", "/PID", String(opened.pid), "/T", "/F"]);
      await sleep(1_500);
      return { status: drawn ? "pass" : "fail", detail: `the old window closed ${closedIn.toFixed(1)} s after the restart was asked; "${opened.title}" opened ${took.toFixed(1)} s after it was asked and ${painted}` };
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

  /**
   * What Windows calls the app's programs, in Task Manager, a file's
   * properties and its security prompts: each one's description, product,
   * publisher and version, and Task Manager's list with the app running.
   */
  async programDetails(): Promise<void> {
    await this.step("program-details", "Windows shows the app's programs as Gloom", async (shots) => {
      const bin = join(this.app, "bin");
      const listing = Bun.spawnSync([
        "powershell", "-NoProfile", "-Command",
        `Get-ChildItem -LiteralPath '${bin.replaceAll("'", "''")}' -Filter *.exe -File | ForEach-Object { $v = $_.VersionInfo; '{0}|{1}|{2}|{3}|{4}' -f $_.Name, $v.FileDescription, $v.ProductName, $v.CompanyName, $v.ProductVersion }`,
      ]).stdout.toString().trim().split(/\r?\n/).filter(Boolean);
      const programs = listing.map((line) => {
        const [file = "", description = "", product = "", company = "", version = ""] = line.split("|");
        return { file, description, product, company, version };
      });
      // Task Manager starts through the shell, which elevates it where it asks to be.
      Bun.spawnSync(["powershell", "-NoProfile", "-Command", "Start-Process taskmgr.exe"]);
      await sleep(4_000);
      const desktop = this.shots.desktop("task-manager");
      if (desktop) shots.push(desktop);
      // A slow machine can still be filling in names at first.
      await sleep(10_000);
      const later = this.shots.desktop("task-manager-later");
      if (later) shots.push(later);
      Bun.spawnSync(["taskkill", "/IM", "Taskmgr.exe", "/F"]);
      // What Windows gives Task Manager for each running program: its description.
      const running = Bun.spawnSync([
        "powershell", "-NoProfile", "-Command",
        `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${bin.replaceAll("'", "''")}\\', [StringComparison]::OrdinalIgnoreCase) } | Group-Object { $_.ProcessName + ' as ' + $_.Description } | ForEach-Object { '{0} x{1}' -f $_.Name, $_.Count }`,
      ]).stdout.toString().trim().split(/\r?\n/).filter(Boolean);
      await sleep(500);
      const named = (program: (typeof programs)[number]) => program.description === "Gloom" && program.product === "Gloom" && program.company === "Gloom";
      const ours = programs.filter((program) => ["launcher.exe", "bun.exe", "bspatch.exe", "zig-zstd.exe"].includes(program.file) || program.file.startsWith("bun Helper"));
      const unnamed = ours.filter((program) => !named(program));
      const describe = (program: (typeof programs)[number]) => `${program.file}: ${[program.description, program.product, program.company, program.version].map((value) => value || "none").join(", ")}`;
      return {
        status: ours.length >= 3 && unnamed.length === 0 ? "pass" : "fail",
        detail: `${unnamed.length ? `${unnamed.length} of ${ours.length} without Gloom's name; ` : ""}${programs.map(describe).join("; ")}; running: ${running.join("; ") || "none"}`,
      };
    });
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
    // Before the app goes: a restart it scheduled would open it again once it is gone.
    for (const line of stopApp(this.app)) console.log(line);
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
  const left = stopApp(app);
  if (left.length) console.log(`Left by an earlier run: ${left.join("; ")}`);
  try {
    // First the popped-out window, while the main window has not been resized.
    await runner.start(null);
    await runner.calibrate();
    await runner.programDetails();
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
    await runner.ensure(runner.main);
    await runner.restartsItself();
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
else if (COMMAND === "ports") await ports(resolve(required("app")), resolve(required("out")), option("label") ?? "app");
else if (COMMAND === "enable-devtools") await enableDevtools(resolve(required("app")));
else if (COMMAND === "run") {
  await run();
  // A page connection the app left open would keep the check from exiting.
  process.exit(0);
} else {
  console.error("Usage: check.ts install --installer <GloomSetup.exe> --dir <dir> | ports --app <dir> --out <dir> [--label <name>] | enable-devtools --app <dir> | run --app <dir> --out <dir> [--label <name>] [--only <text>]");
  process.exit(2);
}
