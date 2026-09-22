import { describe, expect, test } from "bun:test";
import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import type { HeadlessPaneContext } from "../../../types/headless";
import { loadScenarioMarket, scenarioControlsFromSettings, scenarioPositionFromSettings, type ScenarioLoaderDependencies } from "./client";
import { optionsScenarioHeadless } from "./headless";

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

  test("explicit strategy seeds require matched two-sided quotes, IV and currency", async () => {
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
});
