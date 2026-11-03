import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Jimp } from "jimp";
import { Cdp, evaluate } from "../pane-chrome/browser";
import { EXTRACTED_PLUGINS } from "../../src/plugins/extracted-plugins";
import * as win from "./win32";

/**
 * How long the app's own thread (the Bun process that answers every window)
 * goes without answering while a person holds the app, on the installed
 * Windows app with real OS input:
 *
 * - an update found at launch, downloaded and unpacked;
 * - a context menu held open;
 * - the window held mid-move, and mid-resize, with the pointer still moving.
 *
 * A probe asks the app's own local server (the one its windows' sockets
 * connect to) for a page every 50 ms; how long each answer takes is how long
 * the thread could not run. The stalls the app logged meanwhile say what it
 * named. `--strict` fails when the thread waited a second or more through
 * the update or a menu.
 *
 *   bun scripts/windows-desktop-check/responsiveness.ts run --app <install dir> --out <dir> [--label <name>] [--strict]
 *
 * Windows only. `check.ts install` and `check.ts enable-devtools` set the app up.
 */

const ARGS = process.argv.slice(2);
const option = (name: string) => {
  const index = ARGS.indexOf(`--${name}`);
  return index >= 0 ? ARGS[index + 1] : undefined;
};
const sleep = win.sleep;

/** How long each hold lasts. */
const HOLD_MS = 8_000;
/** A wait this long through an update or a menu fails `--strict`. */
const STRICT_LIMIT_MS = 1_000;
const UPDATE_HASH = "responsiveness-update";

interface Sample { at: number; ms: number }

/** Asks the app's thread for an answer every 50 ms, one question at a time. */
class Probe {
  readonly samples: Sample[] = [];
  private running = true;
  private readonly done: Promise<void>;

  constructor(port: number) {
    this.done = this.loop(`http://127.0.0.1:${port}/socket`);
  }

  private async loop(url: string): Promise<void> {
    while (this.running) {
      const at = Date.now();
      try {
        await fetch(url, { signal: AbortSignal.timeout(120_000) });
      } catch {
        // Intentional ignore: an answer that never came is timed like one that came late.
      }
      const ms = Date.now() - at;
      this.samples.push({ at, ms });
      if (ms < 50) await sleep(50 - ms);
    }
  }

  /** The questions asked from `from` to `to`, and the one just before that was still waiting. */
  between(from: number, to: number): Sample[] {
    return this.samples.filter((sample) => sample.at + sample.ms >= from && sample.at <= to);
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.done;
  }
}

function percentile(values: number[], share: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
}

interface Hold {
  scenario: string;
  index: number;
  from: number;
  to: number;
  note?: string;
}

interface ScenarioResult {
  id: string;
  title: string;
  holds: number;
  heldMs: number;
  /** The longest the app's thread took to answer during the holds. */
  longestWaitMs: number;
  p95WaitMs: number;
  questions: number;
  /** The app process's stalls the app logged during the holds. */
  stalls: string[];
  notes: string[];
}

// --- The app ---------------------------------------------------------------

let shotDir = "";
let shotCount = 0;

