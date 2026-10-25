import { describe, expect, setSystemTime, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { createTestHeadlessContext } from "../../../test-support/headless";
import type { DataProvider } from "../../../types/data-provider";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/headless";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import { daysToExpiryFrom, valueOption } from "../shared/volatility";
import type { ImpliedVolatilityApi } from "../iv-history/client";
import { createScenarioDependencies } from "./client";
import { cspScreenHeadless } from "./csp-screen-headless";
import { optionExpirationClose, scenarioValue, type ScenarioPosition } from "./model";
import {
  loadStrategyScreen, rankStrategyScreen, readStrategyFamily, readStrategyScreenCriteria, STRATEGY_FAMILIES, strategyFamilyDef,
  type ScreenFamily, type StrategyScreenRow, type StrategyTrade,
} from "./strategy-screen";

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
const now = Date.parse("2026-10-21T18:00:00Z");
const NEAR = day("2026-11-20");
const FAR = day("2026-12-18");
const STRIKES = Array.from({ length: 17 }, (_, index) => 80 + index * 2.5);
const RATE = 0.04;
const DIVIDEND = 0.01;
const VOL = 0.3;

/** One chain on one model: spot 100, 30% vol at every strike, quotes two cents either side of the model price. */
function sources() {
  const chain = (symbol: string, expiry: number): OptionsChain => {
    const years = daysToExpiryFrom(expiry, now);
    const contract = (side: "call" | "put", strike: number) => {
      const { price } = valueOption({ side, spot: 100, strike, daysToExpiry: years, rate: RATE, dividendYield: DIVIDEND, volatility: VOL });
      const bid = Math.max(0.01, price - 0.02);
      return { contractSymbol: `${symbol}-${side}-${strike}-${expiry}`, strike, bid, ask: bid + 0.04, currency: "USD", expiration: expiry,
        impliedVolatility: 0, lastPrice: 0, change: 0, percentChange: 0, inTheMoney: false, lastTradeDate: now / 1000 };
    };
    return { underlyingSymbol: symbol, expirationDates: [day("2026-10-23"), NEAR, FAR], asOf: new Date(now).toISOString(),
      calls: STRIKES.map((strike) => contract("call", strike)), puts: STRIKES.map((strike) => contract("put", strike)) };
  };
  const quote = (symbol: string): Quote => ({ symbol, price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: now });
  const provider = {
    id: "strategy-screen-test",
    getQuote: async (symbol: string) => quote(symbol),
    getTickerFinancials: async (symbol: string) => ({ quote: quote(symbol), fundamentals: { dividendYield: DIVIDEND }, annualStatements: [],
      quarterlyStatements: [], priceHistory: [] }) as TickerFinancials,
    getOptionsChain: async (symbol: string, _exchange?: string, expiration?: number) => chain(symbol, expiration ?? NEAR),
    getEarningsCalendar: async () => [],
  } as unknown as DataProvider;
  const cloud = {
    impliedVolatility: async () => ({ version: 1, asOf: "2026-10-20", rows: [{ symbol: "AAA", status: "ready", iv30: { rank: 42 }, iv90: null, latest: null, skew: null }] }),
    getCloudYieldCurve: async () => [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-10-20" }, { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-10-20" }],
  };
  return { provider, cloud };
}

async function screen(strategy: ScreenFamily, options: Record<string, unknown> = {}) {
  const { provider, cloud } = sources();
  const loaded = await loadStrategyScreen([{ symbol: "AAA" }], readStrategyScreenCriteria(strategy, options),
    { scenario: { ...createScenarioDependencies(provider, cloud), now: () => now }, earnings: provider, ivApi: cloud as unknown as ImpliedVolatilityApi });
  return loaded.rows[0]!;
}

/** The strike whose delta at the fixture's 30% vol is nearest `target` (a put's negative), as a trader reads it off the chain. */
function strikeAtDelta(side: "call" | "put", target: number, expiry = NEAR, strikes = STRIKES): number {
  const delta = (strike: number) => valueOption({ side, spot: 100, strike, daysToExpiry: daysToExpiryFrom(expiry, now), rate: RATE,
    dividendYield: DIVIDEND, volatility: VOL }).delta;
  const signed = side === "put" ? -target : target;
  return strikes.reduce((best, strike) => Math.abs(delta(strike) - signed) < Math.abs(delta(best) - signed) ? strike : best);
}

