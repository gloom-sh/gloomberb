import { appendFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, launchBrowser } from "./browser";
import { LAYOUT_SIZES } from "./layout-checks";
import { LAYOUT_MEASURE, layoutFailures, type LayoutMeasure } from "./layout-measure";
import { pathName, visitAlternatives, type TabVisit } from "./tab-visits";
import { createReplay, discover, fallbackInstance, key, loadLayout, readCatalog, routeDirectReads, serveWebApp, settle, shot } from "./web-app";

/**
 * Every function in the catalog on the real web build, docked and floating, at
 * three window sizes, with its detail opened where Enter opens one and, docked,
 * every view its tabs and choices lead to, each opened for real and confirmed
 * selected (tab-visits.ts): where each pane's content stops against its footer
 * and its width (layout-measure.ts). A tab that could not be opened fails the
 * sweep with the reason; `coverage-*.json` lists every alternative as
 * measured, unmeasured or skipped (disabled, not laid out, too deep).
 * The layout checks hold a few fixtures to this in CI; this is the whole
 * registry, on demand.
 *
 *   bun run web:build
 *   bun run check:pane-layout [--only TRIAL,CHG] [--shard 0/3] [--depth 2] [--out <dir>] [--root <checkout>] [--web <build>] [--replay <dir>]
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
/** Presses in a row the tab visits follow from the first view (tab-visits.ts); deeper ones are listed as skipped. */
const depth = Number(takeOption(args, "--depth") ?? 2);
const [shardIndex, shardCount] = (takeOption(args, "--shard") ?? "0/1").split("/").map(Number) as [number, number];
const out = resolve(takeOption(args, "--out") ?? cacheDir("layout-sweep"));
const replay = createReplay(resolve(takeOption(args, "--replay") ?? cacheDir("layout-sweep-replay")));

function layoutFor(instance: Record<string, unknown>, mode: "dock" | "float", width: number, height: number, cell: { width: number; height: number }): object {
  const id = instance.instanceId as string;
  if (mode === "dock") return { dockRoot: { kind: "pane", instanceId: id }, instances: [instance], floating: [], detached: [] };
  const columns = width / cell.width, rows = height / cell.height;
  return { dockRoot: null, instances: [instance], floating: [{ instanceId: id, x: 2.5, y: 2.25, width: Math.round(columns * 78) / 100 + 0.37, height: Math.round(rows * 78) / 100 + 0.41, zIndex: 50 }], detached: [] };
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
  const coverage: Array<TabVisit & { token: string; mode: string; size: string }> = [];
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
          const record = async (view: string): Promise<boolean> => {
            const measure = await evaluate<LayoutMeasure>(cdp, LAYOUT_MEASURE(instance.instanceId as string));
            if (measure.missing) return false;
            // A headline a feed sent already cut is the source's, not a count of columns.
            measure.arrivedCut = measure.cut.filter((entry) => replay.arrived(entry.whole));
            measure.cut = measure.cut.filter((entry) => !measure.arrivedCut!.includes(entry));
            const name = `${entry.token}-${mode}-${size.width}x${size.height}-${view.replace(/[^a-z0-9]+/gi, "-")}`;
            await shot(cdp, scope, join(out, "shots", `${name}.jpg`));
            const failures = layoutFailures(measure);
            results.push({ token: entry.token, paneId: entry.paneId, mode, size, view, failures, measure });
            if (failures.length > 0) rows.push(`| ${entry.token} | ${view.replace(/\|/g, "/")} | ${mode} ${size.width}x${size.height} | ${failures.join("; ").replace(/\|/g, "/")} |`);
            return true;
          };
          await record("root");
          const before = await evaluate<string>(cdp, `document.querySelector(${JSON.stringify(scope)})?.innerText ?? ""`);
          await key(cdp, "Enter", "Enter", 13);
          await settle(cdp, scope, 700, 6_000);
          if (await evaluate<string>(cdp, `document.querySelector(${JSON.stringify(scope)})?.innerText ?? ""`) !== before) await record("detail");
          // Every view the tabs and choices lead to, docked: a floating pane draws the same ones.
          if (mode === "dock") {
            const visits = await visitAlternatives({
              cdp,
              scope,
              reset: async () => {
                await loadLayout(cdp, app.url, replay, layoutFor(instance, mode, size.width, size.height, cell), instance.instanceId as string);
                await settle(cdp, scope);
              },
              settle: () => settle(cdp, scope, 700, 6_000),
              record: (path) => record(`tab ${pathName(path)}`),
              depth,
            });
            const sizeName = `${size.width}x${size.height}`;
            for (const visit of visits) {
              coverage.push({ token: entry.token, mode, size: sizeName, ...visit });
              if (visit.status === "unmeasured") rows.push(`| ${entry.token} | tab ${pathName(visit.path).replace(/\|/g, "/")} | ${mode} ${sizeName} | not measured: the switch did not happen (${visit.reason}) |`);
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
  await Bun.write(join(out, `coverage-${shardIndex}of${shardCount}.json`), JSON.stringify(coverage, null, 1));
  const count = (status: TabVisit["status"]) => coverage.filter((visit) => visit.status === status).length;
  const skipped = coverage.filter((visit) => visit.status === "skipped");
  const reasons = [...new Set(skipped.map((visit) => visit.reason ?? ""))].map((reason) => `${skipped.filter((visit) => visit.reason === reason).length} ${reason}`);
  const summary = [
    "| Function | View | Layout | What fails |", "|---|---|---|---|", ...rows, "",
    `Tabs and choices, docked at ${LAYOUT_SIZES.length} sizes, up to ${depth} presses deep: ${count("measured")} views measured, ${count("unmeasured")} not measured (above), ${skipped.length} skipped${reasons.length ? `: ${reasons.join("; ")}` : ""}.`,
  ].join("\n");
  await Bun.write(join(out, `summary-${shardIndex}of${shardCount}.md`), `${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Pane layout sweep\n\n${summary}\n`);
  console.log(`\n${rows.length} failing views in ${catalog.length} functions; ${join(out, `summary-${shardIndex}of${shardCount}.md`)}`);
  if (rows.length > 0) process.exitCode = 1;
}

await main();
