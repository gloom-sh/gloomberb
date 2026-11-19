import { expect, spyOn, test } from "bun:test";
import { getLoadablePlugins } from "../../src/plugins/catalog";
import { createDefaultConfig } from "../../src/types/config";
import { buildPaneCatalogEntries, type PaneCatalogEntry } from "../../src/cli/pane-functions/catalog";
import { createPaneCatalog } from "../../src/cli/pane-functions/discovery";
import type { MarketContext } from "../../src/cli/types";
import type { AppAttentionPayload } from "../../src/api-client/app-attention";
import type { AttentionPayload } from "../../src/api-client/attention";
import type { CatalystResponse } from "../../src/api-client/catalysts";
import type { LiveScanPayload } from "../../src/api-client/live-scan";
import { emptyAttention } from "../../src/plugins/builtin/attention/model";
import { NO_RELATIONSHIPS_TITLE, notInBuildoutTitle } from "../../src/plugins/builtin/buildout/company/model";
import { catalystEmptyTitle, catalystQuery } from "../../src/plugins/builtin/catalysts/model";
import { appsUnmappedReason, NO_CURRENT_ROLE_EVIDENCE } from "../../src/plugins/builtin/company-attention/model";
import { companyEmptyState } from "../../src/plugins/builtin/company-kpis/model";
import { CREDIT_EMPTY_TITLE } from "../../src/plugins/builtin/credit-documents/model";
import { noCallsText } from "../../src/plugins/builtin/earnings-calls/format";
import { rippleEmptyText } from "../../src/plugins/builtin/earnings-ripple/model";
import { boardRangeWords, noCalendarReportsTitle } from "../../src/plugins/builtin/earnings/calendar-model";
import { NO_ESTIMATE_PERIODS_TITLE } from "../../src/plugins/builtin/estimate-revisions/model";
import { PENDING_JOBS_MESSAGE, pendingJobsTitle, uncoveredJobsState } from "../../src/plugins/builtin/jobs/model";
import { haltsEmptyTitle } from "../../src/plugins/builtin/market-halts/model";
import { emptyDealsTitle } from "../../src/plugins/builtin/mna/model";
import { EMPTY_POSITION_TITLE } from "../../src/plugins/builtin/options-scenario/model";
import { NO_BREAKDOWN_STATE } from "../../src/plugins/builtin/revenue-breakdown/model";
import { noAnalystActionsText, noAnalystCoverageText } from "../../src/plugins/builtin/research/client";
import { noRiskFactorsTitle } from "../../src/plugins/builtin/risk-factors/data";
import { hiloEmptyState } from "../../src/plugins/builtin/scanner/hilo-model";
import { liveScanEmptyState } from "../../src/plugins/builtin/scanner/live-pane";
import { shortWatchEmptyTitle } from "../../src/plugins/builtin/short-interest/watch-model";
import { NO_CASHTAG_STATE } from "../../src/plugins/builtin/social-mentions/model";
import { assessCapture, captureEvidence, EXPECTED_EMPTY, exampleArgs, planSweep, REVIEWED_EMPTY, runCommand, selectCases, type Assessment, type CommandResult } from "./data-sweep";

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
    expect(plan.find((item) => item.token === "OSA")?.args).toEqual(["AAPL", "--strategy", "vertical", "--expiration", "2027-01-15"]);
    expect(plan.find((item) => item.token === "SIW")?.args).toEqual(["GME,", "AMC,", "CVNA"]);
    expect(plan.find((item) => item.id === "BUZZ/non-us")).toMatchObject({ status: "unsupported", reason: expect.stringContaining("cashtag") });
    for (const token of ["HVG", "HVT"]) {
      expect(plan.filter((item) => item.token === token && item.status === "unsupported")).toHaveLength(3);
      expect(plan.find((item) => item.id === `${token}/us-large`)?.status).toBeUndefined();
    }
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
  expect(assessCapture(capture({}, { truncationReasons: ["rows below the rendered viewport are cut"] }), "AWARDS"))
    .toMatchObject({ status: "partial", reason: "rows below the rendered viewport are cut" });
  expect(assessCapture(capture({ complete: false, gaps: "no data for XYZ" }, { truncationReasons: [] }), "AWARDS"))
    .toMatchObject({ status: "partial", reason: "no data for XYZ" });
  expect(assessCapture(capture({}, {}, 2), "ANR").status).toBe("failure");
});

