import { describe, expect, test } from "bun:test";
import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import type { HeadlessPaneContext } from "../../../types/headless";
import { loadScenarioMarket, scenarioControlsFromSettings, scenarioPositionFromSettings, type ScenarioLoaderDependencies } from "./client";
import { daysToExpiryFrom, valueOption } from "../shared/volatility";
import { optionsScenarioHeadless } from "./headless";
import { optionExpirationClose } from "./model";

const now = Date.UTC(2026, 8, 22, 14);
const expiration = Date.UTC(2026, 11, 18) / 1000;
const quote: Quote = { symbol: "AAPL", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: now };
const chain: OptionsChain = { underlyingSymbol: "AAPL", expirationDates: [expiration], calls: [], puts: [], asOf: new Date(now).toISOString() };
const financials: TickerFinancials = { quote, fundamentals: { dividendYield: 0.005 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
const ready = <T>(data: T): QueryEntry<T> => ({ phase: "ready", data, lastGoodData: data, source: "test",
  fetchedAt: now, staleAt: now + 60_000, error: null, attempts: [] });
const dependencies = (overrides: Partial<ScenarioLoaderDependencies> = {}): ScenarioLoaderDependencies => ({
  loadQuote: async () => ready(quote), loadSnapshot: async () => ready(financials), loadOptions: async () => ready(chain),
  loadYieldCurve: async () => [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" },
    { maturity: "1Y", maturityYears: 1, yield: 5, asOf: "2026-09-21" }], now: () => now, ...overrides,
});
const legs = "call,100,2026-12-18,1,5,25;call,110,2026-12-18,-1,2,25";

describe("scenario market loader", () => {
  test("retains the chain when rate and dividend inputs fail without substituting assumptions", async () => {
    const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({
      loadYieldCurve: async () => { throw new Error("Treasury offline"); },
      loadSnapshot: async () => { throw new Error("Fundamentals offline"); },
    }));
    expect(market.chain).toEqual(chain);
    expect(market.spot).toBe(100);
    expect(market.rate).toBeNull();
    expect(market.dividendYield).toBeNull();
    expect(market.warnings).toContain("Treasury: Treasury offline");
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL", legs }, market)).toThrow("Treasury rate unavailable");
  });

  test("rejects wrong or stale underlying observations and wrong chain identity", async () => {
    for (const bad of [{ ...quote, symbol: "MSFT" }, { ...quote, stale: true }]) {
      const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({ loadQuote: async () => ready(bad) }));
      expect(market.spot).toBeNull();
      expect(market.underlyingQuote).toBeNull();
      expect(market.chain).toEqual(chain);
    }
    const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({
      loadOptions: async () => ready({ ...chain, underlyingSymbol: "MSFT" }),
      loadSnapshot: async () => ready({ ...financials, quote: { ...quote, symbol: "MSFT" } }),
    }));
    expect(market.chain).toBeNull();
    expect(market.expirationDates).toEqual([]);
    expect(market.dividendYield).toBeNull();
  });

  test("a stale or failed entry cannot reintroduce last-good spot as a current quote", async () => {
    for (const patch of [{ staleAt: now - 1 }, { error: { reasonCode: "UPSTREAM_ERROR", message: "Refresh failed" } }]) {
      const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({
        loadQuote: async () => ({ ...ready(quote), ...patch }),
      }));
      expect(market.spot).toBeNull();
    }
  });

  test("selected-expiry requests reuse OMON coordinator cache and reject provider fallback expiries", async () => {
    const fetched: (number | undefined)[] = [];
    const wrongExpiration = expiration + 86400;
    const provider = { id: "scenario-test", getOptionsChain: async (_symbol: string, _exchange: string, expiry?: number) => {
      fetched.push(expiry); return { ...chain, calls: [{ expiration: wrongExpiration }] };
    } } as unknown as DataProvider;
    const coordinator = new MarketDataCoordinator(provider);
    try {
      const instrument = { symbol: "AAPL", exchange: "NASDAQ" };
      await coordinator.loadOptions({ instrument, expirationDate: expiration });
      const market = await loadScenarioMarket({ instrument, expiration }, dependencies({ loadOptions: coordinator.loadOptions.bind(coordinator) }));
      expect(fetched).toEqual([expiration]);
      expect(market.expirationDates).toEqual([expiration]);
      expect(market.chain).toBeNull();
      expect(market.warnings).toContain("Selected expiration unavailable in the returned options chain");
    } finally { coordinator.destroy(); }
  });

  test("consumer cancellation does not wait for or cancel the shared chain request", async () => {
    const controller = new AbortController();
    let resolve!: (value: QueryEntry<OptionsChain>) => void;
    const pending = new Promise<QueryEntry<OptionsChain>>((done) => { resolve = done; });
    const loading = loadScenarioMarket({ instrument: { symbol: "AAPL" }, signal: controller.signal }, dependencies({ loadOptions: () => pending }));
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    resolve(ready(chain));
    expect(await pending).toEqual(ready(chain));
  });
});