const legs = (trade: StrategyTrade) => trade.position.legs.map((leg) => [leg.quantity, leg.strike, leg.side, leg.expiration === NEAR ? "near" : "far"]);

test("--strategy reads every family by name or alias, and each family's deltas default and refuse as they should", () => {
  expect([readStrategyFamily(""), readStrategyFamily("cc"), readStrategyFamily("Iron Condor"), readStrategyFamily("put-credit")])
    .toEqual(["csp", "covered-call", "iron-condor", "bull-put"]);
  expect(() => readStrategyFamily("butterfly")).toThrow('Invalid --strategy "butterfly". Use one of csp, covered-call');
  const read = (strategy: ScreenFamily, options = {}) => {
    const { delta, wingDelta } = readStrategyScreenCriteria(strategy, options);
    return [delta, wingDelta];
  };
  expect(read("bull-put")).toEqual([0.3, 0.15]);
  expect(read("bull-call")).toEqual([0.5, 0.3]);
  expect(read("iron-condor")).toEqual([0.2, 0.1]);
  // A wing's default that would not sit further out than the delta is half of it.
  expect(read("bull-put", { delta: "0.10" })).toEqual([0.1, 0.05]);
  expect(() => read("bull-put", { delta: "0.10", wingDelta: "0.15" })).toThrow("--wing-delta 0.15 must be below --delta 0.10");
  expect(() => read("short-straddle", { delta: "0.30" })).toThrow("--delta does not apply to short straddles");
  expect(() => read("covered-call", { wingDelta: "0.10" })).toThrow("--wing-delta sets the far legs of a vertical or an iron condor");
  // The expiry and the spread limit read as the put screen reads them.
  expect(readStrategyScreenCriteria("calendar", { days: "45", maxSpread: "15%" })).toMatchObject({ days: 45, maxSpreadPercent: 15 });
  expect(() => readStrategyScreenCriteria("calendar", { days: "30.5" })).toThrow("--days takes whole days");
});

describe("each family picks its legs by delta on the expiry nearest the target", () => {
  const short = (side: "call" | "put", target: number) => strikeAtDelta(side, target);
  const cases: Array<[ScreenFamily, () => Array<Array<string | number>>]> = [
    ["covered-call", () => [[-1, short("call", 0.3), "call", "near"]]],
    ["bull-put", () => [[-1, short("put", 0.3), "put", "near"], [1, short("put", 0.15), "put", "near"]]],
    ["bear-call", () => [[-1, short("call", 0.3), "call", "near"], [1, short("call", 0.15), "call", "near"]]],
    ["bull-call", () => [[1, short("call", 0.5), "call", "near"], [-1, short("call", 0.3), "call", "near"]]],
    ["bear-put", () => [[1, short("put", 0.5), "put", "near"], [-1, short("put", 0.3), "put", "near"]]],
    ["iron-condor", () => [[-1, short("put", 0.2), "put", "near"], [-1, short("call", 0.2), "call", "near"],
      [1, short("put", 0.1), "put", "near"], [1, short("call", 0.1), "call", "near"]]],
    ["short-straddle", () => [[-1, 100, "put", "near"], [-1, 100, "call", "near"]]],
    ["long-straddle", () => [[1, 100, "put", "near"], [1, 100, "call", "near"]]],
    ["short-strangle", () => [[-1, short("put", 0.2), "put", "near"], [-1, short("call", 0.2), "call", "near"]]],
    ["long-strangle", () => [[1, short("put", 0.3), "put", "near"], [1, short("call", 0.3), "call", "near"]]],
    // Sold on the expiry nearest 30 days out, bought on the one nearest 30 days after it.
    ["calendar", () => [[-1, short("call", 0.5), "call", "near"], [1, short("call", 0.5), "call", "far"]]],
  ];
  for (const [strategy, expected] of cases) {
    test(strategy, async () => {
      const row = await screen(strategy);
      expect(row.note).toBeNull();
      expect(legs(row.trade!)).toEqual(expected());
      // Every leg is entered at its quote midpoint with the IV that midpoint implies.
      expect(row.trade!.position.legs.every((leg) => leg.priceSource === "mid" && leg.volatilitySource === "mid" && Math.abs(leg.volatility - VOL) < 1e-3)).toBe(true);
    });
  }
  test("a covered call holds the 100 shares its call covers, bought at the spot the quotes imply", async () => {
    const trade = (await screen("covered-call")).trade!;
    expect(trade.position.underlying!.quantity).toBe(100);
    expect(trade.position.underlying!.price).toBeCloseTo(100, 6);
  });
  test("a typed wing delta moves only the far legs, still strictly further out", async () => {
    const trade = (await screen("bull-put", { wingDelta: "0.29" })).trade!;
    const [sold, bought] = trade.position.legs;
    expect(sold!.strike).toBe(strikeAtDelta("put", 0.3));
    expect(bought!.strike).toBe(strikeAtDelta("put", 0.29, NEAR, STRIKES.filter((strike) => strike < sold!.strike)));
  });
});

