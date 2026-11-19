import { writeFile } from "fs/promises";
import type { PaneInstanceConfig } from "../../src/types/config";
import type { PaneCatalogEntry } from "../../src/cli/pane-functions/catalog";

/**
 *   GLOOMBERB_HOME=<profile> bun scripts/warm-start/plan.ts --out <file>
 *
 * One pane of every type the catalog lists, opened the way `gloom shot`
 * opens it: the data sweep's reviewed read-only example for the type, or the
 * pane alone when it takes no argument. Types that act on an account, write,
 * generate text or need a signed-in session are left out, with the reason.
 * Writes `{ panes, skipped }`; the benchmark lays the panes out in layouts.
 */

export interface PlannedPane {
  token: string;
  args: string[];
  paneId: string;
  instance: PaneInstanceConfig;
}

export interface WarmStartPlan {
  panes: PlannedPane[];
  skipped: Array<{ paneId: string; reason: string }>;
}

/**
 * Types the data sweep leaves out that still open on data without an
 * account: they are opened alone, with no argument.
 */
const EXTRA_PANES: Record<string, string[]> = {
  "portfolio-list": [],
  changelog: [],
  roadmap: [],
  docs: [],
  help: [],
  "world-venue-map": [],
  "data-catalog": [],
  "research-search": [],
};

/** Never opened: they act on an account, write, generate or need a sign-in to show anything. */
const LEFT_OUT: Record<string, string> = {
  "account-management": "account surface",
  alerts: "writes alert rules",
  askg: "generates text",
  brokers: "broker account",
  "broker-orders": "broker account",
  chat: "needs a signed-in session",
  connections: "account surface",
  "equity-diagnostic": "generates text",
  "layout-marketplace": "account surface",
  "plugin-marketplace": "installs plugins",
  analytics: "needs a portfolio with positions",
  "quick-notes": "writes notes",
  "news-story": "needs a story id",
  "thesis-board": "needs a signed-in session",
  "custom-view": "needs a saved view",
  "twitter-feed": "external plugin",
};

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
if (!out) throw new Error("Usage: plan.ts --out <file>");

const { initMarketData } = await import("../../src/cli/context");
const { createPaneCatalog } = await import("../../src/cli/pane-functions/discovery");
const { buildPaneCatalogEntries } = await import("../../src/cli/pane-functions/catalog");
const { parsePaneFunctionArgsFor, resolvePaneFunction } = await import("../../src/cli/pane-functions/resolver");
const { getLoadablePlugins } = await import("../../src/plugins/catalog");
const { planSweep } = await import("../pane-chrome/data-sweep");

const market = await initMarketData();
const registry = await createPaneCatalog(market, getLoadablePlugins());
const entries: PaneCatalogEntry[] = await buildPaneCatalogEntries(registry, market);
const cases = planSweep(entries).filter((sweepCase) => !sweepCase.status);
const paneOf = new Map(entries.map((entry) => [entry.token, entry.paneId]));

// One case per pane type: a US large cap where the sweep tries several, else the first.
const chosen = new Map<string, { token: string; args: string[] }>();
for (const sweepCase of cases) {
  const paneId = paneOf.get(sweepCase.token);
  if (!paneId) continue;
  const current = chosen.get(paneId);
  if (!current || (sweepCase.lane === "us-large" && !current.args.includes("AAPL"))) {
    chosen.set(paneId, { token: sweepCase.token, args: sweepCase.args });
  }
}
for (const [paneId, args] of Object.entries(EXTRA_PANES)) {
  const entry = entries.find((candidate) => candidate.paneId === paneId);
  if (entry && !chosen.has(paneId)) chosen.set(paneId, { token: entry.token, args });
}

const plan: WarmStartPlan = { panes: [], skipped: [] };
for (const entry of entries) {
  if (chosen.has(entry.paneId) || plan.skipped.some((skip) => skip.paneId === entry.paneId)) continue;
  plan.skipped.push({ paneId: entry.paneId, reason: LEFT_OUT[entry.paneId] ?? "no reviewed read-only example" });
}
for (const [paneId, { token, args }] of [...chosen].sort(([left], [right]) => left.localeCompare(right))) {
  try {
    const parsed = parsePaneFunctionArgsFor(registry, [token, ...args]);
    const resolved = await resolvePaneFunction(registry, market, parsed, { command: "shot" });
    const instance = { ...resolved.instance, instanceId: `warm:${paneId}` };
    plan.panes.push({ token, args, paneId, instance });
  } catch (error) {
    plan.skipped.push({ paneId, reason: `could not open ${token} ${args.join(" ")}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
  }
}
registry.destroy();
await writeFile(out, `${JSON.stringify(plan, null, 2)}\n`);
console.error(`${plan.panes.length} pane types planned, ${plan.skipped.length} left out`);
process.exit(0);
