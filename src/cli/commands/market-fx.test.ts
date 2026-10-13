import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { marketDataCliCommands } from "./market";
import { createTestCliContext } from "../../test-support/cli-context";
import { describeFxRate, formatFxRate } from "../fx-pair";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";

afterEach(() => setSystemTime());

const fx = marketDataCliCommands.find((command) => command.name === "fx")!;

type Leg = number | { rate: number; asOf: number; staleAt: number; delayMinutes?: number };

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
        : { value: leg.rate, asOf: leg.asOf, delayMinutes: leg.delayMinutes, fetchedAt: Date.now(), staleAt: leg.staleAt, expiresAt: Infinity, source: "fx" };
    } }) },
  });
  /** What a text and a JSON run print, closing line included. */
  const output = (format: "text" | "json" | "csv") => cli.printed.map(({ result, options }) => serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format }, options));
  return { context: cli.context, rows: () => cli.printed.map(({ result }) => result.data), output, requests, closed: cli.closeCount };
}

test("FX command converts both USD legs into the configured base currency", async () => {
  const run = harness("EUR", { GBP: 1.5, EUR: 1.2 });
  await fx.execute(["GBP"], run.context);
  expect(run.rows()).toEqual([[{ currency: "GBP", baseCurrency: "EUR", rate: 1.25, asOf: null, stale: false, pair: "GBP/EUR", inverse: 0.8 }]]);
  expect(run.requests.sort()).toEqual(["EUR", "GBP"]);
  expect(run.closed()).toBe(1);
});

test("an FX export names the pair and the currency the rate is in, which is the base, not the currency asked for", async () => {
  const now = Date.parse("2026-10-13T06:18:00Z");
  const run = harness("USD", { ZAR: { rate: 0.06055468, asOf: now, staleAt: Infinity } });
  await fx.execute(["ZAR"], run.context);
  expect(run.output("csv")[0]!.split("\n").slice(0, 2)).toEqual([
    "Currency,Base,Rate,As Of,Stale,Pair,Inverse,symbol_or_series,currency_or_unit,interval,source,as_of",
    "ZAR,USD,0.06055468,2026-10-13T06:18:00.000Z,false,ZAR/USD,16.514000239122723,ZAR/USD,USD,spot,Gloom Cloud,2026-10-13T06:18:00.000Z",
  ]);
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

test("a pair ends with the source line a quote does, dated and held back as its rates are", async () => {
  const hour = 3_600_000;
  // Saturday: the FX week is shut, so a quiet Saturday print reads as Friday's close.
  setSystemTime(new Date("2026-10-10T18:45:00Z"));
  const asOf = Date.parse("2026-10-10T03:09:15Z");
  const weekend = harness("USD", { SAR: { rate: 0.2663, asOf, staleAt: Date.now() + hour, delayMinutes: 15 } });
  await fx.execute(["USD/SAR"], weekend.context);
  const line = "Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed";
  // The line says the time and the state, so there is no separate "As of".
  expect(weekend.output("text")[0]).toBe(`1 USD = 3.75516 SAR  (SAR/USD 0.2663)\n\n${line}`);
  expect(JSON.parse(weekend.output("json")[0]!).metadata.freshness).toMatchObject({
    source: "Gloom Cloud", asOf: "2026-10-10T03:09:15.000Z", status: "delayed", delayMinutes: 15, asOfClose: "2026-10-09", market: { state: "closed" },
  });

  // Wednesday: a cross is as old as its older leg and as delayed as its most delayed.
  setSystemTime(new Date("2026-10-14T14:00:00Z"));
  const now = Date.now();
  const leg = (rate: number, minutesAgo: number, delayMinutes: number) => ({ rate, asOf: now - minutesAgo * 60_000, staleAt: now + hour, delayMinutes });
  const cross = harness("EUR", { GBP: leg(1.5, 5, 15), EUR: leg(1.2, 25, 20) });
  await fx.execute(["GBP"], cross.context);
  expect(cross.output("text")[0]).toEndWith("Source: Gloom Cloud · Wed 14 Oct 2026 13:35 UTC · 20 min delayed · markets open");
  // A real-time account's rates are live; a leg that missed its refresh makes the pair stale.
  const live = harness("EUR", { GBP: leg(1.5, 5, 0), EUR: leg(1.2, 25, 0) });
  await fx.execute(["GBP"], live.context);
  expect(live.output("text")[0]).toEndWith("Source: Gloom Cloud · Wed 14 Oct 2026 13:35 UTC · live · markets open");
  const stale = harness("EUR", { GBP: leg(1.5, 5, 15), EUR: { ...leg(1.2, 25, 15), staleAt: now - 1 } });
  await fx.execute(["GBP"], stale.context);
  expect(stale.output("text")[0]).toEndWith("Source: Gloom Cloud · Wed 14 Oct 2026 13:35 UTC · stale (25 min old) · markets open");
  // A code priced in itself is no market data: nothing to cite.
  const identity = harness("EUR", {});
  await fx.execute(["EUR"], identity.context);
  expect(identity.output("text")[0]).toBe("1 EUR = 1 EUR  (EUR/EUR 1)");
  expect(JSON.parse(identity.output("json")[0]!).metadata).toBeUndefined();
});

test("the text line states both directions in figures that survive tiny and large rates", () => {
  expect(describeFxRate({ currency: "NGN", baseCurrency: "USD" }, 0.00075279095)).toBe("1 NGN = 0.000752791 USD  (USD/NGN 1328.39)");
  expect(formatFxRate(5.6220205e-7)).toBe("0.000000562202");
  expect(formatFxRate(1778719.948)).toBe("1778719.95");
  expect(formatFxRate(16.497)).toBe("16.497");
  expect(formatFxRate(1)).toBe("1");
});
