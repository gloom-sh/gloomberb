import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { CloudShortRate } from "../../api-client/types";
import { createDefaultConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import { marketDataCliCommands } from "./market";
import { createTestCliContext } from "../../test-support/cli-context";
import { describeFxRate, formatFxRate } from "../fx-pair";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";

afterEach(() => setSystemTime());

const fx = marketDataCliCommands.find((command) => command.name === "fx")!;

/** A pair's quote as Gloom Cloud serves it: a price, when it printed, delayed 15 minutes unless said otherwise. */
type PairQuote = number | {
  price: number; minutesAgo?: number; lastUpdated?: number; dataSource?: "live" | "delayed"; stale?: boolean;
  intradayBar?: { start: number; minutes: number }; staleReason?: string; currency?: string;
};

function pairQuote(symbol: string, given: PairQuote): Quote {
  const fields = typeof given === "number" ? { price: given } : given;
  const lastUpdated = fields.lastUpdated ?? Date.now() - (fields.minutesAgo ?? 1) * 60_000;
  const { minutesAgo: _minutes, ...rest } = fields;
  return {
    symbol, name: symbol, currency: symbol.slice(3, 6), change: 0, changePercent: 0, exchangeName: "CCY", instrumentType: "CURRENCY",
    providerId: "gloomberb-cloud", dataSource: "delayed", ...rest, lastUpdated,
  } as Quote;
}

/** `fx` over the quotes `quote` reads, by listing; every batch asked for is kept, and whether it forced a refresh. */
function harness(baseCurrency: string, quotes: Record<string, PairQuote | string>, cliOptions: { refresh?: boolean } = {}) {
  const config = createDefaultConfig("/tmp/gloom-fx-command-fixture");
  config.baseCurrency = baseCurrency;
  const batches: string[][] = [];
  const forced: boolean[] = [];
  const cli = createTestCliContext({
    config,
    dataProvider: {
      getCachedQuery: () => ({ load: async () => { throw new Error("fx reads quotes, not exchange rates"); } }),
      getQuotesBatch: async (targets: { symbol: string; exchange: string }[], options?: { forceRefresh?: boolean }) => {
        batches.push(targets.map((target) => target.symbol));
        forced.push(options?.forceRefresh === true);
        return targets.map((target) => {
          const given = quotes[target.symbol];
          // A string is the reason the service gave for having no quote.
          if (given == null || typeof given === "string") return { target, quote: null, error: given ?? `Not a ticker: ${target.symbol}.` };
          return { target, quote: pairQuote(target.symbol, given) };
        });
      },
    },
  }, cliOptions);
  /** What a text and a JSON run print, closing line included. */
  const output = (format: "text" | "json" | "csv") => cli.printed.map(({ result, options }) => serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format }, options));
  return { context: cli.context, rows: () => cli.printed.map(({ result }) => result.data), output, batches, forced, closed: cli.closeCount };
}

// `fx USD/SGD` read 1.27654 at 03:31 "15 min delayed" while `quote USDSGD=X` read 1.27626 at 03:47.
test("fx reads the pair's own quote, the one `quote` reads, dated by it and stale once older than the feed's delay", async () => {
  setSystemTime(new Date("2026-11-05T04:03:00Z"));
  const run = harness("USD", { "USDSGD=X": { price: 1.27626, lastUpdated: Date.parse("2026-11-05T03:47:00Z") } });
  await fx.execute(["USD/SGD"], run.context);
  expect(run.batches).toEqual([["USDSGD=X"]]);
  expect(run.rows()[0]).toMatchObject([{ currency: "USD", baseCurrency: "SGD", rate: 1.27626, asOf: "2026-11-05T03:47:00.000Z", stale: false, quotes: ["USDSGD=X"] }]);
  expect(run.output("text")[0]).toBe("1 USD = 1.27626 SGD  (SGD/USD 0.783539)\n\nSource: Gloom Cloud · Thu 5 Nov 2026 03:47 UTC · 15 min delayed · markets open");
  // Once the service marks the print stale, as `quote` then shows it, so does fx, never "15 min delayed".
  setSystemTime(new Date("2026-11-05T04:15:00Z"));
  const later = harness("USD", { "USDSGD=X": { price: 1.27626, lastUpdated: Date.parse("2026-11-05T03:47:00Z"), stale: true } });
  await fx.execute(["USD/SGD"], later.context);
  expect(later.rows()[0]).toMatchObject([{ stale: true }]);
  expect(later.output("text")[0]).toEndWith("Source: Gloom Cloud · Thu 5 Nov 2026 03:47 UTC · stale (28 min old) · markets open");
  // Unflagged, a weekday quote two hours old is stale all the same: past the feed's delay and fifteen minutes,
  // counted while the FX market trades (Friday's close stays current over the weekend, below).
  setSystemTime(new Date("2026-11-05T05:47:00Z"));
  const aged = harness("USD", { "USDSGD=X": { price: 1.27626, lastUpdated: Date.parse("2026-11-05T03:47:00Z") } });
  await fx.execute(["USD/SGD"], aged.context);
  expect(aged.rows()[0]).toMatchObject([{ stale: true }]);
  expect(aged.output("text")[0]).toEndWith("Source: Gloom Cloud · Thu 5 Nov 2026 03:47 UTC · stale (2 hours old) · markets open");
  // The inverse reads the same quote.
  const inverse = harness("USD", { "USDSGD=X": 1.27626 });
  await fx.execute(["SGD/USD"], inverse.context);
  expect(inverse.batches).toEqual([["USDSGD=X"]]);
  expect(inverse.rows()[0][0].rate).toBeCloseTo(1 / 1.27626, 12);
  expect(inverse.output("text")[0]).toStartWith("1 SGD = 0.783539 USD  (USD/SGD 1.27626)");
});