test("a missing evidence image does not replace a reviewed strict state", async () => {
  const wording = "AAPL has no mapped apps in the observed App Store and Google Play charts.";
  const result = capture({ usable: false, empty: true, rowCount: 0 }, { stateText: { empty: [wording] } }, 2);
  expect(await captureEvidence(result, "APPS", "0012.png", new Blob())).toMatchObject({
    status: "no-coverage", stateText: { empty: [wording] }, evidenceError: "Strict report has no rendered PNG",
  });
  const image = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]);
  expect(await captureEvidence(result, "APPS", "0012.png", image)).toMatchObject({ status: "no-coverage", png: "0012.png" });
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

test("social handles are data only in visible content, never a state-code exemption", () => {
  const visibleText = "@unusual_whales @Mr_Derivatives (@shana_chun)";
  expect(assessCapture(capture({}, { visibleText }), "BUZZ")).toMatchObject({ status: "pass", reasonCodes: [] });
  expect(assessCapture(capture({ complete: false }, { visibleText }), "ADR").status).toBe("partial");
  for (const code of ["NOT_FOUND", "UNKNOWN_STATUS"]) {
    expect(assessCapture(capture({}, { visibleText: `${visibleText} ${code}` }), "BUZZ"))
      .toMatchObject({ status: "failure", reasonCodes: [code] });
  }
  expect(assessCapture(capture({}, { visibleText, stateText: { empty: ["@unusual_whales"] } }), "BUZZ"))
    .toMatchObject({ status: "failure", reasonCodes: ["unusual_whales"] });
});

// What a pane's empty state reads once drawn: the title, then its message, as the capture joins them.
const drawn = ({ title, ...rest }: { title: string; hint?: string; message?: string }) => {
  const body = rest.hint ?? rest.message;
  return !body ? title : /[.!?:]$/.test(title) ? `${title} ${body}` : `${title}. ${body}`;
};

const SATURDAY = Date.UTC(2026, 10, 14, 17);
const WEDNESDAY = Date.UTC(2026, 10, 18, 16);
const [FROM, TO] = ["2026-11-14", "2026-12-14"];
const unmappedApps = { symbol: "AAPL", apps: [], page: { total: 0 }, summary: { appCount: 0 }, locked: {}, coverage: { sources: [{ captures: 3 }] } } as unknown as AppAttentionPayload;
const courts = { coverage: { totalEvents: 19_113, sources: [{ agency: "US courts", jurisdiction: "US", enabled: false }] } } as unknown as CatalystResponse;
const catalog = { coverage: { totalEvents: 19_113, sources: [] } } as unknown as CatalystResponse;
const ripple = { holdings: ["AAPL"], from: FROM, to: TO, preview: false };

