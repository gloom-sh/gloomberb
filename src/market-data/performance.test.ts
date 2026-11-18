import { describe, expect, test } from "bun:test";
import {
  appendQuoteToPriceReturnHistory,
  buildPriceReturnFields,
  computePriceReturnForHorizon,
  headlinePriceReturnEnd,
  PRICE_RETURN_HORIZONS,
} from "./performance";
import type { PricePoint, Quote } from "../types/financials";

function point(date: string, close: number): PricePoint {
  return { date: new Date(date.length === 10 ? `${date}T00:00:00Z` : date), close };
}

const horizon = (id: string) => PRICE_RETURN_HORIZONS.find((entry) => entry.id === id)!;

describe("price performance", () => {
  test("computes horizon return from the closest prior baseline", () => {
    const history = [
      point("2025-12-31", 100),
      point("2026-01-02", 102),
      point("2026-01-31", 110),
      point("2026-02-01", 120),
    ];

    const oneMonth = PRICE_RETURN_HORIZONS.find((horizon) => horizon.id === "1M")!;

    expect(computePriceReturnForHorizon(history, oneMonth)).toBeCloseTo(20 / 100);
  });

  test("leaves fixed horizons empty when history does not reach the baseline date", () => {
    const history = [
      point("2026-01-15", 100),
      point("2026-02-01", 110),
    ];

    const fields = buildPriceReturnFields(history);

    expect(fields.find((field) => field.id === "1M")?.value).toBeNull();
    expect(fields.find((field) => field.id === "1Y")?.value).toBeNull();
  });

  test("can include a newer live quote as the latest return point", () => {
    const history = [
      point("2025-01-31", 100),
      point("2026-01-31", 120),
    ];
    const withQuote = appendQuoteToPriceReturnHistory(history, {
      price: 150,
      lastUpdated: Date.parse("2026-02-01T15:30:00Z"),
    });
    const oneYear = PRICE_RETURN_HORIZONS.find((horizon) => horizon.id === "1Y")!;

    expect(withQuote).toHaveLength(3);
    expect(computePriceReturnForHorizon(withQuote, oneYear)).toBeCloseTo(50 / 100);
  });

  test("a month ending on a closed day uses the prior session rather than the next month's price move", () => {
    const history = [point("2026-02-27", 100), point("2026-03-02", 120), point("2026-03-31", 150)];
    expect(computePriceReturnForHorizon(history, horizon("1M"))).toBe(0.5);
  });

  test("the clamped base day's last observation is the base, not the prior session's or the time of day a month back", () => {
    // A month before 31 Mar is 28 Feb: its close is the last observation that day.
    const history = [
      point("2026-02-27T15:45:12.345Z", 90), point("2026-02-28T15:45:12.345Z", 100),
      point("2026-02-28T15:45:12.346Z", 120), point("2026-03-31T15:45:12.345Z", 150),
    ];
    const original = JSON.stringify(history);
    expect(computePriceReturnForHorizon(history, horizon("1M"))).toBe(0.25);
    expect(computePriceReturnForHorizon(JSON.parse(original), horizon("1M"))).toBe(0.25);
    expect(JSON.stringify(history)).toBe(original);
  });

  test("post-cutoff history cannot supply a full month's return", () => {
    const history = [point("2026-03-02", 100), point("2026-03-31", 110)];
    expect(buildPriceReturnFields(history).find((field) => field.id === "1M")?.value).toBeNull();
  });

  test("bars and the quote are dated on the listing's clock, not by their UTC date", () => {
    // A JPX feed stamps each daily bar at 00:00 JST, 15:00 UTC the day before; the quote is Thu 22 Oct 15:00 JST.
    const jpx = [point("2026-09-20T15:00:00Z", 90), point("2026-09-21T15:00:00Z", 100), point("2026-09-22T15:00:00Z", 120), point("2026-10-20T15:00:00Z", 140)];
    const tokyo = appendQuoteToPriceReturnHistory(jpx, { price: 150, lastUpdated: Date.parse("2026-10-22T06:00:00Z") });
    // A month before 22 Oct is Tue 22 Sep: its bar, not 23 Sep's (stamped 22 Sep 15:00 UTC).
    expect(computePriceReturnForHorizon(tokyo, horizon("1M"), "JPX")).toBeCloseTo(0.5);
    // Tue 1 Dec 19:30 New York after hours is 2 Dec in UTC: a month before 1 Dec is Sun 1 Nov, so Fri 30 Oct's close.
    const us = appendQuoteToPriceReturnHistory([point("2026-10-30", 100), point("2026-11-02", 120), point("2026-12-01", 140)],
      { price: 150, lastUpdated: Date.parse("2026-12-02T00:30:00Z") });
    expect(computePriceReturnForHorizon(us, horizon("1M"), "NASDAQ")).toBeCloseTo(0.5);
  });

  test("the bars are normalized once across quote ticks, and read again when the history grows in place", () => {
    const history = [point("2026-01-30", 100), point("2026-02-27", 110)];
    const quoteAt = (price: number, at: string) => ({ price, lastUpdated: Date.parse(at) });
    const first = appendQuoteToPriceReturnHistory(history, quoteAt(120, "2026-03-02T15:00:00Z"));
    const second = appendQuoteToPriceReturnHistory(history, quoteAt(125, "2026-03-02T15:00:01Z"));
    // The same normalized bars under both ticks' quotes.
    expect(second.slice(0, 2).every((bar, index) => bar === first[index])).toBe(true);
    expect(buildPriceReturnFields(second).find((field) => field.id === "1M")?.value).toBeCloseTo(0.25);

    history.push(point("2026-03-02", 130));
    expect(buildPriceReturnFields(history).find((field) => field.id === "1M")?.value).toBeCloseTo(0.3);
  });

  test("a February 28 year boundary does not move forward to February 29 in a leap year", () => {
    const history = [point("2024-02-28", 100), point("2024-02-29", 150), point("2025-02-28", 200)];
    expect(computePriceReturnForHorizon(history, horizon("1Y"))).toBe(1);
  });

});