/** P(S_T > level) off the fixture's own pricer: a tight call spread around the level, carried to expiry. */
function chanceAbove(trade: StrategyTrade, level: number, volatility: number): number {
  const position = trade.position;
  const close = Math.min(...position.legs.map((leg) => optionExpirationClose(leg.expiration)));
  const days = (close - position.asOf) / 86_400_000;
  const call = (strike: number) => valueOption({ side: "call", spot: position.spot, strike, daysToExpiry: days, rate: position.rate,
    dividendYield: position.dividendYield, volatility }).price;
  const step = 1e-3;
  return Math.exp(position.rate * days / 365) * (call(level - step) - call(level + step)) / (2 * step);
}

describe("payoff and probability of profit on the fixture chain", () => {
  const price = (trade: StrategyTrade, side: "call" | "put", sign: 1 | -1, index = 0) =>
    trade.position.legs.filter((leg) => leg.side === side && Math.sign(leg.quantity) === sign)[index]!;
  const check = (trade: StrategyTrade, expected: { gain: number | null; loss: number | null; breakEvens: number[] }) => {
    if (expected.gain == null) expect(trade.maxGain).toBeNull(); else expect(trade.maxGain!).toBeCloseTo(expected.gain, 6);
    if (expected.loss == null) expect(trade.maxLoss).toBeNull(); else expect(trade.maxLoss!).toBeCloseTo(expected.loss, 6);
    expect(trade.breakEvens).toHaveLength(expected.breakEvens.length);
    expected.breakEvens.forEach((value, index) => expect(trade.breakEvens[index]!).toBeCloseTo(value, 6));
  };
  const iv = (trade: StrategyTrade) => trade.position.legs[0]!.volatility;

  test("covered call: gain to the strike plus the premium, loss to zero less it, profit above spot less the premium", async () => {
    const trade = (await screen("covered-call")).trade!;
    const call = trade.position.legs[0]!;
    const cost = trade.position.underlying!.price;
    check(trade, { gain: (call.strike - cost + call.price) * 100, loss: (cost - call.price) * 100, breakEvens: [cost - call.price] });
    expect(trade.net).toBeCloseTo(call.price, 8);
    expect(trade.probabilityOfProfit!).toBeCloseTo(chanceAbove(trade, cost - call.price, iv(trade)), 3);
    expect(trade.returnOnRisk!).toBeCloseTo(trade.maxGain! / trade.maxLoss!, 10);
    expect(trade.annualizedReturn!).toBeCloseTo(trade.returnOnRisk! * 365 / 30, 10);
  });

  test("credit verticals: the credit is the most made, the width less it the most lost", async () => {
    const bull = (await screen("bull-put")).trade!;
    const [sold, bought] = [price(bull, "put", -1), price(bull, "put", 1)];
    const credit = sold.price - bought.price;
    check(bull, { gain: credit * 100, loss: (sold.strike - bought.strike - credit) * 100, breakEvens: [sold.strike - credit] });
    expect(bull.probabilityOfProfit!).toBeCloseTo(chanceAbove(bull, sold.strike - credit, sold.volatility), 3);
    const bear = (await screen("bear-call")).trade!;
    const [short, long] = [price(bear, "call", -1), price(bear, "call", 1)];
    const taken = short.price - long.price;
    check(bear, { gain: taken * 100, loss: (long.strike - short.strike - taken) * 100, breakEvens: [short.strike + taken] });
    expect(bear.probabilityOfProfit!).toBeCloseTo(1 - chanceAbove(bear, short.strike + taken, short.volatility), 3);
  });

  test("debit verticals: the debit is the most lost, the width less it the most made", async () => {
    const bull = (await screen("bull-call")).trade!;
    const [bought, sold] = [price(bull, "call", 1), price(bull, "call", -1)];
    const debit = bought.price - sold.price;
    check(bull, { gain: (sold.strike - bought.strike - debit) * 100, loss: debit * 100, breakEvens: [bought.strike + debit] });
    expect(bull.net).toBeCloseTo(-debit, 8);
    expect(bull.probabilityOfProfit!).toBeCloseTo(chanceAbove(bull, bought.strike + debit, bought.volatility), 3);
    const bear = (await screen("bear-put")).trade!;
    const [long, short] = [price(bear, "put", 1), price(bear, "put", -1)];
    const paid = long.price - short.price;
    check(bear, { gain: (long.strike - short.strike - paid) * 100, loss: paid * 100, breakEvens: [long.strike - paid] });
    expect(bear.probabilityOfProfit!).toBeCloseTo(1 - chanceAbove(bear, long.strike - paid, long.volatility), 3);
  });

  test("iron condor: the credit made between the short strikes, the wider wing less it lost beyond them", async () => {
    const trade = (await screen("iron-condor")).trade!;
    const [put, call, putWing, callWing] = trade.position.legs;
    const credit = put!.price + call!.price - putWing!.price - callWing!.price;
    const width = Math.max(put!.strike - putWing!.strike, callWing!.strike - call!.strike);
    check(trade, { gain: credit * 100, loss: (width - credit) * 100, breakEvens: [put!.strike - credit, call!.strike + credit] });
    expect(trade.probabilityOfProfit!).toBeCloseTo(chanceAbove(trade, put!.strike - credit, put!.volatility)
      - chanceAbove(trade, call!.strike + credit, call!.volatility), 3);
  });

  test("straddles and strangles: unlimited on the side that has no cover, break-evens the premium either side", async () => {
    for (const strategy of ["short-straddle", "long-straddle", "short-strangle", "long-strangle"] as const) {
      const trade = (await screen(strategy)).trade!;
      const [put, call] = trade.position.legs;
      const premium = put!.price + call!.price;
      const breakEvens = [put!.strike - premium, call!.strike + premium];
      const inside = chanceAbove(trade, breakEvens[0]!, put!.volatility) - chanceAbove(trade, breakEvens[1]!, call!.volatility);
      const selling = strategy.startsWith("short");
      check(trade, selling ? { gain: premium * 100, loss: null, breakEvens } : { gain: null, loss: premium * 100, breakEvens });
      expect([trade.unlimited, trade.returnOnRisk]).toEqual([selling ? "loss" : "gain", null]);
      // A seller keeps the premium between the break-evens; a buyer needs the move past either one.
      expect(trade.probabilityOfProfit!).toBeCloseTo(selling ? inside : 1 - inside, 3);
    }
  });

  test("calendar: read when the sold call expires, the bought one still worth its time value", async () => {
    const trade = (await screen("calendar")).trade!;
    const [sold, bought] = trade.position.legs;
    const debit = bought!.price - sold!.price;
    const close = optionExpirationClose(NEAR);
    const pnl = (spot: number) => scenarioValue(trade.position as ScenarioPosition, spot, close).pnl;
    expect(trade.maxLoss!).toBeCloseTo(debit * 100, 5);
    // The most it makes is at the strike, where the sold call expires worthless and the bought one has the most time value.
    expect(trade.maxGain!).toBeCloseTo(pnl(sold!.strike), 8);
    expect(trade.maxGain!).toBeGreaterThan(pnl(sold!.strike * 0.97));
    expect(trade.breakEvens).toHaveLength(2);
    for (const breakEven of trade.breakEvens) expect(Math.abs(pnl(breakEven))).toBeLessThan(1e-6);
    expect(trade.breakEvens[0]!).toBeLessThan(sold!.strike);
    expect(trade.breakEvens[1]!).toBeGreaterThan(sold!.strike);
    expect(trade.probabilityOfProfit!).toBeCloseTo(chanceAbove(trade, trade.breakEvens[0]!, sold!.volatility)
      - chanceAbove(trade, trade.breakEvens[1]!, sold!.volatility), 3);
    expect([trade.expiry, trade.farExpiry]).toEqual(["2026-11-20", "2026-12-18"]);
  });
});

