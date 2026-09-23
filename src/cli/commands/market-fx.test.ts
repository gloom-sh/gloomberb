import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { CliCommandContext } from "../../types/plugin";
import { marketDataCliCommands } from "./market";

const fx = marketDataCliCommands.find((command) => command.name === "fx")!;

type Leg = number | { rate: number; asOf: number; staleAt: number };

function harness(baseCurrency: string, rates: Record<string, Leg>) {
  const config = createDefaultConfig("/tmp/gloom-fx-command-fixture");
  config.baseCurrency = baseCurrency;
  const rows: unknown[] = [];
  const requests: string[] = [];
  let closed = 0;
  const context = {
    initMarketData: async () => ({
      config,
      persistence: { close: () => { closed++; } },
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
    }),
    cliOptions: { refresh: false },
    printResult: (result: { data: unknown }) => { rows.push(result.data); },
    fail: (message: string): never => { throw new Error(message); },
  } as unknown as CliCommandContext;
  return { context, rows, requests, closed: () => closed };
}

test("FX command converts both USD legs into the configured base currency", async () => {
  const run = harness("EUR", { GBP: 1.5, EUR: 1.2 });
  await fx.execute(["GBP"], run.context);
  expect(run.rows).toEqual([[{ currency: "GBP", baseCurrency: "EUR", rate: 1.25, asOf: null, stale: false }]]);
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
  expect(run.rows).toEqual([[{ currency: "GBP", baseCurrency: "EUR", rate: 1.25,
    asOf: new Date(now - 3 * 86_400_000).toISOString(), stale: true }]]);
});

test("FX command handles identity and USD inverses without requiring a USD quote", async () => {
  const identity = harness("EUR", {});
  await fx.execute(["EUR"], identity.context);
  expect(identity.rows).toEqual([[{ currency: "EUR", baseCurrency: "EUR", rate: 1, asOf: null, stale: false }]]);
  expect(identity.requests).toEqual([]);
  const inverse = harness("EUR", { EUR: 1.25 });
  await fx.execute(["USD"], inverse.context);
  expect(inverse.rows).toEqual([[{ currency: "USD", baseCurrency: "EUR", rate: 0.8, asOf: null, stale: false }]]);
  const usdBase = harness("USD", { JPY: 0.0065 });
  await fx.execute(["JPY"], usdBase.context);
  expect(usdBase.rows).toEqual([[{ currency: "JPY", baseCurrency: "USD", rate: 0.0065, asOf: null, stale: false }]]);
});

test("FX command does not publish a conversion when either rate leg is unavailable", async () => {
  for (const rates of [{ GBP: 1.5 }, { EUR: 1.2 }, { GBP: 1.5, EUR: 0 }, { GBP: NaN, EUR: 1.2 }]) {
    const run = harness("EUR", rates);
    await expect(fx.execute(["GBP"], run.context)).rejects.toThrow("GBP/EUR");
    expect(run.rows).toEqual([]);
    expect(run.closed()).toBe(1);
  }
});
