import { describe, expect, test } from "bun:test";
import type { CentralBankRatesPayload, CentralBankRow } from "../../../api-client/central-bank-rates";
import { ApiRequestError } from "../../../api-client/errors";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { reportGlossary } from "../../../cli/glossary";
import { reportShotCoverage, shotStatusIssues, withReportCoverage, type PaneScreenshotResult } from "../../../cli/pane-functions/screenshot";
import { createTestHeadlessArgs } from "../../../test-support/headless";
import { fetchCentralBankRates, validateCentralBankRates } from "./client";
import { centralBankRatesHeadless } from "./headless";
import { policyBoardRow, policyHistory, policyNotices } from "./model";

function row(overrides: Partial<CentralBankRow> = {}): CentralBankRow {
  return { id: "US", label: "United States", countryCodes: ["US"], centralBank: "Federal Reserve", instrument: "Target midpoint",
    source: "fred", sourceUrl: "https://fred.stlouisfed.org/series/DFEDTARL", sourceSeriesIds: ["DFEDTARL", "DFEDTARU"], unit: "percent",
    publicationFrequency: "daily", value: 0, range: { lower: -0.125, upper: 0.125 }, asOf: "2026-09-21", lagDays: 1,
    fetchedAt: "2026-09-22T10:00:00Z", changeBps: 25, lastChangeDate: "2026-09-17", previousValue: -0.25, previousAsOf: "2026-09-16", direction: "hike",
    percentile: { value: 50, rank: 10, sampleCount: 20, windowStart: "2025-09-21", windowEnd: "2026-09-21", min: -0.25, max: 0, mean: -0.125 },
    history: [{ date: "2026-09-16", value: -0.25 }, { date: "2026-09-17", value: 0 }, { date: "2026-09-21", value: 0 }],
    status: "available", unavailableReason: null, notes: [], nextMeeting: null, ...overrides };
}
function payload(): CentralBankRatesPayload { return { generatedAt: "2026-09-22T10:00:00Z", status: "available", rows: [row()], gaps: [] }; }

describe("central bank policy boundary", () => {
  test("preserves range midpoint, zero and the change's distinct observation date", () => {
    const data = validateCentralBankRates(payload());
    const board = policyBoardRow(data.rows[0]!);
    expect(board.value).toBe(0);
    expect(board.change).toBe(25);
    expect(board.changeAsOf).toBe("2026-09-17");
    expect(board.asOf).toBe("2026-09-21");
    expect(board.observation.range).toEqual({ lower: -0.125, upper: 0.125 });
  });
  test("prints every policy rate with two decimals and keeps a third for eighths", () => {
    expect(policyBoardRow(row({ value: 3.875, range: { lower: 3.75, upper: 4 } })).valueText).toBe("3.75-4.00%");
    expect(["1", "2.5", "14", "3.875"].map((value) => policyBoardRow(row({ value: Number(value), range: null })).valueText))
      .toEqual(["1.00%", "2.50%", "14.00%", "3.875%"]);
  });
  test("accepts unavailable policy jurisdictions without supplying a prior rate", () => {
    const data = payload();
    data.rows.push(row({ id: "AR", value: null, range: null, asOf: null, lagDays: null, changeBps: null, lastChangeDate: null,
      previousValue: null, previousAsOf: null, direction: "unavailable", history: [], status: "unavailable", unavailableReason: "no-policy-rate" }));
    expect(validateCentralBankRates(data).rows[1]!.value).toBeNull();
    expect(policyBoardRow(data.rows[1]!).history).toEqual([]);
    expect(policyNotices(data)).toEqual([]);
  });
  test("members without a policy rate stay out of notices and report completeness", async () => {
    const unavailable = { value: null, range: null, asOf: null, lagDays: null, changeBps: null, lastChangeDate: null,
      previousValue: null, previousAsOf: null, direction: "unavailable" as const, history: [], status: "unavailable" as const };
    const data = payload();
    data.rows.push(row({ id: "AR", label: "Argentina", ...unavailable, unavailableReason: "no-policy-rate" }),
      row({ id: "african-union", label: "African Union", ...unavailable, unavailableReason: "no-unified-rate" }));
    const load = (body: CentralBankRatesPayload) => centralBankRatesHeadless.load({ rawArgument: "", argument: null, symbols: [], options: {} },
      { apiClient: { getCloudCentralBankRates: async () => body } } as unknown as HeadlessPaneContext);
    expect(await load(data)).toMatchObject({ complete: true, errors: [], unavailableSymbols: [] });
    data.status = "partial";
    data.rows.push(row({ id: "IN", label: "India", ...unavailable, unavailableReason: "source-unavailable" }));
    expect(await load(data)).toMatchObject({ complete: false, errors: ["India: source unavailable."], unavailableSymbols: ["IN"] });
  });
  test("rejects impossible dates, wrong units, contradictory ranges and undated changes", () => {
    for (const overrides of [
      { asOf: "2026-02-30" }, { value: NaN }, { range: { lower: 1, upper: 0 } }, { range: { lower: 1, upper: 2 } },
      { lastChangeDate: null }, { lastChangeDate: "2026-09-22" }, { changeBps: 0.25 }, { direction: "cut" },
      { previousAsOf: "2026-09-17" }, { lagDays: -1 }, { unit: "basis-points" },
      { nextMeeting: { date: "2026-02-30", sourceUrl: "https://example.com", verifiedAt: "2026-09-22" } },
    ]) { const data = payload(); data.rows[0] = row(overrides as Partial<CentralBankRow>); expect(() => validateCentralBankRates(data)).toThrow(); }
  });
  test("rejects duplicate identity and malformed histories without changing independent values", () => {
    const data = payload(); data.rows.push(row()); expect(() => validateCentralBankRates(data)).toThrow();
    data.rows = [row({ history: [{ date: "2026-02-30", value: 0 }] })]; expect(() => validateCentralBankRates(data)).toThrow();
  });
  test("history uses the published rank window, retaining gaps", () => {
    const observation = row({ history: [{ date: "2025-09-20", value: 1 }, { date: "2025-09-21", value: 0.25 },
      { date: "2026-09-18", value: null }, { date: "2026-09-21", value: 0 }] });
    expect(policyHistory(observation)).toEqual(observation.history.slice(1));
    expect(policyBoardRow(observation).history.at(-1)?.close).toBe(0);
  });
  test("stale observations retain their original date and numeric rate", () => {
    const data = payload(); data.rows = [row({ status: "stale", lagDays: 61 })];
    expect(validateCentralBankRates(data).rows[0]!.value).toBe(0);
    expect(policyNotices(data)[0]).toContain("2026-09-21");
  });
  test("missing endpoint is distinct from denied access", async () => {
    await expect(fetchCentralBankRates({ getCloudCentralBankRates: async () => { throw new ApiRequestError("not found", 404); } })).rejects.toThrow("not available yet");
    const denied = new ApiRequestError("sign in", 401);
    await expect(fetchCentralBankRates({ getCloudCentralBankRates: async () => { throw denied; } })).rejects.toBe(denied);
  });
});

