import { afterEach, describe, expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { tickerQuoteFooterInfo } from "./quote-footer";

const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

function at(time: string) {
  const now = Date.parse(time);
  Date.now = () => now;
}

/** NVDA as the signed-out delayed feed answered it on Wed 11 Nov 2026: Tuesday's last after-hours print. */
const nvda: Quote = {
  symbol: "NVDA",
  price: 170.4829,
  currency: "USD",
  change: -8.1871,
  changePercent: -4.58,
  previousClose: 178.67,
  regularClose: 168.89,
  regularCloseSessionDate: "2026-11-10",
  changeSessionDate: "2026-11-10",
  lastUpdated: Date.parse("2026-11-11T00:59:59Z"),
  listingExchangeName: "NASDAQ",
  exchangeName: "NASDAQ",
  marketState: "PREPRE",
  dataSource: "delayed",
  providerId: "gloomberb-cloud",
  stale: false,
};

const segments = (quote: Quote) => tickerQuoteFooterInfo(quote, null, 120);
const warning = (quote: Quote) => segments(quote).filter((segment) => segment.id !== "ticker-research-source")
  .map((segment) => segment.parts.map((part) => part.text).join(" "));

describe("ticker footer on a signed-out delayed feed", () => {
  test("US closed overnight: Tuesday's last print is the current price, with no warning", () => {
    at("2026-11-11T07:16:00Z");
    expect(warning(nvda)).toEqual([]);
  });

  test("pre-market, 15 minutes delayed: the prior session's last print until the first delayed print, then that print", () => {
    at("2026-11-11T09:05:00Z");
    expect(warning({ ...nvda, marketState: "PRE" })).toEqual([]);
    at("2026-11-11T09:40:00Z");
    expect(warning({ ...nvda, marketState: "PRE", preMarketPrice: 171.2, extendedSessionPrint: true,
      lastUpdated: Date.parse("2026-11-11T09:24:00Z") })).toEqual([]);
  });

  test("regular session, 15 minutes delayed: no warning", () => {
    at("2026-11-11T15:00:00Z");
    expect(warning({ ...nvda, marketState: "REGULAR", price: 169.9, lastUpdated: Date.parse("2026-11-11T14:44:00Z") })).toEqual([]);
  });

  test("a refresh that failed still says stale, with when the price is from", () => {
    at("2026-11-11T15:00:00Z");
    expect(warning({ ...nvda, marketState: "REGULAR", stale: true, lastUpdated: Date.parse("2026-11-11T14:40:00Z") }))
      .toEqual(["Stale quote 2026-11-11 14:40Z"]);
  });
});

// A quote that was current named nothing in the footer: `vs Wed 11 Nov close` in the body, and no source or time.
test("a current quote's footer names its source and its time, as `quote` ends", () => {
  at("2026-11-11T15:00:00Z");
  const line = segments({ ...nvda, marketState: "REGULAR", price: 169.9, lastUpdated: Date.parse("2026-11-11T14:44:00Z") })
    .find((segment) => segment.id === "ticker-research-source");
  expect(line?.parts[0]?.text).toBe("Gloom Cloud · 14:44 UTC · markets open");
  // A narrow footer keeps the source and the time before the market.
  expect(line?.variants?.map((parts) => parts[0]!.text)).toContain("Gloom Cloud · 14:44 UTC");
});
