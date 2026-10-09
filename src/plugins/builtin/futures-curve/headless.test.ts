import { describe, expect, test } from "bun:test";
import type { FuturesContract, FuturesCurveAsOfPayload, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
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
    return options.quote ? options.quote(symbol) : createTestQuote({ symbol, price: 80_000, lastUpdated: SPOT_AT, dataSource: "live" });
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
    expect(metadata.spot).toEqual({ symbol: "BTC-USD", price: 80_000, asOf: new Date(SPOT_AT).toISOString().replace(".000Z", "Z"), status: "ok", reason: null });
    expect(metadata.notices).toEqual([expect.stringMatching(/^Basis against spot BTC-USD 80,000\.00 · /)]);
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
