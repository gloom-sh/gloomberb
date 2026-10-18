import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test, type Mock } from "bun:test";
import type { OptionContract, OptionsChain } from "../../types/financials";
import { apiClient } from "../../api-client";
import { createTestCliContext } from "../../test-support/cli-context";
import { daysToExpiryFrom, valueOption } from "../../plugins/builtin/shared/volatility";
import { marketDataCliCommands } from "./market";
import { DEFAULT_LEAPS_CRITERIA, parseLeapsCriteria, sortLeapsRows, type LeapsRow } from "./options-leaps";

const options = marketDataCliCommands.find((command) => command.name === "options")!;

const NOW = Date.parse("2026-10-09T20:00:00Z");
const SPOT = 100;
const NEAR = Date.UTC(2026, 11, 18) / 1000;
const LEAPS = Date.UTC(2028, 0, 21) / 1000;

/** A contract priced at 30% vol around its model value, with a 1% wide quote unless told otherwise. */
function contract(
  side: "call" | "put",
  strike: number,
  expiration: number,
  overrides: Partial<OptionContract> = {},
): OptionContract {
  const { price } = valueOption({
    side, spot: SPOT, strike, daysToExpiry: daysToExpiryFrom(expiration, NOW), rate: 0.04, volatility: 0.3, dividendYield: 0,
  });
  return {
    contractSymbol: `X${expiration}${side[0]}${strike}`, strike, currency: "USD", lastPrice: price, change: 0, percentChange: 0,
    bid: Number((price * 0.995).toFixed(2)), ask: Number((price * 1.005).toFixed(2)), openInterest: 500, volume: 10,
    impliedVolatility: 0, inTheMoney: side === "call" ? strike < SPOT : strike > SPOT, expiration, lastTradeDate: 0,
    ...overrides,
  };
}

const STRIKES = [60, 70, 80, 90, 100, 110, 120, 130, 140];

function chainFor(expiration: number, calls: OptionContract[], expirationDates = [NEAR, LEAPS]): OptionsChain {
  return {
    underlyingSymbol: "X", expirationDates, calls,
    puts: STRIKES.map((strike) => contract("put", strike, expiration)),
    asOf: "2026-10-09T19:59:00Z", dataSource: "delayed", delayMinutes: 15,
  };
}

function leapsProvider(chains: Record<string, (expiration: number | undefined) => OptionsChain>) {
  const requests: Array<[string, number | undefined]> = [];
  const dataProvider = {
    getOptionsChain: async (symbol: string, _exchange: string, expiration?: number) => {
      requests.push([symbol, expiration]);
      const chain = chains[symbol];
      if (!chain) throw new Error(`No options provider available for ${symbol}`);
      return chain(expiration);
    },
    getQuote: async (symbol: string) => ({ symbol, price: SPOT, currency: "USD", stale: false }),
    getTickerFinancials: async () => ({ fundamentals: { dividendYield: 0 } }),
  };
  return { requests, dataProvider };
}

// IV rank is read from Cloud IV history; no test reaches the network for it.
let ivHistory: Mock<typeof apiClient.impliedVolatility>;
beforeEach(() => {
  setSystemTime(new Date(NOW));
  ivHistory = spyOn(apiClient, "impliedVolatility").mockRejectedValue(new Error("Gloom Cloud did not answer"));
});
afterEach(() => {
  setSystemTime();
  ivHistory.mockRestore();
});

