import { expect, test } from "bun:test";
import type { ChartSpec } from "./types";
import { chartQuoteOverrideKeyForSource, chartQuoteOverrideKeyForTarget, getLiveChartQuoteTargets, observeLiveChartQuotes } from "./live-quotes";
import { createQuoteStoreFixture } from "./fixtures/quote-store";

test("live chart targets and quote overrides preserve same-local-symbol option definitions", async () => {
  const source = (strike: number) => ({ kind: "security" as const, fieldId: "price", instrument: { symbol: "ACME", exchange: "NASDAQ", brokerId: "fixture", brokerInstanceId: "feed", instrument: { brokerId: "fixture", brokerInstanceId: "feed", symbol: "ACME", localSymbol: "LEGACY", secType: "OPT", currency: "USD", right: "C" as const, strike, lastTradeDateOrContractMonth: "20261016", multiplier: "100" } } });
  const a = source(100); const b = source(110);
  const spec = { series: [{ id: "a", source: a }, { id: "b", source: b }], studies: [] } as unknown as ChartSpec;
  const targets = getLiveChartQuoteTargets(spec); expect(targets).toHaveLength(2);
  let received: ReadonlyMap<string, any> | undefined;
  const store = createQuoteStoreFixture();
  const dispose = observeLiveChartQuotes({ spec, store, onChange: overrides => { received = overrides; } });
  try {
    store.emit(targets[0]!, { symbol: "ACME", currency: "USD", price: 10, change: 0, changePercent: 0, lastUpdated: Date.now() });
    store.emit(targets[1]!, { symbol: "ACME", currency: "USD", price: 20, change: 0, changePercent: 0, lastUpdated: Date.now() });
    expect(received?.size).toBe(2);
    expect(received?.get(chartQuoteOverrideKeyForSource(a))?.price).toBe(10);
    expect(received?.get(chartQuoteOverrideKeyForSource(b))?.price).toBe(20);
    expect(chartQuoteOverrideKeyForTarget(targets[0]!)).toBe(chartQuoteOverrideKeyForSource(a));
  } finally { dispose(); }
});
