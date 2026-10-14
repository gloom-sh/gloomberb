import { appendFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir, click, evaluate, launchBrowser, type Cdp } from "./browser";
import { LAYOUT_SIZES } from "./layout-checks";
import { LAYOUT_MEASURE, layoutFailures, type LayoutMeasure } from "./layout-measure";
import { createReplay, discover, fallbackInstance, key, loadLayout, readCatalog, routeDirectReads, serveWebApp, settle, shot } from "./web-app";

/**
 * Every function in the catalog on the real web build, docked and floating, at
 * three window sizes, with its detail opened where Enter opens one and, docked,
 * each of its tabs: where each pane's content stops against its footer and its
 * width (layout-measure.ts).
 * The layout checks hold a few fixtures to this in CI; this is the whole
 * registry, on demand.
 *
 *   bun run web:build
 *   bun run check:pane-layout [--only TRIAL,CHG] [--shard 0/3] [--out <dir>] [--root <checkout>] [--web <build>] [--replay <dir>]
 *
 * Functions open through the command bar, signed out, so a function behind
 * sign-in shows its gate. The page reads Gloom Cloud as web-app.ts describes,
 * kept under the cache folder for the next run. Results, a summary of every failing
 * pane and a picture of each view go to `--out` (default
 * ~/.cache/gloomberb-pane-chrome/layout-sweep).
 */

const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const web = resolve(takeOption(args, "--web") ?? join(root, "dist/web"));
const only = takeOption(args, "--only")?.split(",");
const [shardIndex, shardCount] = (takeOption(args, "--shard") ?? "0/1").split("/").map(Number) as [number, number];
const out = resolve(takeOption(args, "--out") ?? cacheDir("layout-sweep"));
const replay = createReplay(resolve(takeOption(args, "--replay") ?? cacheDir("layout-sweep-replay")));

function layoutFor(instance: Record<string, unknown>, mode: "dock" | "float", width: number, height: number, cell: { width: number; height: number }): object {
  const id = instance.instanceId as string;
  if (mode === "dock") return { dockRoot: { kind: "pane", instanceId: id }, instances: [instance], floating: [], detached: [] };
  const columns = width / cell.width, rows = height / cell.height;
  return { dockRoot: null, instances: [instance], floating: [{ instanceId: id, x: 2.5, y: 2.25, width: Math.round(columns * 78) / 100 + 0.37, height: Math.round(rows * 78) / 100 + 0.41, zIndex: 50 }], detached: [] };
}

/** Tabs and the query bar's view choices (role radio), which switch what the pane shows as tabs do. */
const TABS = "[role=tab], [role=radio]";

/** The labels of the tabs not showing, in the pane and its title bar. */
function tabLabels(cdp: Cdp, scope: string): Promise<string[]> {
  return evaluate<string[]>(cdp, `[...new Set([...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll(${JSON.stringify(TABS)}) ?? [])].filter((el) => el.getAttribute("aria-selected") !== "true" && el.getAttribute("aria-checked") !== "true" && !el.disabled && el.getBoundingClientRect().width > 0).map((el) => el.textContent.trim()).filter(Boolean))].slice(0, 20)`);
}

