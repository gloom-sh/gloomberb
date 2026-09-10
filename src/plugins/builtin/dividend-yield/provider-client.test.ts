import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { CorporateActionsData } from "../../../types/financials";
import { fetchProviderDividendData } from "./provider-client";

function actions(overrides: Partial<CorporateActionsData> = {}): CorporateActionsData {
  return {
    symbol: "FUND", currency: "EUR", coverage: { dividends: "available" }, splits: [], earnings: [],
    dividends: [{ exDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), amount: 4 }],
    ...overrides,
  };
}

test("browser dividend loading uses provider data with matching quote currency and keeps fractional cash units", async () => {
  const calls: string[] = [];
  const provider = createTestDataProvider({
    getCorporateActions: async (symbol, exchange) => { calls.push(`${symbol}/${exchange}`); return actions(); },
    getQuote: async () => ({ symbol: "FUND", currency: "EUR", price: 80, change: 0, changePercent: 0, lastUpdated: Date.now() }),
  });
  const data = await fetchProviderDividendData(provider, "FUND", 100, "AMS", "USD");
  expect(calls).toEqual(["FUND/AMS"]);
  expect(data).toMatchObject({ currency: "EUR", price: 80, metrics: { trailingRate: 4, trailingYield: 0.05, forwardRate: null } });
  const pence = await fetchProviderDividendData(createTestDataProvider({
    getCorporateActions: async () => actions({ currency: "GBp", dividends: [{ exDate: new Date().toISOString().slice(0, 10), amount: 2.03 }] }),
  }), "VOD.L", 1, "LSE", "GBP");
  expect(pence.payments[0]).toMatchObject({ currency: "GBP", amount: 0.0203 });
  expect(pence.metrics.trailingYield).toBeCloseTo(0.0203, 12);
});

test("browser income distinguishes confirmed no cash from unknown coverage, failed quotes and invalid records", async () => {
  const empty = await fetchProviderDividendData(createTestDataProvider({
    getCorporateActions: async () => actions({ dividends: [] }),
  }), "ACC", 100, "LSE", "EUR");
  expect(empty.metrics.trailingYield).toBe(0);
  for (const coverage of [undefined, { dividends: "unavailable" as const }]) {
    await expect(fetchProviderDividendData(createTestDataProvider({
      getCorporateActions: async () => actions({ dividends: [], coverage }),
    }), "FUND", 100, "AMS", "EUR")).rejects.toThrow("Dividend history is unavailable");
  }
  const noQuote = await fetchProviderDividendData(createTestDataProvider({ getCorporateActions: async () => actions() }), "FUND", null, "AMS");
  expect(noQuote.metrics).toMatchObject({ trailingRate: 4, trailingYield: null });
  await expect(fetchProviderDividendData(createTestDataProvider({
    getCorporateActions: async () => actions({ dividends: [{ exDate: "broken", amount: 4 }] }),
  }), "FUND", 100, "AMS", "EUR")).rejects.toThrow("records are invalid");
});

test("cached dividend and quote provenance survive projection without hiding usable history", async () => {
  const data = await fetchProviderDividendData(createTestDataProvider({
    getCorporateActions: async () => actions({ providerId: "gloomberb-cloud", fetchedAt: "2026-09-01T10:00:00Z", stale: true }),
    getQuote: async () => ({ symbol: "FUND", currency: "EUR", price: 80, change: 0, changePercent: 0,
      lastUpdated: Date.parse("2026-09-02T10:00:00Z"), stale: true }),
  }), "FUND", null, "AMS");
  expect(data).toMatchObject({ providerId: "gloomberb-cloud", fetchedAt: "2026-09-01T10:00:00Z", stale: true,
    priceStale: true, priceAsOf: "2026-09-02T10:00:00.000Z", metrics: { trailingYield: 0.05 } });
  const { projectDividendYieldHeadless } = await import("./headless");
  const result = projectDividendYieldHeadless(data, { argument: "FUND", symbols: ["FUND"], options: {} });
  expect(result.metadata).toMatchObject({ historyFetchedAt: "2026-09-01T10:00:00Z", historyStale: true, priceStale: true });
  expect(result.sections[0]?.entries?.filter(entry => entry.label.endsWith("status"))).toHaveLength(2);
});
