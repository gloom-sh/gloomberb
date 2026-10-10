import { expect, test } from "bun:test";
import { deriveRenderedFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import type { QueryEntry } from "../../../market-data/result-types";
import { createTestQuote } from "../../../test-support/data-provider";
import type { Quote } from "../../../types/financials";
import { fxRateObservations } from "./freshness";
import { fxLegs, liveFxLegEntry } from "./live-legs";

const at = (iso: string) => Date.parse(iso);

/** A rate loaded from the data service: dated by its observation, current until its own schedule says not. */
function snapshot(asOf: string | null, overrides: Partial<QueryEntry<number>> = {}): QueryEntry<number> {
  return {
    phase: "ready", data: 1, lastGoodData: 1, source: "gloom", fetchedAt: at("2026-10-10T18:40:00Z"),
    ...(asOf ? { asOf: at(asOf) } : {}), staleAt: at("2026-10-20T00:00:00Z"), error: null, attempts: [], ...overrides,
  };
}

/** The line a report of the matrix ends with, for the rates it draws at `now`. */
function reportLine(
  now: string,
  entries: Record<string, QueryEntry<number>>,
  legQuotes: Record<string, Quote> = {},
): { line: string; freshness: ReturnType<typeof deriveRenderedFreshness> } {
  const rates = new Map(Object.keys(entries).map((currency) => [currency, 1.1] as const));
  const observed = fxRateObservations(["USD", ...Object.keys(entries)], rates, (currency) => ({
    entry: entries[currency], legQuote: legQuotes[currency],
  }), at(now));
  const freshness = deriveRenderedFreshness(undefined, { footerText: "", cellTimes: [], observed }, at(now));
  return { line: formatFreshnessLine(freshness), freshness };
}

/** A pair quote the way Gloom Cloud serves one, and the rate entry the matrix reads from it. */
function leg(currency: string, lastUpdated: string, overrides: Partial<Quote> = {}) {
  const pair = fxLegs([currency])[0]!;
  const quote = createTestQuote({
    symbol: pair.symbol, price: 1.1, instrumentType: "CURRENCY", listingExchangeName: "CCY", exchangeName: "CCY",
    marketState: "REGULAR", dataSource: "delayed", providerId: "gloomberb-cloud", stale: false,
    lastUpdated: at(lastUpdated), receivedAt: at(lastUpdated) + 1000, ...overrides,
  });
  const quoteEntry: QueryEntry<Quote> = {
    phase: "ready", data: quote, lastGoodData: quote, source: "gloomberb-cloud", fetchedAt: quote.receivedAt!,
    staleAt: null, error: null, attempts: [],
  };
  return { quote, entry: liveFxLegEntry(pair, quoteEntry, null)! };
}

test("over a weekend the matrix is Friday's close, whatever quiet ticks the pairs printed since", () => {
  // Saturday 18:45 UTC, with the rates as the data service served them: the
  // euro and yen last traded Friday, the others ticked on Saturday.
  const { line, freshness } = reportLine("2026-10-10T18:45:00Z", {
    EUR: snapshot("2026-10-09T21:29:00Z"),
    JPY: snapshot("2026-10-09T20:59:00Z"),
    CAD: snapshot("2026-10-10T04:21:11Z"),
    GBP: snapshot("2026-10-10T14:50:28Z"),
  });
  expect(line).toBe("Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · delayed · markets closed");
  // The newest observation stays as it was; only the wording dates it by the close.
  expect(freshness).toMatchObject({ status: "delayed", asOf: "2026-10-10T14:50:28.000Z", asOfClose: "2026-10-09", market: { state: "closed" } });
});

test("on a weekday it is dated by the newest pair quote, with the feed's delay and the market open", () => {
  const now = "2026-10-14T14:00:00Z";
  const eur = leg("EUR", "2026-10-14T13:59:41Z");
  const jpy = leg("JPY", "2026-10-14T13:58:02Z");
  expect(reportLine(now, { EUR: eur.entry, JPY: jpy.entry }, { EUR: eur.quote, JPY: jpy.quote }).line)
    .toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · 15 min delayed · markets open");
  // A real-time feed says live, and never from a snapshot.
  const live = (currency: string, time: string) => leg(currency, time, { dataSource: "live" });
  const [eurLive, jpyLive] = [live("EUR", "2026-10-14T13:59:41Z"), live("JPY", "2026-10-14T13:59:50Z")];
  expect(reportLine(now, { EUR: eurLive.entry, JPY: jpyLive.entry }, { EUR: eurLive.quote, JPY: jpyLive.quote }).line)
    .toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · live · markets open");
  expect(reportLine(now, { EUR: eurLive.entry, JPY: snapshot("2026-10-14T13:50:00Z") }, { EUR: eurLive.quote }).line)
    .toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · delayed · markets open");
});

test("a leg that has gone stale makes the matrix partly stale, with the share", () => {
  const now = "2026-10-14T14:00:00Z";
  const eur = leg("EUR", "2026-10-14T13:59:41Z");
  const jpy = leg("JPY", "2026-10-14T13:58:02Z");
  // The rate for CHF stopped updating: its own schedule ran out an hour ago.
  const chf = snapshot("2026-10-14T09:20:00Z", { staleAt: at("2026-10-14T10:35:00Z") });
  const result = reportLine(now, { EUR: eur.entry, JPY: jpy.entry, CHF: chf }, { EUR: eur.quote, JPY: jpy.quote });
  expect(result.line).toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · 15 min delayed, 1 of 3 stale · markets open");
  expect(result.freshness).toMatchObject({ status: "stale", feed: "delayed", staleCount: 1, observationCount: 3 });
  // So does a failed refresh that kept the last rate.
  const failed = snapshot("2026-10-14T13:30:00Z", { error: { reasonCode: "TIMEOUT", message: "no answer" }, staleAt: null });
  expect(reportLine(now, { EUR: eur.entry, JPY: failed }, { EUR: eur.quote }).line)
    .toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · 15 min delayed, 1 of 2 stale · markets open");
  // Every rate stale: the report says so, and how old the newest is.
  expect(reportLine(now, { CHF: chf, JPY: failed }).line)
    .toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:30 UTC · stale (30 min old) · markets open");
});

test("a currency with no pair quote in the matrix is dated by its loaded rate, in the same line", () => {
  // The coordinator streams pairs for 25 currencies; SAR and NGN are not among
  // them, so their rate is the loaded snapshot unless a pair quote arrives:
  // delayed with no length stated, dated by its own observation. The streamed
  // euro sets the delay the line states.
  const now = "2026-10-14T14:00:00Z";
  const eur = leg("EUR", "2026-10-14T13:59:41Z");
  const sar = snapshot("2026-10-14T13:20:00Z");
  const ngn = snapshot(null);
  expect(reportLine(now, { EUR: eur.entry, SAR: sar, NGN: ngn }, { EUR: eur.quote }).line)
    .toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · 15 min delayed · markets open");
  // Alone, on a weekend, it is dated by the close like any other pair.
  expect(reportLine("2026-10-10T18:45:00Z", {
    SAR: snapshot("2026-10-10T03:09:15Z"), NGN: snapshot("2026-10-10T03:09:13Z"),
  }).line).toBe("Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · delayed · markets closed");
  // A rate the matrix cannot draw is no observation, and the base currency has none.
  expect(fxRateObservations(["USD", "SAR", "NGN"], new Map([["SAR", 0.2663]]), (currency) => ({ entry: snapshot("2026-10-10T03:09:15Z"), legQuote: null }), at("2026-10-10T18:45:00Z")))
    .toHaveLength(1);
  expect(reportLine("2026-10-10T18:45:00Z", {}).line).toContain("status not reported");
});
