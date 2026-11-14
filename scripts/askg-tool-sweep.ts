/**
 * Runs every tool Ask Gloom can call in this app (the headless pane
 * functions it advertises) with heavy, realistic inputs, through the same
 * executor the Ask Gloom pane uses, against Gloom Cloud. Prints, per case,
 * the status, rows, payload size and the median and slowest time, and fails
 * when a case errors, comes back empty, or takes longer than the budget a
 * call gets inside a script (20 s).
 *
 *   GLOOMBERB_HOME=~/.cache/gloom-smoke/sweep GLOOMBERB_SESSION_TOKEN=... \
 *     bun scripts/askg-tool-sweep.ts [--runs 3] [--only 13f,pf] [--budget-ms 20000] [--json out.json]
 *
 * `--check` runs nothing: offline, it fails when a tool has no case or a case
 * names no tool (scripts/askg-tool-sweep-cases.test.ts runs it in CI).
 *
 * GLOOMBERB_HOME must be a throwaway profile: the sweep seeds a watchlist
 * and a portfolio into it. Without a session the tools run signed out, which
 * limits some of them. Cases live in askg-tool-sweep-cases.ts.
 */
import { realpathSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { parseArgs } from "util";
import { testAppEnv } from "./test-app-env";
import { getDataDir, initDataDir, saveConfig } from "../src/data/config/store";
import { getGloomberbDirs } from "../src/data/config/home";
import { initMarketData } from "../src/cli/context";
import { createPaneCatalog } from "../src/cli/pane-functions/discovery";
import { getLoadablePlugins } from "../src/plugins/catalog";
import { buildASKGClientManifest } from "../src/plugins/builtin/cloud/askg/manifest";
import { createASKGToolExecutor } from "../src/plugins/builtin/cloud/askg/executor";
import type { ToolResultPayload } from "../src/plugins/builtin/cloud/askg/protocol";
import type { TickerRecord } from "../src/types/ticker";
import type { MarketContext } from "../src/cli/types";
import { createDefaultConfig } from "../src/types/config";
import { apiClient } from "../src/api-client";
import { resolvePersistedCloudSessionToken } from "../src/cli/pane-functions/cloud-session";
import {
  SWEEP_CASES,
  SWEEP_PORTFOLIO_ID,
  SWEEP_POSITIONS,
  SWEEP_WATCHLIST_ID,
  type SweepCase,
} from "./askg-tool-sweep-cases";

Object.assign(process.env, testAppEnv());

const { values: flags } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    only: { type: "string" },
    "budget-ms": { type: "string", default: "20000" },
    json: { type: "string" },
    check: { type: "boolean", default: false },
  },
});
const runs = Math.max(1, Number(flags.runs));
const budgetMs = Number(flags["budget-ms"]);
/** Long enough to see how slow a slow tool really is. */
const CALL_TIMEOUT_MS = 90_000;

/** The tools without a case and the cases naming no tool, against the tools Ask Gloom is offered. */
function coverage(tools: readonly string[], swept: readonly string[]): { unswept: string[]; unknown: string[] } {
  return {
    unswept: tools.filter((name) => !swept.includes(name)),
    unknown: [...new Set(swept.filter((name) => !tools.includes(name)))],
  };
}

if (flags.check) {
  // Discovery stays offline (src/cli/pane-functions/catalog.test.ts), so the manifest needs no profile or session.
  const context = { config: createDefaultConfig("/synthetic/askg-tool-sweep") } as MarketContext;
  const offered = (await buildASKGClientManifest(await createPaneCatalog(context, getLoadablePlugins()))).tools
    .filter((tool) => tool.source === "headless")
    .map((tool) => tool.name);
  const { unswept, unknown } = coverage(offered, SWEEP_CASES.map((entry) => entry.tool));
  if (unswept.length) console.log(`No case for: ${unswept.join(", ")} (add one to scripts/askg-tool-sweep-cases.ts)`);
  if (unknown.length) console.log(`Not offered to Ask Gloom: ${unknown.join(", ")}`);
  console.log(`${offered.length} tools, ${SWEEP_CASES.length} cases`);
  process.exit(unswept.length || unknown.length ? 1 : 0);
}

/** A folder as the file system names it, through links and `..`, so two spellings of one folder compare equal. */
function canonical(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    // Not created yet: it cannot be a link to a profile that exists.
    return full;
  }
}

// The profile the sweep opens, resolved as the app resolves it (a leading ~, a data folder its config.json records),
// must be none of the user's own: their data folder and config folder without GLOOMBERB_HOME, or ~/.gloomberb.
const { GLOOMBERB_HOME: override, ...userEnv } = process.env;
const profile = override?.trim() ? (await getDataDir()) ?? getGloomberbDirs().data : null;
const userDirs = getGloomberbDirs(userEnv);
const own = [userDirs.data, dirname(userDirs.configFile), join(userEnv.HOME || homedir(), ".gloomberb")].map(canonical);
if (!profile || own.includes(canonical(profile))) {
  console.error("Set GLOOMBERB_HOME to a throwaway profile; the sweep writes a watchlist and a portfolio into it.");
  process.exit(2);
}

