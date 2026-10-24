import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { CloudShortRate } from "../../api-client/types";
import { createDefaultConfig } from "../../types/config";
import { marketDataCliCommands } from "./market";
import { createTestCliContext } from "../../test-support/cli-context";
import { describeFxRate, formatFxRate } from "../fx-pair";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";

afterEach(() => setSystemTime());

const fx = marketDataCliCommands.find((command) => command.name === "fx")!;

type Leg = number | {
  rate: number; asOf: number; staleAt: number; delayMinutes?: number;
  intradayBar?: { start: number; minutes: number }; staleReason?: string;
};

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
        : { value: leg.rate, asOf: leg.asOf, delayMinutes: leg.delayMinutes, intradayBar: leg.intradayBar, staleReason: leg.staleReason,
          fetchedAt: Date.now(), staleAt: leg.staleAt, expiresAt: Infinity, source: "fx" };
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

test("a rate that is its pair's bar says which bar, and a stale one why it stands", async () => {
  // Fri 23 Oct 2026: BRLUSD=X printed nothing from 03:20 UTC while USD/BRL's five-minute bars ran on.
  setSystemTime(new Date("2026-10-23T06:53:00Z"));
  const now = Date.now();
  const bar = harness("USD", { BRL: {
    rate: 1 / 5.05139, asOf: Date.parse("2026-10-23T06:35:00Z"), staleAt: now + 3_600_000, delayMinutes: 15,
    intradayBar: { start: Date.parse("2026-10-23T06:30:00Z"), minutes: 5 },
  } });
  await fx.execute(["USD/BRL"], bar.context);
  const json = JSON.parse(bar.output("json")[0]!);
  expect(json.warnings).toEqual(["BRL/USD: 06:30–06:35 UTC bar close, quotes paused"]);
  expect(json.metadata.freshness).toMatchObject({ asOf: "2026-10-23T06:35:00.000Z", status: "delayed", delayMinutes: 15 });

  const reason = "no newer bar yet";
  const stale = harness("USD", { BRL: {
    rate: 1 / 5.0523, asOf: Date.parse("2026-10-23T03:20:00Z"), staleAt: now - 1, delayMinutes: 15, staleReason: reason,
  } });
  await fx.execute(["USD/BRL"], stale.context);
  expect(JSON.parse(stale.output("json")[0]!).warnings).toEqual([`BRL/USD: ${reason}`]);
  // A rate that is current says nothing of why it would stand.
  const current = harness("USD", { BRL: { rate: 1 / 5.0523, asOf: now - 60_000, staleAt: now + 60_000, staleReason: reason } });
  await fx.execute(["USD/BRL"], current.context);
  expect(JSON.parse(current.output("json")[0]!).warnings).toBeUndefined();
});

test("the text line states both directions in figures that survive tiny and large rates", () => {
  expect(describeFxRate({ currency: "NGN", baseCurrency: "USD" }, 0.00075279095)).toBe("1 NGN = 0.000752791 USD  (USD/NGN 1328.39)");
  expect(formatFxRate(5.6220205e-7)).toBe("0.000000562202");
  expect(formatFxRate(1778719.948)).toBe("1778719.95");
  expect(formatFxRate(16.497)).toBe("16.497");
  expect(formatFxRate(1)).toBe("1");
});

test("a currency typed as its name is asked for by its code and says so; a name several currencies share fails listing them, asking for nothing", async () => {
  const run = harness("USD", { JPY: 0.0063, MXN: 0.054 });
  await fx.execute(["yen"], run.context);
  expect(run.requests).toEqual(["JPY"]);
  expect(run.rows()).toEqual([[expect.objectContaining({ currency: "JPY", baseCurrency: "USD", pair: "JPY/USD" })]]);
  expect(run.output("json")[0]).toContain("Read yen as JPY.");

  const peso = harness("USD", { MXN: 0.054 });
  await expect(fx.execute(["peso"], peso.context)).rejects.toThrow("peso names several currencies: MXN (Mexican), ARS (Argentine), COP (Colombian), CLP (Chilean), PHP (Philippine)");
  expect(peso.requests).toEqual([]);
});

/** `fx --date` against daily closes by pair symbol; every history request is kept. */
function datedHarness(baseCurrency: string, closes: Record<string, Record<string, number>>) {
  const config = createDefaultConfig("/tmp/gloom-fx-command-fixture");
  config.baseCurrency = baseCurrency;
  const asked: string[] = [];
  const cli = createTestCliContext({
    config,
    dataProvider: { getCachedQuery: () => ({ load: async () => { throw new Error("--date reads no latest rate"); } }) },
    fxHistory: {
      getCloudHistory: async (symbol: string, _exchange: string, params: { startDate?: string; endDate?: string }) => {
        asked.push(symbol);
        const data = Object.entries(closes[symbol] ?? {})
          .filter(([day]) => (!params.startDate || day >= params.startDate) && (!params.endDate || day <= params.endDate))
          .map(([day, close]) => ({ date: `${day}T00:00:00.000Z`, close }));
        return { status: "success", data };
      },
    },
  });
  const output = (format: "text" | "json") => cli.printed.map(({ result, options }) => serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format }, options));
  return { context: cli.context, rows: () => cli.printed.map(({ result }) => result.data), printed: cli.printed, output, asked };
}

