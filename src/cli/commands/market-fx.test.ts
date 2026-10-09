import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { marketDataCliCommands } from "./market";
import { createTestCliContext } from "../../test-support/cli-context";
import { describeFxRate, formatFxRate } from "../fx-pair";

const fx = marketDataCliCommands.find((command) => command.name === "fx")!;

type Leg = number | { rate: number; asOf: number; staleAt: number };

function harness(baseCurrency: string, rates: Record<string, Leg>) {
  const config = createDefaultConfig("/tmp/gloom-fx-command-fixture");
  config.baseCurrency = baseCurrency;
  const requests: string[] = [];
  const cli = createTestCliContext({
    config,
    dataProvider: { getCachedQuery: (_method: string, [currency]: [string]) => ({ load: async () => {
      // The router serves USD/USD as a static identity without a provider request.
      if (currency === "USD") return { value: 1, fetchedAt: 0, staleAt: Infinity, expiresAt: Infinity, source: "static" };
      requests.push(currency);
      const leg = rates[currency];
      if (leg == null) throw new Error(`Missing ${currency}/USD`);
      return typeof leg === "number"
        ? { value: leg, fetchedAt: Date.now(), staleAt: Infinity, expiresAt: Infinity, source: "fx" }
        : { value: leg.rate, asOf: leg.asOf, fetchedAt: Date.now(), staleAt: leg.staleAt, expiresAt: Infinity, source: "fx" };
    } }) },
  });
  return { context: cli.context, rows: () => cli.printed.map(({ result }) => result.data), requests, closed: cli.closeCount };
}

test("FX command converts both USD legs into the configured base currency", async () => {
  const run = harness("EUR", { GBP: 1.5, EUR: 1.2 });
  await fx.execute(["GBP"], run.context);
  expect(run.rows()).toEqual([[{ currency: "GBP", baseCurrency: "EUR", rate: 1.25, asOf: null, stale: false, pair: "GBP/EUR", inverse: 0.8 }]]);
  expect(run.requests.sort()).toEqual(["EUR", "GBP"]);
  expect(run.closed()).toBe(1);
});

test("FX cross rate reports the older leg's observation time and any stale leg", async () => {
  const now = Date.now();
  const run = harness("EUR", {
    GBP: { rate: 1.5, asOf: now - 60_000, staleAt: now + 60_000 },
    EUR: { rate: 1.2, asOf: now - 3 * 86_400_000, staleAt: now - 1 },
  });
  await fx.execute(["GBP"], run.context);
  expect(run.rows()).toEqual([[{ currency: "GBP", baseCurrency: "EUR", rate: 1.25,
    asOf: new Date(now - 3 * 86_400_000).toISOString(), stale: true, pair: "GBP/EUR", inverse: 0.8 }]]);
});

test("FX command handles identity and USD inverses without requiring a USD quote", async () => {
  const identity = harness("EUR", {});
  await fx.execute(["EUR"], identity.context);
  expect(identity.rows()).toEqual([[{ currency: "EUR", baseCurrency: "EUR", rate: 1, asOf: null, stale: false, pair: "EUR/EUR", inverse: 1 }]]);
  expect(identity.requests).toEqual([]);
  const inverse = harness("EUR", { EUR: 1.25 });
  await fx.execute(["USD"], inverse.context);
  expect(inverse.rows()).toEqual([[{ currency: "USD", baseCurrency: "EUR", rate: 0.8, asOf: null, stale: false, pair: "USD/EUR", inverse: 1.25 }]]);
  const usdBase = harness("USD", { JPY: 0.0065 });
  await fx.execute(["JPY"], usdBase.context);
  expect(usdBase.rows()).toMatchObject([[{ currency: "JPY", baseCurrency: "USD", rate: 0.0065, pair: "JPY/USD" }]]);
});

test("FX command names the code whose rate leg is unavailable and publishes nothing", async () => {
  for (const [rates, missing] of [[{ GBP: 1.5 }, "EUR"], [{ EUR: 1.2 }, "GBP"], [{ GBP: 1.5, EUR: 0 }, "EUR"], [{ GBP: NaN, EUR: 1.2 }, "GBP"], [{}, "GBP and EUR"]] as const) {
    const run = harness("EUR", rates);
    await expect(fx.execute(["GBP"], run.context)).rejects.toThrow(`Exchange rate unavailable for ${missing}.`);
    expect(run.rows()).toEqual([]);
    expect(run.closed()).toBe(1);
  }
  // A pair never names the base currency it does not use.
  await expect(fx.execute(["USD/XYZ"], harness("EUR", {}).context)).rejects.toThrow("Exchange rate unavailable for XYZ.");
});

test("a pair reads BASE/QUOTE as quote per base and crosses two non-USD codes through their USD legs", async () => {
  const rates = { NGN: 1 / 1328.39, ZAR: 1 / 16.5 };
  const usdNgn = harness("EUR", rates);
  await fx.execute(["usd/ngn"], usdNgn.context);
  expect(usdNgn.rows()[0]).toMatchObject([{ currency: "USD", baseCurrency: "NGN", pair: "USD/NGN" }]);
  expect(usdNgn.rows()[0][0].rate).toBeCloseTo(1328.39, 6);
  expect(usdNgn.rows()[0][0].inverse).toBeCloseTo(1 / 1328.39, 12);
  expect(usdNgn.requests).toEqual(["NGN"]);

  const zarNgn = harness("USD", rates);
  await fx.execute(["ZAR/NGN"], zarNgn.context);
  expect(zarNgn.rows()[0][0].rate).toBeCloseTo(1328.39 / 16.5, 9);
  expect(zarNgn.rows()[0][0].inverse).toBeCloseTo(16.5 / 1328.39, 12);

  for (const bad of ["US/NGN", "USD/NGN/EUR", "USD/"]) {
    await expect(fx.execute([bad], harness("USD", rates).context)).rejects.toThrow(/not a currency/);
  }
});

test("the text line states both directions in figures that survive tiny and large rates", () => {
  expect(describeFxRate({ currency: "NGN", baseCurrency: "USD" }, 0.00075279095)).toBe("1 NGN = 0.000752791 USD  (USD/NGN 1328.39)");
  expect(formatFxRate(5.6220205e-7)).toBe("0.000000562202");
  expect(formatFxRate(1778719.948)).toBe("1778719.95");
  expect(formatFxRate(16.497)).toBe("16.497");
  expect(formatFxRate(1)).toBe("1");
});