test("a return horizon measures from the close before a pair's copied close, never from it", () => {
  const history = [point("2026-10-01", 100), point("2026-10-02", 101), { ...point("2026-10-05", 150), closeCopied: true },
    point("2026-10-06", 102), point("2026-11-05", 110)];
  // 1M from 5 Nov is based on 5 Oct, whose close is the source's copy: 2 Oct's close stands in.
  expect(buildPriceReturnFields(history).find((field) => field.id === "1M")?.value).toBeCloseTo(110 / 101 - 1, 12);
});

// GGAL's DES strip on 18 Nov 2026 read 1Y -36.97% where CMP and `history` read -44.56%: it ran to the 29.08
// after-hours print, not the 28.53 close the headline showed, and its weekly bars put the base at the week ending
// 21 Nov 2025. A horizon runs from the daily close on its start date to the headline close, and names that day.
test("each horizon runs from the daily close on its start date to the headline close, and names that day", () => {
  const daily = [
    point("2025-11-14", 52.0), point("2025-11-17", 51.47), point("2025-11-18", 50.9), point("2025-11-21", 49.5),
    point("2026-10-16", 35.98), point("2026-10-19", 36.4), point("2026-11-16", 28.2), point("2026-11-17", 28.53),
  ];
  // Tue 17 Nov 2026 after hours: the quote's price is the 29.08 print, its headline the 28.53 close.
  const quote = {
    symbol: "GGAL", price: 29.08, currency: "USD", change: 0.55, changePercent: 1.93, previousClose: 28.2,
    regularClose: 28.53, regularCloseSessionDate: "2026-11-17", changeSessionDate: "2026-11-17", marketState: "POST",
    postMarketPrice: 29.08, postMarketChange: 0.55, lastUpdated: Date.parse("2026-11-17T23:56:00Z"), listingExchangeName: "NASDAQ",
  } as unknown as Quote;
  const end = headlinePriceReturnEnd(quote, "NASDAQ");
  expect(end).toEqual({ day: "2026-11-17", close: 28.53 });
  const fields = buildPriceReturnFields(daily, "NASDAQ", PRICE_RETURN_HORIZONS, end);
  expect(fields.find((field) => field.id === "1Y")).toMatchObject({ baseDay: "2025-11-17" });
  expect(fields.find((field) => field.id === "1Y")?.value).toBeCloseTo(28.53 / 51.47 - 1, 12);
  // 17 Oct 2026 was a Saturday: the close on or before it.
  expect(fields.find((field) => field.id === "1M")).toMatchObject({ baseDay: "2026-10-16" });
  expect(fields.find((field) => field.id === "1M")?.value).toBeCloseTo(28.53 / 35.98 - 1, 12);
  // No close on or before 17 May 2026 in these bars, nor 17 Nov 2023: no figure, and no date.
  expect(fields.find((field) => field.id === "3Y")).toEqual({ id: "3Y", label: "3Y", value: null });

  // Weekly bars, dated by their Monday, close on their Friday: the base is the last week that closed by then.
  const weekly = [point("2025-11-03", 53), point("2025-11-10", 52), point("2025-11-17", 49.5), point("2025-11-24", 48),
    point("2026-11-02", 30), point("2026-11-09", 29), point("2026-11-16", 28.53)];
  expect(buildPriceReturnFields(weekly, "NASDAQ", [horizon("1Y")], end)[0]).toMatchObject({ baseDay: "2025-11-14" });
});