// `fx EUR/JPY` was always EUR/USD x USD/JPY and never said so.
test("a cross reads its own quote when it has one and crosses the dollar pairs only otherwise, saying so", async () => {
  setSystemTime(new Date("2026-11-05T04:03:00Z"));
  const quotes = { "EURJPY=X": 177.861, "EURUSD=X": 1.12625, "USDJPY=X": 157.973 };
  const own = harness("USD", quotes);
  await fx.execute(["EUR/JPY"], own.context);
  expect(own.batches).toEqual([["EURJPY=X", "EURUSD=X", "USDJPY=X"]]);
  expect(own.rows()[0]).toMatchObject([{ rate: 177.861, quotes: ["EURJPY=X"] }]);
  expect(own.rows()[0][0].via).toBeUndefined();
  expect(own.output("text")[0]).toStartWith("1 EUR = 177.861 JPY  (JPY/EUR 0.00562237)\n");
  // A pair with no quote of its own is the cross of its dollar pairs, named as sent, and says via USD.
  const crossed = harness("USD", { "EURUSD=X": 1.12625, "USDJPY=X": 157.973 });
  await fx.execute(["EUR/JPY"], crossed.context);
  expect(crossed.rows()[0]).toMatchObject([{ via: "USD", quotes: ["EURUSD=X", "USDJPY=X"] }]);
  expect(crossed.rows()[0][0].rate).toBe(1.12625 * 157.973);
  expect(crossed.output("text")[0]).toStartWith("1 EUR = 177.917 JPY  (JPY/EUR 0.0056206)  ·  via USD: EUR/USD 1.12625, USD/JPY 157.973\n");
  // A stale own quote gives way to current dollar pairs; the cross is as old as its older pair.
  const staleOwn = harness("USD", { ...quotes, "EURJPY=X": { price: 177.861, stale: true }, "USDJPY=X": { price: 157.973, minutesAgo: 4 } });
  await fx.execute(["EUR/JPY"], staleOwn.context);
  expect(staleOwn.rows()[0]).toMatchObject([{ rate: 1.12625 * 157.973, via: "USD", asOf: "2026-11-05T03:59:00.000Z" }]);
  // Neither is quoted: the currencies with no dollar pair are named, and the service's reason when it gave one.
  await expect(fx.execute(["GBP/EUR"], harness("USD", { "GBPUSD=X": 1.35 }).context)).rejects.toThrow("Exchange rate unavailable for EUR.");
  await expect(fx.execute(["USD/XYZ"], harness("USD", {}).context)).rejects.toThrow("Exchange rate unavailable for XYZ.");
  await expect(fx.execute(["XAU"], harness("USD", { "XAUUSD=X": "Spot gold is not quoted; GC=F is the front-month future." }).context))
    .rejects.toThrow("Spot gold is not quoted; GC=F is the front-month future.");
});

