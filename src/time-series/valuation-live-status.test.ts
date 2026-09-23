import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { resolveChartSpecData } from "./resolve";
import { getLiveChartQuoteTargets, observeLiveChartQuotes } from "./live-quotes";
import { createQuoteStoreFixture } from "./fixtures/quote-store";
import type { Quote, TickerFinancials } from "../types/financials";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";

// Synthetic boundary inputs. This exercises actual subscription + resolver,
// not a claim of a newly fetched provider quote or native render execution.
for (const receivedAt of [undefined, 42]) {
  test(`equal source-time stale changes flow through actual resolver with receipt ${receivedAt}`, async () => {
    const quote: Quote = { symbol: "TEST", currency: "USD", price: 60, change: 0, changePercent: 0,
      lastUpdated: Date.parse("2026-09-11T20:00:00Z"), stale: false,
      ...(receivedAt === undefined ? {} : { receivedAt }) };
    const financials: TickerFinancials = { financialCurrency: "USD", quote,
      annualStatements: [{ date: "2025-12-31", availableAt: "2026-09-10T14:00:00Z", currency: "USD", eps: 10 }],
      quarterlyStatements: [], priceHistory: [{ date: new Date("2026-09-10T13:30:00Z"), close: 55 }] };
    const spec: ChartSpec = { version: CHART_SPEC_VERSION, viewport: { range: "5Y", resolution: "1d" },
      panels: [{ id: "main" }], studies: [], series: [{ id: "pe", source: { kind: "security", instrument: { symbol: "TEST", exchange: "NYSE" },
        fieldId: "valuation.trailingPE", period: "annual", timestampMode: "available-at" },
        style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }] };
    const provider = createTestDataProvider({ getTickerFinancials: async () => financials,
      getQuote: async () => financials.quote!, getPriceHistoryForResolution: async () => financials.priceHistory });
    const store = createQuoteStoreFixture();
    const target = getLiveChartQuoteTargets(spec)[0]!;
    const results: Awaited<ReturnType<typeof resolveChartSpecData>>[] = [];
    const pending: Promise<unknown>[] = [];
    const stop = observeLiveChartQuotes({ spec, store, onChange: (quoteOverrides) => {
      pending.push(resolveChartSpecData(spec, { dataProvider: provider,
        now: new Date("2026-09-12T00:00:00Z"), quoteOverrides }).then((result) => results.push(result)));
    } });
    async function send(next: Quote) {
      store.emit(target, next);
      await Promise.all(pending);
    }
    try {
      await send({ ...quote });
      expect(results).toHaveLength(1);
      expect(results.at(-1)?.series[0]?.points.map(point => point.value)).toEqual([5.5, 6]);
      await send({ ...quote, stale: true });
      expect(results).toHaveLength(2);
      expect(results.at(-1)?.series[0]?.points.map(point => point.value)).toEqual([5.5]);
      expect(results.at(-1)?.warnings.some(warning => warning.includes("source quote is stale"))).toBe(true);
      await send({ ...quote, stale: false });
      expect(results).toHaveLength(3);
      expect(results.at(-1)?.series[0]?.points.map(point => point.value)).toEqual([5.5, 6]);
      expect(results.at(-1)?.warnings.some(warning => warning.includes("source quote is stale"))).toBe(false);
      // An older source observation must remain rejected even with a newer receipt.
      await send({ ...quote, lastUpdated: quote.lastUpdated - 60_000, stale: true, receivedAt: 500 });
      expect(results).toHaveLength(3);
      // Exact duplicate and receipt-only heartbeat must not rebuild the chart.
      await send({ ...quote });
      await send({ ...quote, receivedAt: 1000 });
      expect(results).toHaveLength(3);
      // After advancing the receipt, delayed older-receipt status is also rejected.
      await send({ ...quote, stale: true, receivedAt: 999 });
      expect(results).toHaveLength(3);
      await send({ ...quote, stale: true, receivedAt: 1000 });
      expect(results).toHaveLength(4);
      expect(results.at(-1)?.series[0]?.points.map(point => point.value)).toEqual([5.5]);
    } finally { stop(); }
  });
}