describe("a board with stale rows", () => {
  const NOW = Date.parse("2026-10-12T09:00:00Z");
  const stale = (id: string, label: string, asOf: string, lagDays: number) => row({ id, label, status: "stale", asOf, lagDays, source: "bis", range: null, lastChangeDate: "2025-12-05", previousAsOf: "2025-12-04" });
  const board = () => {
    const data = payload();
    data.status = "partial";
    data.rows.push(stale("AU", "Australia", "2026-09-24", 18), stale("IN", "India", "2026-07-23", 81));
    return data;
  };
  const load = async (data: CentralBankRatesPayload) => {
    const args = createTestHeadlessArgs();
    const result = await centralBankRatesHeadless.load(args, { apiClient: { getCloudCentralBankRates: async () => data } } as unknown as HeadlessPaneContext);
    return { definition: centralBankRatesHeadless, args, result };
  };

  test("is partial everywhere: the report's line counts the stale rows and a capture's status says so", async () => {
    const loaded = await load(board());
    expect(formatFreshnessLine(deriveHeadlessFreshness(loaded.definition, loaded.result, NOW)))
      .toBe("Source: Central banks and BIS · Thu 24 Sep 2026 (oldest Thu 23 Jul 2026) · 2 of 3 stale");
    const coverage = await reportShotCoverage({ headless: centralBankRatesHeadless }, async () => loaded);
    expect(coverage).toEqual({ complete: false, unavailableSymbols: [], gaps: "2 stale" });
    // A capture that read its own view as complete takes the report's word, but stays as usable as it was.
    const captured = { complete: true, usable: true, empty: false, semanticMismatch: false, unavailableSymbols: [], render: {} } as unknown as PaneScreenshotResult;
    const partial = withReportCoverage(captured, coverage);
    expect(shotStatusIssues(partial)).toEqual(["partial: 2 stale"]);
    expect(partial).toMatchObject({ complete: false, usable: true, gaps: "2 stale" });
    // A complete board changes nothing.
    const whole = await load(payload());
    const clean = await reportShotCoverage({ headless: centralBankRatesHeadless }, async () => whole);
    expect(shotStatusIssues(withReportCoverage(captured, clean))).toEqual([]);
  });

  test("--explain lists the terms the report shows, with the change date defined as the first observation", async () => {
    const { definition, args, result } = await load(board());
    const entries = reportGlossary("CBR", renderHeadlessPaneText(definition, result, args, "CBR"));
    expect(entries.map((entry) => entry.term)).toEqual(["Last move", "Change observed", "Pctl 1Y", "Status"]);
    expect(entries[1]!.definition).toContain("first date the new rate level appears in the data");
  });
});
