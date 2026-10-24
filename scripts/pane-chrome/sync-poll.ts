import { mkdir, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { cacheDir } from "./browser";

/**
 * How long one Cloud sync blocks the desktop view's main thread on a large
 * workspace, in Playwright WebKit (the engine of the macOS app). Each poll
 * runs the real sync controller and core contributors over the real
 * view-side transport (preload codec, RPC and proxy decoding); see
 * `sync-poll-fixture.ts`. Three kinds of poll, each repeated:
 *
 * - idle: nothing changed here or in the cloud, the 15 s timer's usual case;
 * - quotes: quotes moved since the last sync (a refresh during market hours);
 * - layout: the workspace changed (a layout switch), so the sync pushes.
 *
 * Then a 4 MB message each way through the preload codec alone, the size of
 * a long chart history or a large workspace's snapshot.
 *
 * The block is the longest stretch the page ran no task of its own (a 0 ms
 * timer loop), so it is the freeze a click or a frame would have waited out.
 *
 * bun scripts/pane-chrome/sync-poll.ts [--chromium] [--repeat 5] [--check] [--label sync-poll]
 *   [--positions 300 --tickers 1200 --days 500 --layouts 10 --panes 12] [--preload <compiled.ts>]
 * `--preload` measures another build of Electrobun's preload (its
 * `.generated/compiled.ts`), such as an unpatched one.
 * Samples go to PANE_CHROME_CACHE/<label>.
 */
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]! : fallback);
const repeat = Number(option("repeat", "5"));
const label = option("label", "sync-poll");
const check = args.includes("--check");
const engine = args.includes("--chromium") ? "chromium" : "webkit";
const sizes = Object.fromEntries(["positions", "tickers", "days", "layouts", "panes"].map((name) => [name, option(name, "")]).filter(([, value]) => value));

/**
 * Longest block per kind of sync, median over the repeats. With 300
 * holdings, before their returns were kept with their bars, an
 * idle sync blocked for 115 to 160 ms, a repriced one 110 to 175 ms and an
 * edited one 120 to 155 ms; after, 20 to 35 ms each. The budgets sit
 * between, with room for a slower runner.
 */
const BUDGET_MS: Record<string, number> = { idle: 70, quotes: 70, layout: 90 };
/**
 * A 4 MB message each way through Electrobun's preload codec, the size of a
 * long chart history or a large workspace: about 90 ms with the preload as
 * released, 13 to 15 ms with native base64.
 */
const CODEC_BYTES = 4 * 1024 * 1024;
const CODEC_BUDGET_MS = 50;

const root = resolve(import.meta.dir, "../..");
const out = cacheDir(label);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "sync-poll-fixture.ts")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": "\"production\"" },
});
if (!build.success) throw new AggregateError(build.logs, "Could not build the sync poll page");
const script = await build.outputs[0]!.text();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/page.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
    return new Response(`<!doctype html><meta charset="utf-8"><title>sync poll</title><script type="module" src="/page.js"></script>`, { headers: { "content-type": "text/html" } });
  },
});

const playwright = await import("playwright-core");
const browser = await playwright[engine].launch({ headless: true });
const results: Record<string, Array<{ blockMs: number; totalMs: number; pushed: boolean }>> = { idle: [], quotes: [], layout: [] };
const codecSamples: Array<{ blockMs: number; totalMs: number }> = [];
let workspace: Record<string, number> = {};
try {
  const context = await browser.newContext();
  // As the native side does: the window's key, then Electrobun's preload.
  const { preloadScript } = await import(resolve(option("preload", join(root, "node_modules/electrobun/dist/api/bun/preload/.generated/compiled.ts"))));
  await context.addInitScript({ content: `window.__electrobunSecretKeyBytes = ${JSON.stringify(Array.from(crypto.getRandomValues(new Uint8Array(32))))};` });
  await context.addInitScript({ content: preloadScript });
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const query = new URLSearchParams(sizes as Record<string, string>).toString();
  await page.goto(`http://127.0.0.1:${server.port}/${query ? `?${query}` : ""}`);
  await page.waitForFunction("window.__syncPoll?.ready === true || document.title.startsWith('error')", null, { timeout: 120_000 });
  if (errors.length || (await page.title()).startsWith("error")) throw new Error(`the page failed: ${errors.join("; ") || await page.title()}`);
  workspace = await page.evaluate("window.__syncPoll.sizes") as Record<string, number>;
  // One of each first, so the JIT has seen every path before anything counts.
  for (const kind of ["idle", "quotes", "layout"]) await page.evaluate(`window.__syncPoll.poll(${JSON.stringify(kind)})`);
  for (let round = 0; round < repeat; round++) {
    for (const kind of ["idle", "quotes", "layout"] as const) {
      results[kind]!.push(await page.evaluate(`window.__syncPoll.poll(${JSON.stringify(kind)})`) as { blockMs: number; totalMs: number; pushed: boolean });
    }
  }
  for (let round = 0; round <= repeat; round++) {
    const sample = await page.evaluate(`window.__syncPoll.codec(${CODEC_BYTES})`) as { blockMs: number; totalMs: number };
    if (round > 0) codecSamples.push(sample);
  }
  if (errors.length) throw new Error(`the page failed: ${errors.join("; ")}`);
} finally {
  await browser.close();
  server.stop(true);
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
console.log(`${engine}: ${workspace.positions} positions, ${workspace.tickers} tickers, ${workspace.days} days of bars, snapshot ${Math.round((workspace.snapshotBytes ?? 0) / 1024)} KB`);
const failures: string[] = [];
for (const [kind, samples] of Object.entries(results)) {
  const blocks = samples.map((sample) => sample.blockMs);
  const blocked = median(blocks);
  console.log(`${kind.padEnd(7)} longest block min ${Math.min(...blocks)} / median ${blocked} / max ${Math.max(...blocks)} ms; whole sync median ${median(samples.map((sample) => sample.totalMs))} ms; pushed ${samples.filter((sample) => sample.pushed).length}/${samples.length}`);
  if (blocked > BUDGET_MS[kind]!) failures.push(`${kind} poll blocked the main thread for ${blocked} ms (budget ${BUDGET_MS[kind]} ms)`);
}
const codecBlocks = codecSamples.map((sample) => sample.blockMs);
console.log(`codec   4 MB each way, longest block min ${Math.min(...codecBlocks)} / median ${median(codecBlocks)} / max ${Math.max(...codecBlocks)} ms`);
if (median(codecBlocks) > CODEC_BUDGET_MS) failures.push(`a 4 MB message through the preload codec blocked the main thread for ${median(codecBlocks)} ms (budget ${CODEC_BUDGET_MS} ms)`);
// An unchanged workspace must not be uploaded again, and a changed one must be.
if (results.idle!.some((sample) => sample.pushed)) failures.push("an idle poll pushed the snapshot");
if (!results.layout!.every((sample) => sample.pushed)) failures.push("a layout switch was not pushed");
await writeFile(join(out, "samples.json"), JSON.stringify({ engine, workspace, results, codec: codecSamples }, null, 2));
if (check && failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
if (check) console.log("sync poll budget: ok");
