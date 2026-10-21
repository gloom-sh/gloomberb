import { describe, expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import {
  holdsOtherCurrencies,
  needsVisibleQuoteWarmup,
  needsVisibleQuoteWatchdogRefresh,
  selectQuoteWarmupRoute,
  selectQuoteWarmupTickers,
  selectStreamTickers,
  VISIBLE_QUOTE_STREAM_MAX_AGE_MS,
} from "./data";
import { createTestFinancials } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { resolveVisibleColumns } from "../settings";

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "AAPL",
    price: 100,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function financials(quoteValue: Quote): TickerFinancials {
  return createTestFinancials({ quote: quoteValue });
}

function ticker(symbol: string): TickerRecord {
  return createTestTicker(symbol);
}

describe("portfolio visible quote warmup", () => {
  test("refreshes current-session quotes once the visible-row age window expires", () => {
    const now = Date.now();
    const data = financials(quote({
      lastUpdated: now - VISIBLE_QUOTE_STREAM_MAX_AGE_MS,
      listingExchangeName: "FWB2",
      marketState: "REGULAR",
    }));

    expect(needsVisibleQuoteWarmup(data, now)).toBe(false);
    expect(needsVisibleQuoteWatchdogRefresh(data, now)).toBe(true);
  });

  test("treats stale active-session quotes as visible warmup misses", () => {
    const now = Date.parse("2026-07-07T12:10:30Z");
    const data = financials(quote({
      lastUpdated: Date.parse("2026-07-07T12:10:00Z"),
      listingExchangeName: "NASDAQ",
      marketState: "PRE",
    }));

    expect(needsVisibleQuoteWarmup(data, now)).toBe(true);
    expect(needsVisibleQuoteWatchdogRefresh(data, now)).toBe(true);
  });
});

describe("selectQuoteWarmupRoute", () => {
  test("a quote-sorted row whose quote never arrives reloads its snapshot once per five minutes, not every quote cooldown", () => {
    const start = 1_700_000_000_000;
    const attempts: { quoteAt?: number; snapshotAt?: number } = {};
    const routes: string[] = [];
    // The warm-up re-checks on every tick; the row's quote stays missing.
    for (let now = start; now < start + 10 * 60_000; now += 5_000) {
      const route = selectQuoteWarmupRoute(attempts, true, now);
      if (!route) continue;
      routes.push(route);
      attempts.quoteAt = now;
      if (route === "snapshot") attempts.snapshotAt = now;
    }

    expect(routes.filter((route) => route === "snapshot")).toHaveLength(2);
    expect(routes.filter((route) => route === "quote").length).toBeGreaterThan(30);
    expect(selectQuoteWarmupRoute({ quoteAt: start }, false, start + 5 * 60_000)).toBe("quote");
  });
});

describe("selectStreamTickers", () => {
  test("includes visible rows with overscan and clamps boundaries", () => {
    const tickers = Array.from({ length: 20 }, (_, index) => ticker(`T${index}`));
    expect(selectStreamTickers(tickers, { start: 3, end: 7 }).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(0, 13).map((entry) => entry.metadata.ticker),
    );
    expect(selectStreamTickers(tickers, { start: 18, end: 20 }).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(12, 20).map((entry) => entry.metadata.ticker),
    );
  });

  test("includes selected ticker outside the visible streaming window", () => {
    const tickers = Array.from({ length: 20 }, (_, index) => ticker(`T${index}`));
    expect(selectStreamTickers(tickers, { start: 3, end: 7 }, "T19").map((entry) => entry.metadata.ticker)).toContain("T19");
  });
});

describe("selectQuoteWarmupTickers", () => {
  test("includes hidden quote-missing rows when sorting by quote-dependent columns", () => {
    const tickers = Array.from({ length: 30 }, (_, index) => ticker(`T${index}`));
    const financialsMap = new Map<string, TickerFinancials>(
      tickers.slice(0, 29).map((entry, index) => [
        entry.metadata.ticker,
        financials({
          symbol: entry.metadata.ticker,
          price: index + 1,
          currency: "USD",
          change: index,
          changePercent: index,
          lastUpdated: 1_700_000_000_000,
        }),
      ]),
    );

    const selected = selectQuoteWarmupTickers(
      tickers,
      { start: 0, end: 24 },
      financialsMap,
      { columnId: "change_pct", direction: "asc" },
      1_700_000_010_000,
    ).map((entry) => entry.metadata.ticker);

    expect(selected).toContain("T29");
  });

  test("does not add hidden rows for ticker-only sorting", () => {
    const tickers = Array.from({ length: 30 }, (_, index) => ticker(`T${index}`));
    expect(selectQuoteWarmupTickers(
      tickers,
      { start: 0, end: 24 },
      new Map(),
      { columnId: "ticker", direction: "asc" },
    ).map((entry) => entry.metadata.ticker)).toEqual(
      tickers.slice(0, 24).map((entry) => entry.metadata.ticker),
    );
  });
});

describe("visible quote refresh predicates", () => {
  test("refreshes visible quotes when the local stream timestamp is too old", () => {
    const now = 1_700_000_120_000;
    expect(needsVisibleQuoteWatchdogRefresh(
      financials(quote({ lastUpdated: now, receivedAt: now - 61_000 })),
      now,
      60_000,
    )).toBe(true);
    expect(needsVisibleQuoteWatchdogRefresh(
      financials(quote({ lastUpdated: now, receivedAt: now - 10_000 })),
      now,
      60_000,
    )).toBe(false);
  });
});

// GLO-1106: RY at 278.08 CAD and JNJ at 259.36 USD sat in one PF column with nothing to tell them apart.
test("CCY shows after LAST once a row is priced in another currency than the totals, and only then", () => {
  const row = (symbol: string, currency: string, overrides: Partial<Quote> = {}) => ({
    ticker: createTestTicker(symbol, symbol, { currency }),
    data: financials(quote({ symbol, currency, ...overrides })),
  });
  const holds = (rows: ReturnType<typeof row>[], totals: string) => holdsOtherCurrencies(
    rows.map((entry) => entry.ticker), new Map(rows.map((entry) => [entry.ticker.metadata.ticker, entry.data])), totals);
  const jnj = row("JNJ", "USD");
  const ry = row("RY.TO", "CAD");
  expect(holds([jnj, ry], "USD")).toBe(true);
  // A US stock in a CAD portfolio is the other currency too.
  expect(holds([jnj], "CAD")).toBe(true);
  expect(holds([jnj, row("SPY", "USD")], "USD")).toBe(false);
  // Pence are pounds, whose sign the price carries; an index level is in points.
  expect(holds([row("VOD", "GBp")], "GBP")).toBe(false);
  expect(holds([jnj, row("^N225", "JPY", { instrumentType: "INDEX" })], "USD")).toBe(false);

  const ids = (columns: { id: string }[]) => columns.map((column) => column.id);
  expect(ids(resolveVisibleColumns(["ticker", "price", "change_pct", "mkt_value"], true, { otherCurrencies: true })))
    .toEqual(["ticker", "price", "currency", "change_pct", "mkt_value"]);
  expect(ids(resolveVisibleColumns(["ticker", "price", "change_pct"], true))).toEqual(["ticker", "price", "change_pct"]);
  // A pane that already places CCY keeps it where it is.
  expect(ids(resolveVisibleColumns(["currency", "ticker", "price"], false, { otherCurrencies: true }))).toEqual(["currency", "ticker", "price"]);
});
