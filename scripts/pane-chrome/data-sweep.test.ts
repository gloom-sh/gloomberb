import { expect, spyOn, test } from "bun:test";
import { getLoadablePlugins } from "../../src/plugins/catalog";
import { createDefaultConfig } from "../../src/types/config";
import { buildPaneCatalogEntries, type PaneCatalogEntry } from "../../src/cli/pane-functions/catalog";
import { createPaneCatalog } from "../../src/cli/pane-functions/discovery";
import type { MarketContext } from "../../src/cli/types";
import { assessCapture, exampleArgs, planSweep, runCommand, selectCases, type CommandResult } from "./data-sweep";

const entry = (changes: Partial<PaneCatalogEntry> = {}): PaneCatalogEntry => ({
  token: "ANR", paneId: "analyst-research", label: "Analysts", description: "", paneName: "Analysts", aliases: [], keywords: [], defaultSettings: {},
  argKind: "ticker", capability: { id: "anr", botSafe: true, tickerCardinality: "one", aliases: [], intents: [], outputKind: "bundle",
    reportReadiness: "ready", screenshotReadiness: "live-dom", dataRequirements: [], limitations: [], options: [] }, ...changes,
});

test("every built-in catalog function has a reviewed safety decision and a concrete compatible input", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Planning must stay offline"));
  const context = { config: createDefaultConfig("/synthetic/pane-data-sweep") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const catalog = await buildPaneCatalogEntries(registry, context);
    const plan = planSweep(catalog);
    expect(plan.filter((item) => item.status === "missing")).toEqual([]);
    expect(new Set(plan.map((item) => item.token)).size).toBe(catalog.length);
    expect(plan.filter((item) => item.token === "ANR").map((item) => item.lane)).toEqual(["us-large", "us-small", "us-micro", "non-us"]);
    expect(plan.find((item) => item.token === "G")?.args.length).toBeGreaterThan(0);
    for (const token of ["ETF", "MDAY", "CDX", "GC", "OMON", "CSP"]) {
      expect(plan.filter((item) => item.token === token).every((item) => !["us-small", "us-micro", "non-us"].includes(item.lane))).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { registry.destroy(); fetch.mockRestore(); }
});

test("new panes and argument kinds cannot silently become passes, and action/generative panes never run", () => {
  expect(planSweep([entry({ paneId: "new-pane" })])[0]?.status).toBe("missing");
  expect(planSweep([entry({ argKind: "new-kind" })])[0]?.status).toBe("missing");
  for (const paneId of ["askg", "macro-tv", "broker-orders", "account-management", "thesis-board", "custom-view"]) {
    expect(planSweep([entry({ paneId })])[0]?.status).toBe("skipped");
  }
  const unsupported = entry();
  unsupported.capability.screenshotReadiness = "unsupported";
  expect(planSweep([unsupported])[0]?.status).toBe("unsupported");
  expect(planSweep([entry({ token: "UNKNOWN", argKind: "free-text" })])[0]?.status).toBe("missing");
});

test("catalog examples remain literal argv, respect shot cardinality and do not pass report-only flags", () => {
  const plan = planSweep([entry({ token: "DVD", paneId: "dividend-yield", argKind: "tickers", shotArgument: "<ticker>", argExamples: ["MUB --tax-rate 40.8", "MUB"] })]);
  expect(plan[0]?.args).toEqual(["MUB"]);
  expect(exampleArgs("'S&P 500' \"$(touch nope)\" ; not-a-shell")).toEqual(["S&P 500", "$(touch nope)", ";", "not-a-shell"]);
  expect(() => exampleArgs("'unfinished")).toThrow("Unclosed");
  expect(planSweep([entry({ token: "CDX", paneId: "fixed-income", argKind: "free-text", argExamples: ["XOVER"] })])[0]?.args).toEqual(["XOVER"]);
});

test("selection is deterministic, finite, and accounts for every deferred case", () => {
  const plan = planSweep([entry()]);
  const limited = selectCases(plan, { only: [], shard: [1, 1], maxCases: 2 });
  expect(limited.filter((item) => !item.status)).toHaveLength(2);
  expect(limited.filter((item) => item.reason === "Case budget exhausted")).toHaveLength(2);
  const shards = [1, 2, 3].flatMap((index) => selectCases(plan, { only: [], shard: [index, 3], maxCases: 10 }).filter((item) => !item.status));
  expect(shards.map((item) => item.id).sort()).toEqual(plan.map((item) => item.id).sort());
  expect(selectCases(plan, { only: ["ANR/us-micro"], shard: [1, 1], maxCases: 10 }).filter((item) => !item.status).map((item) => item.args)).toEqual([["DWSN"]]);
});

function capture(changes: Record<string, unknown> = {}, render: Record<string, unknown> = {}, exitCode = 0): CommandResult {
  return { stdout: JSON.stringify({ ok: true, data: { kind: "pane-screenshot", usable: true, complete: true, empty: false, rowCount: 2, semanticMismatch: false,
    unusableReason: null, ...changes, render: { visibleText: "AAPL Analyst ratings", errorStateDetected: false, emptyStateDetected: false, loadingStateDetected: false, ...render } } }),
  stderr: "", exitCode, timedOut: false };
}

test("strict failures preserve exact state wording, visible codes and every blank column", () => {
  expect(assessCapture(capture(), "ANR").status).toBe("pass");
  const failed = assessCapture(capture({ usable: false, blankColumns: ["Target", "Upside"], unusableReason: "The pane rendered an error state." },
    { errorStateDetected: true, visibleText: "source_unavailable SOURCE_TIMEOUT", stateText: { error: ["Ratings failed. source_unavailable"] } }, 2), "ANR");
  expect(failed).toMatchObject({ status: "failure", states: ["error"], reasonCodes: ["source_unavailable", "SOURCE_TIMEOUT"], blankColumns: ["Target", "Upside"],
    stateText: { error: ["Ratings failed. source_unavailable"] } });
  expect(assessCapture(capture({ blankColumns: ["Prior"] }), "CPI").status).toBe("failure");
  for (const render of [{ loadingStateDetected: true }, { accessGate: "pro" }, { accessGate: "sign-in" }, { errorStateDetected: true }]) {
    expect(assessCapture(capture({}, render), "ANR").status).toBe("failure");
  }
  expect(assessCapture(capture({ complete: false, usable: false }), "ANR").status).toBe("failure");
  expect(assessCapture(capture({ complete: false }, { truncationReasons: ["rows below the rendered viewport are cut"] }), "AWARDS"))
    .toMatchObject({ status: "partial", reason: "rows below the rendered viewport are cut" });
  expect(assessCapture(capture({}, {}, 2), "ANR").status).toBe("failure");
});

test("unrecognized visible and state-only codes cannot pass even a usable or partial capture", () => {
  for (const code of ["NOT_FOUND", "NO_DATA", "UNKNOWN_STATUS", "unfamiliar_status"]) {
    for (const complete of [true, false]) {
      expect(assessCapture(capture({ complete }, { visibleText: `AAPL Analyst ratings ${code}` }), "ANR"))
        .toMatchObject({ status: "failure", reasonCodes: [code] });
    }
    for (const render of [{ stateText: { error: [code] } }, { stateText: { empty: [code] } }, { errorStateMarkers: [code] }]) {
      expect(assessCapture(capture({}, render), "ANR")).toMatchObject({ status: "failure", reasonCodes: [code] });
    }
  }
  expect(assessCapture(capture({}, { stateText: { error: ["Request failed"] } }), "ANR"))
    .toMatchObject({ status: "failure", states: ["error"] });
  expect(assessCapture(capture({}, { errorStateMarkers: ["Request failed. UNKNOWN_STATUS"] }), "ANR"))
    .toMatchObject({ status: "failure", stateText: { error: ["Request failed. UNKNOWN_STATUS"] }, reasonCodes: ["UNKNOWN_STATUS"] });
});

test("explicit field and ticker-expression identifiers are data, not reason codes", () => {
  const fields = { visibleText: "G NVDA:net_income / NVDA:revenue Field: custom_metric Expression: USER_FIELD" };
  expect(assessCapture(capture({ symbols: ["NVDA"] }, fields), "G")).toMatchObject({ status: "pass", reasonCodes: [] });
  expect(assessCapture(capture({ symbols: ["NVDA"], complete: false }, fields), "G")).toMatchObject({ status: "partial", reasonCodes: [] });
  expect(assessCapture(capture({ symbols: ["NVDA"] }, { visibleText: `${fields.visibleText} Status: UNKNOWN_STATUS` }), "G"))
    .toMatchObject({ status: "failure", reasonCodes: ["UNKNOWN_STATUS"] });
  expect(assessCapture(capture({ symbols: ["NVDA"] }, { ...fields, stateText: { error: ["custom_metric"] } }), "G"))
    .toMatchObject({ status: "failure", reasonCodes: ["custom_metric"] });
});

test("explicit no-coverage and closed-session lists are separate, never hide unrelated failures", () => {
  const empty = { usable: false, empty: true, rowCount: 0 };
  const noCoverage = { emptyStateDetected: true, stateText: { empty: ["No analyst coverage for this listing. no_coverage"] } };
  expect(assessCapture(capture(empty, noCoverage, 2), "ANR").status).toBe("no-coverage");
  expect(assessCapture(capture({ ...empty, rowCount: 3 }, { emptyStateDetected: true, stateText: { empty: ["No upgrades, downgrades or target changes for 7203:JPX: the source lists them mainly for North American listings."] } }, 2), "ANR").status).toBe("no-coverage");
  expect(assessCapture(capture(empty, { ...noCoverage, visibleText: "no_coverage source_unavailable" }, 2), "ANR").status).toBe("failure");
  expect(assessCapture(capture({ ...empty, blankColumns: ["Target"] }, noCoverage, 2), "ANR").status).toBe("failure");
  expect(assessCapture(capture({ ...empty, semanticMismatch: true }, noCoverage, 2), "ANR").status).toBe("failure");
  expect(assessCapture(capture(empty, { ...noCoverage, loadingStateDetected: true }, 2), "ANR").status).toBe("failure");
  const closed = { emptyStateDetected: true, stateText: { empty: ["Market is closed. No movers this session."] } };
  expect(assessCapture(capture(empty, closed, 2), "MOST").status).toBe("market-closed");
  expect(assessCapture(capture(empty, closed, 2), "ANR").status).toBe("failure");
  expect(assessCapture(capture(empty, { emptyStateDetected: true, stateText: { empty: ["No results"] } }, 2), "MOST").status).toBe("failure");
  expect(assessCapture(capture(empty, { ...closed, errorStateDetected: true }, 2), "MOST").status).toBe("failure");
  const noHalts = { emptyStateDetected: true, stateText: { empty: ["No trading halts reported."] } };
  expect(assessCapture(capture(empty, noHalts, 2), "HALT").status).toBe("expected-empty");
  expect(assessCapture(capture(empty, noHalts, 2), "MOST").status).toBe("failure");
  expect(assessCapture(capture(empty, { ...noHalts, errorStateDetected: true }, 2), "HALT").status).toBe("failure");
  for (const code of ["NOT_FOUND", "NO_DATA", "UNKNOWN_STATUS", "unfamiliar_status", "market_closed"]) {
    for (const render of [{ ...noCoverage, visibleText: code }, { ...noCoverage, errorStateMarkers: [code] },
      { ...noCoverage, stateText: { empty: [...noCoverage.stateText.empty, code] } }]) {
      expect(assessCapture(capture(empty, render, 2), "ANR")).toMatchObject({ status: "failure", reasonCodes: expect.arrayContaining([code]) });
    }
  }
  for (const exitCode of [1, -1, 137]) {
    for (const [token, render] of [["ANR", noCoverage], ["MOST", closed], ["HALT", noHalts]] as const) {
      expect(assessCapture(capture(empty, render, exitCode), token).status).toBe("failure");
    }
  }
  expect(assessCapture(capture(empty, { ...noCoverage, errorStateDetected: true }, 2), "ANR").status).toBe("failure");
  expect(assessCapture(capture(empty, { ...noCoverage, stateText: { ...noCoverage.stateText, error: ["Request failed"] } }, 2), "ANR").status).toBe("failure");
  expect(assessCapture(capture(empty, { ...noCoverage, errorStateMarkers: ["Request failed"] }, 2), "ANR").status).toBe("failure");
  expect(assessCapture(capture({ ...empty, unusableReason: "Request failed" }, noCoverage, 2), "ANR").status).toBe("failure");
  expect(assessCapture(capture(empty, { emptyStateDetected: true, stateText: { empty: ["No results"] }, visibleText: "no_coverage" }, 2), "ANR").status).toBe("failure");
  for (const code of ["no_coverage", "SYMBOL_NOT_COVERED"]) {
    expect(assessCapture(capture(empty, { emptyStateDetected: true, stateText: { empty: [`Not covered. ${code}`] } }, 2), "ANR"))
      .toMatchObject({ status: "no-coverage", reasonCodes: [code] });
    expect(assessCapture(capture({}, { visibleText: code }), "ANR").status).toBe("failure");
  }
  for (const code of ["market_closed", "OUTSIDE_MARKET_HOURS", "outside_session"]) {
    expect(assessCapture(capture(empty, { emptyStateDetected: true, stateText: { empty: [`Market closed. ${code}`] } }, 2), "MOST"))
      .toMatchObject({ status: "market-closed", reasonCodes: [code] });
    expect(assessCapture(capture(empty, { ...closed, visibleText: `NO_DATA ${code}` }, 2), "MOST").status).toBe("failure");
  }
});

test("timeouts, invalid output and CLI errors cannot be mistaken for empty data", async () => {
  expect(assessCapture({ ...capture(), timedOut: true }, "ANR").status).toBe("timeout");
  for (const stdout of ["", "not json", "{}", '{"ok":false,"error":{}}', '{"ok":true,"data":{}}', JSON.stringify({ ok: true, data: { kind: "pane-screenshot", render: {} } })]) {
    expect(assessCapture({ ...capture(), stdout }, "ANR").status).toBe("invalid-output");
  }
  expect(assessCapture(capture({}, { stateText: { error: "not an array" } }), "ANR").status).toBe("invalid-output");
  expect(assessCapture({ ...capture(), stdout: JSON.stringify({ ok: false, error: { code: "auth_required", message: "Sign in first" } }) }, "ANR"))
    .toMatchObject({ status: "command-error", reasonCodes: ["auth_required"], reason: "Sign in first" });
  const timed = await runCommand([process.execPath, "-e", 'setInterval(() => {}, 1000)'], process.env, 100);
  expect(timed.timedOut).toBe(true);
  const literal = await runCommand([process.execPath, "-e", "console.log(process.argv[1])", "$(not-a-command);literal"], process.env, 5_000);
  expect(literal.stdout.trim()).toBe("$(not-a-command);literal");
});
