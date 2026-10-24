import { afterEach, expect, test } from "bun:test";
import type { ScreenMetric, ScreenPayload, ScreenRow } from "../../../api-client/equity-screener";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { marketDataCliCommands } from "../../../cli/commands/market";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../../market-data/market/status";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey } from "../../../market-data/selectors";
import { createDefaultConfig } from "../../../types/config";
import type { Quote } from "../../../types/financials";
import { createTestCliContext, type PrintedCliResult } from "../../../test-support/cli-context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import { equityScreenerHeadless } from "./headless";
import { overlayLiveScreenRows, screenExtendedSessions, sortLiveScreenRows } from "./live";
import { screenFixture } from "./test-fixture";

afterEach(() => setCliColorEnabledOverride(null));

/** AAPL through the sessions around Friday 2026-10-09's 198.78 close (+0.51%), at fixed times. */
const quotes = () => sessionQuotes("AAPL", { listingExchangeName: "NASDAQ", instrumentType: "EQUITY" });
type Session = keyof ReturnType<typeof quotes>;

const metric = (value: number, unit: string, asOf: string): ScreenMetric => ({
  value, unit, asOf, availableAt: null, observedAt: "2026-10-10T12:00:00.000Z", source: "test",
  state: "available", scope: "reported", reason: null, sourceUrl: null,
  percentile: { value: 50, sampleCount: 10, scope: "covered-universe" },
});

/**
 * Gloom Cloud's snapshot row for AAPL, collected Saturday: Friday's close and
 * its move, 1,000 shares' worth of cap. `price` swaps in another price, as a
 * snapshot priced at an extended print was.
 */
function snapshotRow(price = 198.78, changePercent = 0.5056): ScreenRow {
  const row = screenFixture().rows[0]!;
  row.metrics.price = metric(price, "USD", "2026-10-09");
  row.metrics.changePercent = metric(changePercent, "%", "2026-10-09");
  row.metrics.volume = metric(50_000_000, "shares", "2026-10-09");
  row.metrics.marketCap = metric(price * 1000, "USD", "2026-10-09");
  return row;
}

const ready = (quote: Quote): QueryEntry<Quote> => ({
  phase: "ready", data: quote, lastGoodData: quote, source: "gloomberb-cloud", fetchedAt: null, staleAt: null, error: null, attempts: [],
});

/** The pane's row once `quote` streams in. */
function paneRow(row: ScreenRow, quote: Quote) {
  return overlayLiveScreenRows([row], new Map([[buildQuoteKey({ symbol: row.symbol, exchange: row.exchange }), ready(quote)]]))[0]!;
}

test("the pane's live row keeps Last, Chg% and MCAP at the regular session and puts the extended print beside them", () => {
  // Open: the live quote ticks Last, Chg%, volume and the cap.
  const trading = snapshotRow(198.5, 0.36);
  trading.metrics.price.observedAt = "2026-10-09T16:45:00.000Z";
  const open = paneRow(trading, { ...quotes().regular, volume: 60_000_000 });
  expect(open.metrics.price.value).toBe(199.1);
  expect(open.metrics.changePercent.value).toBe(0.6674);
  expect(open.metrics.volume.value).toBe(60_000_000);
  expect(open.metrics.marketCap.value).toBeCloseTo(199_100, 6);
  expect(open.extended).toBeUndefined();

  // After the close the row is the close, wherever the snapshot was priced; the print is `extended`.
  const cases: Array<[Session, "PRE" | "POST" | "OVERNIGHT", number]> = [
    ["afterHours", "POST", 0.0101],
    ["weekend", "POST", 0.0101],
    ["overnight", "OVERNIGHT", 0.0855],
    ["preMarket", "PRE", 0.3622],
  ];
  for (const [session, extendedSession, move] of cases) {
    for (const snapshot of [snapshotRow(), snapshotRow(198.8, 0.5157)]) {
      const row = paneRow(snapshot, quotes()[session]);
      expect(row.metrics.price).toMatchObject({ value: 198.78, asOf: "2026-10-09", state: "available" });
      expect(row.metrics.changePercent.value).toBe(0.5056);
      // The cap scales with the close, not with the print.
      expect(row.metrics.marketCap.value).toBeCloseTo(198_780, 6);
      // The close's session volume is the snapshot's; a quote outside the session never replaces it.
      expect(row.metrics.volume.value).toBe(50_000_000);
      expect(row.extended?.session).toBe(extendedSession);
      expect(row.extended?.changePercent).toBeCloseTo(move, 3);
      // Percentiles, and with them the order, stay the snapshot's.
      expect(row.metrics.changePercent.percentile).toEqual(snapshot.metrics.changePercent.percentile);
    }
  }
  // A snapshot priced at a pre-market print is dated by the day that trades in, as the quote is.
  const preOpen = snapshotRow(199.4, 0.3218);
  preOpen.metrics.price.asOf = "2026-10-12";
  expect(paneRow(preOpen, quotes().preMarket).metrics.price).toMatchObject({ value: 198.78, asOf: "2026-10-09" });
  expect(screenExtendedSessions([paneRow(snapshotRow(), quotes().preMarket), paneRow(snapshotRow(), quotes().weekend), snapshotRow()]))
    .toEqual(["PRE", "POST"]);

  // A quote in the other unit of the currency, a stale one, or a close older than the snapshot's leaves the row alone.
  const snapshot = snapshotRow();
  const pence = { ...snapshotRow(), currency: "GBP" };
  expect(paneRow(pence, { ...quotes().weekend, currency: "GBp", price: 19_880 })).toBe(pence);
  expect(paneRow(snapshot, { ...quotes().weekend, stale: true })).toBe(snapshot);
  const later = snapshotRow();
  later.metrics.price.asOf = "2026-10-12";
  expect(paneRow(later, quotes().weekend)).toBe(later);
  // A live quote older than the snapshot is not news either.
  expect(paneRow(snapshotRow(), { ...quotes().regular, lastUpdated: Date.parse("2026-10-09T15:00:00Z") }).metrics.price.value).toBe(198.78);
});