// Every state is the pane's own builder output, never a copy of its wording.
const REVIEWED: Array<[token: string, text: string, status: Assessment["status"]]> = [
  ["APPS", appsUnmappedReason(unmappedApps, false) ?? "", "no-coverage"],
  ["CALLS", drawn(noCallsText("PLPC")), "no-coverage"],
  ["CATL", catalystEmptyTitle(catalog, catalystQuery({}, "DWSN"), false), "expected-empty"],
  ["EM", NO_ESTIMATE_PERIODS_TITLE, "no-coverage"],
  ["COVN", CREDIT_EMPTY_TITLE.instruments, "no-coverage"],
  ["COVN", CREDIT_EMPTY_TITLE.issuer, "no-coverage"],
  ["CRDOC", CREDIT_EMPTY_TITLE.instruments, "no-coverage"],
  ["CRDOC", CREDIT_EMPTY_TITLE.issuer, "no-coverage"],
  ...["PLPC", "WMT"].map((symbol): [string, string, Assessment["status"]] => ["GUIDE", drawn(companyEmptyState("guidance", symbol, { tab: "table", hasRows: false })), "no-coverage"]),
  ["KPIS", drawn(companyEmptyState("kpis", "DWSN", { tab: "table", hasRows: false })), "no-coverage"],
  ["HIRE", NO_CURRENT_ROLE_EVIDENCE, "no-coverage"],
  ["JOBS", drawn(uncoveredJobsState("PLPC")), "no-coverage"],
  ["JOBS", drawn({ title: pendingJobsTitle("1910:HKEX"), message: PENDING_JOBS_MESSAGE }), "expected-empty"],
  ["LITI", catalystEmptyTitle(courts, catalystQuery({}, "AAPL", true), false), "no-coverage"],
  ["MA", emptyDealsTitle("7203.T", ""), "expected-empty"],
  ["RIPL", rippleEmptyText({ ...ripple, checked: 4 }), "expected-empty"],
  ["RIPL", rippleEmptyText({ ...ripple, checked: 1 }), "expected-empty"],
  ["RIPL", rippleEmptyText({ ...ripple, checked: 0 }), "no-coverage"],
  ["RISK", noRiskFactorsTitle("7203:JPX"), "no-coverage"],
  ["SEG", drawn(NO_BREAKDOWN_STATE), "no-coverage"],
  ["TBOC", notInBuildoutTitle("DWSN"), "no-coverage"],
  ["TBOC", NO_RELATIONSHIPS_TITLE, "no-coverage"],
  ["BUZZ", drawn(NO_CASHTAG_STATE), "unsupported"],
  ["OSA", EMPTY_POSITION_TITLE, "expected-empty"],
  ["SIW", shortWatchEmptyTitle(false), "expected-empty"],
  ["HILO", drawn(hiloEmptyState({ filtered: false, status: "closed", now: SATURDAY })), "market-closed"],
  ["HILO", drawn(hiloEmptyState({ filtered: false, status: "closed", now: WEDNESDAY })), "market-closed"],
  ["SCAN", drawn(liveScanEmptyState({ status: "closed" } as LiveScanPayload)), "market-closed"],
  ["gloom-trending", emptyAttention({ status: "collecting" } as AttentionPayload), "expected-empty"],
  ["ANR", noAnalystActionsText("AAPL"), "expected-empty"],
  ["ANR", noAnalystActionsText("7203:JPX"), "no-coverage"],
  ["ANR", noAnalystCoverageText("DWSN"), "no-coverage"],
  ["HALT", haltsEmptyTitle("all"), "expected-empty"],
  ["ERN", noCalendarReportsTitle(boardRangeWords("2026-11-19", "2026-11-19")), "expected-empty"],
  ["ERN", noCalendarReportsTitle(null), "expected-empty"],
];

test("reviewed empty states classify from the copy the panes draw, and none is left without a builder-backed case", () => {
  for (const [token, text] of REVIEWED) expect(text, `${token} builder output`).not.toBe("");
  for (const [token, expected, status] of [...Object.entries(REVIEWED_EMPTY).map(([token, [status, pattern]]) => [token, pattern, status] as const),
    ...Object.entries(EXPECTED_EMPTY).map(([token, pattern]) => [token, pattern, "expected-empty"] as const)]) {
    expect(REVIEWED.some((entry) => entry[0] === token && entry[2] === status && expected.test(entry[1])), `${token} regex matches a drawn ${status} state`).toBe(true);
  }
  expect(Object.keys(REVIEWED_EMPTY).length).toBeGreaterThan(20);
});

