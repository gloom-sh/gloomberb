import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../types/financials";
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

function chainFor(expiration: number, calls: OptionContract[]): OptionsChain {
  return {
    underlyingSymbol: "X", expirationDates: [NEAR, LEAPS], calls,
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

beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => { setSystemTime(); });

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

  test("its options need --leaps, and --leaps reads every LEAPS expiry rather than one", async () => {
    const { dataProvider } = leapsProvider({});
    await expect(options.execute(["AAPL", "--side", "puts"], createTestCliContext({ dataProvider }).context))
      .rejects.toThrow("--side only applies with --leaps.");
    await expect(options.execute(["AAPL", "--leaps", "--expiration", "2028-01-21"], createTestCliContext({ dataProvider }).context))
      .rejects.toThrow("drop --expiration");
    await expect(options.execute(["AAPL", "--leaps", "--sort", "cheapest"], createTestCliContext({ dataProvider }).context))
      .rejects.toThrow('Invalid --sort "cheapest"');
  });
});

test("parseLeapsCriteria reads each option and names the one it cannot read", () => {
  expect(parseLeapsCriteria({})).toEqual(DEFAULT_LEAPS_CRITERIA);
  expect(parseLeapsCriteria({ "--side": "PUTS", "--delta": "20-40", "--max-spread": "2.5%", "--min-oi": "0", "--sort": "oi" }))
    .toEqual({ side: "put", minDelta: 0.2, maxDelta: 0.4, maxSpreadPercent: 2.5, minOpenInterest: 0, sort: "oi" });
  expect(parseLeapsCriteria({ "--side": "straddle" })).toEqual({ error: 'Invalid --side "straddle". Use calls or puts.' });
  expect(parseLeapsCriteria({ "--max-spread": "0" })).toMatchObject({ error: expect.stringContaining("--max-spread") });
  expect(parseLeapsCriteria({ "--min-oi": "1.5" })).toMatchObject({ error: expect.stringContaining("--min-oi") });
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
