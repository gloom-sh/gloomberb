import { describe, expect, setSystemTime, test } from "bun:test";
import type { FuturesContract, FuturesCurveAsOfPayload, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";
import type { DataProvider } from "../../../types/data-provider";
import type { HeadlessBundleResult } from "../../../types/plugin";
import { futuresCurveHeadless } from "./headless";
import { daysToExpiry } from "./model";

// Expiries sit a fixed number of days from the spot's UTC date, so the fields never depend on the day the suite runs.
const NOW = Date.now();
const SPOT_AT = NOW - 2 * 60_000;
const SPOT_DAY = Date.parse(`${new Date(SPOT_AT).toISOString().slice(0, 10)}T00:00:00Z`);
const expiry = (days: number) => new Date(SPOT_DAY + days * 86_400_000).toISOString().slice(0, 10);
const contract = (root: string, code: string, days: number, price: number | null, stale = false, asOf = new Date(NOW).toISOString()): FuturesContract => ({
  symbol: `${root}${code}.CME`, label: code, expiration: expiry(days), price, asOf, currency: "USD", quoteUnit: "USD",
  volume: 1, openInterest: 1, delayMinutes: 10, stale, percentile: 50, samples: 200, historyStart: null, historyEnd: null,
});
function curve(root: string, contracts: FuturesContract[]): FuturesCurvePayload {
  return { root, name: root, source: "gloom", currency: "USD", quoteUnit: "USD", asOf: new Date(NOW).toISOString(), fetchedAt: new Date(NOW).toISOString(),
    status: "available", stale: false, catalogue: { method: "provider", complete: true, horizonEnd: null }, contracts,
    ghosts: [{ label: "1W", requestedDate: expiry(-7), asOf: null, points: [] }],
    slope: { frontSymbol: null, nextSymbol: null, value: null, annualizedRollYield: null, percentile: null, rollPercentile: null, samples: 0, historyStart: null, historyEnd: null, asOf: null, state: "unavailable" },
    gaps: [] };
}
// Saturday 24 Oct 2026 on a delayed feed: the spot's one-minute bars run to 03:40 UTC, and BTCV26 settles on Friday the
// 30th at 16:00 London, 6.6 days after its 01:33 trade. Z26 is flagged stale, F27 has no price, G27's price has no time
// of day and H27 traded at 03:52, after the newest spot bar.
const btc = (code: string, expiration: string, price: number | null, extra: Partial<FuturesContract> = {}): FuturesContract =>
  ({ ...contract("BTC", code, 0, price), expiration, asOf: "2026-10-24T01:33:11Z", ...extra });
const BTC = [btc("V26", "2026-10-30", 80_740), btc("X26", "2026-11-27", 81_210, { asOf: "2026-10-24T03:34:50Z" }),
  btc("Z26", "2026-12-24", 82_140, { stale: true }), btc("F27", "2027-01-29", null), btc("G27", "2027-02-26", 82_320, { asOf: "2026-10-23" }),
  btc("H27", "2027-03-25", 83_035, { asOf: "2026-10-24T03:52:00Z" })];
// The spot's minutes from 01:00 to 03:40 UTC, at 80,700 but for the minutes V26 and X26 traded in.
const SPOT_BARS = Array.from({ length: 161 }, (_, index) => Date.parse("2026-10-24T01:00:00Z") + index * 60_000)
  .map((minute) => ({ date: new Date(minute), close: minute === Date.parse("2026-10-24T01:33:00Z") ? 80_600 : minute === Date.parse("2026-10-24T03:34:00Z") ? 80_860 : 80_700 }));

function context(options: { quote?: (symbol: string) => Promise<ReturnType<typeof createTestQuote>>; asOf?: FuturesCurveAsOfPayload;
  bars?: DataProvider["getPriceHistoryForResolutionWithMetadata"] } = {}) {
  const reads: string[] = [];
  const marketData = createTestDataProvider({ getQuote: async (symbol) => {
    reads.push(symbol);
    return options.quote ? options.quote(symbol) : createTestQuote({ symbol, price: 80_874.24, lastUpdated: SPOT_AT, dataSource: "delayed", listingExchangeName: "CCC" });
  }, getPriceHistoryForResolutionWithMetadata: options.bars ?? (async (symbol, _exchange, range, resolution) => {
    reads.push(`${symbol} ${range} ${resolution}`);
    return { points: SPOT_BARS, resolution: "1m" };
  }) });
  const apiClient = { getCloudFuturesCurve: async (root: string) => curve(root, root === "BTC" ? BTC : [contract("ES", "Z26", 30, 6600)]),
    getCloudFuturesCurveAsOf: async () => options.asOf! } as never;
  return { reads, ctx: createTestHeadlessContext({ marketData, apiClient }) };
}
async function run(root: string, ctxOptions: Parameters<typeof context>[0] = {}, options: Record<string, string> = {}) {
  const { reads, ctx } = context(ctxOptions);
  const result = await futuresCurveHeadless.load(createTestHeadlessArgs({ rawArgument: root, argument: root, symbols: [], options }), ctx) as HeadlessBundleResult;
  return { reads, result, rows: result.sections[0]!.rows as Array<Record<string, unknown>>, metadata: result.metadata as Record<string, unknown> };
}

test("a root no board lists fails naming the roots; the Baltic Dry Index adds the freight gap line and its proxies", async () => {
  const failure = async (root: string) => run(root).then(() => null, (error: Error & { details?: string }) => error);
  const bdi = await failure("BDI");
  expect(bdi?.message).toStartWith("No futures curve for BDI");
  expect(bdi?.details).toStartWith("Baltic indices (BDI, Capesize, Panamax, Supramax) and freight forwards (FFA) are not covered.");
  expect((await failure("QQQ"))?.details).toBeUndefined();
});

describe("CTM report units", () => {
  test("Dutch TTF gas reports euros per MWh on every row, in the metadata and as its one contract term", async () => {
    const eur = { ...curve("TTF", [{ ...contract("TTF", "X26", 30, 81.434), currency: "EUR", quoteUnit: "EUR", settlement: 78.8490001 }]),
      currency: "EUR", quoteUnit: "EUR", settlementDate: expiry(-1) };
    const ctx = createTestHeadlessContext({ marketData: createTestDataProvider({}), apiClient: { getCloudFuturesCurve: async () => eur } as never });
    const result = await futuresCurveHeadless.load(createTestHeadlessArgs({ rawArgument: "TTF", argument: "TTF", symbols: [], options: {} }), ctx) as HeadlessBundleResult;
    expect(result.sections[0]!.rows![0]).toMatchObject({ price: 81.434, change: 2.585, currency: "EUR", quoteUnit: "EUR / MWh" });
    expect(result.sections.find((section) => section.title === "Contract terms")?.entries).toEqual([{ key: "unit", label: "Unit", value: "EUR / MWh" }]);
    expect(result.metadata).toMatchObject({ currency: "EUR", quoteUnit: "EUR / MWh" });
    // A root with neither server terms nor a catalogue unit adds no terms section.
    expect((await run("ES")).result.sections.some((section) => section.title === "Contract terms")).toBe(false);
  });
});

describe("CTM report basis", () => {
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const days = (asOf: string, expiration: string) => daysToExpiry(Date.parse(asOf), expiration)!;

  test("each crypto trade is read against the spot bar of its own minute, to fractional days, and the metadata names the spot", async () => {
    const { reads, rows, metadata } = await run("BTC");
    expect(reads).toEqual(["BTC-USD", "BTC-USD 1D 1m"]);
    const v26 = days("2026-10-24T01:33:11Z", "2026-10-30");
    const x26 = days("2026-10-24T03:34:50Z", "2026-11-27");
    // 6 days 14h27m to Friday's fixing, not the 6 UTC dates.
    expect(v26).toBeCloseTo(6.602, 3);
    const round = (value: number) => Number(value.toFixed(4));
    expect(rows.map((row) => [row.spot, row.spotTime, row.daysToExpiry, row.vsSpotPct, row.annualisedBasisPct])).toEqual([
      [80_600, "2026-10-24T01:33:00Z", round(v26), round((80_740 / 80_600 - 1) * 100), round((80_740 / 80_600 - 1) * 365 / v26 * 100)],
      [80_860, "2026-10-24T03:34:00Z", round(x26), round((81_210 / 80_860 - 1) * 100), round((81_210 / 80_860 - 1) * 365 / x26 * 100)],
      // A stale print and a missing price are blank, not zero, and so are a price with no time of day and a trade after the newest bar.
      ...Array.from({ length: 4 }, () => [null, null, null, null, null]),
    ]);
    expect(metadata.basisBlankedUnpaired).toBe(2);
    // The spot is named in plain words, never by its listing code, and is the terminal's price, not the CME reference rate.
    expect(metadata.spot).toEqual({ symbol: "BTC-USD", price: 80_874.24, asOf: new Date(SPOT_AT).toISOString().replace(".000Z", "Z"),
      status: "ok", reason: null, venue: "crypto composite price", feed: "delayed" });
    expect(metadata.notices).toEqual(["Basis against BTC-USD spot in each last trade's own minute (crypto composite price, delayed); not the CME reference rate."]);
    expect(JSON.stringify(metadata)).not.toContain("CCC");
  });

  test("the footnotes give the convention, why each blank cell is blank with both times, and that a rate inside a week is noise", async () => {
    const { result } = await run("BTC");
    expect(result.notes).toEqual([
      "Ann Basis = (Last / spot - 1) × 365 / days to expiry: simple actual/365, each last trade against spot in the same minute, "
        + "with days counted to final settlement at 16:00 London on the last trading day.",
      "Basis blank for BTCZ26 (price over two sessions old); BTCF27 (no price); BTCG27 (last trade has no time of day); "
        + "BTCH27 (spot and print 12 min apart: print 03:52, nearest spot 03:40 UTC).",
      // 6.6 days to the front contract's fixing: 0.1% x 365 / 6.6 = 5.5 points a year.
      "Ann Basis is noisy under 7 days to expiry, so read Vs Spot there: 10 bp of spot noise moves BTCV26 (6.6 days) by ±5.5 points.",
    ]);
    const text = plain(renderHeadlessPaneText(futuresCurveHeadless, result, createTestHeadlessArgs(), "CTM"));
    // The text reads each spot beside its premium and the days the rate divides by; the spot's minute is the trade's, in As Of UTC.
    expect(text).toMatch(/Contract +Last Trade +Settle +Last +Change +Spot +Vs Spot +Days +Ann Basis +As Of UTC/);
    expect(text).toMatch(/BTCV26 +2026-10-30 +-- +80740\.00 +-- +80600\.00 +\+0\.17% +6\.6 +\+9\.6% +2026-10-24 01:33/);
    expect(text).toMatch(/BTCH27 .* 83035\.00 +-- +-- +-- +-- +-- +2026-10-24 03:52/);
    expect(text).not.toContain("Spot Time");
    expect(text).toMatch(/\nNotes:\n {2}Ann Basis = \(Last \/ spot - 1\) × 365 \/ days to expiry.*\n {2}Basis blank for BTCZ26 .*\n {2}Ann Basis is noisy under 7 days/);
    // Other roots have no basis columns to footnote.
    expect((await run("ES")).result.notes).toBeUndefined();
  });

  test("the CSV carries each row's spot, its minute and the fractional days to expiry", async () => {
    const { result, rows } = await run("BTC");
    const args = createTestHeadlessArgs();
    const freshness = deriveHeadlessFreshness(futuresCurveHeadless, result);
    const csv = renderReportCsv(headlessReportTables(futuresCurveHeadless, result, args, "CTM", freshness, { complete: true, unavailableSymbols: [] }), freshness).split("\n");
    const header = csv.findIndex((line) => line.startsWith("Contract,"));
    expect(csv[header]).toMatch(/^Contract,Last Trade,Settle,Last,Change,Spot,Spot Time UTC,Vs Spot \(%\),Days to Expiry,Ann Basis \(%\),As Of UTC,/);
    expect(csv[header + 1]).toContain(`,80740,,80600,2026-10-24T01:33:00Z,${rows[0]!.vsSpotPct},${rows[0]!.daysToExpiry},${rows[0]!.annualisedBasisPct},2026-10-24T01:33:11Z,`);
    expect(csv[header + 6]).toContain(",83035,,,,,,,2026-10-24T03:52:00Z,");
  });

  test("without spot bars every cell is blank and says why; a stale quote blanks nothing a bar can pair", async () => {
    const missing = await run("BTC", { bars: async () => { throw new Error("no history"); } });
    expect(missing.rows).toHaveLength(6);
    expect(missing.rows.every((row) => row.vsSpotPct === null && row.spot === null)).toBe(true);
    expect(missing.result.notes?.[1]).toBe("Basis blank for BTCV26, BTCX26, BTCH27 (no one-minute spot prices); BTCZ26 (price over two sessions old); BTCF27 (no price); BTCG27 (last trade has no time of day).");
    // Bars of another size are no minute's spot.
    const coarse = await run("BTC", { bars: async () => ({ points: SPOT_BARS, resolution: "5m" }) });
    expect(coarse.rows.every((row) => row.vsSpotPct === null)).toBe(true);
    const stale = await run("BTC", { quote: async (symbol) => createTestQuote({ symbol, price: 80_000, lastUpdated: SPOT_AT - 2 * 3_600_000, dataSource: "live" }) });
    expect(stale.rows[0]).toMatchObject({ spot: 80_600, vsSpotPct: expect.any(Number) });
    expect(stale.metadata.spot).toMatchObject({ symbol: "BTC-USD", price: 80_000, status: "stale", reason: "BTC-USD quote is 2h old" });
    // A quote that cannot be read leaves the spot unnamed; the bars still price each trade.
    const unquoted = await run("BTC", { quote: async () => { throw new Error("no such symbol"); } });
    expect(unquoted.metadata.spot).toEqual({ symbol: "BTC-USD", price: null, asOf: null, status: "missing", reason: "no BTC-USD quote" });
    expect(unquoted.metadata.notices).toEqual(["Basis against BTC-USD spot in each last trade's own minute; not the CME reference rate."]);
    expect(unquoted.rows[1]).toMatchObject({ spot: 80_860 });
  });

  test("contract rows read in one field order for every root, at the root's tick precision", async () => {
    const es = await run("ES");
    const btc = await run("BTC");
    const basisFields = ["spot", "spotTime", "daysToExpiry", "vsSpotPct", "annualisedBasisPct"];
    expect(Object.keys(es.rows[0]!)).toEqual(Object.keys(btc.rows[0]!).filter((key) => !basisFields.includes(key)));
    // A float-noise change reads at the tick: ES ticks in quarters.
    const { ctx } = context();
    const noisy = { ...ctx, apiClient: { getCloudFuturesCurve: async () => ({ ...curve("ES", [{ ...contract("ES", "Z26", 30, 6600.000001), settlement: 6587.750002 }]),
      settlementDate: expiry(-1) }) } as never };
    const result = await futuresCurveHeadless.load(createTestHeadlessArgs({ rawArgument: "ES", argument: "ES", symbols: [], options: {} }), noisy) as HeadlessBundleResult;
    expect(result.sections[0]!.rows![0]).toMatchObject({ price: 6600, change: 12.25 });
  });

  test("other roots and past dates add no basis fields and never read a spot", async () => {
    const es = await run("ES");
    expect(es.reads).toEqual([]);
    expect(es.rows[0]).not.toHaveProperty("vsSpotPct");
    expect(es.metadata).not.toHaveProperty("spot");
    expect(es.metadata).not.toHaveProperty("basisBlankedUnpaired");
    const asOf: FuturesCurveAsOfPayload = { root: "BTC", name: "Bitcoin", date: expiry(-3), asOf: expiry(-3), currency: "USD", quoteUnit: "USD", archiveStart: expiry(-90), gaps: [],
      contracts: [{ contract: "BTCV26", symbol: "BTCV26.CME", label: "Oct 2026", deliveryMonth: "2026-10", expiration: expiry(21), tradeDate: expiry(-3), price: 79_500, volume: 1, openInterest: 1, asOf: `${expiry(-3)}T00:00:00.000Z`, stale: false }] };
    const past = await run("BTC", { asOf }, { date: expiry(-3) });
    expect(past.reads).toEqual([]);
    expect(past.rows[0]).not.toHaveProperty("vsSpotPct");
    expect(past.metadata).not.toHaveProperty("spot");
  });
});

describe("CTM change", () => {
  test("Change is the last trade less the settlement shown; a contract with no trade since that settlement has none and says so", async () => {
    // ES on 23 Oct 2026, Settle 2026-10-22. The source measured each move from the settlement before the contract's own last
    // trade, so ESM27, last traded in the 22 Oct session, read -103.50 against the 21 Oct settle beside ESZ26's -22.00 against the 22nd.
    const es = (code: string, days: number, price: number, settlement: number, change: number, asOf: string): FuturesContract =>
      ({ ...contract("ES", code, days, price, false, asOf), settlement, change });
    const payload: FuturesCurvePayload = { ...curve("ES", [
      es("Z26", 56, 7682.5, 7704.5, -22, "2026-10-23T18:09:23.000Z"),
      es("M27", 237, 7857.25, 7858.75, -103.5, "2026-10-22T19:26:48.000Z"),
      // An evening trade opens the next session's.
      es("U27", 329, 7950, 7944, -98.5, "2026-10-22T22:30:00.000Z"),
      // The settlement itself stands in for an older trade.
      es("Z27", 420, 8028, 8028, -109.5, "2026-10-22"),
      // Without a settlement shown there is nothing to measure from, and nothing more to say.
      { ...es("H28", 511, 8100, 0, 5, "2026-10-23T15:00:00.000Z"), settlement: null },
    ]), settlementDate: "2026-10-22" };
    const ctx = createTestHeadlessContext({ marketData: createTestDataProvider({}), apiClient: { getCloudFuturesCurve: async () => payload } as never });
    const result = await futuresCurveHeadless.load(createTestHeadlessArgs({ rawArgument: "ES", argument: "ES", symbols: [], options: {} }), ctx) as HeadlessBundleResult;
    expect(result.sections[0]!.rows!.map((row) => [row.change, row.noTradeSince])).toEqual([
      [-22, null], [null, "2026-10-22"], [6, null], [null, "2026-10-22"], [null, null]]);
    expect(result.notes).toEqual(["Change blank for ESM27, ESZ27 (no trade since 2026-10-22)."]);
    const text = renderHeadlessPaneText(futuresCurveHeadless, result, createTestHeadlessArgs(), "CTM").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/ESM27 .* 7858\.75 +7857\.25 +-- /);
    // A Cboe price is the settlement itself: its move from the settlement before stays.
    const vix = { ...payload, root: "VX", source: "cboe" as const, contracts: [{ ...contract("VX", "X26", 30, 19.379, false, "2026-10-22"), symbol: "VX/X6", settlement: 19.379, change: 1.1408 }] };
    const cboe = await futuresCurveHeadless.load(createTestHeadlessArgs({ rawArgument: "VX", argument: "VX", symbols: [], options: {} }),
      createTestHeadlessContext({ marketData: createTestDataProvider({}), apiClient: { getCloudFuturesCurve: async () => vix } as never })) as HeadlessBundleResult;
    expect(cboe.sections[0]!.rows![0]).toMatchObject({ change: 1.1408, noTradeSince: null });
    expect(cboe.notes).toBeUndefined();
  });
});