// USD/CAD as dealers quote it (CAD per USD), and EUR/USD (USD per EUR).
const CAD_CLOSES = { "CAD=X": { "2026-08-31": 1.38554, "2026-09-01": 1.3897, "2026-09-02": 1.3845, "2026-09-03": 1.3819, "2026-09-04": 1.38376 } };

// `fx USD/CAD --date 2026-09-02` answered "fx takes no options".
test("fx --date gives the rate at that day's daily closes, dated by the source line, and says when it read the trading day before", async () => {
  setSystemTime(new Date("2026-10-20T15:00:00Z"));
  const run = datedHarness("CAD", { ...CAD_CLOSES, "EURUSD=X": { "2026-09-01": 1.1593, "2026-09-02": 1.15884 } });
  await fx.execute(["USD/CAD", "--date", "2026-09-02"], run.context);
  expect(run.rows()[0]).toEqual([{ currency: "USD", baseCurrency: "CAD", rate: 1.3845, asOf: "2026-09-02", stale: false, pair: "USD/CAD",
    inverse: 1 / 1.3845, date: "2026-09-02" }]);
  expect(run.output("text")[0]).toBe("1 USD = 1.3845 CAD  (CAD/USD 0.722282)\n\nSource: Gloom Cloud · Wed 2 Sep 2026 · not a live feed (daily FX close)");
  expect(run.printed[0]!.result.warnings).toBeUndefined();

  // A Saturday has no close: Friday's, said so. A cross reads both pairs' closes of the day.
  await fx.execute(["USD/CAD", "--date", "2026-09-05"], run.context);
  expect(run.rows()[1]).toMatchObject([{ rate: 1.38376, asOf: "2026-09-04", date: "2026-09-05" }]);
  expect(run.printed[1]!.result.warnings).toEqual(["No daily close on 2026-09-05, a weekend or market holiday: this is the close of 2026-09-04, the trading day before it."]);
  await fx.execute(["1000", "EUR/CAD", "--date", "2026-09-02"], run.context);
  expect(run.rows()[2][0].rate).toBeCloseTo(1.15884 * 1.3845, 9);
  expect(run.rows()[2][0].converted).toBeCloseTo(1000 * 1.15884 * 1.3845, 6);
  expect(run.asked).toEqual(["CAD=X", "CAD=X", "EURUSD=X", "CAD=X"]);
});

test("fx --date refuses today and a day ahead, and a week with no close, before or instead of guessing", async () => {
  setSystemTime(new Date("2026-10-20T15:00:00Z"));
  const run = datedHarness("USD", CAD_CLOSES);
  await expect(fx.execute(["USD/CAD", "--date", "2026-10-20"], run.context)).rejects.toThrow("2026-10-20 has no daily close yet: --date takes a day before today (2026-10-20).");
  await expect(fx.execute(["USD/CAD", "--date", "2026-08-01"], run.context)).rejects.toThrow("No USD/CAD daily close in the week up to 2026-08-01.");
  await expect(fx.execute(["USD/CAD", "--date", "9/2/2026"], run.context)).rejects.toThrow(/Use a --date date as YYYY-MM-DD/);
  expect(run.rows()).toEqual([]);
});

function shortRates(overrides: Record<string, Partial<CloudShortRate>> = {}) {
  const base = (currency: string, name: string, value: number, asOf: string, publisher: string): CloudShortRate => ({
    currency, name, tenor: currency === "MXN" ? "28 days" : "overnight", tenorDays: currency === "MXN" ? 28 : 1, dayCountBasis: 360,
    publisher, sourceUrl: "https://example.com", value, asOf, fetchedAt: "2026-10-21T10:00:00.000Z", stale: false, unavailableReason: null,
    ...overrides[currency],
  });
  return {
    generatedAt: "2026-10-21T10:00:00.000Z",
    rates: [
      base("USD", "SOFR", 3.87, "2026-10-19", "Federal Reserve Bank of New York"),
      base("MXN", "TIIE 28d", 6.776, "2026-10-20", "Banco de México"),
    ],
  };
}