test("reviewed source empty states remain findings, while mixed faults and unknown empties fail", () => {
  const empty = { usable: false, empty: true, rowCount: 0 };
  for (const [token, text, status] of REVIEWED) {
    const render = { emptyStateDetected: true, stateText: { empty: [text] } };
    expect(assessCapture(capture(empty, render, 2), token), `${token}: ${text}`).toMatchObject({ status, stateText: render.stateText });
    for (const changes of [{ blankColumns: ["Prior"] }, { semanticMismatch: true }]) {
      expect(assessCapture(capture({ ...empty, ...changes }, render, 2), token).status).toBe("failure");
    }
    for (const fault of [{ loadingStateDetected: true }, { errorStateDetected: true }, { accessGate: "pro" },
      { visibleText: "UNKNOWN_STATUS" }, { errorStateMarkers: ["Request failed"] }]) {
      expect(assessCapture(capture(empty, { ...render, ...fault }, 2), token).status).toBe("failure");
    }
    expect(assessCapture(capture(empty, render, 1), token).status).toBe("failure");
  }
  for (const text of ["No covered estimate periods. Backend unavailable.", "Not yet available", "No results"]) {
    expect(assessCapture(capture(empty, { stateText: { empty: [text] } }, 2), "EM").status).toBe("failure");
  }
});

test("negative-FCF and absent listed-option IV are narrow input limits, not backend-error exemptions", () => {
  const text = "reverse DCF unavailable. Free cash flow over the last twelve months is negative, so no growth rate prices it.";
  const empty = { usable: false, empty: true, rowCount: 0, unusableReason: `The pane rendered an error state. It reads "${text}"` };
  const render = { errorStateDetected: true, stateText: { error: [text] }, emptyStateText: ["reverse DCF unavailable.", "Free cash flow over the last twelve months is negative, so no growth rate prices it."],
    errorStateMarkers: ["RDCF DWSN Discount 9% FCF margin Own unavailable reverse DCF unavailable."] };
  expect(assessCapture(capture(empty, render, 2), "RDCF")).toMatchObject({ status: "unsupported", states: ["error", "empty"] });
  expect(assessCapture(capture(empty, render, 2), "FA").status).toBe("failure");
  for (const fault of [{ stateText: { error: [text, "Request failed"] } }, { errorStateMarkers: [...render.errorStateMarkers, "Backend unavailable"] }, { loadingStateDetected: true }, { visibleText: "NOT_FOUND" }]) {
    expect(assessCapture(capture(empty, { ...render, ...fault }, 2), "RDCF").status).toBe("failure");
  }
  const errors = ["No options provider available for DWSN", "Current ATM IV unavailable"];
  const dataEvidence = { kind: "realized-volatility", symbol: "DWSN", showIv: true, currentIv: null, loading: false, stale: false, errors, ivErrors: errors };
  const missingIv = { usable: false, unavailableSymbols: ["DWSN"], unusableReason: "Data is unavailable for DWSN.", dataEvidence };
  expect(assessCapture(capture(missingIv, {}, 2), "HVT").status).toBe("no-coverage");
  for (const changes of [{ dataEvidence: { ...dataEvidence, errors: ["Upstream timeout"] } }, { blankColumns: ["IV"] }, { semanticMismatch: true }, { gaps: "Request failed" }]) {
    expect(assessCapture(capture({ ...missingIv, ...changes }, {}, 2), "HVT").status).toBe("failure");
  }
  expect(assessCapture(capture(missingIv, { errorStateDetected: true }, 2), "HVT").status).toBe("failure");
  expect(assessCapture(capture(missingIv, { stateText: { empty: ["Backend unavailable"] } }, 2), "HVT").status).toBe("failure");
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
  const stderr = 'Still loading the data for CALLS DWSN.\nStill drawing CALLS DWSN.\n' + JSON.stringify({ ok: false, error: { code: "cli_error", message: "Timed out waiting for the desktop pane screenshot renderer." } });
  expect(assessCapture({ ...capture(), stdout: "", stderr, exitCode: 1 }, "CALLS"))
    .toMatchObject({ status: "command-error", reasonCodes: ["cli_error"], reason: "Timed out waiting for the desktop pane screenshot renderer." });
  for (const changes of [{ stdout: "malformed" }, { exitCode: 0 }, { stderr: `${stderr}\ntrailing noise` }, { stderr: `Unexpected warning\n${stderr}` }, { stderr: capture().stdout }]) {
    expect(assessCapture({ ...capture(), stdout: "", stderr, exitCode: 1, ...changes }, "CALLS").status).toBe("invalid-output");
  }
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