test("gold with no spot quote is priced from its front-month future and the dollar pair, and says it is derived", async () => {
  const noSpot = "Spot gold is not quoted; GC=F is the front-month future.";
  const quotes = { "XAUUSD=X": noSpot, "XAUTRY=X": noSpot, "GC=F": { price: 4070.1, currency: "USD" }, "USDTRY=X": 50.1511 };
  const lira = harness("USD", quotes);
  await fx.execute(["XAU/TRY"], lira.context);
  expect(lira.rows()[0]).toMatchObject([{ pair: "XAU/TRY", via: "USD", derived: true, derivedFrom: "GC=F", quotes: ["GC=F", "USDTRY=X"] }]);
  expect(lira.rows()[0][0].rate).toBeCloseTo(4070.1 * 50.1511, 6);
  expect(lira.output("text")[0]).toContain("via USD: XAU/USD 4070.10, USD/TRY 50.1511  ·  derived: gold from GC=F, the front-month future (spot gold is not quoted)");
  // In dollars it is the future itself; with no future either, the service's reason still stands.
  const dollars = harness("USD", quotes);
  await fx.execute(["XAU/USD"], dollars.context);
  expect(dollars.rows()[0]).toMatchObject([{ rate: 4070.1, derivedFrom: "GC=F" }]);
  await expect(fx.execute(["XAU/TRY"], harness("USD", { "XAUUSD=X": noSpot, "USDTRY=X": 50.1511 }).context)).rejects.toThrow(noSpot);
});

test("a currency priced in itself reads nothing and cites nothing", async () => {
  const identity = harness("EUR", {});
  await fx.execute(["EUR"], identity.context);
  expect(identity.rows()).toEqual([[{ currency: "EUR", baseCurrency: "EUR", rate: 1, asOf: null, stale: false, pair: "EUR/EUR", inverse: 1 }]]);
  expect(identity.batches).toEqual([]);
  expect(identity.output("text")[0]).toBe("1 EUR = 1 EUR  (EUR/EUR 1)");
  expect(JSON.parse(identity.output("json")[0]!).metadata).toBeUndefined();
});

test("an FX export names the pair and the currency the rate is in, which is the base, not the currency asked for", async () => {
  setSystemTime(new Date("2026-10-13T06:20:00Z"));
  const run = harness("USD", { "USDZAR=X": { price: 16.514, lastUpdated: Date.parse("2026-10-13T06:18:00Z") } });
  await fx.execute(["ZAR"], run.context);
  expect(run.output("csv")[0]!.split("\n").slice(0, 2)).toEqual([
    "Currency,Base,Rate,As Of,Stale,Pair,Inverse,symbol_or_series,currency_or_unit,interval,source,as_of",
    `ZAR,USD,${1 / 16.514},2026-10-13T06:18:00.000Z,false,ZAR/USD,16.514,ZAR/USD,USD per ZAR,spot,Gloom Cloud,2026-10-13T06:18:00.000Z`,
  ]);
});

// `fx 2500000.50 EUR/USD` printed 2,815,633.06 USD beside `1 EUR = 1.12625 USD`, which gives 2,815,625.56; rounding
// the rate instead converted IDR/JPY 0.009612 at 0.010, 4% off.
test("an amount converts at the quote as sent, never a rounded rate, and the line prints each figure it used", async () => {
  setSystemTime(new Date("2026-11-05T04:03:00Z"));
  const run = harness("USD", { "EURUSD=X": 1.1262531, "USDJPY=X": 157.8481 });
  await fx.execute(["2500000.50", "EUR/USD"], run.context);
  expect(run.output("text")[0]).toStartWith("2,500,000.50 EUR = 2,815,633.31 USD\n1 EUR = 1.1262531 USD  (USD/EUR 0.8879)\n");
  expect(run.rows()[0]).toMatchObject([{ rate: 1.1262531, inverse: 1 / 1.1262531, amount: 2500000.5, converted: 2500000.5 * 1.1262531 }]);
  // Converted against the quote's direction, the amount is divided by the pair's quote.
  await fx.execute(["1000000", "JPY/USD"], run.context);
  expect(run.output("text")[1]).toStartWith("1,000,000 JPY = 6,335.20 USD\n1 JPY = 0.0063352 USD  (USD/JPY 157.8481)\n");
  expect(run.rows()[1][0].converted).toBeCloseTo(1_000_000 / 157.8481, 9);

  // The yen below 1 keeps its significant digits, a cross converts at both dollar pairs as sent, and a figure
  // sent as a single-precision float is the decimal it was (EUR/JPY 177.861, not 177.86099243164062).
  const yen = harness("USD", { "USDIDR=X": 16250.5, "USDKRW=X": 1473.6, "USDJPY=X": 157.848, "EURJPY=X": Math.fround(177.861) });
  await fx.execute(["1000000", "IDR/JPY"], yen.context);
  expect(yen.output("text")[0]).toStartWith(
    "1,000,000.00 IDR = 9,713 JPY\n1 IDR = 0.0097134 JPY  (JPY/IDR 102.95)  ·  via USD: USD/IDR 16250.50, USD/JPY 157.848\n");
  expect(yen.rows()[0][0].converted).toBeCloseTo(1_000_000 * 157.848 / 16250.5, 6);
  await fx.execute(["KRW/JPY"], yen.context);
  expect(yen.output("text")[1]).toStartWith("1 KRW = 0.10712 JPY  (JPY/KRW 9.33556)  ·  via USD: USD/KRW 1473.60, USD/JPY 157.848\n");
  expect(yen.rows()[1][0].rate).toBe((1 / 1473.6) / (1 / 157.848));
  await fx.execute(["100", "USD/IDR"], yen.context);
  expect(yen.output("text")[2]).toStartWith("100.00 USD = 1,625,050.00 IDR\n1 USD = 16250.50 IDR  (IDR/USD 0.0000615366)\n");
  await fx.execute(["EUR/JPY"], yen.context);
  expect(yen.output("text")[3]).toStartWith("1 EUR = 177.861 JPY  (JPY/EUR 0.00562237)\n");
  expect(yen.rows()[3][0].rate).toBe(177.861);
});