test("each family ranks by its own measure: return on risk, or IV rank rich first to sell and cheap first to buy", () => {
  const row = (symbol: string, annualizedReturn: number | null, ivRank: number | null, trade = true): Omit<StrategyScreenRow, "rank"> =>
    ({ symbol, trade: trade ? { annualizedReturn } as StrategyTrade : null, ivRank, wideSpread: false, note: trade ? null : "No chain" });
  const rows = [row("AAA", 0.4, 30), row("BBB", 0.9, 70), row("CCC", null, null), row("DDD", 0.6, 50), row("EEE", null, null, false)];
  const order = (strategy: ScreenFamily) => rankStrategyScreen(rows, strategy).map((entry) => `${entry.rank ?? "-"}${entry.symbol}`);
  expect(order("bull-put")).toEqual(["1BBB", "2DDD", "3AAA", "-CCC", "-EEE"]);
  expect(order("short-strangle")).toEqual(["1BBB", "2DDD", "3AAA", "-CCC", "-EEE"]);
  expect(order("long-straddle")).toEqual(["1AAA", "2DDD", "3BBB", "-CCC", "-EEE"]);
});

describe("fn CSP --strategy writes each family's trades with their figures as numbers", () => {
  for (const strategy of STRATEGY_FAMILIES.filter((family): family is ScreenFamily => family !== "csp")) {
    test(strategy, async () => {
      const { provider, cloud } = sources();
      const ctx = createTestHeadlessContext({ marketData: provider, apiClient: cloud as unknown as HeadlessPaneContext["apiClient"] });
      const input: HeadlessPaneLoadArgs = { symbols: ["AAA"], rawArgument: "AAA", argument: ["AAA"], options: { strategy } };
      setSystemTime(now);
      try {
        const result = await cspScreenHeadless.load(input, ctx);
        const freshness = deriveHeadlessFreshness(cspScreenHeadless, result);
        const def = strategyFamilyDef(strategy);
        expect(renderHeadlessPaneText(cspScreenHeadless, result, input, "CSP", freshness).split("\n")[0]).toContain(`${def.title} · `);
        const csv = renderReportCsv(headlessReportTables(cspScreenHeadless, result, input, "CSP", freshness, { complete: true, unavailableSymbols: [] }), freshness)
          .split("\n").map((line) => line.match(/("[^"]*"|[^,]*)(,|$)/g)!.map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, "")));
        const cell = (header: string) => csv[1]![csv[0]!.indexOf(header)]!;
        const row = (result as { rows: Array<Record<string, unknown>> }).rows[0]!;
        // Every figure as a number, to the twelve digits an export keeps.
        for (const [header, key] of [[def.net === "credit" ? "Credit" : "Debit", "net"], ["Break-even", "breakEven"], ["PoP (%)", "pop"],
          ["Return/yr (%)", "returnPerYear"], ["Spread (%)", "spread"]] as const) {
          if (row[key] == null) expect(cell(header)).toBe("");
          else expect(Number(cell(header))).toBeCloseTo(row[key] as number, 8);
        }
        expect(cell("Trade")).toBe(String(row.trade));
        // A side with no limit is said in the row's status, never written as a number.
        const unlimited = row.unlimited as string | null;
        for (const side of ["gain", "loss"] as const) {
          const header = side === "gain" ? "Max gain" : "Max loss";
          if (unlimited === side) expect(cell(header)).toBe("");
          else expect(Number(cell(header))).toBeCloseTo(row[side === "gain" ? "maxGain" : "maxLoss"] as number, 8);
        }
        expect(cell("status")).toBe(unlimited ? `Max ${unlimited}: unlimited` : "");
        expect(result.notes?.[0]).toStartWith(`Ranked by ${def.rank === "return" ? "annualised return on risk" : "IV rank"}`);
      } finally {
        setSystemTime();
      }
    });
  }
});
