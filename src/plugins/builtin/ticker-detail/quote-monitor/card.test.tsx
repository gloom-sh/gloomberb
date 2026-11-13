import { describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import type { Quote } from "../../../../types/financials";
import type { QueryEntry } from "../../../../market-data/result-types";
import { createIdleEntry } from "../../../../market-data/result-types";
import { QuoteMonitorCard } from "./card";

const tui = createOpenTuiTestHarness();

async function renderCard(quoteEntry: QueryEntry<Quote> | null, width = 40, height = 4): Promise<string> {
  await act(async () => {
    await tui.render(
      <QuoteMonitorCard
        symbol={quoteEntry?.data?.symbol ?? "MSFT"}
        ticker={null}
        cachedFinancials={null}
        quoteEntry={quoteEntry}
        chartEntry={null}
        width={width}
        height={height}
        showRightDivider={false}
        showBottomDivider={false}
        chartPeriod="1M"
        valueFlashingEnabled={false}
        onOpen={() => {}}
      />,
      { width, height },
    );
  });
  await act(async () => {
    await tui.setup().renderOnce();
  });
  return tui.frame();
}

describe("QuoteMonitorCard without a quote", () => {
  test("separates loading, unknown symbol and provider failure", async () => {
    expect(await renderCard({ ...createIdleEntry<Quote>(), phase: "loading" }))
      .toContain("Loading quote");

    expect(await renderCard({
      ...createIdleEntry<Quote>(),
      phase: "error",
      error: { reasonCode: "NOT_FOUND", message: "No match" },
    })).toContain("MSFT not recognized");

    expect(await renderCard({
      ...createIdleEntry<Quote>(),
      phase: "error",
      error: { reasonCode: "UPSTREAM_ERROR", message: "Provider is down" },
    })).toContain("Provider is down");
  });
});

test("a dense NAV card keeps the published date beside its monetary price and day change", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-07T15:00:00Z"));
  const quote: Quote = {
    symbol: "VFIAX", currency: "USD", instrumentType: "MUTUALFUND", listingExchangeName: "NASDAQ",
    price: 721.63, previousClose: 718.5, change: 3.13, changePercent: (3.13 / 718.5) * 100,
    priceBasis: "per-unit", priceObservation: "nav", changeSessionDate: "2026-10-06",
    lastUpdated: Date.parse("2026-10-06T04:00:00Z"), dataSource: "delayed",
  };
  try {
    const entry = { ...createIdleEntry<Quote>(), phase: "ready" as const, data: quote };
    for (const width of [28, 40]) {
      const frame = await renderCard(entry, width, 3);
      expect(frame).toContain("NAV · as of 6 Oct");
      expect(frame).toContain("$721.63");
      expect(frame).toContain("+3.13");
      expect(frame).toContain("+0.44%");
      expect(frame).not.toContain("Stale");
    }
  } finally {
    clock.mockRestore();
  }
});

test("a card of a listing that no longer trades says when, not that its quote is stale", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-20T15:00:00Z"));
  const quote: Quote = {
    symbol: "TWTR", currency: "USD", listingExchangeName: "NYSE", price: 53.86, change: 0.51, changePercent: 0.96,
    lastUpdated: Date.parse("2022-10-28T12:00:00Z"), dataSource: "delayed", stale: true,
    delisting: { status: "delisted", lastTradeDate: "2022-10-27", historyStart: "2016-01-04" },
  };
  try {
    const entry = { ...createIdleEntry<Quote>(), phase: "ready" as const, data: quote };
    const card = await renderCard(entry, 40, 4);
    expect(card).toContain("Delisted 27 Oct 2022");
    expect(card).not.toContain("Stale quote");
    // Its last close alone: no move, not even a dash for one.
    for (const move of ["+0.96%", "+0.51", "—"]) expect(card).not.toContain(move);
    // A narrow card too short for a status row says it beside the price.
    const compact = await renderCard(entry, 30, 3);
    expect(compact).toContain("$53.86 · DELISTED");
  } finally {
    clock.mockRestore();
  }
});

