import { expect, test } from "bun:test";
import { AssetDataRouter } from "../../sources/provider-router";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { ExchangeRateSnapshot } from "../../types/exchange-rate";
import { MarketDataCoordinator } from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const cachedRouter of [false, true]) {
  test(`FX refresh bypasses fresh ${cachedRouter ? "router" : "direct"} cache, shares requests and preserves failed-source age`, async () => {
    const firstTime = Date.now() - 60_000;
    const snapshot = (rate: number, asOf: number): ExchangeRateSnapshot => ({
      rate, fromCurrency: "EUR", toCurrency: "USD", source: "controlled-fx",
      asOf: new Date(asOf).toISOString(), fetchedAt: new Date(asOf).toISOString(),
      staleAt: new Date(asOf + 3_600_000).toISOString(), stale: false,
    });
    const pending = deferred<ExchangeRateSnapshot>();
    let calls = 0;
    let fail = false;
    const provider = createTestDataProvider({
      id: "controlled-fx",
      getExchangeRateSnapshot: async currency => {
        expect(currency).toBe("EUR");
        calls++;
        if (fail) throw new Error("source offline");
        return calls === 1 ? snapshot(1.1, firstTime) : pending.promise;
      },
    });
    const coordinator = new MarketDataCoordinator(cachedRouter ? new AssetDataRouter(provider) : provider);
    try {
      expect((await coordinator.loadFxRate("EUR")).data).toBe(1.1);
      expect((await coordinator.loadFxRate("EUR")).data).toBe(1.1);
      expect((await coordinator.loadFxRate("USD", { forceRefresh: true })).data).toBe(1);
      expect(calls).toBe(1);

      const firstRefresh = coordinator.loadFxRate("EUR", { forceRefresh: true });
      const secondRefresh = coordinator.loadFxRate("EUR", { forceRefresh: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toBe(2);
      const secondTime = firstTime + 30_000;
      pending.resolve(snapshot(1.2, secondTime));
      expect((await firstRefresh).data).toBe(1.2);
      expect((await secondRefresh).data).toBe(1.2);
      expect(coordinator.getFxEntry("EUR").asOf).toBe(secondTime);

      fail = true;
      const failed = await coordinator.loadFxRate("EUR", { forceRefresh: true });
      expect(failed.data ?? failed.lastGoodData).toBe(1.2);
      expect(failed.asOf).toBe(secondTime);
      expect(failed.fetchedAt).toBe(secondTime);
      expect(failed.error).not.toBeNull();
      expect(calls).toBe(3);
    } finally {
      coordinator.destroy();
    }
  });
}