/** The whole screen as a PNG under the output folder, named in order. */
async function shot(label: string): Promise<void> {
  if (!shotDir) return;
  try {
    const bitmap = win.captureScreen(win.screenRect());
    shotCount += 1;
    const image = new Jimp({ width: bitmap.width, height: bitmap.height, data: bitmap.data });
    await writeFile(join(shotDir, `${String(shotCount).padStart(2, "0")}-${label}.png`), await image.getBuffer("image/png"));
  } catch (error) {
    console.error(`Could not picture ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface Frame { x: number; y: number; width: number; height: number }

async function seedProfile(profile: string, frame: Frame): Promise<string> {
  await rm(profile, { recursive: true, force: true });
  const dataDir = join(profile, "data");
  await mkdir(dataDir, { recursive: true });
  const layout = {
    dockRoot: { kind: "pane", instanceId: "portfolio-list:watchlist" },
    instances: [{ instanceId: "portfolio-list:watchlist", paneId: "portfolio-list", params: { collectionId: "watchlist" }, binding: { kind: "none" } }],
    floating: [],
    detached: [],
  };
  await writeFile(join(profile, "desktop-window.json"), JSON.stringify({ frame, maximized: false, fullscreen: false }));
  await writeFile(join(profile, "config.json"), JSON.stringify({ dataDir }, null, 2));
  await writeFile(join(dataDir, "config.json"), JSON.stringify({
    dataDir,
    onboardingComplete: true,
    telemetry: { crashReports: false, usage: false },
    seededPlugins: EXTRACTED_PLUGINS.map((plugin) => plugin.id),
    layout,
    layouts: [{ name: "Responsiveness", layout, paneState: {}, focusedPaneId: "portfolio-list:watchlist" }],
    activeLayoutIndex: 0,
  }, null, 2));
  return dataDir;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
}

async function devtoolsPage(): Promise<{ webSocketDebuggerUrl: string } | null> {
  for (let port = 9222; port <= 9232; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) continue;
      const targets = await response.json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("views://mainview/"));
      if (page) return page;
    } catch {
      // Intentional ignore: the port is closed or not CEF's; try the next.
    }
  }
  return null;
}

/** Ends everything run from the app's folder. */
function stopApp(app: string): void {
  const script = `$App = $env:GLOOM_CHECK_APP.TrimEnd([char]92) + [char]92
Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith($App, [StringComparison]::OrdinalIgnoreCase) } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue`;
  Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, GLOOM_CHECK_APP: app }, timeout: 60_000 });
}

interface Running {
  launcher: ReturnType<typeof Bun.spawn>;
  cdp: Cdp;
  hwnd: number;
  port: number;
  probe: Probe;
  dataDir: string;
  readyAt: number;
  stdout: string;
}

class Session {
  running: Running | null = null;
  launches = 0;

  constructor(readonly app: string, readonly out: string) {}

  async launch(label: string): Promise<Running> {
    await this.close();
    this.launches += 1;
    for (const key of [win.VK.control, win.VK.shift, win.VK.alt]) win.keyUp(key);
    const known = new Set(win.topLevelWindows().map((info) => info.hwnd));
    const profile = join(this.out, "..", `profile-${basename(this.out)}-${this.launches}`);
    const scale = win.primaryMonitor().dpi / 96;
    const work = win.primaryMonitor().work;
    const dataDir = await seedProfile(profile, {
      x: Math.round((work.left + 80) / scale), y: Math.round((work.top + 80) / scale),
      width: Math.round(1100 / scale), height: Math.round(720 / scale),
    });
    const bin = join(this.app, "bin");
    const stdout = join(this.out, `app-stdout-${label}.log`);
    const launcher = Bun.spawn([join(bin, "launcher.exe")], {
      cwd: bin,
      env: { ...process.env, GLOOMBERB_HOME: profile, ELECTROBUN_CONSOLE: "1", DO_NOT_TRACK: "1", GLOOMBERB_NO_TELEMETRY: "1" },
      stdout: Bun.file(stdout),
      stderr: Bun.file(join(this.out, `app-stderr-${label}.log`)),
    });
    const deadline = Date.now() + 120_000;
    let cdp: Cdp | null = null;
    let port = 0;
    let hwnd = 0;
    while (Date.now() < deadline && launcher.exitCode === null) {
      if (!port) {
        const text = await readFile(stdout, "utf8").catch(() => "");
        port = Number(text.match(/Server started at http:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
      }
      if (!cdp) {
        const page = await devtoolsPage();
        if (page) cdp = await Cdp.connect(page.webSocketDebuggerUrl).catch(() => null);
      }
      if (!hwnd) {
        hwnd = win.topLevelWindows().find((info) => info.visible && info.className === "BasicWindowClass" && info.title === "Gloom" && !known.has(info.hwnd))?.hwnd ?? 0;
      }
      if (cdp && port && hwnd) {
        const ready = await evaluate<boolean>(cdp, "!!document.querySelector('[data-gloom-role=pane-window]')", 3_000).catch(() => false);
        if (ready) break;
      }
      await sleep(500);
    }
    if (!cdp || !port || !hwnd) {
      throw new Error(`The app did not open (${launcher.exitCode === null ? "still running" : `exited ${launcher.exitCode}`}; port ${port}, window ${hwnd}, page ${cdp ? "yes" : "no"})`);
    }
    const running: Running = { launcher, cdp, hwnd, port, probe: new Probe(port), dataDir, readyAt: Date.now(), stdout };
    this.running = running;
    // The panes load what they show.
    await sleep(8_000);
    return running;
  }

  async close(): Promise<void> {
    const running = this.running;
    this.running = null;
    if (running) {
      await running.probe.stop();
      running.cdp.close();
      Bun.spawnSync(["taskkill", "/PID", String(running.launcher.pid), "/T", "/F"]);
      const log = await readFile(join(running.dataDir, "stall-log.txt"), "utf8").catch(() => "");
      await writeFile(join(this.out, `stall-log-${this.launches}.txt`), log);
    }
    stopApp(this.app);
    await sleep(1_500);
  }
}

/** Physical pixels per CSS pixel, and the page point on screen. */
async function toScreen(running: Running, point: { x: number; y: number }): Promise<win.Point> {
  const dpr = await evaluate<number>(running.cdp, "devicePixelRatio", 3_000);
  const scale = dpr * (win.monitorOf(running.hwnd).dpi / (win.windowDpi(running.hwnd).dpi || 96));
  const client = win.clientRect(running.hwnd);
  return { x: Math.round(client.left + point.x * scale), y: Math.round(client.top + point.y * scale) };
}

async function focusApp(running: Running): Promise<void> {
  if (win.foregroundWindow() === running.hwnd) return;
  await win.pressKeys(win.VK.alt);
  win.bringToFront(running.hwnd);
  await sleep(400);
}

/** The app process's stall log lines from `from` to `to`, with a few seconds for the stall to be noticed. */
async function stallsBetween(dataDir: string, from: number, to: number): Promise<string[]> {
  const text = await readFile(join(dataDir, "stall-log.txt"), "utf8").catch(() => "");
  return text.split(/\r?\n/).filter((line) => {
    const match = line.match(/^(\S+Z)\s+app\s/);
    if (!match) return false;
    const at = Date.parse(match[1]!);
    return at >= from - 1_000 && at <= to + 4_000;
  });
}

function summarize(id: string, title: string, holds: Hold[], probe: Probe, stalls: string[]): ScenarioResult {
  const waits = holds.flatMap((hold) => probe.between(hold.from, hold.to).map((sample) => sample.ms));
  return {
    id,
    title,
    holds: holds.length,
    heldMs: holds.reduce((sum, hold) => sum + (hold.to - hold.from), 0),
    longestWaitMs: Math.max(0, ...waits),
    p95WaitMs: percentile(waits, 0.95),
    questions: waits.length,
    stalls,
    notes: holds.flatMap((hold) => hold.note ? [`${hold.scenario} ${hold.index}: ${hold.note}`] : []),
  };
}

// --- Scenarios -------------------------------------------------------------

/**
 * A point in the pane's body with no field under it: a right click anywhere
 * on the page outside a field opens the app's menu.
 */
const MENU_POINT = String.raw`(() => {
  const pane = document.querySelector("[data-gloom-role=pane-window]");
  const r = (pane || document.body).getBoundingClientRect();
  for (const share of [0.6, 0.75, 0.45, 0.9]) {
    const x = r.left + r.width / 2;
    const y = r.top + r.height * share;
    const hit = document.elementFromPoint(x, y);
    if (hit && !hit.closest("input, textarea, [contenteditable=true], select")) return { x, y };
  }
  return null;
})()`;

/** A point on the top bar with nothing pressable under it. */
const TITLE_BAR_POINT = String.raw`(() => {
  const header = document.querySelector("[data-gloom-role=app-header]");
  if (!header) return null;
  const h = header.getBoundingClientRect();
  const y = h.top + h.height / 2;
  for (let x = h.right - 150; x > h.left + 20; x -= 6) {
    const hit = document.elementFromPoint(x, y);
    if (hit && header.contains(hit) && !hit.closest("button, [role=button], [role=tab], input, textarea, a, [data-gloom-interactive=true], [data-gloom-role=window-controls], [data-gloom-role=pane-header-tabs]")) return { x, y };
  }
  return null;
})()`;

const menuOpen = () => win.topLevelWindows().some((info) => info.visible && info.className === "#32768");

async function waitUntil(ms: number, condition: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(50);
  }
  return condition();
}

async function holdContextMenus(running: Running, count: number): Promise<Hold[]> {
  const holds: Hold[] = [];
  for (let index = 1; index <= count; index += 1) {
    await focusApp(running);
    const point = await evaluate<{ x: number; y: number } | null>(running.cdp, MENU_POINT, 5_000);
    if (!point) {
      await shot(`menu-${index}-no-point`);
      holds.push({ scenario: "menu", index, from: Date.now(), to: Date.now(), note: "no point in the pane to right-click" });
      continue;
    }
    const screenPoint = await toScreen(running, point);
    await win.rightClick(screenPoint);
    const opened = await waitUntil(5_000, menuOpen);
    const from = Date.now();
    if (!opened) {
      await shot(`menu-${index}-not-open`);
      const hit = win.hitTest(screenPoint);
      holds.push({ scenario: "menu", index, from, to: from, note: `the menu did not open (right-clicked ${screenPoint.x},${screenPoint.y}: ${hit.code} of "${hit.window?.title ?? "nothing"}", foreground ${win.foregroundWindow() === running.hwnd ? "the app" : "another window"})` });
      await win.pressKeys(win.VK.escape);
      continue;
    }
    await sleep(HOLD_MS / 2);
    if (index === 1) await shot("menu-held");
    await sleep(HOLD_MS / 2);
    await win.pressKeys(win.VK.escape);
    const closed = await waitUntil(5_000, () => !menuOpen());
    holds.push({ scenario: "menu", index, from, to: Date.now(), ...(closed ? {} : { note: "the menu stayed open after Escape" }) });
    await sleep(2_000);
  }
  return holds;
}

/**
 * Holds the window with the pointer down and still moving: by its top bar
 * (Windows' move loop), or by its right edge (its size loop). The window
 * goes back where it was after each hold.
 */
async function holdWindow(running: Running, how: "move" | "resize", count: number): Promise<Hold[]> {
  const holds: Hold[] = [];
  for (let index = 1; index <= count; index += 1) {
    await focusApp(running);
    const before = win.windowRect(running.hwnd);
    let from: win.Point;
    if (how === "move") {
      const point = await evaluate<{ x: number; y: number } | null>(running.cdp, TITLE_BAR_POINT, 5_000);
      if (!point) {
        holds.push({ scenario: how, index, from: Date.now(), to: Date.now(), note: "no bare point on the top bar" });
        continue;
      }
      from = await toScreen(running, point);
    } else {
      if (win.isMaximized(running.hwnd)) win.showWindow(running.hwnd, "restore");
      const rect = win.visibleRect(running.hwnd);
      const y = Math.round((rect.top + rect.bottom) / 2);
      from = { x: rect.right - 2, y };
      for (let inset = 1; inset <= 6; inset += 1) {
        const point = { x: rect.right - inset, y };
        if (win.hitTest(point).code === "right") { from = point; break; }
      }
    }
    const to = { x: from.x + 80, y: from.y + (how === "move" ? 40 : 0) };
    const hit = win.hitTest(from);
    let heldFrom = 0;
    let heldTo = 0;
    let during = before;
    await win.drag(from, to, {
      whileHeld: async () => {
        heldFrom = Date.now();
        for (let step = 0; Date.now() - heldFrom < HOLD_MS; step += 1) {
          win.moveMouse({ x: to.x + (step % 2 ? 6 : -6), y: to.y });
          await sleep(250);
          if (step === 8) {
            during = win.windowRect(running.hwnd);
            if (index === 1) await shot(`${how}-held`);
          }
        }
        heldTo = Date.now();
      },
    });
    const fmt = (rect: win.Rect) => `${rect.left},${rect.top} ${win.rectWidth(rect)}x${rect.bottom - rect.top}`;
    const moved = how === "move"
      ? during.left !== before.left || during.top !== before.top
      : win.rectWidth(during) !== win.rectWidth(before);
    holds.push({
      scenario: how, index, from: heldFrom, to: heldTo,
      ...(moved ? {} : { note: `the window did not ${how}: pressed ${from.x},${from.y} (${hit.code} of "${hit.window?.title ?? "nothing"}"${win.isMaximized(running.hwnd) ? ", maximized" : ""}), held at ${to.x},${to.y}; ${fmt(before)} before, ${fmt(during)} while held` }),
    });
    await sleep(500);
    win.placeWindow(running.hwnd, before);
    await sleep(1_500);
  }
  return holds;
}

/**
 * Serves an update for the installed app, as its release server would: the
 * app finds it as it starts, downloads it and unpacks it.
 */
async function serveUpdate(app: string, work: string): Promise<{ stop(): void; baseUrl: string; requestedAt: () => number }> {
  const release = join(work, "release");
  await rm(release, { recursive: true, force: true });
  await mkdir(release, { recursive: true });
  const info = await readJson(join(app, "Resources", "version.json"));
  const name = info.name ?? "Gloom";
  const tar = join(work, "update.tar");
  const started = Date.now();
  let result = Bun.spawnSync(["tar", "-cf", tar, "-C", dirname(app), basename(app)], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error("tar could not pack the app");
  // Level 3: the default takes minutes on a build this size.
  result = Bun.spawnSync([join(app, "bin", "zig-zstd.exe"), "compress", "-i", tar, "-o", join(release, `stable-win-x64-${name}.tar.zst`), "-l", "3", "--threads", "max"], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error("zig-zstd could not pack the app");
  await rm(tar, { force: true });
  await writeFile(join(release, "stable-win-x64-update.json"), JSON.stringify({ ...info, channel: "stable", hash: UPDATE_HASH }));
  console.log(`Packed an update of ${name} in ${Math.round((Date.now() - started) / 1000)} s`);
  let requestedAt = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const file = basename(new URL(request.url).pathname);
      if (file.endsWith("-update.json") && !requestedAt) requestedAt = Date.now();
      const path = join(release, file);
      return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
    },
  });
  return { stop: () => server.stop(true), baseUrl: `http://127.0.0.1:${server.port}`, requestedAt: () => requestedAt };
}

async function updateAtLaunch(session: Session, app: string, out: string): Promise<ScenarioResult> {
  const versionPath = join(app, "Resources", "version.json");
  const original = await readFile(versionPath, "utf8");
  const info = JSON.parse(original.replace(/^\uFEFF/, ""));
  const extraction = join(process.env.LOCALAPPDATA ?? "", info.identifier, "stable", "self-extraction");
  await rm(extraction, { recursive: true, force: true });
  const server = await serveUpdate(app, join(out, "update"));
  const notes: string[] = [];
  try {
    await writeFile(versionPath, JSON.stringify({ ...info, channel: "stable", baseUrl: server.baseUrl }, null, 2));
    const running = await session.launch("update");
    const downloaded = join(extraction, `${UPDATE_HASH}.tar`);
    const done = await waitUntil(240_000, () => existsSync(downloaded));
    if (!done) notes.push("the app did not download and unpack the update");
    await sleep(3_000);
    const from = server.requestedAt() || running.readyAt;
    const to = Date.now();
    const stalls = await stallsBetween(running.dataDir, from, to);
    const result = summarize("update", "An update found at launch, downloaded and unpacked", [{ scenario: "update", index: 1, from, to }], running.probe, stalls);
    result.notes.push(...notes);
    return result;
  } finally {
    await session.close();
    server.stop();
    await writeFile(versionPath, original);
    await rm(extraction, { recursive: true, force: true });
    await rm(join(out, "update"), { recursive: true, force: true });
  }
}

function table(results: ScenarioResult[], label: string): string {
  const rows = results.map((result) => {
    const named = result.stalls.map((line) => line.match(/froze\s+([\d.]+ s)\s+(.*?)\s+\[/)).filter(Boolean).map((match) => `${match![1]} ${match![2]}`);
    return `| ${result.title} | ${result.holds} | ${(result.heldMs / 1000).toFixed(1)} s | ${result.longestWaitMs} ms | ${result.p95WaitMs} ms | ${result.stalls.length}${named.length ? `: ${named.slice(0, 2).join("; ")}` : ""} |`;
  });
  return [
    `### ${label}: how long the app's thread took to answer`,
    "",
    "| While | Holds | Held | Longest wait | p95 wait | App stalls logged |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

async function run(): Promise<void> {
  const app = resolve(option("app") ?? "");
  const out = resolve(option("out") ?? "");
  const label = option("label") ?? "app";
  const strict = ARGS.includes("--strict");
  if (!option("app") || !option("out")) throw new Error("--app and --out are required");
  await rm(out, { recursive: true, force: true });
  shotDir = join(out, "shots");
  await mkdir(shotDir, { recursive: true });
  const session = new Session(app, out);
  const results: ScenarioResult[] = [];
  let fatal: string | null = null;
  stopApp(app);
  try {
    results.push(await updateAtLaunch(session, app, out));
    const running = await session.launch("held");
    await focusApp(running);
    await shot("held-launch");
    const menus = await holdContextMenus(running, 3);
    results.push(summarize("menu", "A context menu held open", menus, running.probe, await stallsBetween(running.dataDir, menus[0]?.from ?? 0, Date.now())));
    const moves = await holdWindow(running, "move", 2);
    results.push(summarize("move", "The window held mid-move", moves, running.probe, await stallsBetween(running.dataDir, moves[0]?.from ?? 0, Date.now())));
    const resizes = await holdWindow(running, "resize", 2);
    results.push(summarize("resize", "The window held mid-resize", resizes, running.probe, await stallsBetween(running.dataDir, resizes[0]?.from ?? 0, Date.now())));
  } catch (error) {
    fatal = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(fatal);
    await shot("stopped");
  } finally {
    await session.close();
  }
  const version = await readJson(join(app, "Resources", "version.json")).then((info) => info.version as string).catch(() => "unknown");
  await writeFile(join(out, "results.json"), JSON.stringify({ label, version, results, fatal }, null, 2));
  const summary = table(results, `${label} (${version})`);
  console.log(summary);
  for (const result of results) for (const note of result.notes) console.log(`note: ${note}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (let launch = 1; launch <= session.launches; launch += 1) {
    await rm(join(out, "..", `profile-${basename(out)}-${launch}`), { recursive: true, force: true }).catch(() => {});
  }
  const failures = [
    ...(fatal ? [`the run stopped: ${fatal.split("\n")[0]}`] : []),
    ...results.flatMap((result) => result.notes.length && (result.id === "menu" || result.id === "update") ? result.notes : []),
    ...results.filter((result) => (result.id === "menu" || result.id === "update") && result.longestWaitMs >= STRICT_LIMIT_MS)
      .map((result) => `${result.title}: the app's thread waited ${result.longestWaitMs} ms`),
  ];
  if (failures.length) console.error(`${strict ? "Failed" : "Would fail with --strict"}:\n${failures.join("\n")}`);
  if (strict && failures.length) process.exit(1);
}

if (ARGS[0] === "run") {
  await run();
  process.exit(0);
} else {
  console.error("Usage: responsiveness.ts run --app <install dir> --out <dir> [--label <name>] [--strict]");
  process.exit(2);
}
