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
      expect(frame).toContain("NAV · as of Oct 6");
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
    expect(card).toContain("Delisted Oct 27, 2022");
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