describe("scenario headless inputs", () => {
  const explicit = { legs, spot: "100.5", rate: "4", dividendYield: "0.5", currency: "USD", asOf: "2026-09-22", date: "2026-10-22", volShift: "2", spotRange: "25" };

  test("fully specified positions value offline and preserve exact scenario controls", async () => {
    const fail = () => { throw new Error("Unexpected market request"); };
    const result = await optionsScenarioHeadless.load({ symbols: ["AAPL"], rawArgument: "AAPL", argument: "AAPL", options: explicit }, {
      marketData: new Proxy({}, { get: fail }), apiClient: new Proxy({}, { get: fail }), signal: new AbortController().signal,
    } as HeadlessPaneContext);
    expect(result.complete).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.metadata?.inputSource).toBe("user");
    expect(result.metadata?.position).toMatchObject({ spot: 100.5, rate: 0.04, dividendYield: 0.005, asOf: Date.UTC(2026, 8, 22) });
    expect(result.metadata?.controls).toEqual({ date: Date.UTC(2026, 9, 22), volShift: 0.02, spotRange: 0.25 });
    expect(result.sections.find((section) => section.title === "Scenario grid")?.rows?.length).toBeGreaterThan(5);
  });

  test("strict numeric and calendar parsing rejects silent coercion", () => {
    for (const bad of ["0x10", "Infinity", "100usd", " "]) {
      expect(() => scenarioPositionFromSettings({ ...explicit, symbol: "AAPL", spot: bad })).toThrow("spot must be a finite number");
    }
    for (const bad of ["2026-02-30", "2026-13-01", "2026-09-22T15:00:00+02:00"]) {
      expect(() => scenarioPositionFromSettings({ ...explicit, symbol: "AAPL", asOf: bad })).toThrow();
    }
    const position = scenarioPositionFromSettings({ ...explicit, symbol: "AAPL" })!;
    expect(() => scenarioControlsFromSettings({ spotRange: "0" }, position)).toThrow("spotRange");
    expect(scenarioPositionFromSettings({ symbol: "AAPL" })).toBeNull();
  });

  test("saved positions and retained market snapshots cannot seed another ticker", async () => {
    const position = scenarioPositionFromSettings({ ...explicit, symbol: "AAPL" })!;
    const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies());
    expect(() => scenarioPositionFromSettings({ symbol: "MSFT", seedPosition: position })).toThrow("Saved position does not match");
    expect(() => scenarioPositionFromSettings({ symbol: "MSFT", legs }, market)).toThrow("Market snapshot does not match");
    expect(scenarioPositionFromSettings({ symbol: "AAPL:NASDAQ", seedPosition: position })?.symbol).toBe("AAPL");
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL:NASDAQ", seedPosition: { ...position, symbol: "AAPL:NYSE" } })).toThrow("Saved position does not match");
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL:NASDAQ", legs }, { ...market, exchange: "NYSE" })).toThrow("Market snapshot does not match");
  });

  test("explicit strategy seeds require matched two-sided quotes and one currency", async () => {
    const contract = (strike: number, bid: number, ask: number) => ({ contractSymbol: `AAPL${strike}`, strike, bid, ask,
      currency: "USD", expiration, impliedVolatility: .25, lastPrice: 999, change: 0, percentChange: 0,
      inTheMoney: false, lastTradeDate: now / 1000 });
    const liveChain = { ...chain, calls: [contract(100, 4, 6), contract(110, 1, 3), contract(101, 0, 1)] };
    const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({ loadOptions: async () => ready(liveChain) }));
    const position = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "vertical" }, market)!;
    expect(position.legs.map((leg) => [leg.strike, leg.quantity, leg.price])).toEqual([[100, 1, 5], [110, -1, 2]]);
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle" }, market)).toThrow("no complete quoted strategy");
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL", strategy: "vertical", currency: "EUR" }, market)).toThrow("Strategy currency differs");
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL", strategy: "vertical" }, { ...market, warnings: ["Options chain is stale"] })).toThrow("current options chain");
  });

  test("a leg the chain gives no IV takes the one its midpoint implies at the market time", async () => {
    const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies());
    const daysToExpiry = (optionExpirationClose(expiration) - now) / 86_400_000;
    const priced = (side: "call" | "put", strike: number, impliedVolatility: number) => {
      const { price } = valueOption({ side, spot: 100, strike, daysToExpiry, rate: market.rate!,
        dividendYield: market.dividendYield!, volatility: 0.3 });
      return { contractSymbol: `AAPL${side}${strike}`, strike, bid: price - 0.05, ask: price + 0.05, currency: "USD",
        expiration, impliedVolatility, lastPrice: 0, change: 0, percentChange: 0, inTheMoney: false, lastTradeDate: now / 1000 };
    };
    const withChain = (calls: OptionsChain["calls"], puts: OptionsChain["puts"]) =>
      loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({ loadOptions: async () => ready({ ...chain, calls, puts }) }));
    const solved = await withChain([priced("call", 100, 0)], [priced("put", 100, 0.28)]);
    // A what-if spot does not move the solved IV off the market observation.
    const position = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle", spot: "110" }, solved)!;
    expect(position.legs[0]).toMatchObject({ side: "call", volatilitySource: "mid" });
    expect(position.legs[0]!.volatility).toBeCloseTo(0.3, 6);
    expect(position.legs[1]).toMatchObject({ side: "put", volatility: 0.28 });
    expect(position.legs[1]!.volatilitySource).toBeUndefined();
    // A midpoint below intrinsic value has no IV; the seed passes over it rather than invent one.
    const strikes = [95, 100, 105];
    const unpriceable = await withChain([{ ...priced("call", 80, 0), bid: 1, ask: 1.2 }, ...strikes.map((strike) => priced("call", strike, 0))],
      [80, ...strikes].map((strike) => priced("put", strike, 0.28)));
    const passedOver = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle", spot: "80" }, unpriceable)!;
    expect(passedOver.legs.map((leg) => leg.strike)).toEqual([95, 95]);
  });

  test("a chain quoted before the spot moved solves its missing IVs against its own parity forward", async () => {
    // Tomorrow's expiry, quoted four hours before the spot print OSA values at.
    const near = Date.UTC(2026, 8, 23) / 1000;
    const quotedAt = now - 4 * 3_600_000;
    const quotedDays = daysToExpiryFrom(near, quotedAt);
    // The 1M bill, held flat for a one-day expiry.
    const rate = 0.04;
    const contract = (side: "call" | "put", strike: number) => {
      const { price } = valueOption({ side, spot: 100, strike, daysToExpiry: quotedDays, rate, dividendYield: 0.005, volatility: 0.3 });
      return { contractSymbol: `AAPL${side}${strike}`, strike, bid: price - 0.01, ask: price + 0.01, currency: "USD",
        expiration: near, impliedVolatility: 0, lastPrice: 0, change: 0, percentChange: 0, inTheMoney: false, lastTradeDate: quotedAt / 1000 };
    };
    const strikes = [98, 100, 102, 104];
    const stale = { ...chain, expirationDates: [near], asOf: new Date(quotedAt).toISOString(),
      calls: strikes.map((strike) => contract("call", strike)), puts: strikes.map((strike) => contract("put", strike)) };
    const after = async (price: number) => {
      const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({
        loadQuote: async () => ready({ ...quote, price }), loadOptions: async () => ready(stale) }));
      expect(market.rate).toBe(rate);
      return market;
    };
    // A 2% move: the call and the put share the forward's volatility, with the
    // time left at the market timestamp, so each still returns its midpoint there.
    // Solved at the moved spot instead, the call would read low and the put high.
    const moved = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle" }, await after(102))!;
    expect(moved.legs.map((leg) => [leg.side, leg.volatilitySource])).toEqual([["call", "mid"], ["put", "mid"]]);
    expect(moved.legs[0]!.strike).toBe(moved.legs[1]!.strike);
    const expected = 0.3 * Math.sqrt(quotedDays / daysToExpiryFrom(near, now));
    for (const leg of moved.legs) expect(leg.volatility).toBeCloseTo(expected, 3);
    // An 8% move leaves no parity forward the spot can trust: no strategy rather than invented IVs.
    const gapped = await after(108);
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle" }, gapped)).toThrow("no complete quoted strategy");
  });
});