describe("CTM expiry", () => {
  test("a Brent contract expires on its last trading day everywhere, and the roll yield counts to it and reads as a percent", async () => {
    // A fixed clock, with the quotes and the curve stamped at it: the listed 2 Nov date must not appear in the text,
    // which an As Of column dated the day the suite runs would print on 2 Nov.
    const at = "2026-10-29T15:00:00.000Z";
    setSystemTime(new Date(at));
    try {
      // The source lists BZZ26 for Nov 2 and BZF27 for Dec 1; they stop trading Oct 30 and Nov 30.
      const bz = (code: string, listed: string, lastTrade: string, price: number): FuturesContract =>
        ({ ...contract("BZ", code, 30, price, false, at), symbol: `BZ${code}.NYM`, expiration: listed, lastTrade });
      const contracts = [bz("Z26", "2026-11-02", "2026-10-30", 98), bz("F27", "2026-12-01", "2026-11-30", 97)];
      const listedRoll = (98 / 97 - 1) * 365 / 29 * 100;
      const payload: FuturesCurvePayload = { ...curve("BZ", contracts), asOf: at, fetchedAt: at,
        ghosts: [{ label: "1W", requestedDate: "2026-10-22", asOf: null, points: contracts.map((row) => ({ symbol: row.symbol, expiration: row.expiration, price: row.price, asOf: null })) }],
        slope: { ...curve("BZ", []).slope, frontSymbol: "BZZ26.NYM", nextSymbol: "BZF27.NYM", value: -1, annualizedRollYield: listedRoll, state: "backwardation" } };
      const ctx = createTestHeadlessContext({ marketData: createTestDataProvider({}), apiClient: { getCloudFuturesCurve: async () => payload } as never });
      const result = await futuresCurveHeadless.load(createTestHeadlessArgs({ rawArgument: "BZ", argument: "BZ", symbols: [], options: {} }), ctx) as HeadlessBundleResult;
      const section = (title: string) => result.sections.find((entry) => entry.title === title)!;
      expect(section("Contracts").rows!.map((row) => [row.expiration, row.lastTrade])).toEqual([["2026-10-30", "2026-10-30"], ["2026-11-30", "2026-11-30"]]);
      expect(section("1W same-contract history").rows!.map((row) => row.expiration)).toEqual(["2026-10-30", "2026-11-30"]);
      // 31 days between the last trades, not the 29 between the listed dates; JSON keeps the number.
      const roll = (98 / 97 - 1) * 365 / 31 * 100;
      expect(section("Front spread").rows![0]!.annualizedRollYield).toBe(Number(roll.toFixed(2)));
      const text = renderHeadlessPaneText(futuresCurveHeadless, result, createTestHeadlessArgs(), "CTM").replace(/\x1b\[[0-9;]*m/g, "");
      expect(text).toContain(`+${roll.toFixed(2)}%`);
      expect(text).toContain("2026-10-29 15:00");
      expect(text).not.toContain("2026-11-02");
    } finally {
      setSystemTime();
    }
  });
});
