import { expect, setSystemTime, test } from "bun:test";
import { deriveHeadlessFreshness, deriveRenderedFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { quoteChangeBasis } from "../../../market-data/market/change-basis";
import type { QueryEntry } from "../../../market-data/result-types";
import { createTestQuote } from "../../../test-support/data-provider";
import type { DataProvider } from "../../../types/data-provider";
import type { ExchangeRateSnapshot } from "../../../types/exchange-rate";
import type { Quote } from "../../../types/financials";
import { buildASKGToolManifests } from "../cloud/askg/manifest";
import { MAX_TOOL_RESULT_BYTES } from "../cloud/askg/protocol";
import { fxRateObservations } from "../shared/fx-rate-freshness";
import { loadFxBoard, type FxLegReading } from "./client";
import { fxMatrixHeadless, projectFxCrosses } from "./headless";
import { fxMatrixModule } from "./index";
import { fxLegReferenceRate, fxLegs, liveFxLegEntry } from "./live-legs";
import { FX_CURRENCIES, resolveCurrencies, type FxCurrency } from "./pairs";
import { fxTradingDay } from "../../../utils/fx-market-hours";

const at = (iso: string) => Date.parse(iso);

/** A rate as the shared FX cache loads it: dated, 15 minutes behind, current until its own schedule says not. */
function loadedRate(currency: string, rate: number, asOf: string | null, overrides: Partial<QueryEntry<number>> = {}): FxLegReading {
  return {
    leg: fxLegs([currency])[0]!,
    entry: {
      phase: "ready", data: rate, lastGoodData: rate, source: "gloom", fetchedAt: at("2026-10-14T13:59:00Z"),
      ...(asOf ? { asOf: at(asOf) } : {}), delayMinutes: 15, staleAt: at("2026-10-20T00:00:00Z"), error: null, attempts: [],
      ...overrides,
    },
    quote: null,
    reference: null,
    error: null,
  };
}

/** A leg drawn from its pair quote, as Gloom Cloud serves one, with the previous close a move reads against. */
function quotedRate(currency: string, usdPerUnit: number, previousUsdPerUnit: number, lastUpdated: string): FxLegReading {
  const leg = fxLegs([currency])[0]!;
  const price = leg.inverted ? 1 / usdPerUnit : usdPerUnit;
  const quote = createTestQuote({
    symbol: leg.symbol, price, previousClose: leg.inverted ? 1 / previousUsdPerUnit : previousUsdPerUnit,
    instrumentType: "CURRENCY", listingExchangeName: "CCY", exchangeName: "CCY", marketState: "REGULAR",
    dataSource: "delayed", providerId: "gloomberb-cloud", stale: false, lastUpdated: at(lastUpdated), receivedAt: at(lastUpdated) + 1000,
    changeSessionDate: fxTradingDay(at(lastUpdated)),
  });
  const quoteEntry: QueryEntry<Quote> = {
    phase: "ready", data: quote, lastGoodData: quote, source: "gloomberb-cloud", fetchedAt: quote.receivedAt!,
    staleAt: null, error: null, attempts: [],
  };
  return { leg, entry: liveFxLegEntry(leg, quoteEntry, null), quote, reference: fxLegReferenceRate(leg, quoteEntry), changeBasis: quoteChangeBasis(quote), error: null };
}

function readings(...legs: FxLegReading[]): Map<string, FxLegReading> {
  return new Map(legs.map((reading) => [reading.leg.currency, reading]));
}

test("one row per ordered cross in board order, moved only when both legs carry a close, as old as the older leg", () => {
  const now = at("2026-10-14T14:00:00Z");
  const result = projectFxCrosses(["USD", "EUR", "JPY", "GBP", "CAD"], readings(
    quotedRate("EUR", 1.2, 1.18, "2026-10-14T13:59:00Z"),
    quotedRate("JPY", 1 / 150, 1 / 151, "2026-10-14T13:50:00Z"),
    // A loaded rate has no previous close, and this one no observation time.
    loadedRate("CAD", 0.7, null),
    { ...loadedRate("GBP", 1.3, null), entry: null, error: "No rate came back." },
  ), { now });
  const row = (pair: string) => result.rows.find((candidate) => candidate.pair === pair)!;

  expect(result.rows.map(({ pair }) => pair)).toEqual([
    "USD/EUR", "USD/JPY", "USD/GBP", "USD/CAD", "EUR/USD", "EUR/JPY", "EUR/GBP", "EUR/CAD",
    "JPY/USD", "JPY/EUR", "JPY/GBP", "JPY/CAD", "GBP/USD", "GBP/EUR", "GBP/JPY", "GBP/CAD",
    "CAD/USD", "CAD/EUR", "CAD/JPY", "CAD/GBP",
  ]);
  expect(row("EUR/USD")).toMatchObject({ rate: 1.2, asOf: "2026-10-14T13:59:00.000Z", dataSource: "delayed", delayMinutes: 15 });
  expect(row("EUR/USD").movePercent).toBeCloseTo((1.2 / 1.18 - 1) * 100, 10);
  expect(row("EUR/JPY").rate).toBeCloseTo(180, 10);
  expect(row("EUR/JPY").movePercent).toBeCloseTo(((1.2 / 1.18) / (151 / 150) - 1) * 100, 10);
  // The older leg dates the cross; a leg without a time leaves it unknown, and a loaded rate has no move.
  expect(row("EUR/JPY").asOf).toBe("2026-10-14T13:50:00.000Z");
  expect(row("EUR/CAD")).toMatchObject({ movePercent: null, asOf: null });
  expect(row("EUR/CAD").rate).toBeCloseTo(1.2 / 0.7, 10);
  // A leg with no rate leaves its crosses unavailable, never at parity.
  expect(row("GBP/USD")).toEqual({ pair: "GBP/USD", base: "GBP", quote: "USD", rate: null, movePercent: null, asOf: null });
  expect(row("EUR/GBP").rate).toBeNull();
  expect(result).toMatchObject({ complete: false, unavailableSymbols: ["GBP"], errors: ["GBP: No rate came back."] });

  // Fifteen currencies cross into 210 ordered pairs, none against itself.
  const asia = resolveCurrencies("USD,KRW,asia");
  const all = projectFxCrosses(asia, readings(...asia.filter((code) => code !== "USD").map((code, index) => (
    loadedRate(code, 1 / (index + 2), "2026-10-14T13:30:00Z")
  ))), { now });
  expect(asia).toHaveLength(15);
  expect(all.rows).toHaveLength(210);
  expect(all.rows.some(({ base, quote }) => base === quote)).toBe(false);
  expect(all.complete).toBe(true);
});

test("the report is dated by its legs as the pane's capture is, not by the crosses each leg makes", () => {
  const currencies: FxCurrency[] = ["USD", "EUR", "JPY", "CAD", "GBP"];
  const reportOf = (now: string, legs: Map<string, FxLegReading>) => {
    const result = projectFxCrosses(currencies, legs, { now: at(now) });
    // What the pane publishes for the same rates (index.tsx's report-freshness node).
    const rates = new Map(currencies.flatMap((code) => {
      const rate = code === "USD" ? 1 : legs.get(code)?.entry?.data;
      return rate == null ? [] : [[code as string, rate] as const];
    }));
    const observed = fxRateObservations(currencies, rates, (code) => ({ entry: legs.get(code)?.entry, legQuote: legs.get(code)?.quote }), at(now));
    const pane = deriveRenderedFreshness(undefined, { footerText: "", cellTimes: [], observed }, at(now));
    const report = deriveHeadlessFreshness(fxMatrixHeadless, result, at(now));
    expect(report).toEqual(pane);
    return formatFreshnessLine(report);
  };

  // Saturday: Friday's close, whatever quiet ticks some pairs printed since.
  expect(reportOf("2026-10-10T18:45:00Z", readings(
    loadedRate("EUR", 1.12, "2026-10-09T21:29:00Z"),
    loadedRate("JPY", 1 / 158, "2026-10-09T20:59:00Z"),
    loadedRate("CAD", 0.7, "2026-10-10T04:21:11Z"),
    loadedRate("GBP", 1.32, "2026-10-10T14:50:28Z"),
  ))).toBe("Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed");

  // One stale leg of four is one stale rate, though it sits in 8 of the 20 crosses.
  expect(reportOf("2026-10-14T14:00:00Z", readings(
    quotedRate("EUR", 1.2, 1.18, "2026-10-14T13:59:41Z"),
    quotedRate("JPY", 1 / 150, 1 / 151, "2026-10-14T13:58:02Z"),
    loadedRate("CAD", 0.7, "2026-10-14T13:50:00Z"),
    loadedRate("GBP", 1.3, "2026-10-14T09:00:00Z", { staleAt: at("2026-10-14T10:15:00Z") }),
  ))).toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · 15 min delayed, 1 of 4 stale · markets open");
});

test("a pair quote replaces a leg's loaded rate only when it is at least as new, and its close is the move's either way", async () => {
  // Mid-session on a Wednesday, so every rate below is of the same FX trading day but the last.
  const now = at("2026-10-14T14:00:00Z");
  setSystemTime(now);
  try {
    const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const pairQuote = (symbol: string, price: number, previousClose: number, minutesAgo: number) => createTestQuote({
      symbol, price, previousClose, dataSource: "delayed", lastUpdated: now - minutesAgo * 60_000,
    });
    const provider = {
      id: "test",
      // EUR's loaded rate is older than its quote; JPY's and CHF's quotes are older than their loaded rates.
      getExchangeRateSnapshot: async (currency: string): Promise<ExchangeRateSnapshot> => {
        if (currency === "GBP") throw new Error("no rate");
        return {
          fromCurrency: currency, toCurrency: "USD", rate: currency === "EUR" ? 1.1 : currency === "CHF" ? 1.25 : 1 / 150,
          source: "test", asOf: ago(currency === "EUR" ? 30 : 5), fetchedAt: ago(0), stale: false,
        };
      },
      getQuotesBatch: async (targets: { symbol: string }[]) => targets.map((target) => ({
        target,
        quote: target.symbol === "EURUSD=X" ? pairQuote("EURUSD=X", 1.2, 1.18, 10)
          : target.symbol === "JPY=X" ? pairQuote("JPY=X", 140, 141, 6)
            // Last printed before Tuesday's 17:00 New York roll: its previous close is Monday's, not Tuesday's.
            : target.symbol === "CHF=X" ? pairQuote("CHF=X", 0.8, 0.81, 22 * 60) : null,
      })),
    } as unknown as DataProvider;

    const board = await loadFxBoard(["USD", "EUR", "JPY", "CHF", "GBP"], provider);

    expect(board.get("EUR")).toMatchObject({ entry: { data: 1.2, asOf: now - 10 * 60_000 }, reference: 1.18 });
    // The loaded rate a minute newer draws the cell, and moves from the quote's close instead of leaving Move blank.
    expect(board.get("JPY")).toMatchObject({ entry: { data: 1 / 150 }, quote: null });
    expect(board.get("JPY")?.reference).toBeCloseTo(1 / 141, 12);
    expect(board.get("CHF")).toMatchObject({ entry: { data: 1.25 }, reference: null, changeBasis: null });
    expect(board.get("GBP")).toMatchObject({ entry: null, error: expect.stringContaining("no rate") });
  } finally {
    setSystemTime();
  }
});

test("every cross moves from its legs' previous daily close, and the Move header names that close", () => {
  const now = at("2026-10-22T04:45:00Z");
  const eur = quotedRate("EUR", 1.1247, 1.1235, "2026-10-22T04:41:00Z");
  const result = projectFxCrosses(["USD", "EUR", "CHF"], readings(
    // A loaded rate a minute newer than its quote keeps the quote's close.
    { ...eur, entry: { ...eur.entry!, data: 1.1248, asOf: at("2026-10-22T04:42:00Z") }, quote: null },
    quotedRate("CHF", 1 / 0.8229, 1 / 0.8241, "2026-10-22T04:41:00Z"),
  ), { now });
  expect(result.rows.every((row) => typeof row.movePercent === "number")).toBe(true);
  expect(result.metadata).toMatchObject({ changeBasis: "vs Wed 21 Oct close" });
  const args = { rawArgument: "", argument: null, symbols: [], options: { currencies: "USD,EUR,CHF" } };
  const text = renderHeadlessPaneText(fxMatrixHeadless, result, args, "FXC");
  expect(text).toContain("Move vs Wed 21 Oct close");
  expect(text).not.toContain("—");
});

test("Ask Gloom's FXC tool takes the currencies as one string and gets every cross of all 45 within its result limit", () => {
  const pane = fxMatrixModule.panes![0]!;
  const template = fxMatrixModule.paneTemplates![0]!;
  const tool = buildASKGToolManifests({
    panes: new Map([[pane.id, pane]]),
    paneTemplates: new Map([[template.id, template]]),
    destroy() {},
  }).tools.find(({ name }) => name === "fxc");
  expect(tool).toMatchObject({ source: "headless", writeTier: "read", shape: "rows", argument: { kind: "none" } });
  expect(tool?.options?.map(({ key, type }) => ({ key, type }))).toEqual([{ key: "currencies", type: "string" }]);

  const quoted = FX_CURRENCIES.filter((code) => code !== "USD").map((code, index) => (
    quotedRate(code, 1 / (index + 1.37), 1 / (index + 1.38), "2026-10-14T13:59:41Z")
  ));
  const result = projectFxCrosses(FX_CURRENCIES, readings(...quoted), { now: at("2026-10-14T14:00:00Z") });
  const compact = fxMatrixHeadless.compact!(result, { rawArgument: "", argument: null, symbols: [], options: { currencies: "all" } });
  const bytes = new TextEncoder().encode(JSON.stringify(serializeHeadlessPaneResult(fxMatrixHeadless, compact))).byteLength;

  expect(compact.rows).toHaveLength(1980);
  // Room for the call's envelope and a note, as the executor keeps it.
  expect(bytes).toBeLessThan(MAX_TOOL_RESULT_BYTES - 8_192);
});
