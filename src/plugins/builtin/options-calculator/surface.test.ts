import { describe, expect, test } from "bun:test";
import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionsChain, OptionContract, Quote } from "../../../types/financials";
import type { DataProvider } from "../../../types/data-provider";
import { buildSurfaceGrid } from "../vol-surface/model";
import { loadVolatilitySurface } from "../vol-surface/client";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, valueOption } from "./model";
import { loadCalculatorSurfaceVol, projectCalculatorSurfaceVol, type CalculatorSurfaceDependencies } from "./surface";

const now = Date.UTC(2026, 8, 22, 14);
const expirations = [Date.UTC(2026, 9, 9), Date.UTC(2026, 10, 20), Date.UTC(2026, 11, 18)].map((ms) => ms / 1000);
const days = (expiration: number) => daysToExpiryFrom(expiration, now);
const quote: Quote = { symbol: "AAPL", price: 100, currency: "USD", lastUpdated: now,
  change: 0, changePercent: 0, stale: false };
const curve = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" },
  { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-09-21" }];
const ready = <T>(data: T): QueryEntry<T> => ({ phase: "ready", data, lastGoodData: data, fetchedAt: now,
  staleAt: now + 60_000, source: "test", error: null, attempts: [] });

function chain(expiration: number, catalogue = expirations, volatility = expiration === catalogue[0] ? .2 : .4, skew = 0): OptionsChain {
  const contract = (strike: number, side: "call" | "put"): OptionContract => {
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: quote.price, strike,
      daysToExpiry: days(expiration), rate: .04, dividendYield: .01,
      volatility: volatility + skew * Math.log(strike / (100 * Math.exp(.03 * days(expiration) / 365))) }).price;
    return { contractSymbol: `${side}-${strike}-${expiration}`, strike, currency: "USD", expiration,
      bid: price * .99, ask: price * 1.01, lastPrice: 999, impliedVolatility: .9,
      openInterest: 100, volume: 10, lastTradeDate: now / 1000 - 60,
      change: 0, percentChange: 0, inTheMoney: side === "call" ? strike < quote.price : strike > quote.price };
  };
  const strikes = [70, 80, 90, 95, 100, 105, 110, 120, 130];
  return { underlyingSymbol: "AAPL", expirationDates: catalogue, calls: strikes.map((strike) => contract(strike, "call")),
    puts: strikes.map((strike) => contract(strike, "put")), asOf: "2026-09-22T13:45:00Z", providerId: "test" };
}
const dependencies = (overrides: Partial<CalculatorSurfaceDependencies> = {}): CalculatorSurfaceDependencies => ({
  loadQuote: async () => ready(quote), loadOptions: async (request) => ready(chain(request.expirationDate ?? expirations[0]!)),
  loadYieldCurve: async () => curve, now: () => now, ...overrides,
});
const request = { symbol: "AAPL", spot: 100, strike: 100, daysToExpiry: 30 };

