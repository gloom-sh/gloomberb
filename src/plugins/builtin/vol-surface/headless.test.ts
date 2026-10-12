import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import type { HeadlessBundleResult, HeadlessPaneApiClient } from "../../../types/headless";
import { parseOptionExpiration } from "../../../utils/option-expiry";
import { DEFAULT_OPTION_CALC_DRAFT } from "../options-calculator/model";
import { daysToExpiryFrom, valueOption } from "../shared/volatility";
import { volSurfaceHeadless } from "./headless";
import type { SurfaceSnapshot } from "./model";
import { storedSurfacePayload } from "./test-fixture";

const now = Date.UTC(2026, 8, 22, 14);
const expiry = (days: number) => Date.UTC(2026, 8, 22 + days) / 1000;
// A three-day expiry, a week-plus one, one whose calls stop short of the 25-delta call, and a quarter out.
const listed = [expiry(3), expiry(10), expiry(40), expiry(90)];
const volatility = new Map([[listed[0], 0.5], [listed[1], 0.3], [listed[2], 0.28], [listed[3], 0.26]]);
const fullStrikes = [70, 80, 90, 95, 100, 105, 110, 120, 130];

function chain(expiration: number): OptionsChain {
  const strikes = expiration === listed[2] ? [70, 80, 90, 95, 100, 101] : fullStrikes;
  const contract = (strike: number, side: "call" | "put"): OptionContract => {
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: 100, strike, daysToExpiry: daysToExpiryFrom(expiration, now),
      rate: 0.04, dividendYield: 0.01, volatility: volatility.get(expiration)! }).price;
    return { contractSymbol: `${side}-${strike}-${expiration}`, strike, currency: "USD", expiration, bid: price * 0.99, ask: price * 1.01,
      lastPrice: price, impliedVolatility: 0, openInterest: 10, volume: 2, lastTradeDate: now / 1000 - 1000,
      change: 0, percentChange: 0, inTheMoney: side === "call" ? strike < 100 : strike > 100 };
  };
  return { underlyingSymbol: "AAPL", expirationDates: listed, calls: strikes.map((strike) => contract(strike, "call")),
    puts: strikes.map((strike) => contract(strike, "put")), dataSource: "delayed", delayMinutes: 15, asOf: new Date(now - 60_000).toISOString() };
}

const curve = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" }, { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-09-21" }];

async function load(options: Record<string, string | number>) {
  const args = createTestHeadlessArgs({ rawArgument: "AAPL", argument: "AAPL", symbols: ["AAPL"],
    options: { tab: "surface", ivSource: "recomputed", priceSide: "mid", axis: "spot", tenors: "listed", limit: 18, ...options } });
  const result = await volSurfaceHeadless.load(args, createTestHeadlessContext({
    marketData: createTestDataProvider({ id: "ovdv-test", getQuote: async () => createTestQuote({ price: 100, lastUpdated: now }),
      getOptionsChain: async (_symbol, _exchange, expiration) => chain(expiration ?? listed[0]!) }),
    apiClient: { getCloudYieldCurve: async () => curve } as unknown as HeadlessPaneApiClient,
  })) as HeadlessBundleResult;
  const titles = result.sections.map((section) => section.title).filter((title) => title !== "Warnings");
  const table = (title: string) => result.sections.find((section) => section.title === title) as Extract<HeadlessBundleResult["sections"][number], { rows: unknown[] }>;
  const cell = (title: string, key: string, index: number) => {
    const section = table(title);
    const column = section.columns!.find((entry) => entry.key === key)!;
    return column.format!(section.rows[index]![key], section.rows[index]!);
  };
  return { result, titles, table, cell, text: renderHeadlessPaneText(volSurfaceHeadless, result, args, "OVDV") };
}

beforeEach(() => setSystemTime(now));
afterEach(() => setSystemTime());