async function seedProfile(): Promise<void> {
  const config = await initDataDir(profile!);
  await saveConfig({
    ...config,
    portfolios: [
      ...config.portfolios.filter((portfolio) => portfolio.id !== SWEEP_PORTFOLIO_ID),
      { id: SWEEP_PORTFOLIO_ID, name: "Sweep Portfolio", currency: "USD" },
    ],
    watchlists: [
      ...config.watchlists.filter((watchlist) => watchlist.id !== SWEEP_WATCHLIST_ID),
      { id: SWEEP_WATCHLIST_ID, name: "Sweep Watchlist" },
    ],
  });
  const context = await initMarketData();
  const records: TickerRecord[] = SWEEP_POSITIONS.map((position) => ({
    metadata: {
      ticker: position.symbol,
      exchange: position.exchange,
      currency: position.currency,
      name: position.symbol,
      portfolios: [SWEEP_PORTFOLIO_ID],
      watchlists: [SWEEP_WATCHLIST_ID],
      positions: [{
        portfolio: SWEEP_PORTFOLIO_ID,
        shares: position.shares,
        avgCost: position.avgCost,
        currency: position.currency,
        side: "long",
        broker: "manual",
      }],
      custom: {},
      tags: [],
    },
  }) as TickerRecord);
  await context.store.saveTickers(records);
  context.persistence.close();
}

interface CaseResult {
  tool: string;
  input: string;
  status: string;
  rowCount: number | null;
  bytes: number;
  p50Ms: number;
  maxMs: number;
  timesMs: number[];
  note: string;
  failed: string | null;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};

function describeInput(args: SweepCase["args"]): string {
  return Object.entries(args)
    .map(([key, value]) => {
      const text = Array.isArray(value) ? (value.length > 4 ? `${value.slice(0, 3).join(",")},+${value.length - 3}` : value.join(",")) : String(value);
      return key === "text" || key === "symbol" || key === "symbols" ? text : `${key}=${text}`;
    })
    .join(" ") || "(none)";
}

/** Why a case failed, or null: an error, nothing back, or over the budget. */
function failure(entry: SweepCase, payloads: ToolResultPayload[], maxMs: number): string | null {
  const last = payloads.at(-1)!;
  if (entry.expect === "error") return null;
  if (last.status === "error" || last.status === "timeout" || last.status === "denied") return last.status;
  if (entry.expect !== "empty" && (last.rowCount ?? 0) === 0) return "empty";
  if (maxMs > budgetMs) return "slow";
  return null;
}

await seedProfile();
const context = await initMarketData();
const registry = await createPaneCatalog(context, getLoadablePlugins());
const manifest = await buildASKGClientManifest(registry);
// Inside the app the API client holds the signed-in session; loading the plugins may have reset it.
apiClient.setSessionToken(resolvePersistedCloudSessionToken(context));
const headless = manifest.tools.filter((tool) => tool.source === "headless");
const executor = createASKGToolExecutor({
  manifests: manifest.tools,
  registry,
  context,
  // Headless tools never reach the app's remote control; app actions are not swept.
  remoteHandler: async () => ({ ok: false, error: { code: "unavailable", message: "No app in the sweep." } }),
});

const only = flags.only ? new Set(flags.only.split(",").map((name) => name.trim().toLowerCase())) : null;
const cases = SWEEP_CASES.filter((entry) => !only || only.has(entry.tool));
const { unswept: allUnswept, unknown } = coverage(headless.map((tool) => tool.name), cases.map((entry) => entry.tool));
const unswept = only ? [] : allUnswept;

const results: CaseResult[] = [];
let sequence = 0;
for (const entry of cases) {
  const tool = headless.find((candidate) => candidate.name === entry.tool);
  if (!tool) continue;
  const payloads: ToolResultPayload[] = [];
  const timesMs: number[] = [];
  for (let run = 0; run < runs; run++) {
    const startedAt = performance.now();
    const payload = await executor.execute({
      type: "tool-call",
      seq: ++sequence,
      turnId: "sweep",
      toolCallId: `sweep-${sequence}`,
      name: tool.name,
      args: entry.args,
      writeTier: tool.writeTier,
      requiresConfirmation: false,
      preview: "",
      timeoutMs: CALL_TIMEOUT_MS,
      expiresAt: new Date(Date.now() + CALL_TIMEOUT_MS).toISOString(),
    });
    timesMs.push(Math.round(performance.now() - startedAt));
    payloads.push(payload);
    if (payload.status === "error" || payload.status === "denied") break;
  }
  const last = payloads.at(-1)!;
  const maxMs = Math.max(...timesMs);
  const result: CaseResult = {
    tool: entry.tool,
    input: describeInput(entry.args),
    status: last.status,
    rowCount: last.rowCount ?? null,
    bytes: new TextEncoder().encode(JSON.stringify(last.result ?? null)).byteLength,
    p50Ms: median(timesMs),
    maxMs,
    timesMs,
    note: (last.note ?? "").replace(/\s+/g, " ").slice(0, 140),
    failed: failure(entry, payloads, maxMs),
  };
  results.push(result);
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  console.log([
    result.failed ? "FAIL" : "ok  ",
    result.tool.padEnd(6),
    result.input.slice(0, 44).padEnd(44),
    result.status.padEnd(8),
    String(result.rowCount ?? "-").padStart(6),
    `${seconds(result.p50Ms)}s/${seconds(result.maxMs)}s`.padStart(13),
    result.failed ?? "",
    result.failed ? result.note : "",
  ].join("  "));
}

const failedCases = results.filter((result) => result.failed);
console.log(`\n${results.length} cases, ${failedCases.length} failed, budget ${budgetMs / 1000} s, ${runs} run(s) each.`);
if (unknown.length) console.log(`Not advertised: ${unknown.join(", ")}`);
if (unswept.length) console.log(`No case for: ${unswept.join(", ")}`);
if (flags.json) await Bun.write(flags.json, JSON.stringify({ budgetMs, runs, results, unswept, unknown }, null, 2));
context.persistence.close();
process.exit(failedCases.length || unknown.length ? 1 : 0);
