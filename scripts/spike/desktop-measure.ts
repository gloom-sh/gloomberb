import { existsSync, readdirSync, statSync } from "fs";
import { cp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { heavyLayout, multiWindowLayout, type SpikeLayout } from "./layouts";

/**
 *   bun scripts/spike/desktop-measure.ts --shell <name> --launch <exe> --view-html <index.html> --app-root <dir>
 *       [--launch-arg <arg>]... [--runs 6] [--out <dir>] [--window-probe <ps1|sh>] [--skip <scenario>]...
 *
 * Measures one installed desktop build the same way whatever shell it uses:
 *
 * - startup: from the moment this script starts the app until the window's
 *   page first paints anything ("paint"), shows the layout ("layout") and has
 *   drawn every pane itself ("ready"). A probe injected at the top of the
 *   view's index.html reports each change of what the page shows, with the
 *   page's own clock, over a WebSocket to 127.0.0.1 (the transport the
 *   Electrobun RPC already uses, so every webview allows it).
 * - memory: the resident memory of every process of the app (the shell, Bun,
 *   the webview's processes) 10 s after the default layout is ready and 20 s
 *   after the heavy one is, and with three windows open.
 * - window behaviour: on Windows, scripts/spike/win-window-probe.ps1 drives the
 *   real window with the mouse and keyboard (edge resize, snap, maximize,
 *   minimum size, quit) and the next launch says whether the frame came back.
 *
 * Writes results.json and summary.md under --out.
 */

type Scenario = "default" | "heavy" | "multi" | "window";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function options(name: string): string[] {
  const values: string[] = [];
  args.forEach((value, index) => { if (value === name && args[index + 1] !== undefined) values.push(args[index + 1]!); });
  return values;
}

const shell = option("--shell") ?? "unknown";
const launchPath = option("--launch");
const viewHtml = option("--view-html");
const appRoot = option("--app-root");
if (!launchPath || !viewHtml || !appRoot) {
  throw new Error("Usage: desktop-measure.ts --shell <name> --launch <exe> --view-html <index.html> --app-root <dir>");
}
const launchArgs = options("--launch-arg");
const runs = Number(option("--runs") ?? 6);
const outDir = resolve(option("--out") ?? "spike-results");
const windowProbe = option("--window-probe");
const skip = new Set(options("--skip"));
const cacheRoot = join(homedir(), ".cache", "gloom-smoke", "spike-desktop");
const platformLabel = option("--platform-label") ?? `${process.platform}-${process.arch}`;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const log = (...parts: unknown[]) => console.error(`[spike ${new Date().toISOString().slice(11, 23)}]`, ...parts);

// ---------------------------------------------------------------------------
// Probe

interface FrameState { window: string; at: number; panes: number; frame: number; loading: boolean; url: string }

function probeSource(port: number): string {
  return `(() => {
  const token = Math.random().toString(36).slice(2, 10);
  const queue = [];
  let socket = null;
  let last = "";
  const flush = () => { if (socket && socket.readyState === 1) { while (queue.length) socket.send(queue.shift()); } };
  const connect = () => {
    try {
      socket = new WebSocket("ws://127.0.0.1:${port}/probe");
      socket.onopen = flush;
      socket.onclose = () => { socket = null; setTimeout(connect, 250); };
    } catch { setTimeout(connect, 250); }
  };
  connect();
  const tick = () => {
    const panes = document.querySelectorAll("[data-gloom-pane-id]").length;
    const kind = document.querySelector("[data-gloom-boot-frame]")?.getAttribute("data-gloom-boot-frame");
    const frame = kind === "layout" ? 2 : kind ? 1 : 0;
    const loading = document.querySelector(".gloom-loading") ? 1 : 0;
    const state = panes + "," + frame + "," + loading;
    if (state !== last) {
      last = state;
      queue.push(JSON.stringify({ window: token, state, at: performance.timeOrigin + performance.now(), url: location.href }));
      flush();
    }
    if (performance.now() < 180000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
}

const PROBE_MARK = "<!--spike-probe-->";

function withoutProbe(page: string): string {
  const start = page.indexOf(PROBE_MARK);
  if (start < 0) return page;
  const end = page.indexOf(PROBE_MARK, start + PROBE_MARK.length);
  return page.slice(0, start) + page.slice(end + PROBE_MARK.length);
}

async function injectProbe(port: number): Promise<void> {
  const page = withoutProbe(await readFile(viewHtml!, "utf8"));
  const tag = `${PROBE_MARK}<script>${probeSource(port)}</script>${PROBE_MARK}`;
  const next = page.includes("<head>") ? page.replace("<head>", `<head>${tag}`) : `${tag}${page}`;
  await writeFile(viewHtml!, next);
}

async function removeProbe(): Promise<void> {
  if (existsSync(viewHtml!)) await writeFile(viewHtml!, withoutProbe(await readFile(viewHtml!, "utf8")));
}

const states: FrameState[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, srv) {
    if (new URL(request.url).pathname === "/probe" && srv.upgrade(request)) return undefined;
    return new Response("", { status: 404 });
  },
  websocket: {
    message(_ws, raw) {
      try {
        const message = JSON.parse(String(raw)) as { window: string; state: string; at: number; url: string };
        const [panes, frame, loading] = message.state.split(",").map(Number);
        states.push({ window: message.window, at: message.at, panes: panes!, frame: frame!, loading: loading === 1, url: message.url });
      } catch { /* not a probe message */ }
    },
  },
});

// ---------------------------------------------------------------------------
// Processes

interface ProcessInfo { pid: number; ppid: number; name: string; rssKb: number; privateKb: number | null; path: string | null }

async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,WorkingSetSize,PageFileUsage | ConvertTo-Json -Compress";
    const run = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]);
    const parsed = JSON.parse(run.stdout.toString() || "[]") as Array<Record<string, unknown>>;
    return parsed.map((entry) => ({
      pid: Number(entry.ProcessId),
      ppid: Number(entry.ParentProcessId),
      name: String(entry.Name ?? ""),
      rssKb: Math.round(Number(entry.WorkingSetSize ?? 0) / 1024),
      privateKb: Number(entry.PageFileUsage ?? 0),
      path: typeof entry.ExecutablePath === "string" ? entry.ExecutablePath : null,
    }));
  }
  const run = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss=,comm="]);
  return run.stdout.toString().split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    const path = match[4]!;
    return [{ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), privateKb: null, name: path.split("/").pop() ?? path, path }];
  });
}

/** WebKit's XPC services (macOS) and WebView2 (Windows) may not be children of the app. */
function isWebviewHelper(info: ProcessInfo): boolean {
  if (process.platform === "darwin") return info.name.startsWith("com.apple.WebKit.");
  if (process.platform === "win32") return info.name.toLowerCase() === "msedgewebview2.exe";
  return /^WebKit(Web|Network|GPU)Process$/.test(info.name);
}

function appProcesses(all: ProcessInfo[], rootPid: number, before: Set<number>): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const info of all) {
    const list = byParent.get(info.ppid) ?? [];
    list.push(info);
    byParent.set(info.ppid, list);
  }
  const picked = new Map<number, ProcessInfo>();
  const queue = all.filter((info) => info.pid === rootPid);
  while (queue.length) {
    const next = queue.shift()!;
    if (picked.has(next.pid)) continue;
    picked.set(next.pid, next);
    queue.push(...(byParent.get(next.pid) ?? []));
  }
  const root = resolve(appRoot!).toLowerCase();
  for (const info of all) {
    if (picked.has(info.pid) || before.has(info.pid)) continue;
    const insideApp = info.path ? resolve(info.path).toLowerCase().startsWith(root) : false;
    if (insideApp || isWebviewHelper(info)) {
      picked.set(info.pid, info);
      for (const child of byParent.get(info.pid) ?? []) if (!before.has(child.pid)) picked.set(child.pid, child);
    }
  }
  return [...picked.values()];
}

interface MemorySample { totalRssMb: number; totalPrivateMb: number | null; processes: number; byName: Record<string, number> }

async function sampleMemory(rootPid: number, before: Set<number>): Promise<MemorySample> {
  const picked = appProcesses(await listProcesses(), rootPid, before);
  const byName: Record<string, number> = {};
  let rss = 0;
  let priv = 0;
  for (const info of picked) {
    rss += info.rssKb;
    priv += info.privateKb ?? 0;
    byName[info.name] = Math.round(((byName[info.name] ?? 0) + info.rssKb / 1024) * 10) / 10;
  }
  return {
    totalRssMb: Math.round(rss / 102.4) / 10,
    totalPrivateMb: process.platform === "win32" ? Math.round(priv / 102.4) / 10 : null,
    processes: picked.length,
    byName,
  };
}

async function killApp(rootPid: number, before: Set<number>): Promise<void> {
  const picked = appProcesses(await listProcesses(), rootPid, before);
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(rootPid), "/T", "/F"]);
    for (const info of picked) Bun.spawnSync(["taskkill", "/PID", String(info.pid), "/T", "/F"]);
  } else {
    for (const info of picked.reverse()) {
      try { process.kill(info.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const left = appProcesses(await listProcesses(), rootPid, before).filter((info) => !isWebviewHelper(info) || process.platform !== "darwin");
    if (left.length === 0) return;
    await sleep(300);
  }
  log("processes still running after kill");
}

// ---------------------------------------------------------------------------
// Profiles

async function seedProfile(): Promise<string> {
  const dir = join(cacheRoot, "seed");
  if (existsSync(join(dir, "seeded"))) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const { createDefaultConfig } = await import("../../src/types/config");
  const config = { ...createDefaultConfig(dir), onboardingComplete: true, telemetry: { crashReports: false, usage: false } };
  await writeFile(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const root = resolve(join(import.meta.dir, "..", ".."));
  const restore = Bun.spawn(["bun", "-e", `const { restoreExtractedPlugins } = await import(${JSON.stringify(join(root, "src/cli/restore-plugins.ts"))}); await restoreExtractedPlugins();`], {
    env: { ...process.env, GLOOMBERB_HOME: dir },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await restore.exited !== 0) log("plugin seeding failed; continuing with what is there");
  await writeFile(join(dir, "seeded"), "");
  return dir;
}

async function profile(name: string, seed: string, layout?: SpikeLayout): Promise<string> {
  const dir = join(cacheRoot, `profile-${name}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const config = JSON.parse(await readFile(join(seed, "config.json"), "utf8"));
  const next = layout
    ? { ...config, dataDir: dir, layout, layouts: [{ name: "Spike", layout, paneState: {} }], activeLayoutIndex: 0 }
    : { ...config, dataDir: dir };
  await writeFile(join(dir, "config.json"), `${JSON.stringify(next, null, 2)}\n`);
  if (existsSync(join(seed, "plugins"))) await cp(join(seed, "plugins"), join(dir, "plugins"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Runs

interface Launch { pid: number; startedAt: number; before: Set<number>; child: ReturnType<typeof Bun.spawn> }

async function launch(home: string, label: string): Promise<Launch> {
  const before = new Set((await listProcesses()).map((info) => info.pid));
  states.length = 0;
  const logDir = join(outDir, "logs");
  await mkdir(logDir, { recursive: true });
  const startedAt = Date.now();
  const child = Bun.spawn([launchPath!, ...launchArgs], {
    cwd: resolve(launchPath!, ".."),
    env: {
      ...process.env,
      GLOOMBERB_HOME: home,
      GLOOMBERB_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      ELECTROBUN_CONSOLE: "1",
    },
    stdout: Bun.file(join(logDir, `${label}.out.txt`)),
    stderr: Bun.file(join(logDir, `${label}.err.txt`)),
  });
  return { pid: child.pid, startedAt, before, child };
}

interface StartupTimes { paintMs: number; layoutMs: number; readyMs: number; panes: number }

/** The first window's timeline once it has settled: its pane count stops changing. */
async function waitReady(launched: Launch, quietMs: number, timeoutMs: number, window?: string): Promise<StartupTimes> {
  const deadline = Date.now() + timeoutMs;
  let seen = -1;
  let lastChange = Date.now();
  const pick = () => {
    const first = window ?? states[0]?.window;
    return first ? states.filter((state) => state.window === first) : [];
  };
  while (Date.now() < deadline) {
    const mine = pick();
    if (mine.length !== seen) {
      seen = mine.length;
      lastChange = Date.now();
    }
    const latest = mine.at(-1);
    if (latest && latest.panes > 0 && !latest.frame && !latest.loading && Date.now() - lastChange > quietMs) break;
    if (launched.child.exitCode !== null && mine.length === 0) throw new Error(`the app exited with ${launched.child.exitCode} before it drew`);
    await sleep(50);
  }
  const mine = pick();
  const latest = mine.at(-1);
  if (!latest || latest.panes === 0) throw new Error(`the page never drew a pane (${mine.length} probe reports)`);
  const sorted = [...mine].sort((left, right) => left.at - right.at);
  const ready = sorted.find((state) => state.panes >= latest.panes && !state.frame && !state.loading)!;
  const layout = sorted.find((state) => state.frame === 2 || state.panes >= latest.panes) ?? ready;
  const paint = sorted.find((state) => state.frame > 0 || state.loading || state.panes > 0) ?? ready;
  return {
    paintMs: Math.round(paint.at - launched.startedAt),
    layoutMs: Math.round(layout.at - launched.startedAt),
    readyMs: Math.round(ready.at - launched.startedAt),
    panes: latest.panes,
  };
}

interface RunRecord extends Partial<StartupTimes> { scenario: Scenario; run: number; memory?: MemorySample; error?: string; windows?: number; allWindowsReadyMs?: number; windowFrames?: unknown }

/** Every top-level window of the app and where it is (Windows and Linux). */
async function listWindows(launched: Launch): Promise<unknown> {
  if (!windowProbe || process.platform === "darwin") return null;
  const pids = appProcesses(await listProcesses(), launched.pid, launched.before).map((info) => info.pid);
  const out = join(outDir, `windows-${Date.now()}.json`);
  const command = process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowProbe, "-Pids", pids.join(","), "-Out", out, "-ListOnly"]
    : ["bash", windowProbe, pids.join(","), out, "", "--list"];
  const run = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  await Promise.race([run.exited, sleep(60_000)]);
  return existsSync(out) ? JSON.parse(await readFile(out, "utf8")) : null;
}
const records: RunRecord[] = [];
const notes: string[] = [];

async function runScenario(scenario: Scenario, home: string, run: number, settleMs: number, quietMs: number): Promise<void> {
  const label = `${scenario}-${run}`;
  log(`launch ${label}`);
  const launched = await launch(home, label);
  const record: RunRecord = { scenario, run };
  try {
    Object.assign(record, await waitReady(launched, quietMs, 120_000));
    log(`${label}: paint ${record.paintMs} ms, layout ${record.layoutMs} ms, ready ${record.readyMs} ms, ${record.panes} panes`);
    if (scenario === "multi") {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && new Set(states.map((state) => state.window)).size < 3) await sleep(100);
      const windows = [...new Set(states.map((state) => state.window))];
      record.windows = windows.length;
      let last = 0;
      for (const window of windows) {
        try {
          const times = await waitReady(launched, quietMs, 30_000, window);
          last = Math.max(last, times.readyMs);
        } catch (error) {
          record.error = `window ${window}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      record.allWindowsReadyMs = last;
      log(`${label}: ${record.windows} windows, all ready at ${last} ms`);
      record.windowFrames = await listWindows(launched);
    }
    await sleep(settleMs);
    record.memory = await sampleMemory(launched.pid, launched.before);
    log(`${label}: ${record.memory.totalRssMb} MB resident over ${record.memory.processes} processes`);
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    log(`${label} failed: ${record.error}`);
  } finally {
    records.push(record);
    await killApp(launched.pid, launched.before);
    await sleep(1500);
  }
}

interface WindowResult { probe?: unknown; reopen?: unknown; error?: string }
const windowResult: WindowResult = {};

async function runWindowProbe(home: string): Promise<void> {
  if (!windowProbe) return;
  log("launch window probe");
  const launched = await launch(home, "window-1");
  try {
    await waitReady(launched, 2500, 120_000);
    await sleep(2000);
    const pids = appProcesses(await listProcesses(), launched.pid, launched.before).map((info) => info.pid);
    const out = join(outDir, "window-probe.json");
    const command = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowProbe, "-Pids", pids.join(","), "-Out", out, "-ScreenshotDir", join(outDir, "window-shots")]
      : ["bash", windowProbe, pids.join(","), out, join(outDir, "window-shots")];
    const probe = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
    const code = await Promise.race([probe.exited, sleep(240_000).then(() => -1)]);
    if (code === -1) probe.kill();
    windowResult.probe = existsSync(out) ? JSON.parse(await readFile(out, "utf8")) : { error: `probe exited ${code} without a result` };
  } catch (error) {
    windowResult.error = error instanceof Error ? error.message : String(error);
  } finally {
    await killApp(launched.pid, launched.before);
    await sleep(1500);
  }
  // Reopen: does the frame the probe left come back?
  if (process.platform !== "win32") return;
  const reopened = await launch(home, "window-2");
  try {
    await waitReady(reopened, 2500, 120_000);
    await sleep(1500);
    const pids = appProcesses(await listProcesses(), reopened.pid, reopened.before).map((info) => info.pid);
    const out = join(outDir, "window-reopen.json");
    const probe = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowProbe, "-Pids", pids.join(","), "-Out", out, "-FrameOnly"], { stdout: "inherit", stderr: "inherit" });
    await probe.exited;
    windowResult.reopen = existsSync(out) ? JSON.parse(await readFile(out, "utf8")) : null;
  } catch (error) {
    windowResult.reopen = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await killApp(reopened.pid, reopened.before);
  }
}

// ---------------------------------------------------------------------------
// Sizes

function folderBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path)) {
    try { total += folderBytes(join(path, entry)); } catch { /* unreadable */ }
  }
  return total;
}

// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function summarize(): string {
  const lines = [`## ${shell} on ${platformLabel}`, ""];
  const pick = (scenario: Scenario, from = 0) => records.filter((record) => record.scenario === scenario && record.run >= from && !record.error);
  const row = (label: string, list: RunRecord[]) => {
    const rss = median(list.map((record) => record.memory?.totalRssMb ?? NaN));
    const priv = median(list.map((record) => record.memory?.totalPrivateMb ?? NaN));
    lines.push(`| ${label} | ${list.length} | ${median(list.map((r) => r.paintMs!)) ?? "-"} | ${median(list.map((r) => r.layoutMs!)) ?? "-"} | ${median(list.map((r) => r.readyMs!)) ?? "-"} | ${rss ?? "-"} | ${priv ?? "-"} |`);
  };
  lines.push("| scenario | runs | paint ms | layout ms | ready ms | resident MB | private MB |", "|---|---|---|---|---|---|---|");
  row("first launch (default layout)", pick("default").filter((record) => record.run === 1));
  row("warm launch (default layout)", pick("default", 2));
  row("heavy layout", pick("heavy"));
  const multi = pick("multi");
  row("three windows", multi);
  if (multi.length) lines.push("", `Three windows: ${multi.map((record) => `${record.windows} windows, all ready ${record.allWindowsReadyMs} ms`).join("; ")}`);
  const failed = records.filter((record) => record.error);
  if (failed.length) lines.push("", "Failures:", ...failed.map((record) => `- ${record.scenario} ${record.run}: ${record.error}`));
  lines.push("", `App folder: ${(folderBytes(appRoot!) / 1e6).toFixed(1)} MB (${appRoot})`);
  if (notes.length) lines.push("", ...notes.map((note) => `- ${note}`));
  return lines.join("\n");
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await injectProbe(server.port!);
  try {
    const seed = await seedProfile();
    const base = JSON.parse(await readFile(join(seed, "config.json"), "utf8")).layout as SpikeLayout;
    if (!skip.has("default")) {
      const home = await profile("default", seed);
      for (let run = 1; run <= runs; run += 1) await runScenario("default", home, run, 10_000, 2500);
    }
    if (!skip.has("heavy")) {
      const home = await profile("heavy", seed, heavyLayout());
      // The first launch fills the caches; the rest are measured the same way.
      for (let run = 1; run <= 3; run += 1) await runScenario("heavy", home, run, 20_000, 4000);
    }
    if (!skip.has("multi")) {
      // The second window is placed past a 1920 px wide first screen: on a
      // second screen where there is one (Linux runs two), off-screen otherwise.
      const frames = [{ x: 80, y: 80, width: 640, height: 420 }, { x: 2200, y: 120, width: 640, height: 420 }];
      const home = await profile("multi", seed, multiWindowLayout(base, frames));
      for (let run = 1; run <= 2; run += 1) await runScenario("multi", home, run, 10_000, 2500);
    }
    if (!skip.has("window") && windowProbe) {
      const home = await profile("window", seed);
      await runWindowProbe(home);
    }
  } finally {
    await removeProbe();
    server.stop(true);
  }
  const summary = summarize();
  const result = {
    shell,
    platform: platformLabel,
    os: `${process.platform}-${process.arch}`,
    appRootBytes: folderBytes(appRoot!),
    records,
    window: windowResult,
    at: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  };
  await writeFile(join(outDir, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(outDir, "summary.md"), `${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: "a" });
  console.log(summary);
  process.exit(0);
}

await main();
