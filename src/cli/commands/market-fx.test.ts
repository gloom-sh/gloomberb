import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { CliCommandContext } from "../../types/plugin";
import { marketDataCliCommands } from "./market";

const fx = marketDataCliCommands.find((command) => command.name === "fx")!;

function harness(baseCurrency: string, rates: Record<string, number>) {
  const config = createDefaultConfig("/tmp/gloom-fx-command-fixture");
  config.baseCurrency = baseCurrency;
  const rows: unknown[] = [];
  const requests: string[] = [];
  let closed = 0;
  const context = {
    initMarketData: async () => ({
      config,
      persistence: { close: () => { closed++; } },
      dataProvider: { getExchangeRate: async (currency: string) => {
        requests.push(currency);
        const rate = rates[currency];
        if (rate == null) throw new Error(`Missing ${currency}/USD`);
        return rate;
      } },
    }),
    printResult: (result: { data: unknown }) => { rows.push(result.data); },
    fail: (message: string): never => { throw new Error(message); },
  } as unknown as CliCommandContext;
  return { context, rows, requests, closed: () => closed };
}

test("FX command converts both USD legs into the configured base currency", async () => {
  const run = harness("EUR", { GBP: 1.5, EUR: 1.2 });
  await fx.execute(["GBP"], run.context);
  expect(run.rows).toEqual([[{ currency: "GBP", baseCurrency: "EUR", rate: 1.25 }]]);
  expect(run.requests.sort()).toEqual(["EUR", "GBP"]);
  expect(run.closed()).toBe(1);
});

test("FX command handles identity and USD inverses without requiring a USD quote", async () => {
  const identity = harness("EUR", {});
  await fx.execute(["EUR"], identity.context);
  expect(identity.rows).toEqual([[{ currency: "EUR", baseCurrency: "EUR", rate: 1 }]]);
  expect(identity.requests).toEqual([]);
  const inverse = harness("EUR", { EUR: 1.25 });
  await fx.execute(["USD"], inverse.context);
  expect(inverse.rows).toEqual([[{ currency: "USD", baseCurrency: "EUR", rate: 0.8 }]]);
  const usdBase = harness("USD", { JPY: 0.0065 });
  await fx.execute(["JPY"], usdBase.context);
  expect(usdBase.rows).toEqual([[{ currency: "JPY", baseCurrency: "USD", rate: 0.0065 }]]);
});

test("FX command does not publish a conversion when either rate leg is unavailable", async () => {
  for (const rates of [{ GBP: 1.5 }, { EUR: 1.2 }, { GBP: 1.5, EUR: 0 }, { GBP: NaN, EUR: 1.2 }]) {
    const run = harness("EUR", rates);
    await expect(fx.execute(["GBP"], run.context)).rejects.toThrow("GBP/EUR");
    expect(run.rows).toEqual([]);
    expect(run.closed()).toBe(1);
  }
});