describe("options --leaps", () => {
  test("ranks contracts more than a year out by carry, keeping only liquid ones in the delta band", async () => {
    // Strikes 80 to 110 sit in a 0.50-0.90 band. Each symbol spoils two of them for the LEAPS expiry only.
    const calls = (expiration: number, spoiled: Record<number, Partial<OptionContract>>) => STRIKES.map((strike) => (
      contract("call", strike, expiration, expiration === LEAPS ? spoiled[strike] : undefined)
    ));
    const { dataProvider, requests } = leapsProvider({
      // A zero bid and a quote with no ask.
      AAA: (expiration) => chainFor(expiration ?? NEAR, calls(expiration ?? NEAR, { 80: { bid: 0 }, 100: { ask: 0 } })),
      // A quote 20% wide and open interest under the default 100.
      BBB: (expiration) => chainFor(expiration ?? NEAR, calls(expiration ?? NEAR, { 90: { bid: 10 }, 100: { openInterest: 20 } })),
    });
    const cli = createTestCliContext({ dataProvider });
    await options.execute(["AAA", "BBB", "--leaps", "--delta", "0.5-0.9"], cli.context);

    // The catalogue, then only the expiry more than a year out; never the near one.
    expect(requests.filter(([, expiration]) => expiration === NEAR)).toEqual([]);
    expect(requests.filter(([, expiration]) => expiration === LEAPS)).toHaveLength(2);
    const rows = cli.printed[0]!.result.data as LeapsRow[];
    expect(rows.every((row) => row.expiration === "2028-01-21" && row.days > 365)).toBe(true);
    expect(rows.every((row) => row.delta >= 0.5 - 5e-4 && row.delta <= 0.9 + 5e-4)).toBe(true);
    expect(rows.map((row) => `${row.symbol} ${row.strike}`).sort()).toEqual(["AAA 110", "AAA 90", "BBB 110", "BBB 80"]);
    // Lowest extrinsic per year first; every row says what it rests on.
    const carry = rows.map((row) => row.extrinsicPerYearPercent);
    expect(carry).toEqual([...carry].sort((left, right) => left - right));
    expect(rows[0]).toMatchObject({ side: "call", spot: SPOT, asOf: "2026-10-09T19:59:00Z", dataSource: "delayed", delayMinutes: 15 });
    expect(rows[0]!.spreadPercent).toBeLessThanOrEqual(DEFAULT_LEAPS_CRITERIA.maxSpreadPercent);
  });

  test("names a symbol without a chain or without LEAPS and still ranks the rest", async () => {
    const { dataProvider } = leapsProvider({
      AAA: (expiration) => chainFor(expiration ?? NEAR, STRIKES.map((strike) => contract("call", strike, expiration ?? NEAR))),
      SHORT: () => ({ ...chainFor(NEAR, []), expirationDates: [NEAR] }),
    });
    const cli = createTestCliContext({ dataProvider });
    await options.execute(["AAA", "SHORT", "NONE", "--leaps"], cli.context);
    const printed = cli.printed[0]!.result;
    expect((printed.data as LeapsRow[]).length).toBeGreaterThan(0);
    expect(printed.warnings).toEqual([
      "SHORT: no expiry more than a year out (last 2026-12-18)",
      "NONE: options chain unavailable (No options provider available for NONE)",
    ]);
    expect((printed.metadata!.symbols as Array<{ symbol: string; error?: string }>).map((entry) => [entry.symbol, !!entry.error]))
      .toEqual([["AAA", false], ["SHORT", true], ["NONE", true]]);

    // When no chain loads at all there is nothing to rank.
    await expect(options.execute(["NONE", "--leaps"], createTestCliContext({ dataProvider }).context))
      .rejects.toThrow("NONE: options chain unavailable");
  });

  test("its options need --leaps", async () => {
    const { dataProvider } = leapsProvider({});
    await expect(options.execute(["AAPL", "--side", "puts"], createTestCliContext({ dataProvider }).context))
      .rejects.toThrow("--side only applies with --leaps.");
    await expect(options.execute(["AAPL", "--max-days", "730"], createTestCliContext({ dataProvider }).context))
      .rejects.toThrow("--max-days only applies with --leaps.");
    await expect(options.execute(["AAPL", "--leaps", "--sort", "cheapest"], createTestCliContext({ dataProvider }).context))
      .rejects.toThrow('Invalid --sort "cheapest"');
  });

  test("reads only the expiries inside the window, by days or by date, and names those past the cap", async () => {
    const at = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / 1000;
    // 69, 251, 469 and 832 days out.
    const listed = [NEAR, at(2027, 6, 17), LEAPS, at(2029, 1, 19)];
    const read = async (args: string[], expirations = listed) => {
      const { dataProvider, requests } = leapsProvider({
        AAA: (expiration) => chainFor(expiration ?? NEAR, STRIKES.map((strike) => contract("call", strike, expiration ?? NEAR)), expirations),
      });
      const cli = createTestCliContext({ dataProvider });
      await options.execute(["AAA", "--leaps", "--delta", "0.5-0.9", ...args], cli.context);
      const result = cli.printed[0]!.result;
      return {
        read: requests.flatMap(([, expiration]) => expiration == null ? [] : [new Date(expiration * 1000).toISOString().slice(0, 10)]).sort(),
        rows: result.data as LeapsRow[],
        warnings: result.warnings ?? [],
      };
    };
    // A year out by default; a lower bound replaces that floor, and every bound given applies.
    expect((await read([])).read).toEqual(["2028-01-21", "2029-01-19"]);
    expect((await read(["--min-days", "180", "--max-days", "500"])).read).toEqual(["2027-06-17", "2028-01-21"]);
    expect((await read(["--expiry-from", "2027-06-01", "--expiry-to", "2028-06-30"])).read).toEqual(["2027-06-17", "2028-01-21"]);
    expect((await read(["--max-days", "800"])).read).toEqual(["2028-01-21"]);
    const one = await read(["--expiration", "2028-01-21"]);
    expect(one.read).toEqual(["2028-01-21"]);
    expect(one.rows.length).toBeGreaterThan(0);
    expect(one.rows.every((row) => row.expiration === "2028-01-21")).toBe(true);

    // Eleven monthly expiries in the window: the 8 nearest its start are read, and the rest are named.
    const monthly = Array.from({ length: 11 }, (_, index) => at(2027 + Math.floor((10 + index) / 12), ((10 + index) % 12) + 1, 19));
    const capped = await read([], [NEAR, ...monthly]);
    expect(capped.read).toEqual(monthly.slice(0, 8).map((expiration) => new Date(expiration * 1000).toISOString().slice(0, 10)));
    expect(capped.warnings).toEqual([
      "AAA: read the 8 expiries nearest the window's start, through 2028-06-19; 3 later not read (2028-07-19, 2028-08-19, 2028-09-19). "
        + "Raise --min-days or --expiry-from to reach them",
    ]);
  });

  test("--columns adds its figures, leaving a blank and one warning where a source has none", async () => {
    const calls = (expiration?: number) => chainFor(expiration ?? NEAR, STRIKES.map((strike) => contract("call", strike, expiration ?? NEAR)));
    const { dataProvider } = leapsProvider({ AAA: calls, BBB: calls });
    dataProvider.getTickerFinancials = async (symbol: string) => {
      if (symbol === "BBB") throw new Error("no financials");
      return { fundamentals: { dividendYield: 0.01, exDividendDate: "2026-11-02" }, nextEarnings: { date: "2026-10-29" } } as never;
    };

    const plain = createTestCliContext({ dataProvider });
    await options.execute(["AAA", "--leaps", "--delta", "0.5-0.9"], plain.context);
    // Nothing more is read, and the rows keep their keys.
    expect(ivHistory).not.toHaveBeenCalled();
    expect(Object.keys((plain.printed[0]!.result.data as LeapsRow[])[0]!)).not.toContain("costPerContract");

    const cli = createTestCliContext({ dataProvider });
    await options.execute(["AAA", "BBB", "--leaps", "--delta", "0.5-0.9", "--columns", "ivr,cost,breakeven,next-earnings,ex-dividend,carry-net"], cli.context);
    expect(ivHistory).toHaveBeenCalledTimes(1);
    const result = cli.printed[0]!.result;
    const rows = result.data as LeapsRow[];
    const bbb = rows.find((row) => row.symbol === "BBB")!;
    const aaa = rows.find((row) => row.symbol === "AAA" && row.contract === bbb.contract)!;
    expect(aaa).toMatchObject({ ivRank: null, nextEarnings: "2026-10-29", exDividend: "2026-11-02" });
    expect(aaa.costPerContract).toBeCloseTo((aaa.bid + aaa.ask) / 2 * 100, 6);
    expect(aaa.breakeven).toBeCloseTo(aaa.strike + (aaa.bid + aaa.ask) / 2, 3);
    expect(bbb).toMatchObject({ nextEarnings: null, exDividend: null });
    // BBB counts no dividends: on the same quotes its carry-net is AAA's less the 1% yield AAA's call forgoes.
    expect(bbb.carryNetPerYearPercent! - aaa.carryNetPerYearPercent!).toBeCloseTo(-1, 2);
    expect(result.warnings).toEqual([
      "BBB: no earnings or dividend data, so carry-net counts no dividends",
      "IV rank unavailable (Gloom Cloud did not answer)",
    ]);
  });
});

