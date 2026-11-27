import { afterEach, expect, setSystemTime, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import type { QuoteBatchResult } from "../../../types/data-provider";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../../market-data/market/status";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import { worldIndicesHeadless } from "./headless";
import { WORLD_INDICES } from "./indices";
import { renderWorldIndexCell, type WorldIndexColumn } from "./table";

afterEach(() => { setCliColorEnabledOverride(null); setSystemTime(); });

async function report(failure: Error) {
  const marketData = createTestDataProvider({
    getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => targets.map((target) => (
      target.symbol === "DX-Y.NYB"
        ? { target: { symbol: target.symbol, exchange: "" }, quote: null, error: failure }
        : { target: { symbol: target.symbol, exchange: "" }, quote: createTestQuote({ symbol: target.symbol, price: 100, change: 1, changePercent: 1, marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T20:15:00Z") }) }
    )),
  });
  const args = createTestHeadlessArgs();
  const result = await worldIndicesHeadless.load(args, createTestHeadlessContext({ marketData }));
  setCliColorEnabledOverride(false);
  const text = renderHeadlessPaneText(worldIndicesHeadless, result, args, "World Equity Indices");
  return { result, text, dxy: text.split("\n").find((line) => line.startsWith("DXY")) ?? "" };
}

test("an index the feed has no quote for says so in its row, in place of dashes and an error line", async () => {
  const { result, text, dxy } = await report(new Error("No quote provider available for DX-Y.NYB"));
  expect(dxy).toContain("US Dollar Index");
  expect(dxy).toContain("not available from the feed");
  expect(dxy).not.toContain("-");
  expect(text).not.toContain("Errors:");
  expect(text).not.toContain("DX-Y.NYB");
  // The report still says it is not whole, by symbol and as a count, and JSON marks the row.
  expect(result.unavailableSymbols).toEqual(["DX-Y.NYB"]);
  expect(result.errors).toEqual([]);
  expect(result.metadata).toMatchObject({ requested: 20, available: 19 });
  const rows = (result.sections as Array<{ rows: Array<Record<string, unknown>> }>).flatMap((section) => section.rows);
  expect(rows.filter((row) => row.unavailable === true).map((row) => row.shortName)).toEqual(["DXY"]);
});

test("a load that failed is an error, not a gap in what the feed carries", async () => {
  const { result, text, dxy } = await report(new Error("request timed out"));
  expect(text).toContain("Errors: DX-Y.NYB: request timed out");
  expect(dxy).not.toContain("not available from the feed");
  expect(result.unavailableSymbols).toBeUndefined();
});

test("WEI marks a stale open snapshot without relabeling a weekend close", async () => {
  setSystemTime(new Date("2026-10-10T15:00:00Z"));
  const weekendClose = sessionQuotes("^GSPC", { instrumentType: "INDEX" }).weekend;
  const marketData = createTestDataProvider({
    getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: target.symbol === "^GSPC" ? weekendClose
      : target.symbol === "DX-Y.NYB" ? { ...weekendClose, symbol: target.symbol, marketState: "REGULAR", stale: true } : null })),
  });
  const args = createTestHeadlessArgs();
  const result = await worldIndicesHeadless.load(args, createTestHeadlessContext({ marketData }));
  setCliColorEnabledOverride(false);
  const lines = renderHeadlessPaneText(worldIndicesHeadless, result, args, "World Equity Indices").split("\n");
  expect(lines.find((line) => line.startsWith("DXY"))).toMatch(/\bSTALE\b/);
  expect(lines.find((line) => line.startsWith("SPX"))).toMatch(/\bCLOSED\b/);
});

test("DXY uses its own cash session and the observed tick, not the equity pre-market or a presumed close", async () => {
  const entry = WORLD_INDICES.find((index) => index.shortName === "DXY")!;
  for (const [now, observed, price, marketState, stale, label, delayed] of [
    ["2026-11-27T11:44:00Z", "2026-11-26T04:58:00Z", 103.81, "REGULAR", true, "OPEN · STALE"],
    ["2026-11-21T16:00:00Z", "2026-11-20T21:59:00Z", 103.84, "CLOSED", false, "CLOSED"],
    ["2026-11-21T16:00:00Z", "2026-11-21T12:00:00Z", 103.84, "CLOSED", true, "CLOSED · STALE"],
    ["2026-11-22T23:02:00Z", "2026-11-22T23:01:00Z", 103.85, "REGULAR", false, "OPEN", true],
    ["2026-01-02T00:40:00Z", "2026-01-01T00:14:59Z", 98.4, null, true, "UNKNOWN · STALE"],
    ["2026-01-02T01:00:00Z", "2026-01-02T00:50:00Z", 98.4, null, true, "UNKNOWN · STALE"],
    ["2026-11-27T22:25:00Z", "2026-11-27T20:58:00Z", 103.81, "CLOSED", true, "CLOSED · STALE"],
    ["2026-11-25T00:30:00Z", "2026-11-25T00:14:59Z", 103.81, "CLOSED", false, "CLOSED"],
  ] as const) {
    setSystemTime(new Date(now));
    const quote = createTestQuote({ symbol: entry.symbol, exchangeName: "NYB", instrumentType: "INDEX",
      marketState: "PRE", preMarketPrice: price + 1,
      ...(delayed ? { dataSource: "delayed", providerId: "gloomberb-cloud" } : {}),
      lastUpdated: Date.parse(observed), price });
    const marketData = createTestDataProvider({ getQuotesBatch: async (targets) => targets.map((target) => ({
      target, quote: target.symbol === entry.symbol ? quote : null,
    })) });
    const args = createTestHeadlessArgs();
    const result = await worldIndicesHeadless.load(args, createTestHeadlessContext({ marketData }));
    const rows = (result.sections as Array<{ rows: Record<string, unknown>[] }>).flatMap((part) => part.rows);
    expect(rows.find((row) => row.symbol === entry.symbol)).toMatchObject({ marketState, stale, lastUpdated: Date.parse(observed), price, extendedPrice: null });
    const line = renderHeadlessPaneText(worldIndicesHeadless, result, args, "WEI").split("\n").find((row) => row.startsWith("DXY"));
    expect(line).toContain(label);
    const board = new Map([[entry.symbol, { quote, loading: false, error: null, stale: false }]]);
    const cell = (id: WorldIndexColumn["id"]) => renderWorldIndexCell({ type: "row", entry }, { id, label: "", width: 12, align: "right" }, board, { sessionText: true });
    expect(cell("status").value).toBe(label);
    expect(cell("price").value).toBe(price);
    expect(cell("time").value).toEqual(new Date(observed));
  }
});

test("WEI and its board headline the regular session's close and move, as `ticker` does", async () => {
  const quotes = sessionQuotes("^GSPC", { instrumentType: "INDEX" });
  for (const state of ["weekend", "afterHours", "preMarket", "regular"] as const) {
    const quote = quotes[state];
    const marketData = createTestDataProvider({
      getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => targets.map((target) => ({
        target: { symbol: target.symbol, exchange: "" }, quote: target.symbol === "^GSPC" ? quote : null,
      })),
    });
    const result = await worldIndicesHeadless.load(createTestHeadlessArgs(), createTestHeadlessContext({ marketData }));
    const spx = (result.sections as Array<{ rows: Array<Record<string, unknown>> }>)[0]!.rows[0]!;
    const headline = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote);
    expect(spx).toMatchObject({ price: headline.price, change: headline.change, changePercent: headline.changePercent,
      extendedSession: extended?.session ?? null, extendedPrice: extended?.price ?? null });

    const board = new Map([["^GSPC", { quote, loading: false, error: null, stale: false }]]);
    const cell = (id: WorldIndexColumn["id"]) => renderWorldIndexCell({ type: "row", entry: WORLD_INDICES[0]! }, { id, label: "", width: 12, align: "right" }, board);
    expect(cell("price").value).toBe(headline.price);
    expect(cell("changePercent").value).toBe(headline.changePercent);
  }
});