async function clickTab(cdp: Cdp, scope: string, label: string): Promise<boolean> {
  const at = await evaluate<{ x: number; y: number } | null>(cdp, `(() => { const el = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll(${JSON.stringify(TABS)}) ?? [])].find((tab) => tab.textContent.trim() === ${JSON.stringify(label)}); const r = el?.getBoundingClientRect(); return r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  if (!at) return false;
  await click(cdp, at);
  return true;
}

async function main(): Promise<void> {
  if (!await Bun.file(join(web, "index.html")).exists()) throw new Error(`No web build in ${web}; run bun run web:build first.`);
  const catalog = readCatalog(root, cacheDir("layout-sweep-home"))
    .filter((entry, index) => index % shardCount === shardIndex && (!only || only.includes(entry.token)));
  await mkdir(join(out, "shots"), { recursive: true });
  const app = serveWebApp(web, replay);
  const browser = await launchBrowser("layout-sweep", LAYOUT_SIZES[1].width, LAYOUT_SIZES[1].height);
  const { cdp } = browser;
  const rows: string[] = [];
  const results: unknown[] = [];
  try {
    // Reads the web app makes straight from another site (the release feed) go through the same reads.
    await routeDirectReads(cdp, replay);
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
    for (const entry of catalog) {
      const instance = await discover(cdp, app.url, replay, entry) ?? fallbackInstance(entry);
      const scope = `[data-gloom-pane-id="${instance.instanceId as string}"]`;
      for (const mode of ["dock", "float"] as const) {
        for (const size of LAYOUT_SIZES) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
          const cell = await evaluate<{ width: number; height: number }>(cdp, `({ width: parseFloat(getComputedStyle(document.body).getPropertyValue("--cell-w")) || 8, height: parseFloat(getComputedStyle(document.body).getPropertyValue("--cell-h")) || 18 })`);
          await loadLayout(cdp, app.url, replay, layoutFor(instance, mode, size.width, size.height, cell), instance.instanceId as string);
          await settle(cdp, scope);
          const record = async (view: string) => {
            const measure = await evaluate<LayoutMeasure>(cdp, LAYOUT_MEASURE(instance.instanceId as string));
            if (measure.missing) return;
            // A headline a feed sent already cut is the source's, not a count of columns.
            measure.arrivedCut = measure.cut.filter((entry) => replay.arrived(entry.whole));
            measure.cut = measure.cut.filter((entry) => !measure.arrivedCut!.includes(entry));
            const name = `${entry.token}-${mode}-${size.width}x${size.height}-${view.replace(/[^a-z0-9]+/gi, "-")}`;
            await shot(cdp, scope, join(out, "shots", `${name}.jpg`));
            const failures = layoutFailures(measure);
            results.push({ token: entry.token, paneId: entry.paneId, mode, size, view, failures, measure });
            if (failures.length > 0) rows.push(`| ${entry.token} | ${view} | ${mode} ${size.width}x${size.height} | ${failures.join("; ").replace(/\|/g, "/")} |`);
          };
          const tabs = await tabLabels(cdp, scope);
          await record("root");
          const before = await evaluate<string>(cdp, `document.querySelector(${JSON.stringify(scope)})?.innerText ?? ""`);
          await key(cdp, "Enter", "Enter", 13);
          await settle(cdp, scope, 700, 6_000);
          if (await evaluate<string>(cdp, `document.querySelector(${JSON.stringify(scope)})?.innerText ?? ""`) !== before) await record("detail");
          // Every tab of the root, docked: a floating pane draws the same tabs.
          if (mode === "dock" && tabs.length > 0) {
            await loadLayout(cdp, app.url, replay, layoutFor(instance, mode, size.width, size.height, cell), instance.instanceId as string);
            await settle(cdp, scope);
            for (const label of tabs) {
              if (!await clickTab(cdp, scope, label)) continue;
              await settle(cdp, scope, 700, 6_000);
              await record(`tab ${label}`);
            }
          }
        }
      }
      console.log(`${entry.token}: ${rows.filter((row) => row.startsWith(`| ${entry.token} |`)).length} failing views`);
    }
  } finally {
    await browser.close();
    app.stop();
  }
  await Bun.write(join(out, `results-${shardIndex}of${shardCount}.json`), JSON.stringify(results, null, 1));
  const summary = ["| Function | View | Layout | What fails |", "|---|---|---|---|", ...rows].join("\n");
  await Bun.write(join(out, `summary-${shardIndex}of${shardCount}.md`), `${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Pane layout sweep\n\n${summary}\n`);
  console.log(`\n${rows.length} failing views in ${catalog.length} functions; ${join(out, `summary-${shardIndex}of${shardCount}.md`)}`);
  if (rows.length > 0) process.exitCode = 1;
}

await main();
