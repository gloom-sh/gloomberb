import { existsSync, readdirSync } from "fs";
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { gzipSync } from "zlib";
import { launchBrowser, sleep } from "./pane-chrome/browser";
import { median, positiveInteger, runTmux, shellQuote, takeOption } from "./tui-benchmark-harness";

/**
 *   bun scripts/benchmark-startup.ts <tui|desktop|web> --base <checkout> [--runs 7] [--cold] [--binary] [--build]
 *
 * Launch to an interactive layout, on this checkout and a base, in turns so a
 * machine that slows down mid-run slows both. Each run is timed from the moment
 * the harness starts the app until the panes of the layout are drawn:
 *
 * - tui: `bun src/cli/entry.ts` in tmux, or with `--binary` the release
 *   binary each checkout's `scripts/build.ts` makes; ready when the screen
 *   shows the seeded layout's panes.
 * - desktop: the Electrobun dev build in `build/` (`--build` makes it), under
 *   its own Xvfb display (Linux only).
 * - web: `dist/web` (`--build` runs `bun run web:build`), served on 127.0.0.1
 *   with `/api` forwarded to Gloom Cloud like the Worker, in Chrome headless.
 *
 * Desktop and web pages carry a probe that reports, every frame, how many
 * panes are drawn and whether the page shows a loading screen or the frame
 * a launch draws before the app is up (the last layout, or the bare shell).
 * Three times come out of it: "paint" is the first frame showing anything of
 * the app; "layout" is the first frame showing the layout, as a launch frame
 * or drawn; "ready" is the first frame with every pane drawn by the app.
 *
 * Warm runs reuse one profile that has launched before. `--cold` starts each
 * run from a profile that never launched (the config and plugins only) and,
 * for the views, with no browser cache or storage. Profiles live under
 * ~/.cache/gloom-smoke/startup-benchmark.
 */

type Target = "tui" | "desktop" | "web";
type Side = "base" | "head";

interface RunResult {
  /** First frame showing anything of the app: loading text, the bare shell, the layout. Equal to ready on the terminal. */
  paintMs: number;
  /** First frame showing the layout, as a launch frame or drawn. Equal to ready on the terminal. */
  layoutMs: number;
  /** First frame with every pane drawn by the app. */
  readyMs: number;
}

const args = process.argv.slice(2);
const target = args[0] as Target;
if (!["tui", "desktop", "web"].includes(target)) {
  throw new Error("Usage: benchmark-startup.ts <tui|desktop|web> --base <checkout> [--runs 7] [--cold] [--binary] [--build]");
}
const baseRoot = takeOption(args, "--base");
if (!baseRoot) throw new Error("--base <checkout> is required");
const roots: Record<Side, string> = { base: resolve(baseRoot), head: resolve(join(import.meta.dir, "..")) };
const runs = positiveInteger(takeOption(args, "--runs"), 7, "runs");
const cold = args.includes("--cold");
const binary = args.includes("--binary");
const build = args.includes("--build");
const cacheRoot = join(homedir(), ".cache", "gloom-smoke", "startup-benchmark");
const READY_TIMEOUT_MS = 60_000;
const results: Record<Side, RunResult[]> = { base: [], head: [] };
const prepared: Record<Side, unknown> = { base: null, head: null };
let seed = "";

/**
 * A profile that has the config and the official plugins a first launch
 * installs, so no run pays for cloning them. Made once from this checkout.
 */