// `fx gbp-chf` asked for three letters; `fx eurusd` said to write EUR/USD.
test("fx takes the pair spellings quote takes, and an amount before one converts into its quote currency", async () => {
  const quotes = { "GBPCHF=X": 1.0982, "EURUSD=X": 1.12625, "USDJPY=X": 157.848 };
  for (const [typed, pair] of [["gbp-chf", "GBP/CHF"], ["eurusd", "EUR/USD"], ["EURUSD=X", "EUR/USD"], ["JPY=X", "USD/JPY"], ["eur/usd", "EUR/USD"]] as const) {
    const run = harness("USD", quotes);
    await fx.execute([typed], run.context);
    expect(run.rows()[0], typed).toMatchObject([{ pair }]);
  }
  const amount = harness("USD", quotes);
  await fx.execute(["100", "GBPCHF"], amount.context);
  expect(amount.rows()[0]).toMatchObject([{ pair: "GBP/CHF", amount: 100 }]);
  expect(JSON.parse(amount.output("json")[0]!).warnings).toBeUndefined();
  // A bare code still converts to USD and says so.
  const bare = harness("USD", { "GBPUSD=X": 1.35 });
  await fx.execute(["100", "GBP"], bare.context);
  expect(JSON.parse(bare.output("json")[0]!).warnings).toEqual(["No target currency given, so GBP is converted to USD; for another, write fx 100 GBP/<to>."]);
  for (const bad of ["US/NGN", "USD/NGN/EUR", "USD/", "USDUSD"]) {
    await expect(fx.execute([bad], harness("USD", quotes).context)).rejects.toThrow(/not a currency/);
  }
});

test("a pair ends with the source line a quote does, held back as its quote is", async () => {
  // Saturday: the FX week is shut, so the pair's print in the week's last minute reads as Friday's close.
  setSystemTime(new Date("2026-10-10T18:45:00Z"));
  const weekend = harness("USD", { "USDSAR=X": { price: 3.75516, lastUpdated: Date.parse("2026-10-09T20:59:00Z") } });
  await fx.execute(["USD/SAR"], weekend.context);
  // Shut, it says when the FX week reopens, as a future's line does.
  expect(weekend.output("text")[0]).toBe("1 USD = 3.75516 SAR  (SAR/USD 0.2663)\n\nSource: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed · reopens Sun 21:00 UTC, 17:00 ET");
  // A real-time account's quote is live.
  setSystemTime(new Date("2026-10-14T14:00:00Z"));
  const live = harness("EUR", { "EURGBP=X": { price: 0.8, minutesAgo: 1, dataSource: "live" } });
  await fx.execute(["GBP"], live.context);
  expect(live.output("text")[0]).toEndWith("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · live · markets open");
});