/** EQS's report over one row, its quote read through `marketData`. */
async function report(snapshot: ScreenRow, quote: Quote) {
  const data: ScreenPayload = screenFixture();
  data.rows = [snapshot];
  const apiClient = { equityScreener: async () => structuredClone(data) };
  const marketData = createTestDataProvider({ getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote })) });
  const args = { argument: undefined, options: {} } as never;
  const result = await equityScreenerHeadless.load(args, { apiClient, marketData } as never);
  setCliColorEnabledOverride(false);
  return { row: result.sections![0]!.rows![0]!, text: renderHeadlessPaneText(equityScreenerHeadless, result, args, "EQS") };
}

/** `quote AAPL`'s row. */
async function quoteRow(quote: Quote) {
  const cli = createTestCliContext({ config: createDefaultConfig("/tmp/gloom-eqs-sessions-test"), dataProvider: {
    getQuotesBatch: async () => [{ target: { symbol: "AAPL", exchange: "" }, quote }],
  } });
  await marketDataCliCommands.find((command) => command.name === "compare")!.execute(["AAPL"], cli.context);
  const [{ result, options }] = cli.printed as [PrintedCliResult];
  return (options!.rows!(result.data) as Array<Record<string, unknown>>)[0]!;
}

test("the EQS pane, its report and `quote` agree on Last and Chg% in every session, the extended print a column of its own", async () => {
  for (const session of ["regular", "afterHours", "weekend", "overnight", "preMarket"] as const) {
    const quote = quotes()[session];
    // A snapshot priced at the after-hours print, as Gloom Cloud priced one before it ranked by the close.
    const snapshot = snapshotRow(198.8, 0.5157);
    if (session === "regular") snapshot.metrics.price.observedAt = "2026-10-09T16:30:00.000Z";
    const pane = paneRow(snapshot, quote);
    const { row, text } = await report(snapshot, quote);
    const cli = await quoteRow(quote);
    const headline = getRegularSessionDisplay(quote)!;
    expect(cli.rawPrice).toBe(headline.price);
    expect(pane.metrics.price.value).toBe(headline.price);
    expect(row.price).toBe(headline.price);
    expect(Number(cli.changePercent)).toBeCloseTo(headline.changePercent!, 2);
    expect(pane.metrics.changePercent.value).toBe(headline.changePercent!);
    expect(row.changePercent).toBe(headline.changePercent);

    const extended = getExtendedSessionDisplay(quote);
    expect(row.extendedSession).toBe(extended?.session ?? null);
    expect(cli.extendedSession).toBe(extended?.session ?? null);
    expect(pane.extended?.session).toBe(extended?.session);
    const line = text.split("\n").find((entry) => entry.startsWith("AAPL "))!;
    if (session === "regular") {
      expect(line).toMatch(/\$199\.10 +\+0\.67%/);
      expect(text).not.toMatch(/Pre-Market|After Hours|Overnight/);
    } else {
      // Last and Chg% are the close; the print and its move from it sit in their own column.
      expect(line).toMatch(new RegExp(`\\$198\\.78 +\\+0\\.51% +\\$${extended!.price.toFixed(2).replace(".", "\\.")} \\+`));
      expect(text).toContain({ PRE: "Pre-Market", POST: "After Hours", OVERNIGHT: "Overnight" }[extended!.session]);
    }
  }
});

test("a sort on a figure the quotes move is redone on the figures shown; other sorts keep the snapshot's order", () => {
  // GRAB was ranked at a cap two closes old (13.05B) and shown at its close (12.19B), above MANH's 12.98B.
  const row = (symbol: string, cap: number | null, volume: number) => {
    const base = snapshotRow();
    return { ...base, symbol, metrics: { ...base.metrics,
      marketCap: { ...base.metrics.marketCap, value: cap }, volume: { ...base.metrics.volume, value: volume } } };
  };
  const shown = [row("GRAB", 12.19e9, 3), row("NONE", null, 1), row("MANH", 12.98e9, 2), row("DUOL", 6.55e9, 4)];
  const order = (sort: Parameters<typeof sortLiveScreenRows>[1]) => sortLiveScreenRows(shown, sort).map((item) => item.symbol);
  expect(order({ field: "marketCap", direction: "desc" })).toEqual(["MANH", "GRAB", "DUOL", "NONE"]);
  expect(order({ field: "marketCap", direction: "asc" })).toEqual(["DUOL", "GRAB", "MANH", "NONE"]);
  expect(order({ field: "trailingPE", direction: "desc" })).toEqual(["GRAB", "NONE", "MANH", "DUOL"]);
});