test("parseLeapsCriteria reads each option and names the one it cannot read", () => {
  expect(parseLeapsCriteria({})).toEqual(DEFAULT_LEAPS_CRITERIA);
  expect(parseLeapsCriteria({ "--side": "PUTS", "--delta": "20-40", "--max-spread": "2.5%", "--min-oi": "0", "--sort": "oi" }))
    .toMatchObject({ side: "put", minDelta: 0.2, maxDelta: 0.4, maxSpreadPercent: 2.5, minOpenInterest: 0, sort: "oi" });
  expect(parseLeapsCriteria({ "--side": "straddle" })).toEqual({ error: 'Invalid --side "straddle". Use calls or puts.' });
  expect(parseLeapsCriteria({ "--max-spread": "0" })).toMatchObject({ error: expect.stringContaining("--max-spread") });
  expect(parseLeapsCriteria({ "--min-oi": "1.5" })).toMatchObject({ error: expect.stringContaining("--min-oi") });
  // A decimal comma gets the number to type, a band's at both ends.
  expect(parseLeapsCriteria({ "--delta": "0,80-0,90" })).toMatchObject({ error: expect.stringMatching(/; use a dot: 0\.80-0\.90$/) });
  expect(parseLeapsCriteria({ "--max-spread": "1,5" })).toMatchObject({ error: expect.stringMatching(/; use a dot: 1\.5$/) });
  expect(parseLeapsCriteria({ "--columns": "iv,IVR,colour" })).toMatchObject({ error: expect.stringContaining("iv, ivr, cost, breakeven") });
});