test("a rate that is its pair's bar says which bar, and a stale one why it stands; --refresh says when it found nothing newer", async () => {
  // Fri 23 Oct 2026: USD/BRL's print stopped at 03:20 UTC while its five-minute bars ran on.
  setSystemTime(new Date("2026-10-23T06:53:00Z"));
  const bar = harness("USD", { "USDBRL=X": {
    price: 5.05139, lastUpdated: Date.parse("2026-10-23T06:35:00Z"), intradayBar: { start: Date.parse("2026-10-23T06:30:00Z"), minutes: 5 },
  } });
  await fx.execute(["USD/BRL"], bar.context);
  expect(JSON.parse(bar.output("json")[0]!).warnings).toEqual(["USDBRL=X: 06:30–06:35 UTC bar close, quotes paused"]);
  const reason = "no newer bar yet";
  const stale = harness("USD", { "USDBRL=X": { price: 5.0523, lastUpdated: Date.parse("2026-10-23T03:20:00Z"), stale: true, staleReason: reason } }, { refresh: true });
  await fx.execute(["USD/BRL"], stale.context);
  expect(JSON.parse(stale.output("json")[0]!).warnings).toEqual([`USDBRL=X: ${reason}`]);
  expect(stale.forced).toEqual([true]);
  const refreshed = harness("USD", { "USDZAR=X": { price: 17.4, lastUpdated: Date.parse("2026-10-23T05:00:00Z"), stale: true } }, { refresh: true });
  await fx.execute(["ZAR"], refreshed.context);
  expect(JSON.parse(refreshed.output("json")[0]!).warnings).toEqual(["USDZAR=X: --refresh found no newer quote than Fri 23 Oct 05:00 UTC."]);
  // Without --refresh, nothing claims a refresh ran.
  const cached = harness("USD", { "USDZAR=X": { price: 17.4, lastUpdated: Date.parse("2026-10-23T05:00:00Z") } });
  await fx.execute(["ZAR"], cached.context);
  expect(cached.forced).toEqual([false]);
  expect(cached.output("json")[0]).not.toContain("--refresh");
});

test("the text line states both directions in figures that survive tiny and large rates", () => {
  expect(describeFxRate({ currency: "NGN", baseCurrency: "USD" }, 0.00075279095)).toBe("1 NGN = 0.000752791 USD  (USD/NGN 1328.39)");
  expect(formatFxRate(5.6220205e-7)).toBe("0.000000562202");
  expect(formatFxRate(1778719.948)).toBe("1778719.95");
  expect(formatFxRate(16.497)).toBe("16.497");
  expect(formatFxRate(1)).toBe("1");
});

