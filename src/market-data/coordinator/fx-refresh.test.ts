import { expect, test } from "bun:test";
import { AssetDataRouter } from "../../sources/provider-router";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { ExchangeRateSnapshot } from "../../types/exchange-rate";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { MarketDataCoordinator } from "./index";
import { createManualFrameDriver, DataFrameScheduler } from "../frame-scheduler";

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

test("streamed USD pairs move the FX rate while current and keep the loaded rate as the reference", async () => {
  const now = Date.now();
  const rates: Record<string, number> = { EUR: 1.1, JPY: 1 / 150 };
  const subscribed: string[][] = [];
  let emit: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
  const provider = createTestDataProvider({
    getExchangeRate: async (currency) => rates[currency]!,
    subscribeQuotes: (targets, onQuote) => {
      subscribed.push(targets.map((target) => `${target.symbol}${target.visible ? "" : " (background)"}`));
      emit = onQuote;
      return () => {};
    },
  });
  const clock = createManualFrameDriver(0);
  const coordinator = new MarketDataCoordinator(provider, { frames: new DataFrameScheduler(clock.driver) });
  const pair = (symbol: string, quote: Partial<Quote>) => {
    emit!({ symbol, exchange: "" }, { symbol, currency: "USD", change: 0, changePercent: 0, lastUpdated: now, price: 0, ...quote });
  };

  await coordinator.loadFxRate("EUR");
  coordinator.subscribeFxRates(["USD", "EUR", "JPY", "XXX"]);
  expect(subscribed.at(-1)?.sort()).toEqual(["EURUSD=X (background)", "JPY=X (background)"]);

  pair("EURUSD=X", { price: 1.1181, bid: 1.118, ask: 1.1182 });
  // No loaded JPY rate yet, so nothing can vouch for the streamed one.
  pair("JPY=X", { price: 151 });
  clock.advance(0);
  expect(coordinator.getFxEntry("EUR").data).toBeCloseTo(1.1181, 6);
  expect(coordinator.getFxEntry("EUR").asOf).toBe(now);
  expect(coordinator.getFxEntry("JPY").data).toBeNull();

  // Once a rate loads, the held pair quote is checked against it and used.
  await coordinator.loadFxRate("JPY");
  await Promise.resolve();
  expect(coordinator.getFxEntry("JPY").data).toBeCloseTo(1 / 151, 8);

  // A loaded rate cannot pull a current streamed one back.
  rates.EUR = 1.09;
  await coordinator.loadFxRate("EUR", { forceRefresh: true });
  expect(coordinator.getFxEntry("EUR").data).toBeCloseTo(1.1181, 6);

  // A print far from the loaded rate is a wrong pair or a bad tick.
  pair("EURUSD=X", { price: 0.5 });
  clock.advance(1_000);
  expect(coordinator.getQuoteEntry({ symbol: "EURUSD=X", exchange: "" }).data?.price).toBe(0.5);
  expect(coordinator.getFxEntry("EUR").data).toBeCloseTo(1.1181, 6);
});

test("a pair overrides the loaded rate only with a current observation of its own", async () => {
  const now = Date.now();
  // The loaded rate is half an hour old, so only the pair's own age can reject it.
  let loaded = { rate: 1.1, asOf: now - 30 * 60_000 };
  let emit: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
  const pairQuote = (quote: Partial<Quote>): Quote => ({
    symbol: "EURUSD=X", currency: "USD", change: 0, changePercent: 0, lastUpdated: now, price: 0, dataSource: "live", ...quote,
  });
  const provider = createTestDataProvider({
    getExchangeRateSnapshot: async () => ({
      rate: loaded.rate, fromCurrency: "EUR", toCurrency: "USD", source: "controlled-fx",
      asOf: new Date(loaded.asOf).toISOString(), fetchedAt: new Date(now).toISOString(), stale: false,
    }),
    // An open EURUSD=X detail holds a snapshot with its own bid and ask.
    getTickerFinancials: async () => ({
      annualStatements: [], quarterlyStatements: [], priceHistory: [],
      quote: pairQuote({ price: 1.1181, bid: 1.118, ask: 1.1182, lastUpdated: now - 20 * 60_000 }),
    }),
    subscribeQuotes: (_targets, onQuote) => { emit = onQuote; return () => {}; },
  });
  const clock = createManualFrameDriver(0);
  const coordinator = new MarketDataCoordinator(provider, { frames: new DataFrameScheduler(clock.driver) });
  const pair = (quote: Partial<Quote>) => {
    emit!({ symbol: "EURUSD=X", exchange: "" }, pairQuote(quote));
    clock.advance(1_000);
  };
  try {
    await coordinator.loadFxRate("EUR");
    await coordinator.loadSnapshot({ symbol: "EURUSD=X", exchange: "" });
    coordinator.subscribeFxRates(["EUR"]);

    // A pair last observed minutes ago (a delayed feed, a quiet market) is not a live rate.
    pair({ price: 1.105, lastUpdated: now - 3 * 60_000, dataSource: "delayed" });
    expect(coordinator.getFxEntry("EUR").data).toBe(1.1);

    // A frame with only a price moves the rate; the snapshot's bid and ask do not pin it.
    pair({ price: 1.119 });
    expect(coordinator.getFxEntry("EUR").data).toBeCloseTo(1.119, 6);

    // A request that observed the market after the last tick is the better rate.
    loaded = { rate: 1.12, asOf: now + 1_000 };
    await coordinator.loadFxRate("EUR", { forceRefresh: true });
    expect(coordinator.getFxEntry("EUR").data).toBe(1.12);
  } finally {
    coordinator.destroy();
  }
});