test("fx --forward implies the forward from both short rates, shows them with their dates and says it is no dealer quote", async () => {
  setSystemTime(new Date("2026-10-21T15:00:00Z"));
  const spy = spyOn(apiClient, "getCloudShortRates").mockImplementation(async () => shortRates());
  try {
    // USD/MXN 18.35: one MXN is 1/18.35 USD.
    const run = harness("USD", { MXN: 1 / 18.35 });
    await fx.execute(["USD/MXN", "--forward", "30d"], run.context);
    const [row] = run.rows()[0] as Record<string, unknown>[];
    expect(row).toMatchObject({ pair: "USD/MXN", tenor: "30d", days: 30, forwardDate: "2026-11-20", label: "implied by rates, not a dealer quote",
      baseRate: { currency: "USD", name: "SOFR", value: 3.87, asOf: "2026-10-19" }, quoteRate: { currency: "MXN", name: "TIIE 28d", value: 6.776, asOf: "2026-10-20" } });
    expect(row!.forward as number).toBeCloseTo(18.35 * (1 + 0.06776 * 30 / 360) / (1 + 0.0387 * 30 / 360), 9);
    const text = run.output("text")[0]!;
    expect(text).toContain("USD/MXN 30d forward 18.3943, implied by rates, not a dealer quote");
    expect(text).toContain("forward points +442.9 (pips of 0.0001)");
    expect(text).toContain("premium +0.2414% over 30 days to 2026-11-20, +2.90% a year");
    // In the pair's order, each with its day and publisher.
    expect(text).toContain("USD rate: SOFR 3.87% (Federal Reserve Bank of New York, 2026-10-19; ACT/360)\nMXN rate: TIIE 28d 6.776% (Banco de México, 2026-10-20; ACT/360)");

    // A rate that could not be read, or a currency with none, is named.
    spy.mockImplementation(async () => shortRates({ MXN: { value: null, asOf: null, unavailableReason: "Banxico did not answer" } }));
    await expect(fx.execute(["USD/MXN", "--forward", "30d"], harness("USD", { MXN: 1 / 18.35 }).context))
      .rejects.toThrow("No 30d forward for USD/MXN. TIIE 28d (MXN) could not be read: Banxico did not answer.");
    spy.mockImplementation(async () => shortRates());
    await expect(fx.execute(["USD/ZAR", "--forward", "1m"], harness("USD", { ZAR: 0.055 }).context))
      .rejects.toThrow("No 1m forward for USD/ZAR. No short rate for ZAR; forwards are implied for MXN, USD.");
    // A server without short rates says forwards are not there yet.
    spy.mockImplementation(async () => { throw new ApiRequestError("not found", 404); });
    await expect(fx.execute(["USD/MXN", "--forward", "30d"], harness("USD", { MXN: 1 / 18.35 }).context))
      .rejects.toThrow("Forwards are not available from Gloom Cloud yet");
    // A currency typed as its name says which code it was read as, as the spot answer does.
    spy.mockImplementation(async () => {
      const payload = shortRates();
      return { ...payload, rates: [...payload.rates, { ...payload.rates[0]!, currency: "EUR", name: "€STR", value: 2.441, publisher: "European Central Bank" }] };
    });
    const named = harness("USD", { EUR: 1.12 });
    await fx.execute(["euro/USD", "--forward", "3m"], named.context);
    expect(named.output("json")[0]).toContain("Read euro as EUR.");
    // A bad tenor or an amount is refused before anything is read.
    await expect(fx.execute(["USD/MXN", "--forward", "30"], harness("USD", {}).context)).rejects.toThrow("is not a tenor");
    await expect(fx.execute(["100", "USD/MXN", "--forward", "30d"], harness("USD", { MXN: 0.05 }).context)).rejects.toThrow("--forward prices a pair, not an amount.");
  } finally {
    spy.mockRestore();
  }
});

test("fx --forward with --date says the forward is today's only and how to get either, reading nothing", async () => {
  setSystemTime(new Date("2026-10-21T15:00:00Z"));
  const spy = spyOn(apiClient, "getCloudShortRates").mockImplementation(async () => shortRates());
  try {
    const run = datedHarness("USD", CAD_CLOSES);
    // The failure's second line says what to run instead.
    const context = { ...run.context, fail: (message: string, details?: unknown): never => { throw new Error(`${message}\n${String(details)}`); } };
    for (const args of [["USD/MXN", "--forward", "30d", "--date", "2026-09-02"], ["USD/MXN", "--date", "2026-09-02", "--forward", "30d"]]) {
      await expect(fx.execute(args, context)).rejects.toThrow(
        "fx --forward does not take --date: the forward is implied from today's spot and the latest short rates, and past short rates are not served.\n"
        + "For that day's close: gloom fx USD/MXN --date 2026-09-02. For today's forward, drop --date.");
    }
    expect(spy).not.toHaveBeenCalled();
    expect(run.asked).toEqual([]);
    expect(run.rows()).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