test("a currency typed as its name is asked for by its code and says so; a name several currencies share fails listing them, asking for nothing", async () => {
  const run = harness("USD", { "USDJPY=X": 158.7, "USDMXN=X": 18.5 });
  await fx.execute(["yen"], run.context);
  expect(run.batches).toEqual([["USDJPY=X"]]);
  expect(run.rows()).toEqual([[expect.objectContaining({ currency: "JPY", baseCurrency: "USD", pair: "JPY/USD" })]]);
  expect(run.output("json")[0]).toContain("Read yen as JPY.");

  const peso = harness("USD", { "USDMXN=X": 18.5 });
  await expect(fx.execute(["peso"], peso.context)).rejects.toThrow("peso names several currencies: MXN (Mexican), ARS (Argentine), COP (Colombian), CLP (Chilean), PHP (Philippine)");
  expect(peso.batches).toEqual([]);
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
  expect(run.output("text")[0]).toBe("1 USD = 1.38450 CAD  (CAD/USD 0.722282)\n\nSource: Gloom Cloud · Wed 2 Sep 2026 · not a live feed (daily FX close)");
  expect(run.printed[0]!.result.warnings).toBeUndefined();

  // A Saturday has no close: Friday's, said so. A cross reads both pairs' closes of the day.
  await fx.execute(["USD/CAD", "--date", "2026-09-05"], run.context);
  expect(run.rows()[1]).toMatchObject([{ rate: 1.38376, asOf: "2026-09-04", date: "2026-09-05" }]);
  expect(run.printed[1]!.result.warnings).toEqual(["No daily close on 2026-09-05, a weekend or market holiday: this is the close of 2026-09-04, the trading day before it."]);
  await fx.execute(["1000", "EUR/CAD", "--date", "2026-09-02"], run.context);
  // The cross converts at both closes as sent, which its line names.
  expect(run.rows()[2][0].rate).toBeCloseTo(1.15884 * 1.3845, 12);
  expect(run.rows()[2][0].converted).toBeCloseTo(1000 * 1.15884 * 1.3845, 9);
  expect(run.output("text")[2]).toStartWith("1,000.00 EUR = 1,604.41 CAD\n1 EUR = 1.60441 CAD  (CAD/EUR 0.623281)  ·  via USD: EUR/USD 1.15884, USD/CAD 1.38450\n");
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
    const run = harness("USD", { "USDMXN=X": 18.35 });
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
    await expect(fx.execute(["USD/MXN", "--forward", "30d"], harness("USD", { "USDMXN=X": 18.35 }).context))
      .rejects.toThrow("No 30d forward for USD/MXN. TIIE 28d (MXN) could not be read: Banxico did not answer.");
    spy.mockImplementation(async () => shortRates());
    await expect(fx.execute(["USD/ZAR", "--forward", "1m"], harness("USD", { "USDZAR=X": 18.2 }).context))
      .rejects.toThrow("No 1m forward for USD/ZAR. No short rate for ZAR; forwards are implied for MXN, USD.");
    // A server without short rates says forwards are not there yet.
    spy.mockImplementation(async () => { throw new ApiRequestError("not found", 404); });
    await expect(fx.execute(["USD/MXN", "--forward", "30d"], harness("USD", { "USDMXN=X": 18.35 }).context))
      .rejects.toThrow("Forwards are not available from Gloom Cloud yet");
    // A currency typed as its name says which code it was read as, as the spot answer does.
    spy.mockImplementation(async () => {
      const payload = shortRates();
      return { ...payload, rates: [...payload.rates, { ...payload.rates[0]!, currency: "EUR", name: "€STR", value: 2.441, publisher: "European Central Bank" }] };
    });
    const named = harness("USD", { "EURUSD=X": 1.12 });
    await fx.execute(["euro/USD", "--forward", "3m"], named.context);
    expect(named.output("json")[0]).toContain("Read euro as EUR.");
    // A bad tenor or an amount is refused before anything is read.
    await expect(fx.execute(["USD/MXN", "--forward", "30"], harness("USD", {}).context)).rejects.toThrow("is not a tenor");
    await expect(fx.execute(["100", "USD/MXN", "--forward", "30d"], harness("USD", { "USDMXN=X": 20 }).context)).rejects.toThrow("--forward prices a pair, not an amount.");
  } finally {
    spy.mockRestore();
  }
});

test("fx --forward through SGD says what MAS's licence asks of SORA, and that a rate MAS has not answered for is a kept copy", async () => {
  setSystemTime(new Date("2026-11-06T03:00:00Z"));
  const attribution = { text: "Contains information from MAS's Domestic Interest Rates, made available under the Singapore Open Data Licence version 1.0",
    licenceUrl: "https://www.mas.gov.sg/terms-of-use" };
  const spy = spyOn(apiClient, "getCloudShortRates").mockImplementation(async () => {
    const payload = shortRates();
    return { ...payload, rates: [...payload.rates, { ...payload.rates[0]!, currency: "SGD", name: "SORA", value: 1.2081, asOf: "2026-11-04",
      dayCountBasis: 365 as const, publisher: "Monetary Authority of Singapore", stale: true, attribution }] };
  });
  try {
    const run = harness("USD", { "USDSGD=X": 1.3 });
    await fx.execute(["USD/SGD", "--forward", "3m"], run.context);
    const [row] = run.rows()[0] as Record<string, unknown>[];
    expect(row).toMatchObject({ quoteRate: { currency: "SGD", name: "SORA", stale: true, attribution } });
    const text = run.output("text")[0]!;
    expect(text).toContain("SGD rate: SORA 1.2081% (Monetary Authority of Singapore, 2026-11-04; ACT/365)");
    expect(text).toContain("SORA: Contains information from MAS's Domestic Interest Rates, made available under the Singapore Open Data Licence version 1.0 (https://www.mas.gov.sg/terms-of-use).");
    expect(run.output("json")[0]).toContain("SORA (SGD) is the last copy read, dated 2026-11-04; its source could not be read since.");
    // A rate whose publisher asks for none says nothing of a licence.
    const other = harness("USD", { "USDMXN=X": 18.35 });
    await fx.execute(["USD/MXN", "--forward", "30d"], other.context);
    expect(other.output("text")[0]).not.toContain("Licence");
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