// The week dated Monday 9 Nov closes on Friday 13 Nov, after Wednesday's headline. That close is the week so far
// as the bars were read (29.4), not the headline's 28.1: the headline is the end, being newer than the week's Monday.
test("weekly bars end at a headline from inside their newest week, not at that week's close", () => {
  const weekly = [point("2025-11-03", 53), point("2025-11-10", 52), point("2025-11-17", 49.5), point("2025-11-24", 48),
    point("2026-10-05", 32), point("2026-10-12", 31.5), point("2026-10-19", 31), point("2026-10-26", 30.8),
    point("2026-11-02", 30), point("2026-11-09", 29.4)];
  const end = { day: "2026-11-11", close: 28.1 };
  const [oneYear, oneMonth] = buildPriceReturnFields(weekly, "NASDAQ", [horizon("1Y"), horizon("1M")], end);
  // 1Y from Tue 11 Nov 2025: the week dated 3 Nov closed on Friday 7 Nov.
  expect(oneYear).toMatchObject({ baseDay: "2025-11-07" });
  expect(oneYear?.value).toBeCloseTo(28.1 / 53 - 1, 12);
  // 1M from Sun 11 Oct 2026: the week dated 5 Oct closed on Friday 9 Oct.
  expect(oneMonth).toMatchObject({ baseDay: "2026-10-09" });
  expect(oneMonth?.value).toBeCloseTo(28.1 / 32 - 1, 12);
  // A headline from before the newest week's Monday is older than the bars: the newest close is the end.
  const [behind] = buildPriceReturnFields(weekly, "NASDAQ", [horizon("1Y")], { day: "2026-11-06", close: 30.5 });
  expect(behind?.value).toBeCloseTo(29.4 / 53 - 1, 12);
});

test("a headline older than the bars is not the end: the newest close is, as before a quote was given", () => {
  const daily = [point("2026-01-02", 100), point("2026-02-02", 104), point("2026-03-02", 110)];
  const fields = buildPriceReturnFields(daily, undefined, [horizon("1M")], { day: "2026-01-02", close: 105.25 });
  expect(fields[0]).toMatchObject({ baseDay: "2026-02-02" });
  expect(fields[0]?.value).toBeCloseTo(110 / 104 - 1, 12);
});