async function seedProfile(): Promise<string> {
  const dir = join(cacheRoot, "seed");
  if (existsSync(join(dir, "plugins"))) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const { createDefaultConfig } = await import("../src/types/config");
  await writeFile(join(dir, "config.json"), `${JSON.stringify({ ...createDefaultConfig(dir), onboardingComplete: true }, null, 2)}\n`);
  const restore = Bun.spawn(["bun", "-e", `const { restoreExtractedPlugins } = await import(${JSON.stringify(join(roots.head, "src/cli/restore-plugins.ts"))}); await restoreExtractedPlugins();`], {
    env: { ...process.env, GLOOMBERB_HOME: dir },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await restore.exited !== 0) throw new Error("Seeding the plugins failed");
  return dir;
}

/** A profile for one run: the seed's config and plugins, under a fresh folder when cold. */
async function profileFor(side: Side, run: number): Promise<string> {
  const dir = join(cacheRoot, cold ? `${target}-${side}-cold-${run}` : `${target}-${side}-warm`);
  if (!cold && existsSync(join(dir, "config.json"))) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const config = JSON.parse(await readFile(join(seed, "config.json"), "utf8"));
  await writeFile(join(dir, "config.json"), `${JSON.stringify({ ...config, dataDir: dir }, null, 2)}\n`);
  // Hard links: the plugins are large, and a launch only rewrites their links.
  const copy = Bun.spawnSync(["cp", "-al", join(seed, "plugins"), join(dir, "plugins")]);
  if (copy.exitCode !== 0) await cp(join(seed, "plugins"), join(dir, "plugins"), { recursive: true });
  return dir;
}

async function prepare(side: Side): Promise<unknown> {
  const root = roots[side];
  if (target === "tui") {
    if (!binary) return null;
    const run = Bun.spawn(["bun", "run", "scripts/build.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (await run.exited !== 0) throw new Error(`The release build failed in ${root}`);
    const archive = join(root, "dist", `gloomberb-linux-${process.arch === "arm64" ? "arm64" : "x64"}.gz`);
    const out = join(cacheRoot, `gloomberb-${side}`);
    await writeFile(out, Bun.gunzipSync(new Uint8Array(await Bun.file(archive).arrayBuffer())));
    Bun.spawnSync(["chmod", "+x", out]);
    return out;
  }
  if (target === "desktop") {
    if (process.platform !== "linux") throw new Error("The desktop benchmark runs the Linux build under Xvfb.");
    if (build || !findDesktopApp(root)) {
      const run = Bun.spawn(["node", "node_modules/electrobun/bin/electrobun.cjs", "build"], { cwd: root, stdout: "ignore", stderr: "inherit" });
      if (await run.exited !== 0) throw new Error(`electrobun build failed in ${root}`);
    }
    return findDesktopApp(root);
  }
  if (build || !existsSync(join(root, "dist", "web", "index.html"))) {
    const run = Bun.spawn(["bun", "run", "web:build"], { cwd: root, stdout: "ignore", stderr: "inherit" });
    if (await run.exited !== 0) throw new Error(`web:build failed in ${root}`);
  }
  return join(root, "dist", "web");
}

async function cleanup(side: Side): Promise<void> {
  if (target === "desktop" && typeof prepared[side] === "string") await removeProbe(prepared[side] as string);
  if (target === "web") await closeWeb();
}

async function runOnce(side: Side, run: number): Promise<RunResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (target === "tui") return await runTui(side, run);
      if (target === "desktop") return await runDesktop(side, run);
      return await runWeb(side, run);
    } catch (error) {
      if (attempt === 3) throw error;
      console.error(`${side} ${run}: ${error instanceof Error ? error.message : String(error)}; retrying`);
    }
  }
}

async function runTui(side: Side, run: number): Promise<RunResult> {
  const home = await profileFor(side, run);
  const session = `gloom-startup-${process.pid}`;
  const transpilerCache = join(cacheRoot, `transpiler-${side}`);
  if (cold) await rm(transpilerCache, { recursive: true, force: true });
  const command = binary ? shellQuote(prepared[side] as string) : `bun ${shellQuote(join(roots[side], "src/cli/entry.ts"))}`;
  await runTmux(["kill-session", "-t", session], false);
  const started = performance.now();
  await runTmux([
    "new-session", "-d", "-s", session, "-x", "200", "-y", "50",
    `env GLOOMBERB_HOME=${shellQuote(home)} BUN_RUNTIME_TRANSPILER_CACHE_PATH=${shellQuote(transpilerCache)} ${command} 2>/dev/null; sleep 60`,
  ]);
  try {
    const deadline = started + READY_TIMEOUT_MS;
    while (performance.now() < deadline) {
      const capture = Bun.spawnSync(["tmux", "capture-pane", "-p", "-t", session]);
      const screen = capture.stdout.toString();
      // The seeded layout: the portfolio, the ticker linked to it and the status bar.
      if (screen.includes("No tickers.") && screen.includes("No tickers in Main Portfolio") && screen.includes("Home")) {
        const readyMs = performance.now() - started;
        return { paintMs: readyMs, layoutMs: readyMs, readyMs };
      }
      await sleep(10);
    }
    throw new Error("The terminal did not draw its layout in time");
  } finally {
    await runTmux(["kill-session", "-t", session], false);
    if (cold) await rm(home, { recursive: true, force: true });
  }
}

