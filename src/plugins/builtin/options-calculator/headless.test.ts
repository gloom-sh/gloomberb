import { expect, test } from "bun:test";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { optionsCalculatorHeadless } from "./headless";

const offline = { signal: new AbortController().signal, settings: {},
  marketData: new Proxy({}, { get() { throw new Error("Unexpected market access"); } }),
  apiClient: new Proxy({}, { get() { throw new Error("Unexpected cloud access"); } }),
} as unknown as HeadlessPaneContext;
const load = (options: Record<string, string | number | boolean>, context = offline) => optionsCalculatorHeadless.load({
  rawArgument: "", argument: null, symbols: [], options,
}, context);

test("OVME report prices explicit assumptions offline and interprets percent inputs consistently", async () => {
  const european = await load({ model: "european", side: "call", spot: "100", strike: "100", days: "365",
    volatility: "20", rate: "5", dividendYield: "0" });
  expect(european.complete).toBe(true);
  expect(european.metadata?.inputs).toMatchObject({ volatility: .2, rate: .05, dividendYield: 0 });
  expect((european.metadata?.valuation as { price: number }).price).toBeCloseTo(10.4506, 3);
  const american = await load({ model: "american", side: "put", spot: "100", strike: "100", days: "365",
    volatility: "20", rate: "5", dividendYield: "0", dividends: "10:1;20:1", steps: 400 });
  expect(american.complete).toBe(true);
  expect(american.metadata?.inputs).toMatchObject({ pricingModel: "american", dividends: [{ days: 10, amount: 1 }, { days: 20, amount: 1 }] });
  expect((american.metadata?.valuation as { price: number }).price).toBeGreaterThan(6);
});

test("OVME rejects cash schedules under the closed form and unavailable surface never falls back to input IV", async () => {
  await expect(load({ model: "european", dividends: "10:1" })).rejects.toThrow("American CRR");
  await expect(load({ model: "american", dividends: "31:1", days: "30" })).rejects.toThrow("between today and expiry");
  await expect(load({ volSource: "surface" })).rejects.toThrow("--symbol");
  const unavailable = await load({ volSource: "surface", symbol: "AAPL", spot: "100", strike: "100", days: "30" }, {
    ...offline,
    marketData: { id: "offline", getQuote: async () => { throw new Error("Quote is offline"); } },
    apiClient: { getCloudYieldCurve: async () => { throw new Error("Unexpected curve request"); } },
  } as unknown as HeadlessPaneContext);
  expect(unavailable.complete).toBe(false);
  expect(unavailable.metadata?.valuation).toBeNull();
  expect(unavailable.unavailableSymbols).toEqual(["AAPL"]);
  expect(unavailable.errors?.length).toBeGreaterThan(0);
});
