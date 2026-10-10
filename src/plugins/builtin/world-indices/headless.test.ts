import { afterEach, expect, test } from "bun:test";
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

afterEach(() => setCliColorEnabledOverride(null));

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
