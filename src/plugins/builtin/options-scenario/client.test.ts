import { describe, expect, setSystemTime, test } from "bun:test";
import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import type { HeadlessPaneContext } from "../../../types/headless";
import { loadScenarioMarket, scenarioControlsFromSettings, scenarioPositionFromSettings, type ScenarioLoaderDependencies } from "./client";
import { daysToExpiryFrom, solveImpliedVolatility, valueOption } from "../shared/volatility";
import { optionsScenarioHeadless } from "./headless";
import { parseOptionExpiration } from "../../../utils/option-expiry";
import { buildScenario, optionExpirationClose } from "./model";

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

  test("a typed date selects the chain's expiry of that day, and an unlisted one names the listed dates", async () => {
    // A source that stamps the expiry at the New York close and keys its chains by that stamp.
    const stamped = expiration + 20 * 3600;
    const contract = (strike: number) => ({ contractSymbol: `AAPL${strike}`, strike, bid: 4, ask: 6, currency: "USD", expiration: stamped,
      impliedVolatility: .25, lastPrice: 5, change: 0, percentChange: 0, inTheMoney: false, lastTradeDate: now / 1000 });
    const requested: (number | undefined)[] = [];
    const deps = dependencies({ loadOptions: async (request) => {
      requested.push(request.expirationDate);
      return ready({ ...chain, expirationDates: [stamped], calls: request.expirationDate === stamped ? [contract(100), contract(110)] : [] });
    } });
    const typed = parseOptionExpiration("2026-12-18")!;
    const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" }, expiration: typed }, deps);
    expect(requested).toEqual([typed, stamped]);
    expect(market.chain?.calls.map((call) => call.strike)).toEqual([100, 110]);
    expect(market.missingExpiry).toBeUndefined();
    const unlisted = await loadScenarioMarket({ instrument: { symbol: "AAPL" }, expiration: parseOptionExpiration("2026-12-19")! }, deps);
    expect(unlisted.chain).toBeNull();
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL", strategy: "vertical" }, unlisted))
      .toThrow("No expiry 2026-12-19 for AAPL; available: 2026-12-18");
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
    expect(result.sections.find((section) => section.title.startsWith("Scenario grid"))?.rows?.length).toBeGreaterThan(5);
  });

  test("money figures name their currency and size: the underlying's currency, entry per share, value per contract", async () => {
    const offline = { symbols: ["AAPL"], rawArgument: "AAPL", argument: "AAPL" };
    const fail = () => { throw new Error("Unexpected market request"); };
    const context = { marketData: new Proxy({}, { get: fail }), apiClient: new Proxy({}, { get: fail }),
      signal: new AbortController().signal } as HeadlessPaneContext;
    // No --currency: a US listing (a bare symbol is one) is in dollars, without a quote to ask.
    const { currency: _currency, ...untyped } = explicit;
    const result = await optionsScenarioHeadless.load({ ...offline, options: untyped }, context);
    expect(result.metadata?.units).toEqual({ currency: "USD", price: "per share", value: "for 2 contracts" });
    expect(result.sections.map((section) => section.title)).toEqual(["Position", "Inputs", "Valuation (USD for 2 contracts)",
      "Expiry risk (USD for 2 contracts)", "Scenario grid (P&L, USD for 2 contracts)"]);
    const entry = (key: string) => result.sections.flatMap((section) => section.entries ?? []).find((item) => item.key === key);
    expect([entry("price")?.label, entry("spot")?.formatted, entry("thetaPerDay")?.label]).toEqual(["Value", "100.50 per share", "Theta (USD per day)"]);
    expect(result.sections[0]!.columns!.find((column) => column.key === "price")?.header).toBe("Entry/share");
    const single = await optionsScenarioHeadless.load({ ...offline, options: { ...untyped, legs: "call,100,2026-12-18,1,5,25" } }, context);
    expect(single.metadata?.units).toMatchObject({ value: "per contract" });
    // A listing abroad with nothing naming its currency says so, never a bare code.
    const abroad = await optionsScenarioHeadless.load({ ...offline, symbols: ["SAP:XETRA"], options: untyped }, context);
    expect(abroad.sections[2]!.title).toBe("Valuation (currency unknown for 2 contracts)");
  });

  test("a typed rate or yield clears the warning that the source had none", async () => {
    const provider = { id: "scenario-test", getQuote: async () => quote, getTickerFinancials: async () => { throw new Error("Fundamentals offline"); },
      getOptionsChain: async () => chain } as unknown as DataProvider;
    const run = (options: Record<string, unknown>) => optionsScenarioHeadless.load({ symbols: ["AAPL"], rawArgument: "AAPL", argument: "AAPL",
      options: { legs, ...options } }, { marketData: provider, signal: new AbortController().signal,
      apiClient: { getCloudYieldCurve: dependencies().loadYieldCurve } } as unknown as HeadlessPaneContext);
    setSystemTime(now);
    try {
      await expect(run({})).rejects.toThrow("Dividend yield unavailable");
      const typed = await run({ dividendYield: "0" });
      expect(typed.errors).not.toContain("Dividend yield unavailable; supply an explicit assumption");
      expect(typed.sections.find((section) => section.title === "Inputs")?.entries?.find((item) => item.key === "dividendYield")?.formatted).toBe("0.00%");
    } finally { setSystemTime(); }
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

  test("a seeded leg takes the IV its midpoint implies at the market time, over a provider IV", async () => {
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
    // The call has no provider IV; the put's 28% disagrees with the 30% its quotes were priced at.
    const solved = await withChain([priced("call", 100, 0)], [priced("put", 100, 0.28)]);
    const seeded = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle" }, solved)!;
    expect(seeded.legs.map((leg) => [leg.side, leg.volatilitySource])).toEqual([["call", "mid"], ["put", "mid"]]);
    for (const leg of seeded.legs) expect(leg.volatility).toBeCloseTo(0.3, 6);
    // Entered at its midpoints, the position is worth what it cost at the origin.
    expect(Math.abs(buildScenario(seeded).valuation.pnl)).toBeLessThan(1e-4);
    // A what-if spot does not move the solved IV off the market observation.
    const position = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle", spot: "110" }, solved)!;
    expect(position.legs.map((leg) => leg.volatility)).toEqual(seeded.legs.map((leg) => leg.volatility));
    // A midpoint below intrinsic value has no IV; the seed passes over it rather than invent one.
    const strikes = [95, 100, 105];
    const below = (impliedVolatility: number) => withChain([{ ...priced("call", 80, impliedVolatility), bid: 1, ask: 1.2 },
      ...strikes.map((strike) => priced("call", strike, 0))], [80, ...strikes].map((strike) => priced("put", strike, 0.28)));
    const passedOver = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle", spot: "80" }, await below(0))!;
    expect(passedOver.legs.map((leg) => leg.strike)).toEqual([95, 95]);
    // Only a leg its midpoint cannot price keeps a usable provider IV, and says so by carrying no mark.
    const fallback = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle", spot: "80" }, await below(0.28))!;
    expect(fallback.legs.map((leg) => [leg.strike, leg.volatilitySource])).toEqual([[80, undefined], [80, "mid"]]);
    expect(fallback.legs[0]!.volatility).toBe(0.28);
  });

  test("a same-day IV solved when the chain was served still seeds a straddle at zero P&L", async () => {
    // An expiry-day chain from the prior close, valued at the last after-hours
    // print (20h left), with provider IVs a server solved from the same
    // midpoints at 06:00 UTC (14h left), as a filled 0DTE chain arrives.
    const sameDay = Date.UTC(2026, 8, 23) / 1000;
    const quotedAt = Date.UTC(2026, 8, 22, 20);
    const printAt = Date.UTC(2026, 8, 23);
    const servedAt = Date.UTC(2026, 8, 23, 6);
    const rate = 0.04;
    const contract = (side: "call" | "put", strike: number) => {
      const { price } = valueOption({ side, spot: 100, strike, daysToExpiry: daysToExpiryFrom(sameDay, quotedAt), rate,
        dividendYield: 0.005, volatility: 0.3 });
      const served = solveImpliedVolatility({ side, spot: 100, strike, daysToExpiry: daysToExpiryFrom(sameDay, servedAt), rate,
        dividendYield: 0.005 }, price).volatility!;
      return { contractSymbol: `AAPL${side}${strike}`, strike, bid: price - 0.01, ask: price + 0.01, currency: "USD",
        expiration: sameDay, impliedVolatility: served, lastPrice: 0, change: 0, percentChange: 0, inTheMoney: false,
        lastTradeDate: quotedAt / 1000 };
    };
    const strikes = [98, 100, 102, 104];
    const filled = { ...chain, expirationDates: [sameDay], asOf: new Date(servedAt).toISOString(),
      calls: strikes.map((strike) => contract("call", strike)), puts: strikes.map((strike) => contract("put", strike)) };
    const current = <T>(data: T): QueryEntry<T> => ({ ...ready(data), fetchedAt: servedAt, staleAt: servedAt + 60_000 });
    const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({ now: () => servedAt,
      loadQuote: async () => current({ ...quote, lastUpdated: printAt }), loadOptions: async () => current(filled) }));
    expect([market.asOf, market.rate, market.warnings]).toEqual([printAt, rate, []]);
    const position = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle" }, market)!;
    expect(position.asOf).toBe(printAt);
    expect(position.legs.map((leg) => [leg.side, leg.strike, leg.volatilitySource])).toEqual([["call", 100, "mid"], ["put", 100, "mid"]]);
    const cost = position.legs.reduce((sum, leg) => sum + leg.price * leg.quantity * leg.multiplier, 0);
    // The served IVs, valued over the 20 hours left at the print, would start the straddle deep in profit.
    const served = { ...position, legs: position.legs.map((leg) => ({ ...leg,
      volatility: filled[leg.side === "call" ? "calls" : "puts"].find((quoted) => quoted.contractSymbol === leg.id)!.impliedVolatility })) };
    expect(buildScenario(served).valuation.pnl).toBeGreaterThan(cost * 0.15);
    expect(Math.abs(buildScenario(position).valuation.pnl)).toBeLessThan(cost * 0.001);
  });

  test("a strategy seeded from the close's 0DTE chain starts at zero P&L after the print moves", async () => {
    // Quoted at the close (spot 100, 30%), valued at the 00:00 UTC after-hours
    // print. On a same-day vertical a quarter-percent print move is worth about
    // a fifth of its cost, so valued at the print the seed would not start flat.
    const sameDay = Date.UTC(2026, 8, 23) / 1000;
    const quotedAt = Date.UTC(2026, 8, 22, 20);
    const printAt = Date.UTC(2026, 8, 23);
    const contract = (side: "call" | "put", strike: number) => {
      const { price } = valueOption({ side, spot: 100, strike, daysToExpiry: daysToExpiryFrom(sameDay, quotedAt), rate: 0.04,
        dividendYield: 0.005, volatility: 0.3 });
      return { contractSymbol: `AAPL${side}${strike}`, strike, bid: price - 0.01, ask: price + 0.01, currency: "USD",
        expiration: sameDay, impliedVolatility: 0, lastPrice: 0, change: 0, percentChange: 0, inTheMoney: false,
        lastTradeDate: quotedAt / 1000 };
    };
    const strikes = [97.5, 100, 102.5, 105];
    const close = { ...chain, expirationDates: [sameDay], asOf: new Date(quotedAt).toISOString(),
      calls: strikes.map((strike) => contract("call", strike)), puts: strikes.map((strike) => contract("put", strike)) };
    const current = <T>(data: T): QueryEntry<T> => ({ ...ready(data), fetchedAt: printAt, staleAt: printAt + 60_000 });
    for (const print of [99, 100.25, 101]) {
      const market = await loadScenarioMarket({ instrument: { symbol: "AAPL" } }, dependencies({ now: () => printAt,
        loadQuote: async () => current({ ...quote, price: print, lastUpdated: printAt }), loadOptions: async () => current(close) }));
      expect([market.spot, market.asOf, market.warnings]).toEqual([print, printAt, []]);
      for (const strategy of ["straddle", "vertical"]) {
        const position = scenarioPositionFromSettings({ symbol: "AAPL", strategy }, market)!;
        expect(position.legs.map((leg) => leg.strike)).toEqual(strategy === "straddle" ? [100, 100] : [100, 102.5]);
        expect(position.legs.every((leg) => leg.volatilitySource === "mid")).toBe(true);
        expect(position.legs[0]!.volatility).toBeCloseTo(position.legs[1]!.volatility, 4);
        // The origin is the spot the quotes imply, the close plus a few hours of carry.
        expect(position.spot).toBeCloseTo(100, 2);
        const cost = position.legs.reduce((sum, leg) => sum + leg.price * leg.quantity * leg.multiplier, 0);
        expect(Math.abs(buildScenario(position).valuation.pnl)).toBeLessThan(1e-6);
        // The print is still in reach as a what-if, at the IVs the quotes imply.
        const whatIf = scenarioPositionFromSettings({ symbol: "AAPL", strategy, spot: String(print) }, market)!;
        expect(whatIf.spot).toBe(print);
        expect(whatIf.legs.map((leg) => leg.volatility)).toEqual(position.legs.map((leg) => leg.volatility));
        if (strategy === "vertical" && print === 100.25) expect(buildScenario(whatIf).valuation.pnl).toBeGreaterThan(cost * 0.15);
      }
    }
    // Headless output names the last print beside the origin, and leaves it out for a typed spot.
    setSystemTime(printAt);
    try {
      const provider = { id: "scenario-test", getQuote: async () => ({ ...quote, price: 100.25, lastUpdated: printAt }),
        getTickerFinancials: async () => financials, getOptionsChain: async () => close } as unknown as DataProvider;
      const run = (options: Record<string, unknown>) => optionsScenarioHeadless.load({ symbols: ["AAPL"], rawArgument: "AAPL",
        argument: "AAPL", options: { strategy: "vertical", ...options } }, { marketData: provider, signal: new AbortController().signal,
        apiClient: { getCloudYieldCurve: dependencies().loadYieldCurve } } as unknown as HeadlessPaneContext);
      const seeded = await run({});
      expect([seeded.complete, seeded.errors]).toEqual([true, []]);
      const spot = (result: typeof seeded) => result.sections.find((section) => section.title === "Inputs")?.entries
        ?.filter((entry) => entry.key === "spot" || entry.key === "last").map((entry) => [entry.label, entry.formatted]);
      expect(spot(seeded)).toEqual([["Spot implied by option quotes", "100.00 per share"], ["Last price", "100.25 per share"]]);
      const pnl = seeded.sections.find((section) => section.title.startsWith("Valuation"))?.entries?.find((entry) => entry.key === "pnl");
      expect(Math.abs(Number(pnl?.value))).toBeLessThan(1e-6);
      expect(pnl?.formatted).toBe("0.00");
      expect(spot(await run({ spot: "100.25" }))).toEqual([["Spot", "100.25 per share"]]);
    } finally { setSystemTime(); }
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
    const market = await after(102);
    const moved = scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle" }, market)!;
    expect(moved.legs.map((leg) => [leg.side, leg.volatilitySource])).toEqual([["call", "mid"], ["put", "mid"]]);
    expect(moved.legs[0]!.strike).toBe(moved.legs[1]!.strike);
    const expected = 0.3 * Math.sqrt(quotedDays / daysToExpiryFrom(near, now));
    for (const leg of moved.legs) expect(leg.volatility).toBeCloseTo(expected, 3);
    // Both strategies start where the quotes put the spot, at zero P&L, rather
    // than a -33% straddle and a +375% vertical valued at the moved print.
    for (const strategy of ["straddle", "vertical"]) {
      const position = scenarioPositionFromSettings({ symbol: "AAPL", strategy }, market)!;
      expect(position.spot).toBeCloseTo(100, 1);
      expect(Math.abs(buildScenario(position).valuation.pnl)).toBeLessThan(1e-6);
    }
    // An 8% move leaves no parity forward the spot can trust: no strategy rather than invented IVs.
    const gapped = await after(108);
    expect(() => scenarioPositionFromSettings({ symbol: "AAPL", strategy: "straddle" }, gapped)).toThrow("no complete quoted strategy");
  });
});
