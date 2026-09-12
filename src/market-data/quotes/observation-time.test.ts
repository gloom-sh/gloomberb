import { expect, spyOn, test } from "bun:test";
import type { Quote } from "../../types/financials";
import { isProviderQuoteUsableForCurrentSession } from "../../sources/provider-router/financials";
import { hasFreshQuoteForCurrentSession, isQuoteStaleForCurrentSession } from "./freshness";
import { isQuoteContributionStaleForCurrentSession } from "./resolution";

const quote = (lastUpdated: unknown, overrides: Partial<Quote> = {}): Quote => ({
  symbol: "TEST", currency: "USD", price: 100, change: 1, changePercent: 1,
  lastUpdated: lastUpdated as number, dataSource: "delayed", ...overrides,
});

test("invalid source observation times remain unavailable across sessions and serialized inputs", () => {
  const scenarios = [
    { now: "2026-09-14T11:00:00Z", venue: "NASDAQ", marketState: "PRE" },
    { now: "2026-09-14T18:00:00Z", venue: "NASDAQ", marketState: "REGULAR" },
    { now: "2026-09-14T22:00:00Z", venue: "NASDAQ", marketState: "POST" },
    { now: "2026-09-12T03:01:00Z", venue: "NASDAQGM", marketState: "POST" },
    { now: "2026-09-14T05:00:00Z", venue: "JPX", marketState: "REGULAR" },
    { now: "2026-09-14T18:00:00Z", venue: "OSAKA", marketState: "POST", instrumentType: "INDEX" },
    { now: "2026-09-12T03:01:00Z", venue: "CCY", marketState: "CLOSED", instrumentType: "CURRENCY" },
    { now: "2026-09-12T03:01:00Z", venue: "CCC", marketState: "REGULAR" },
    { now: "2026-09-12T03:01:00Z", venue: undefined, marketState: undefined },
  ] as const;
  const clock = spyOn(Date, "now");
  try {
    for (const scenario of scenarios) {
      const now = Date.parse(scenario.now);
      clock.mockReturnValue(now);
      for (const invalid of [NaN, Infinity, -Infinity, -1e20, 1e20, 0, -1, undefined, null, "2026-09-11", now + 1]) {
        const input = Object.freeze(quote(invalid, {
          listingExchangeName: scenario.venue, marketState: scenario.marketState,
          instrumentType: "instrumentType" in scenario ? scenario.instrumentType : "EQUITY",
          preMarketPrice: 100, postMarketPrice: 100, receivedAt: now,
        }));
        expect(isQuoteStaleForCurrentSession(input, now)).toBe(true);
        expect(isProviderQuoteUsableForCurrentSession(input, scenario.venue)).toBe(false);
        expect(isQuoteStaleForCurrentSession(JSON.parse(JSON.stringify(input)), now)).toBe(true);
        expect(isQuoteContributionStaleForCurrentSession({ ...input, marketState: undefined }, now)).toBe(true);
      }
    }
  } finally { clock.mockRestore(); }
});

test("valid delayed, live, last-session and unknown/index observations retain their existing session rules", () => {
  const clock = spyOn(Date, "now");
  try {
    for (const [date, marketState] of [["2026-09-14T11:00:00Z", "PRE"], ["2026-09-14T18:00:00Z", "REGULAR"], ["2026-09-14T22:00:00Z", "POST"]] as const) {
      const now = Date.parse(date); clock.mockReturnValue(now);
      for (const dataSource of ["delayed", "realtime"] as const) {
        const sourceTime = now - (dataSource === "delayed" ? 16 * 60_000 : 1_000);
        const input = quote(sourceTime, { listingExchangeName: "NASDAQ", marketState, dataSource, preMarketPrice: 100, postMarketPrice: 100 });
        expect(isQuoteStaleForCurrentSession(input)).toBe(false);
        expect(isProviderQuoteUsableForCurrentSession(input)).toBe(true);
        expect(isQuoteStaleForCurrentSession({ ...input, stale: true })).toBe(true);
      }
    }
    const weekend = Date.parse("2026-09-12T03:01:00Z"); clock.mockReturnValue(weekend);
    const retained = quote(Date.parse("2026-09-11T23:59:00Z"), { listingExchangeName: "NASDAQGM", marketState: "POST" });
    expect(isProviderQuoteUsableForCurrentSession(retained)).toBe(true);
    clock.mockReturnValue(Date.parse("2026-09-15T02:00:00Z"));
    expect(isProviderQuoteUsableForCurrentSession(retained)).toBe(false);
    clock.mockReturnValue(weekend);
    for (const venue of [undefined, "UNKNOWN", "OSAKA"]) {
      expect(isProviderQuoteUsableForCurrentSession(quote(weekend - 6 * 3_600_000, { listingExchangeName: venue, marketState: "CLOSED", instrumentType: "INDEX" }))).toBe(true);
    }
    expect(isQuoteStaleForCurrentSession(null)).toBe(false);
    expect(isQuoteStaleForCurrentSession(undefined)).toBe(false);
    expect(hasFreshQuoteForCurrentSession([null, undefined])).toBe(false);
    expect(hasFreshQuoteForCurrentSession([quote(NaN), quote(weekend + 1)])).toBe(false);
    expect(hasFreshQuoteForCurrentSession([quote(NaN), retained])).toBe(true);
    expect(isQuoteStaleForCurrentSession(quote(weekend), NaN)).toBe(true);
    expect(isQuoteStaleForCurrentSession(quote(weekend), 1e20)).toBe(true);
  } finally { clock.mockRestore(); }
});