test("each card says what its own price is as of: Hong Kong's close beside a delayed New York after hours", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T21:35:00Z"));
  const hsi: Quote = {
    symbol: "^HSI", name: "HANG SENG INDEX", instrumentType: "INDEX", currency: "HKD", exchangeName: "HKSE",
    price: 24481.86, change: -315.12, changePercent: -1.27, marketState: "CLOSED", dataSource: "delayed",
    providerId: "gloomberb-cloud", lastUpdated: Date.parse("2026-11-06T08:09:00Z"),
  };
  const aapl: Quote = {
    symbol: "AAPL", currency: "USD", listingExchangeName: "NASDAQ", price: 270.5, change: 1.2, changePercent: 0.45,
    marketState: "POST", postMarketPrice: 270.9, postMarketChange: 0.4, postMarketChangePercent: 0.15,
    dataSource: "delayed", providerId: "gloomberb-cloud", lastUpdated: Date.parse("2026-11-06T21:20:00Z"),
  };
  try {
    const ready = (quote: Quote) => ({ ...createIdleEntry<Quote>(), phase: "ready" as const, data: quote });
    expect(await renderCard(ready(hsi), 40, 6)).toContain("CLOSED · 08:09 UTC");
    expect(await renderCard(ready(aapl), 40, 6)).toContain("15 min delayed · 21:20 UTC");
    // A short card keeps its sparkline's rows; the line waits for room.
    expect(await renderCard(ready(hsi), 40, 4)).not.toContain("UTC");
  } finally {
    clock.mockRestore();
  }
});

// at 70-90 columns ^N225 read "AH +2.77%" beside its day's "+2.33% +1,340.73", as if two moves of the day.
test("a narrow card sets an extended print's move only beside its price, as a wide card does", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-09T22:40:00Z"));
  const apple: Quote = {
    symbol: "AAPL", currency: "USD", instrumentType: "EQUITY", exchangeName: "NMS", price: 336.66, change: 7.78, changePercent: 2.37,
    previousClose: 328.88, marketState: "POST", postMarketPrice: 336.08, postMarketChange: -0.58, postMarketChangePercent: -0.17,
    dataSource: "delayed", providerId: "gloomberb-cloud", lastUpdated: Date.parse("2026-11-09T22:35:00Z"),
  };
  try {
    const entry = { ...createIdleEntry<Quote>(), phase: "ready" as const, data: apple };
    expect(await renderCard(entry, 60, 4)).toContain("After-Hours $336.08 -0.17%");
    for (const width of [20, 26, 34]) {
      const card = await renderCard(entry, width, 4);
      expect(card, String(width)).toContain("+2.37%");
      expect(card, String(width)).not.toMatch(/(AH|After-Hours) -0\.17%/);
    }
  } finally {
    clock.mockRestore();
  }
});

// ^N225 and 8058:JPX read "After-Hours 60,404.00 +2.77%" and "+4.17%" beside their closes: Tokyo has no such session.
test("a card on a venue without an extended session shows no after-hours line, at any width", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-09T21:40:00Z"));
  const nikkei: Quote = {
    symbol: "^N225", currency: "JPY", instrumentType: "INDEX", exchangeName: "OSAKA", price: 58775.5, change: 1340.73, changePercent: 2.33,
    previousClose: 57434.77, marketState: "POST", postMarketPrice: 60404, postMarketChange: 1628.5, postMarketChangePercent: 2.77,
    dataSource: "delayed", providerId: "gloomberb-cloud", lastUpdated: Date.parse("2026-11-09T06:45:00Z"),
  };
  const mitsubishi: Quote = {
    symbol: "8058", currency: "JPY", instrumentType: "EQUITY", exchangeName: "JPX", listingExchangeName: "JPX", price: 5164.5, change: 206.5, changePercent: 4.17,
    previousClose: 4958, regularClose: 5170, regularChange: 212, regularChangePercent: 4.28, regularCloseSessionDate: "2026-11-09", marketState: "CLOSED",
    dataSource: "delayed", providerId: "gloomberb-cloud", lastUpdated: Date.parse("2026-11-09T06:45:00Z"),
  };
  try {
    for (const quote of [nikkei, mitsubishi]) {
      const entry = { ...createIdleEntry<Quote>(), phase: "ready" as const, data: quote };
      for (const width of [26, 34, 60]) {
        const card = await renderCard(entry, width, 4);
        expect(card, `${quote.symbol} ${width}`).not.toMatch(/After-Hours|\bAH\b|2\.77%|4\.17%/);
      }
    }
  } finally {
    clock.mockRestore();
  }
});