describe("OVDV report", () => {
  test("prints the view --tab asks for", async () => {
    expect((await load({})).titles).toEqual(["Surface", "Expiries"]);
    expect((await load({ tab: "term" })).titles).toEqual(["Term structure"]);
    expect((await load({ tab: "forwards" })).titles).toEqual(["Forwards"]);
    const skew = await load({ tab: "skew" });
    expect(skew.titles).toEqual(["Skew"]);
    // Each difference names its sign; the risk reversal is call minus put, unlike HIVG and VCA's skew.
    expect(skew.table("Skew").columns!.slice(4, 7).map((column) => column.header))
      .toEqual(["RR call-put (pts)", "BF wings-ATM (pts)", "90/110 90%-110% (pts)"]);
    expect(skew.text).not.toContain("Expiry / tenor");
    expect(skew.result.notes?.[0]).toContain("RR is 25D call IV minus 25D put IV");
  });

  test("the skew view says why a figure is missing and leaves out slopes under a week", async () => {
    const { cell, table, result } = await load({ tab: "skew" });
    const rows = table("Skew").rows;
    expect(rows.map((row) => row.expiry)).toEqual(listed.map((value) => new Date(value * 1000).toISOString().slice(0, 10)));
    // Three days out: the slope to the next expiry is left out in the text and the JSON row, and kept in the model.
    expect(cell("Skew", "termSlope", 0)).toBe("under 7d");
    expect(rows[0]).toMatchObject({ termSlope: null, termSlopeHidden: true });
    expect(typeof (result.metadata!.expiries as Array<{ termSlope: unknown }>)[0]!.termSlope).toBe("number");
    expect(cell("Skew", "termSlope", 1)).toMatch(/^-?\d+\.\d\d$/);
    // The 40-day calls stop at 101, short of the 25-delta call.
    expect([cell("Skew", "riskReversal", 2), cell("Skew", "butterfly", 2)]).toEqual(["no 25D call", "no 25D call"]);
    expect(cell("Skew", "riskReversal", 3)).toMatch(/^-?\d+\.\d\d$/);
  });

  test("--expiration takes a date and selects that expiry's smile", async () => {
    const date = new Date(listed[3]! * 1000).toISOString().slice(0, 10);
    const { titles, result } = await load({ tab: "smile", expiration: parseOptionExpiration(date)! });
    expect(titles).toEqual([`Smile ${date}`, "Clean quotes"]);
    expect(result.errors).toEqual([]);
    // A date the chain does not list names the listed ones, once.
    const missing = await load({ tab: "smile", expiration: parseOptionExpiration("2026-10-03")! });
    expect(missing.result.errors).toEqual(["2026-10-03: not listed; nearest: 2026-09-25, 2026-10-02, 2026-11-01, 2026-12-21"]);
  });
});

describe("OVDV --date", () => {
  const sessionDate = "2026-09-22";
  /** The report on a stored close: the live board fitted once is what a close capture stores. */
  async function stored(options: Record<string, string | number>, { surface, dates }: { surface: boolean; dates: string[] }) {
    const live = (await load({})).result.metadata as unknown as SurfaceSnapshot;
    const payload = storedSurfacePayload({ symbol: "AAPL", sessionDate, capturedAt: new Date(now).toISOString(), spot: 100, expiries: live.expiries });
    const paths: string[] = [];
    const apiClient = { impliedVolatility: async (path: string) => {
      paths.push(path);
      if (path.startsWith("surface-dates?")) return { version: 1, symbol: "AAPL", dates };
      if (surface) return payload;
      throw new ApiRequestError("No stored AAPL surface", 404);
    } } as unknown as HeadlessPaneApiClient;
    const args = createTestHeadlessArgs({ rawArgument: "AAPL", argument: "AAPL", symbols: ["AAPL"],
      options: { tab: "surface", ivSource: "recomputed", priceSide: "mid", axis: "spot", tenors: "listed", limit: 18, ...options } });
    const result = await volSurfaceHeadless.load(args, createTestHeadlessContext({ apiClient,
      // A stored close carries its own spot; a live quote is never asked for.
      marketData: createTestDataProvider({ id: "ovdv-test", getQuote: async () => { throw new Error("no quote for a stored close"); } }) })) as HeadlessBundleResult;
    return { result, paths, text: renderHeadlessPaneText(volSurfaceHeadless, result, args, "OVDV") };
  }

  test("prints that session's stored close through the same views, dated by the session", async () => {
    const { result, paths, text } = await stored({ date: sessionDate, tab: "skew" }, { surface: true, dates: [sessionDate] });
    expect(paths).toContain(`surface?symbol=AAPL&date=${sessionDate}`);
    expect(result.sections.map((section) => section.title).filter((title) => title !== "Warnings")).toEqual(["Skew"]);
    expect(result.freshness).toEqual({ status: "not-a-feed", basis: "stored close capture", asOf: sessionDate });
    expect(result.notes?.[0]).toBe("Stored close, spot 100.00, captured 10:00 New York.");
    expect(text).toContain("Tue 22 Sep 2026 · not a live feed (stored close capture)");
    expect(result.metadata).not.toHaveProperty("underlyingQuote");
  });

  test("a date with no capture lists the stored dates, and a capture not shown yet says so", async () => {
    await expect(stored({ date: "2026-09-19" }, { surface: false, dates: ["2026-09-22", "2026-09-18"] }))
      .rejects.toThrow("No stored AAPL close surface for 2026-09-19. Stored dates: 2026-09-22, 2026-09-18.");
    await expect(stored({ date: sessionDate }, { surface: false, dates: [sessionDate] }))
      .rejects.toThrow(`The AAPL ${sessionDate} close capture is not shown yet: without real-time data a capture shows 15 minutes after it is taken.`);
  });
});
