import { useRegularMarketSession } from "../test-support/market-session";
import { expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { AssetDataRouter } from "../sources/provider-router";
import { createTestDataProvider } from "../test-support/data-provider";
import { MarketDataCoordinator } from "./coordinator";
import type { InstrumentRef } from "./request-types";
import { buildChartKey, buildOptionsKey, toMarketDataContext } from "./selectors";
import { instrumentIdentityKey } from "../utils/instrument-identity";
import { getRouterEntityKey } from "../sources/provider-router/cache";

useRegularMarketSession();

const instrument = (strike: number): InstrumentRef => ({ symbol: "ACME", exchange: "NASDAQ", brokerId: "fixture", brokerInstanceId: "feed", instrument: { brokerId: "fixture", brokerInstanceId: "feed", symbol: "ACME", localSymbol: "LEGACY", secType: "OPT", currency: "USD", exchange: "SMART", lastTradeDateOrContractMonth: "20261016", right: "C", strike, multiplier: "100" } });
const quote = (price: number) => ({ symbol: "ACME", price, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now(), stale: false });

test("coordinator quote batching and independent resource keys retain two same-symbol derivatives", async () => {
  const calls: number[] = [];
  const c = new MarketDataCoordinator(createTestDataProvider({ getQuote: async (_symbol, _exchange, context) => { calls.push(context!.instrument!.strike!); return quote(context!.instrument!.strike! / 10); } }));
  const a = instrument(100); const b = instrument(110);
  try {
    const entries = await c.loadQuotesBatch([a, b]);
    expect(calls.sort()).toEqual([100, 110]); expect(entries.map(e => e.data?.price)).toEqual([10, 11]);
    expect(c.getQuoteEntry(a).data?.price).toBe(10); expect(c.getQuoteEntry(b).data?.price).toBe(11);
    expect(instrumentIdentityKey(a)).not.toBe(instrumentIdentityKey(b));
    expect(buildChartKey({ instrument: a, bufferRange: "1Y" })).not.toBe(buildChartKey({ instrument: b, bufferRange: "1Y" }));
    expect(buildOptionsKey({ instrument: a })).not.toBe(buildOptionsKey({ instrument: b }));
  } finally { c.destroy(); }
});

test("router fallback identity excludes old local-symbol resource while conId and public keys remain compatible", async () => {
  const persistence = new AppPersistence(":memory:"); const calls: number[] = [];
  const provider = createTestDataProvider({ id: "fixture-provider", getQuote: async (_s, _e, context) => { calls.push(context!.instrument!.strike!); return quote(context!.instrument!.strike! / 10); } });
  try {
    persistence.resources.set({ namespace: "market", kind: "quote", entityKey: "contract:LEGACY", variantKey: "exchange=NASDAQ", sourceKey: "provider:fixture-provider" }, quote(999), { cachePolicy: { staleMs: 60000, expireMs: 120000 } });
    const firstRouter = new AssetDataRouter(provider, [], persistence.resources);
    expect((await firstRouter.getQuote("ACME", "NASDAQ", toMarketDataContext(instrument(100)))).price).toBe(10);
    const reopenedRouter = new AssetDataRouter(provider, [], persistence.resources);
    expect((await reopenedRouter.getQuote("ACME", "NASDAQ", toMarketDataContext(instrument(110)))).price).toBe(11);
    expect((await reopenedRouter.getQuote("ACME", "NASDAQ", toMarketDataContext(instrument(100)))).price).toBe(10);
    expect(calls).toEqual([100, 110]);
    expect(getRouterEntityKey("ACME", { ...instrument(100).instrument!, conId: 123 })).toBe("contract:123");
    expect(getRouterEntityKey(" acme ")).toBe("ACME");
  } finally { persistence.close(); }
});

test("chart loading never seeds another definition and options retain separate successful observations", async () => {
  const calls: number[] = [];
  const history = (price: number) => [{ date: new Date("2026-09-11"), close: price }];
  let resolveHistory!: (value: ReturnType<typeof history>) => void;
  const c = new MarketDataCoordinator(createTestDataProvider({
    getPriceHistory: async (_symbol, _exchange, _range, context) => context!.instrument!.strike === 100
      ? history(10) : new Promise(resolve => { resolveHistory = resolve; }),
    getOptionsChain: async (_symbol, _exchange, _date, context) => {
      const strike = context!.instrument!.strike!; calls.push(strike);
      return { underlyingSymbol: "ACME", expirationDates: strike === 100 ? ["2026-10-16"] : [], calls: [], puts: [] };
    },
  }));
  const a = instrument(100); const b = instrument(110);
  try {
    await c.loadChart({ instrument: a, bufferRange: "1Y", granularity: "range" });
    const request = { instrument: b, bufferRange: "5Y", granularity: "range" } as const;
    const pending = c.loadChart(request);
    expect(c.getChartEntry(request).data).toBeNull();
    expect(c.getChartEntry(request).lastGoodData).toBeNull();
    resolveHistory(history(11)); expect((await pending).data?.[0]?.close).toBe(11);
    expect((await c.loadOptions({ instrument: a })).data?.expirationDates).toEqual(["2026-10-16"]);
    const empty = await c.loadOptions({ instrument: b });
    expect(empty.data?.expirationDates).toEqual([]); expect(empty.error?.reasonCode).toBe("NO_DATA");
    await c.loadOptions({ instrument: a }); await c.loadOptions({ instrument: b });
    expect(calls).toEqual([100, 110]);
  } finally { c.destroy(); }
});

test.each([
  { secType: "OPT", conId: undefined }, { secType: "STK", conId: undefined },
  { secType: "OPT", conId: 123 }, { secType: "STK", conId: 456 },
])("symbol enrichment cannot restore unproven declared contract prices or history", ({ secType, conId }) => {
  const persistence = new AppPersistence(":memory:");
  const provider = createTestDataProvider({ id: "fixture-provider" });
  const router = new AssetDataRouter(provider, [], persistence.resources);
  const contract = { ...instrument(110).instrument!, secType, conId };
  const target = { ...instrument(110), instrument: contract };
  const store = (kind: string, entityKey: string, value: unknown) => persistence.resources.set(
    { namespace: "market", kind, entityKey, variantKey: "exchange=NASDAQ", sourceKey: "provider:fixture-provider" }, value,
    { ...(kind === "financials" ? { schemaVersion: 7 } : {}), cachePolicy: { staleMs: 60000, expireMs: 120000 } },
  );
  try {
    store("quote", "ACME", quote(999));
    store("financials", "ACME", { quote: quote(999), quoteContributions: { public: quote(999) }, quoteMetadata: { currency: "USD", instrumentType: "Common Stock" }, profile: { description: "Issuer description" }, fundamentals: { marketCap: 1000 }, annualStatements: [], quarterlyStatements: [], priceHistory: [{ date: new Date("2026-09-11"), close: 999 }] });
    const scoped = router.getCachedFinancialsForTargets([target]).get("ACME")!;
    expect(scoped.quote).toBeUndefined(); expect(scoped.quoteContributions).toBeUndefined(); expect(scoped.quoteMetadata).toBeUndefined(); expect(scoped.priceHistory).toEqual([]);
    expect(scoped.profile?.description).toBe("Issuer description"); expect(scoped.fundamentals?.marketCap).toBe(1000);
    const publicValue = router.getCachedFinancialsForTargets([{ symbol: "ACME", exchange: "NASDAQ" }]).get("ACME")!;
    expect(publicValue.quote?.price).toBe(999); expect(publicValue.priceHistory[0]?.close).toBe(999);
    store("quote", getRouterEntityKey("ACME", contract), quote(11));
    const recovered = router.getCachedFinancialsForTargets([target]).get("ACME")!;
    expect(recovered.quote?.price).toBe(11); expect(recovered.profile?.description).toBe("Issuer description");
  } finally { persistence.close(); }
});