test("the expiry window: a lower bound replaces the one-year floor, and one no expiry can be in names the option to change", () => {
  const window = (raw: Record<string, string>) => {
    const parsed = parseLeapsCriteria(raw, NOW);
    return "error" in parsed ? parsed.error : [parsed.minDays, parsed.maxDays, parsed.expiryFrom, parsed.expiryTo];
  };
  expect(window({ "--max-days": "730" })).toEqual([365, 730, null, null]);
  expect(window({ "--min-days": "180" })).toEqual([180, null, null, null]);
  expect(window({ "--expiry-from": "2027-04-01", "--max-days": "400" })).toEqual([null, 400, "2027-04-01", null]);
  expect(window({ "--expiry-from": "1.4.2027", "--expiry-to": "Jan 21 2028" })).toEqual([null, null, "2027-04-01", "2028-01-21"]);
  expect(window({ "--expiration": "1832025600" })).toEqual([null, null, "2028-01-21", "2028-01-21"]);
  expect(window({ "--min-days": "730", "--max-days": "365" })).toContain("--min-days 730 is more than --max-days 365");
  expect(window({ "--expiry-from": "2028-06-01", "--expiry-to": "2027-06-01" })).toContain("such as --expiry-from 2027-06-01 --expiry-to 2028-06-01");
  expect(window({ "--max-days": "300" })).toContain("under the 365 days --leaps starts from. Add a lower bound, such as --min-days 180 --max-days 300");
  expect(window({ "--expiry-to": "2027-06-01" })).toContain("--expiry-to 2027-06-01 is 235 days out, under the 365 days");
  expect(window({ "--min-days": "100", "--expiry-to": "2026-12-01" })).toContain("under --min-days 100");
  expect(window({ "--expiry-from": "2029-06-01", "--max-days": "730" })).toContain("past --max-days 730");
  expect(window({ "--expiry-to": "2026-10-09" })).toContain("has passed");
  expect(window({ "--expiry-from": "2027-02-30" })).toBe('Invalid --expiry-from "2027-02-30". '
    + "Use an expiry date as YYYY-MM-DD, DD.MM.YYYY, Oct 14 2026 or 14 October 2026, such as --expiry-from 2027-06-18.");
  expect(window({ "--expiration": "2028-01-21", "--expiry-to": "2028-06-30" })).toContain("--expiration reads one expiry");
});

test("sortLeapsRows orders by the chosen figure and falls back to carry", () => {
  const row = (symbol: string, carry: number, openInterest: number, spread: number) => ({
    symbol, expiration: "2028-01-21", strike: 100, delta: 0.8, extrinsicPerYearPercent: carry, openInterest, spreadPercent: spread,
  }) as LeapsRow;
  const rows = [row("A", 5, 100, 1), row("B", 3, 900, 2), row("C", 4, 900, 0.5)];
  expect(sortLeapsRows(rows, "carry").map((entry) => entry.symbol)).toEqual(["B", "C", "A"]);
  expect(sortLeapsRows(rows, "oi").map((entry) => entry.symbol)).toEqual(["B", "C", "A"]);
  expect(sortLeapsRows(rows, "spread").map((entry) => entry.symbol)).toEqual(["C", "A", "B"]);
});
