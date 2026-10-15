import { describe, expect, test } from "bun:test";
import type { FuturesContract, FuturesCurveAsOfPayload, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import type { HeadlessBundleResult } from "../../../types/plugin";
import { futuresCurveHeadless } from "./headless";

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
// Z26 is flagged stale and F27 has no price; G27 and H27 are priced and not stale but printed long before the spot.
const BTC = [contract("BTC", "V26", 21, 80_200), contract("BTC", "X26", 49, 79_000), contract("BTC", "Z26", 77, 80_400, true), contract("BTC", "F27", 112, null),
  contract("BTC", "G27", 126, 81_000, false, expiry(-1)), contract("BTC", "H27", 140, 81_500, false, new Date(SPOT_AT - 61 * 60_000).toISOString())];

function context(options: { quote?: (symbol: string) => Promise<ReturnType<typeof createTestQuote>>; asOf?: FuturesCurveAsOfPayload } = {}) {
  const reads: string[] = [];
  const marketData = createTestDataProvider({ getQuote: async (symbol) => {
    reads.push(symbol);
    return options.quote ? options.quote(symbol) : createTestQuote({ symbol, price: 80_000, lastUpdated: SPOT_AT, dataSource: "live", listingExchangeName: "CCC" });
  } });
  const apiClient = { getCloudFuturesCurve: async (root: string) => curve(root, root === "BTC" ? BTC : [contract("ES", "Z26", 30, 6600)]),
    getCloudFuturesCurveAsOf: async () => options.asOf! } as never;
  return { reads, ctx: createTestHeadlessContext({ marketData, apiClient }) };
}
async function run(root: string, ctxOptions: Parameters<typeof context>[0] = {}, options: Record<string, string> = {}) {
  const { reads, ctx } = context(ctxOptions);
  const result = await futuresCurveHeadless.load(createTestHeadlessArgs({ rawArgument: root, argument: root, symbols: [], options }), ctx) as HeadlessBundleResult;
  return { reads, result, rows: result.sections[0]!.rows as Array<Record<string, unknown>>, metadata: result.metadata as Record<string, unknown> };
}

describe("CTM report units", () => {
  test("Dutch TTF gas reports euros per MWh on every row, in the metadata and as its one contract term", async () => {
    const eur = { ...curve("TTF", [{ ...contract("TTF", "X26", 30, 81.434), currency: "EUR", quoteUnit: "EUR", change: 2.5849999 }]), currency: "EUR", quoteUnit: "EUR" };
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
  test("each crypto contract carries its premium and annualised basis, and the metadata names the spot", async () => {
    const { reads, rows, metadata } = await run("BTC");
    expect(reads).toEqual(["BTC-USD"]);
    expect(rows.map((row) => [row.vsSpotPct, row.annualisedBasisPct])).toEqual([
      [0.25, Number((0.0025 * 365 / 21 * 100).toFixed(4))], [-1.25, Number((-0.0125 * 365 / 49 * 100).toFixed(4))],
      // A stale print and a missing price are blank, not zero, and so is a print over an hour before the spot.
      [null, null], [null, null], [null, null], [null, null],
    ]);
    expect(metadata.basisBlankedThin).toBe(2);
    expect(metadata.spot).toEqual({ symbol: "BTC-USD", price: 80_000, asOf: new Date(SPOT_AT).toISOString().replace(".000Z", "Z"), status: "ok", reason: null, venue: "CCC", feed: "real-time" });
    // The spot is named as the quote path reports it, and is the terminal's quote, not the CME reference rate.
    expect(metadata.notices).toEqual([expect.stringMatching(/^Basis against spot BTC-USD 80,000\.00 · .* UTC \(CCC, real-time\); not the CME reference rate\.$/)]);
  });

  test("the footnotes give the convention, why each blank cell is blank and how noisy a short-dated rate is", async () => {
    const { result } = await run("BTC");
    expect(result.notes).toEqual([
      "Ann Basis = (Last / spot - 1) × 365 / days to expiry: simple actual/365, the latest trade against the spot quote.",
      "Basis blank for BTCZ26 (price over two sessions old); BTCF27 (no price); BTCG27, BTCH27 (last trade over 1h before the spot quote).",
      // 21 days to the front contract: 0.1% x 365 / 21 = 1.7 points a year.
      "Ann Basis is noisy under 30 days to expiry: 10 bp of spot noise moves BTCV26 (21d) by ±1.7 points.",
    ]);
    const text = renderHeadlessPaneText(futuresCurveHeadless, result, createTestHeadlessArgs(), "CTM").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/\nNotes:\n {2}Ann Basis = \(Last \/ spot - 1\) × 365 \/ days to expiry.*\n {2}Basis blank for BTCZ26 .*\n {2}Ann Basis is noisy under 30 days/);
    // A spot that is not usable blanks every cell for its own reason, which the notice gives: the convention stays, nothing else.
    const stale = await run("BTC", { quote: async (symbol) => createTestQuote({ symbol, price: 80_000, lastUpdated: SPOT_AT - 2 * 3_600_000, dataSource: "live" }) });
    expect(stale.result.notes).toEqual([expect.stringContaining("Ann Basis = (Last / spot - 1)")]);
    // Other roots have no basis columns to footnote.
    expect((await run("ES")).result.notes).toBeUndefined();
  });

  test("a stale or missing spot blanks the fields and the report says why", async () => {
    const stale = await run("BTC", { quote: async (symbol) => createTestQuote({ symbol, price: 80_000, lastUpdated: SPOT_AT - 2 * 3_600_000, dataSource: "live" }) });
    expect(stale.rows.every((row) => row.vsSpotPct === null && row.annualisedBasisPct === null)).toBe(true);
    expect(stale.metadata.spot).toMatchObject({ symbol: "BTC-USD", price: 80_000, status: "stale", reason: "BTC-USD quote is 2h old" });
    expect(stale.metadata.notices).toEqual(["Basis blank: BTC-USD quote is 2h old."]);
    // The curve still loads without its basis.
    const missing = await run("BTC", { quote: async () => { throw new Error("no such symbol"); } });
    expect(missing.rows).toHaveLength(6);
    expect(missing.rows.every((row) => row.vsSpotPct === null)).toBe(true);
    // With no spot nothing is blanked for being thin: the reason is the spot's.
    expect(missing.metadata.basisBlankedThin).toBe(0);
    expect(stale.metadata.basisBlankedThin).toBe(0);
    expect(missing.metadata.spot).toEqual({ symbol: "BTC-USD", price: null, asOf: null, status: "missing", reason: "no BTC-USD quote" });
  });

  test("contract rows read in one field order for every root, at the root's tick precision", async () => {
    const es = await run("ES");
    const btc = await run("BTC");
    expect(Object.keys(es.rows[0]!)).toEqual(Object.keys(btc.rows[0]!).filter((key) => key !== "vsSpotPct" && key !== "annualisedBasisPct"));
    // A float-noise change reads at the tick: ES ticks in quarters.
    const { ctx } = context();
    const noisy = { ...ctx, apiClient: { getCloudFuturesCurve: async () => curve("ES", [{ ...contract("ES", "Z26", 30, 6600.000001), change: 12.249999 }]) } as never };
    const result = await futuresCurveHeadless.load(createTestHeadlessArgs({ rawArgument: "ES", argument: "ES", symbols: [], options: {} }), noisy) as HeadlessBundleResult;
    expect(result.sections[0]!.rows![0]).toMatchObject({ price: 6600, change: 12.25 });
  });

  test("other roots and past dates add no basis fields and never read a spot", async () => {
    const es = await run("ES");
    expect(es.reads).toEqual([]);
    expect(es.rows[0]).not.toHaveProperty("vsSpotPct");
    expect(es.metadata).not.toHaveProperty("spot");
    expect(es.metadata).not.toHaveProperty("basisBlankedThin");
    const asOf: FuturesCurveAsOfPayload = { root: "BTC", name: "Bitcoin", date: expiry(-3), asOf: expiry(-3), currency: "USD", quoteUnit: "USD", archiveStart: expiry(-90), gaps: [],
      contracts: [{ contract: "BTCV26", symbol: "BTCV26.CME", label: "Oct 2026", deliveryMonth: "2026-10", expiration: expiry(21), tradeDate: expiry(-3), price: 79_500, volume: 1, openInterest: 1, asOf: `${expiry(-3)}T00:00:00.000Z`, stale: false }] };
    const past = await run("BTC", { asOf }, { date: expiry(-3) });
    expect(past.reads).toEqual([]);
    expect(past.rows[0]).not.toHaveProperty("vsSpotPct");
    expect(past.metadata).not.toHaveProperty("spot");
    expect(past.metadata).not.toHaveProperty("basisBlankedThin");
  });
});

describe("CTM expiry", () => {
  test("a Brent contract expires on its last trading day everywhere, and the roll yield counts to it and reads as a percent", async () => {
    // The source lists BZZ26 for Nov 2 and BZF27 for Dec 1; they stop trading Oct 30 and Nov 30.
    const bz = (code: string, listed: string, lastTrade: string, price: number): FuturesContract =>
      ({ ...contract("BZ", code, 30, price), symbol: `BZ${code}.NYM`, expiration: listed, lastTrade });
    const contracts = [bz("Z26", "2026-11-02", "2026-10-30", 98), bz("F27", "2026-12-01", "2026-11-30", 97)];
    const listedRoll = (98 / 97 - 1) * 365 / 29 * 100;
    const payload: FuturesCurvePayload = { ...curve("BZ", contracts),
      ghosts: [{ label: "1W", requestedDate: expiry(-7), asOf: null, points: contracts.map((row) => ({ symbol: row.symbol, expiration: row.expiration, price: row.price, asOf: null })) }],
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
    expect(text).not.toContain("2026-11-02");
  });
});