/**
 * Reports what each frame shows: how many panes are drawn, whether the
 * launch frame is up and whether a loading screen is. Runs before anything
 * else on the page, at every animation frame for the first minute.
 */
function probeSource(origin: string): string {
  return `(() => {
  const beacons = [];
  let last = "";
  const tick = () => {
    const panes = document.querySelectorAll("[data-gloom-pane-id]").length;
    const kind = document.querySelector("[data-gloom-boot-frame]")?.getAttribute("data-gloom-boot-frame");
    const frame = kind === "layout" ? 2 : kind ? 1 : 0;
    const loading = document.querySelector(".gloom-loading") ? 1 : 0;
    const state = panes + "," + frame + "," + loading;
    if (state !== last) {
      last = state;
      const image = new Image();
      image.src = ${JSON.stringify(origin)} + "/__startup?state=" + state + "&t=" + (performance.timeOrigin + performance.now());
      beacons.push(image);
    }
    if (performance.now() < 60000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;
}

/** `frame`: 0 none, 1 the bare shell, 2 the last layout. */
interface FrameState { at: number; panes: number; frame: number; loading: boolean }

/** Collects probe reports; for the web it also serves the build and forwards `/api`. */
function startServer(webRoot: string | null) {
  const states: FrameState[] = [];
  const gzipped = new Map<string, ArrayBuffer>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__startup") {
        const [panes, frame, loading] = (url.searchParams.get("state") ?? "0,0,0").split(",").map(Number);
        states.push({ at: Number(url.searchParams.get("t")), panes: panes!, frame: frame!, loading: loading === 1 });
        return new Response("", { headers: { "cache-control": "no-store" } });
      }
      if (!webRoot) return new Response("", { status: 404 });
      if (url.pathname.startsWith("/api/")) {
        const upstream = new URL(url.pathname.slice(4) + url.search, "https://api.gloom.sh");
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("origin");
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        const response = await fetch(upstream, { method: request.method, headers, body, redirect: "manual" });
        const outHeaders = new Headers(response.headers);
        outHeaders.delete("content-encoding");
        outHeaders.delete("content-length");
        return new Response(await response.arrayBuffer(), { status: response.status, headers: outHeaders });
      }
      const path = url.pathname === "/" || !url.pathname.includes(".") ? "/index.html" : url.pathname;
      const file = Bun.file(join(webRoot, path));
      if (!(await file.exists())) return new Response("", { status: 404 });
      // Compressed and cached the way the Worker serves assets, so a throttled
      // run downloads what a visitor does.
      let body = gzipped.get(path);
      if (!body) {
        const zipped = gzipSync(new Uint8Array(await file.arrayBuffer()), { level: 6 });
        body = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
        gzipped.set(path, body);
      }
      return new Response(body, {
        headers: {
          "content-type": file.type,
          "content-encoding": "gzip",
          "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, states, stop: () => server.stop(true) };
}

/** Reads the probe's timeline once it has settled: the layout's pane count stops changing. */
async function settledResult(states: FrameState[], startedAt: number): Promise<RunResult> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastChange = Date.now();
  let seen = 0;
  while (Date.now() < deadline) {
    if (states.length !== seen) {
      seen = states.length;
      lastChange = Date.now();
    }
    const latest = states.at(-1);
    if (latest && latest.panes > 0 && !latest.frame && !latest.loading && Date.now() - lastChange > 2_500) break;
    await sleep(50);
  }
  const latest = states.at(-1);
  if (!latest || latest.panes === 0) throw new Error("The page never drew a pane");
  const sorted = [...states].sort((left, right) => left.at - right.at);
  const ready = sorted.find((state) => state.panes >= latest.panes && !state.frame && !state.loading)!;
  const layout = sorted.find((state) => state.frame === 2 || state.panes >= latest.panes) ?? ready;
  const paint = sorted.find((state) => state.frame > 0 || state.loading || state.panes > 0) ?? ready;
  return {
    paintMs: Math.round(paint.at - startedAt),
    layoutMs: Math.round(layout.at - startedAt),
    readyMs: Math.round(ready.at - startedAt),
  };
}

function findDesktopApp(root: string): string | null {
  const dir = join(root, "build", `dev-linux-${process.arch === "arm64" ? "arm64" : "x64"}`);
  if (!existsSync(dir)) return null;
  const app = readdirSync(dir).find((name) => existsSync(join(dir, name, "bin", "launcher")));
  return app ? join(dir, app) : null;
}

const PROBE_MARK = "<!--startup-probe-->";

async function injectProbe(app: string, origin: string): Promise<void> {
  const html = join(app, "Resources", "app", "views", "mainview", "index.html");
  const page = await removeProbeFrom(await readFile(html, "utf8"));
  await writeFile(html, page.replace("<head>", `<head>${PROBE_MARK}<script>${probeSource(origin)}</script>${PROBE_MARK}`));
}

async function removeProbeFrom(page: string): Promise<string> {
  const start = page.indexOf(PROBE_MARK);
  if (start < 0) return page;
  const end = page.indexOf(PROBE_MARK, start + PROBE_MARK.length);
  return page.slice(0, start) + page.slice(end + PROBE_MARK.length);
}

async function removeProbe(app: string): Promise<void> {
  const html = join(app, "Resources", "app", "views", "mainview", "index.html");
  if (existsSync(html)) await writeFile(html, await removeProbeFrom(await readFile(html, "utf8")));
}

let display: { name: string; process: ReturnType<typeof Bun.spawn> } | null = null;

async function xvfbDisplay(): Promise<string> {
  if (display) return display.name;
  for (let number = 90 + (process.pid % 50); number < 200; number += 1) {
    if (existsSync(`/tmp/.X11-unix/X${number}`) || existsSync(`/tmp/.X${number}-lock`)) continue;
    const xvfb = Bun.spawn(["Xvfb", `:${number}`, "-screen", "0", "1440x900x24", "-nolisten", "tcp"], { stdout: "ignore", stderr: "ignore" });
    await sleep(500);
    if (xvfb.exitCode === null) {
      display = { name: `:${number}`, process: xvfb };
      process.on("exit", () => xvfb.kill());
      return display.name;
    }
  }
  throw new Error("No free X display for Xvfb");
}

async function runDesktop(side: Side, run: number): Promise<RunResult> {
  const app = prepared[side] as string;
  const home = await profileFor(side, run);
  const server = startServer(null);
  const webkitCache = join(cacheRoot, cold ? `webkit-${side}-cold-${run}` : `webkit-${side}-warm`);
  await injectProbe(app, server.origin);
  const startedAt = Date.now();
  const launcher = Bun.spawn([join(app, "bin", "launcher")], {
    cwd: join(app, "bin"),
    env: {
      ...process.env,
      DISPLAY: await xvfbDisplay(),
      GLOOMBERB_HOME: home,
      XDG_CACHE_HOME: webkitCache,
      XDG_DATA_HOME: join(webkitCache, "data"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    return await settledResult(server.states, startedAt);
  } finally {
    launcher.kill();
    await launcher.exited;
    // The app runs in a child of the launcher; wait for its window to go.
    Bun.spawnSync(["pkill", "-f", join(app, "Resources", "main.js")]);
    await sleep(500);
    server.stop();
    if (cold) {
      await rm(home, { recursive: true, force: true });
      await rm(webkitCache, { recursive: true, force: true });
    }
  }
}

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
const webSides = new Map<Side, { server: ReturnType<typeof startServer>; browser: Browser | null }>();

/** One server per side for the whole benchmark: the origin, and with it the cache and storage, stays put. */
function webSide(side: Side) {
  let entry = webSides.get(side);
  if (!entry) {
    entry = { server: startServer(prepared[side] as string), browser: null };
    webSides.set(side, entry);
  }
  return entry;
}

async function openBrowser(side: Side): Promise<Browser> {
  const entry = webSide(side);
  const opened = await launchBrowser(`startup-${side}`, 1440, 900);
  await opened.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: probeSource(entry.server.origin) });
  return opened;
}

async function visit(side: Side, browser: Browser): Promise<RunResult> {
  const { server } = webSide(side);
  server.states.length = 0;
  const loaded = browser.cdp.once("Page.loadEventFired", READY_TIMEOUT_MS);
  await browser.cdp.send("Page.navigate", { url: `${server.origin}/` });
  await loaded;
  const origin = await browser.cdp.send("Runtime.evaluate", { expression: "performance.timeOrigin", returnByValue: true });
  return settledResult(server.states, origin.result.value as number);
}

async function runWeb(side: Side, _run: number): Promise<RunResult> {
  const entry = webSide(side);
  // Cold: a new browser, with no cache and no saved workspace. Warm: one
  // browser per side, kept open, whose first visit is not timed.
  if (cold) {
    const fresh = await openBrowser(side);
    try {
      return await visit(side, fresh);
    } finally {
      await fresh.close();
    }
  }
  if (!entry.browser) {
    entry.browser = await openBrowser(side);
    await visit(side, entry.browser);
  }
  return visit(side, entry.browser);
}

async function closeWeb(): Promise<void> {
  for (const entry of webSides.values()) {
    await entry.browser?.close();
    entry.server.stop();
  }
  webSides.clear();
}

async function main(): Promise<void> {
  await mkdir(cacheRoot, { recursive: true });
  seed = await seedProfile();
  for (const side of ["base", "head"] as const) prepared[side] = await prepare(side);

  try {
    for (let run = 1; run <= runs; run += 1) {
      for (const side of ["base", "head"] as const) {
        const result = await runOnce(side, run);
        results[side].push(result);
        console.error(`${target} ${cold ? "cold" : "warm"} ${side} ${run}/${runs}: paint ${result.paintMs} ms, layout ${result.layoutMs} ms, ready ${result.readyMs} ms`);
      }
    }
  } finally {
    for (const side of ["base", "head"] as const) await cleanup(side);
  }

  const summary = (side: Side, pick: (result: RunResult) => number) => {
    const values = results[side].map(pick);
    return `${Math.round(median(values))} ms (${Math.round(Math.min(...values))} to ${Math.round(Math.max(...values))})`;
  };
  const lines = [
    `### Startup, ${target}${binary ? " (release binary)" : ""}, ${cold ? "cold" : "warm"}`,
    "",
    `Middle value of ${runs} alternating runs per side, range in brackets.`,
    "",
    "| | base | this checkout |",
    "|---|---|---|",
    ...(target === "tui" ? [] : [
      `| first paint | ${summary("base", (r) => r.paintMs)} | ${summary("head", (r) => r.paintMs)} |`,
      `| layout on screen | ${summary("base", (r) => r.layoutMs)} | ${summary("head", (r) => r.layoutMs)} |`,
    ]),
    `| panes drawn | ${summary("base", (r) => r.readyMs)} | ${summary("head", (r) => r.readyMs)} |`,
  ];
  const markdown = `${lines.join("\n")}\n`;
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
}

await main();
process.exit(process.exitCode ?? 0);