describe("calculator surface source", () => {
  test("uses OVDV fixed-forward variance interpolation instead of provider IV or a hypothetical spot", async () => {
    const result = await loadCalculatorSurfaceVol({ ...request, spot: 500 }, dependencies());
    const leftYears = days(expirations[0]!) / 365, rightYears = days(expirations[1]!) / 365, years = 30 / 365;
    const weight = (years - leftYears) / (rightYears - leftYears);
    const expected = Math.sqrt(((1 - weight) * .2 ** 2 * leftYears + weight * .4 ** 2 * rightYears) / years);
    expect(result.error).toBeNull();
    expect(result.volatility).toBeCloseTo(expected, 4);
    expect(result.rate).toBeCloseTo(.04, 8);
    expect(result.dividendYield).toBeCloseTo(.01, 7);
    expect(result.sourceSpot).toBe(100);
    expect(result.spotAsOf).toBe(now);
    expect(result.asOf).toBe("2026-09-22T13:45:00Z");
    expect(result.rateAsOf).toEqual(["2026-09-21"]);
    const snapshot = await loadVolatilitySurface({ instrument: { symbol: "AAPL" }, spot: 100 }, dependencies({
      loadOptions: async (query) => ready(chain(query.expirationDate ?? expirations[0]!, expirations, .3, .5)),
    }));
    const month = buildSurfaceGrid(snapshot, { axis: "strike", coordinates: [110], tenors: "fixed" }).rows.find((row) => row.label === "1M")!;
    const projected = projectCalculatorSurfaceVol(snapshot, { ...request, strike: 110, daysToExpiry: month.years * 365 });
    expect(projected.volatility).toBeCloseTo(month.cells[0]!.volatility!, 10);
  });

  test("exact listed tenor needs one usable slice and does not require a neighboring smile", async () => {
    const result = await loadCalculatorSurfaceVol({ ...request, daysToExpiry: days(expirations[1]!) }, dependencies({
      loadOptions: async (query) => {
        if (query.expirationDate === expirations[2]) throw new Error("Unused neighboring expiry offline");
        return ready(chain(query.expirationDate ?? expirations[0]!));
      },
    }));
    expect(result.error).toBeNull();
    expect(result.volatility).toBeCloseTo(.4, 4);
  });

  test("pins actual adjacent listings with bounded requests and reuses the selected OMON cache", async () => {
    const catalogue = Array.from({ length: 30 }, (_, index) => Date.UTC(2026, 8, index + 23) / 1000);
    const fetched: (number | undefined)[] = [];
    const provider = { id: "calculator-surface", getOptionsChain: async (_symbol: string, _exchange: string, expiration?: number) => {
      fetched.push(expiration); return chain(expiration ?? catalogue[0]!, catalogue, .3);
    } } as unknown as DataProvider;
    const coordinator = new MarketDataCoordinator(provider);
    try {
      const instrument = { symbol: "AAPL", exchange: "NASDAQ" };
      await coordinator.loadOptions({ instrument, expirationDate: catalogue[20] });
      const result = await loadCalculatorSurfaceVol({ ...request, exchange: "NASDAQ", daysToExpiry: (days(catalogue[20]!) + days(catalogue[21]!)) / 2 },
        dependencies({ loadOptions: coordinator.loadOptions.bind(coordinator) }));
      expect(result.error).toBeNull();
      expect(fetched.filter((expiration) => expiration === catalogue[20])).toHaveLength(1);
      expect(fetched).toContain(catalogue[21]);
      expect(fetched.length).toBeLessThanOrEqual(4);
    } finally { coordinator.destroy(); }
  });

  test("rejects tenor and clean-strike extrapolation instead of holding the nearest IV", async () => {
    for (const daysToExpiry of [1, 900]) {
      const result = await loadCalculatorSurfaceVol({ ...request, daysToExpiry }, dependencies());
      expect(result.volatility).toBeNull();
      expect(result.error).toContain("outside the listed surface range");
    }
    const wing = await loadCalculatorSurfaceVol({ ...request, strike: 500 }, dependencies());
    expect(wing.volatility).toBeNull();
    expect(wing.error).toContain("outside cleaned smile support");
  });

  test("does not bridge past a stale, failed or wrong-expiry actual bracket", async () => {
    for (const invalid of ["stale", "failed", "expiry"] as const) {
      const result = await loadCalculatorSurfaceVol(request, dependencies({ loadOptions: async (query) => {
        if (query.expirationDate !== expirations[1]) return ready(chain(query.expirationDate ?? expirations[0]!));
        if (invalid === "failed") throw new Error("Required expiry offline");
        if (invalid === "expiry") return ready(chain(expirations[2]!));
        return { ...ready(chain(expirations[1]!)), staleAt: now - 1 };
      } }));
      expect(result.volatility).toBeNull();
      expect(result.error).toContain("both tenor brackets are required");
      if (invalid === "failed") expect(result.warnings.some((warning) => warning.includes("Required expiry offline"))).toBe(true);
      if (invalid === "expiry") expect(result.warnings.some((warning) => warning.includes("different expiration"))).toBe(true);
    }
  });

  test("rejects stale and foreign underlying observations, chain identity and currency mismatch", async () => {
    for (const badQuote of [{ ...quote, symbol: "MSFT" }, { ...quote, symbol: "AAPL:NYSE" }, { ...quote, stale: true }]) {
      const result = await loadCalculatorSurfaceVol({ ...request, symbol: "AAPL:NASDAQ" }, dependencies({ loadQuote: async () => ready(badQuote) }));
      expect(result.volatility).toBeNull();
      expect(result.error).not.toBeNull();
    }
    for (const mismatch of ["identity", "currency"] as const) {
      const result = await loadCalculatorSurfaceVol(request, dependencies({ loadOptions: async (query) => {
        const value = chain(query.expirationDate ?? expirations[0]!);
        return ready(mismatch === "identity" ? { ...value, underlyingSymbol: "MSFT" }
          : { ...value, calls: value.calls.map((contract) => ({ ...contract, currency: "EUR" })), puts: value.puts.map((contract) => ({ ...contract, currency: "EUR" })) });
      } }));
      expect(result.volatility).toBeNull();
      expect([result.error, ...result.warnings].some((value) => value?.includes(mismatch))).toBe(true);
    }
  });

  test("missing Treasury does not invent a volatility and cancellation releases a pending consumer", async () => {
    const missing = await loadCalculatorSurfaceVol(request, dependencies({ loadYieldCurve: async () => { throw new Error("Treasury offline"); } }));
    expect(missing.volatility).toBeNull();
    expect(missing.rate).toBeNull();
    expect(missing.warnings.some((warning) => warning.includes("Treasury offline"))).toBe(true);
    const controller = new AbortController();
    let resolve!: (value: QueryEntry<Quote>) => void;
    const pending = new Promise<QueryEntry<Quote>>((done) => { resolve = done; });
    const loading = loadCalculatorSurfaceVol({ ...request, signal: controller.signal }, dependencies({ loadQuote: () => pending }));
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    resolve(ready(quote));
  });
});
