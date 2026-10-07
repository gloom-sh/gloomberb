import { expect, test } from "bun:test";
import { createDailyNavQuote } from "../../test-support/daily-nav";
import { mergeQuoteContribution, normalizeQuoteContribution } from "./contributions";
import { isQuoteContributionStaleForCurrentSession, resolveCanonicalQuote } from "./resolution";

test("a NAV contribution owns its source date and cannot inherit an intraday session or lend its marker", () => {
  const nav = createDailyNavQuote({ providerId: "gloomberb-cloud" });
  const intraday = { ...nav, priceObservation: undefined, changeSessionDate: undefined,
    marketState: "POST" as const, sessionConfidence: "explicit" as const, postMarketPrice: 725,
    bid: 724, ask: 726, volume: 200, lastTradeTime: nav.lastUpdated, lastTradePrice: 725 };
  const intoNav = mergeQuoteContribution(normalizeQuoteContribution(intraday), nav);
  expect(intoNav).toMatchObject({ priceObservation: "nav", changeSessionDate: "2026-10-06", lastUpdated: nav.lastUpdated });
  for (const field of ["marketState", "postMarketPrice", "bid", "ask", "volume", "lastTradeTime", "lastTradePrice"] as const) {
    expect(intoNav[field]).toBeUndefined();
  }
  const missingDate = { ...nav };
  delete missingDate.changeSessionDate;
  expect(mergeQuoteContribution(intoNav, missingDate).changeSessionDate).toBeUndefined();
  const intoIntraday = mergeQuoteContribution(intoNav, intraday);
  expect(intoIntraday.priceObservation).toBeUndefined();
  expect(intoIntraday.changeSessionDate).toBeUndefined();
  expect(isQuoteContributionStaleForCurrentSession(intoNav, Date.parse("2026-10-07T15:00:00Z"))).toBe(false);
  expect(isQuoteContributionStaleForCurrentSession(intoNav, Date.parse("2026-10-08T07:59:59.999Z"))).toBe(false);
  expect(isQuoteContributionStaleForCurrentSession(intoNav, Date.parse("2026-10-08T08:00:00Z"))).toBe(true);
});

test("canonical NAV keeps its own observation even when stale research includes another session", () => {
  const nav = normalizeQuoteContribution(createDailyNavQuote({ providerId: "other-fund-source" }))!;
  const intraday = normalizeQuoteContribution({ ...nav, providerId: "gloomberb-cloud", priceObservation: undefined,
    instrumentType: "EQUITY", listingExchangeName: "NYSE", changeSessionDate: "2026-10-05",
    lastUpdated: Date.parse("2026-10-05T20:00:00Z"), marketState: "POST", sessionConfidence: "explicit",
    postMarketPrice: 700, previousClose: 699, bid: 698, ask: 701, volume: 200, marketCap: 1e12, price: 700 })!;
  // Once both observations are stale, the canonical research snapshot still
  // needs to preserve the selected NAV's identity for its stale display.
  const selected = resolveCanonicalQuote({ nav, intraday }, Date.parse("2026-10-08T09:00:00Z")).quote!;
  expect(selected).toMatchObject({ price: nav.price, priceObservation: "nav", instrumentType: "MUTUALFUND",
    changeSessionDate: nav.changeSessionDate, lastUpdated: nav.lastUpdated, previousClose: nav.previousClose,
    listingExchangeName: nav.listingExchangeName, sessionConfidence: "unknown" });
  for (const field of ["marketState", "postMarketPrice", "bid", "ask", "volume", "marketCap"] as const) expect(selected[field]).toBeUndefined();
  expect(selected.change).toBeCloseTo(3.13);

  const live = { ...intraday, dataSource: "live" as const, price: 726, marketState: "REGULAR" as const,
    lastUpdated: Date.parse("2026-10-07T15:00:00Z"), changeSessionDate: "2026-10-07" };
  expect(resolveCanonicalQuote({ nav, live }, live.lastUpdated).quote?.priceObservation).toBeUndefined();
});

test("canonical NAV cannot repair missing observation evidence from the clock or another contribution", () => {
  const now = Date.parse("2026-10-07T15:00:00Z");
  const dated = createDailyNavQuote({ providerId: "fund-source", changeSessionDate: "2026-10-07", lastUpdated: now });
  const descriptors = normalizeQuoteContribution({ ...dated, providerId: "gloomberb-cloud",
    priceObservation: undefined, price: Number.NaN, stale: true })!;
  for (const malformed of [
    { ...dated, lastUpdated: undefined as unknown as number },
    { ...dated, lastUpdated: null as unknown as number },
    { ...dated, instrumentType: undefined },
  ]) {
    const nav = normalizeQuoteContribution(malformed)!;
    expect(isQuoteContributionStaleForCurrentSession(nav, now)).toBe(true);
    expect(resolveCanonicalQuote({ nav, descriptors }, now).quote).toBeUndefined();
  }

  // Age and explicit stale status do not invalidate the source evidence of a
  // held research snapshot; it must retain the original date and observation.
  const old = normalizeQuoteContribution(createDailyNavQuote({ providerId: "fund-source", stale: true }))!;
  const selected = resolveCanonicalQuote({ old, descriptors }, now).quote!;
  expect(selected).toMatchObject({ priceObservation: "nav", changeSessionDate: old.changeSessionDate,
    lastUpdated: old.lastUpdated, stale: true });
  expect(isQuoteContributionStaleForCurrentSession(selected, now)).toBe(true);
});
