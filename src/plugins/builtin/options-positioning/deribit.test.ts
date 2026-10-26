import { expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import type { HeadlessBundleResult } from "../../../types/plugin";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { GammaPayload, OpenInterestPayload } from "./client";
import { optionsPositioningHeadless } from "./headless";
import { expiryWithTimeLabel, formatContracts, formatPositioningSpot, positioningSpotDetail, settlementTime, wallsByExpiry } from "./model";

// Deribit's BTC book as Gloom Cloud serves it: live OI in coins, expiries settling at 08:00 UTC.
// Read a minute after its spot and OI time, so the fixture never ages into "stale".
const READ_AT = Date.parse("2026-10-22T22:49:34.592Z");
const expiry = (date: string, days: number, maxPain: number) => ({
  date, days, callOI: 87_461.9, putOI: 49_016.5, putCallRatio: 0.56, maxPain, callChange: null, putChange: null,
  expiresAt: `${date}T08:00:00.000Z`,
});
const openInterest: OpenInterestPayload = {
  version: 1, symbol: "BTC-USD", underlying: "BTC-USD", oiDate: "2026-10-22", previousOiDate: null, tracked: false,
  spot: 81_230.13, spotAsOf: "2026-10-22T22:48:34.592Z", delayed: false,
  expiries: [expiry("2026-10-23", 1, 82_000), expiry("2026-10-30", 8, 78_000)],
  expiry: "2026-10-30",
  strikes: [{ strike: 78_000, callOI: 3.1, putOI: 2_068, callChange: null, putChange: null, payout: 11_100_000 }],
  warnings: [], oiAsOf: "2026-10-22T22:48:34.592Z", venue: "Deribit", contract: { size: 1, unit: "BTC" },
};
const gamma: GammaPayload = {
  version: 1, symbol: "BTC-USD", underlying: "BTC-USD", oiDate: "2026-10-22", spot: 81_230.13, spotAsOf: "2026-10-22T22:48:34.592Z",
  delayed: false, expiry: null, expiries: ["2026-10-23", "2026-10-30"], missing: [],
  total: { calls: 3e8, puts: 2e8, net: 1e8 }, band: null, flip: 79_877, quotesAsOf: "2026-10-22T22:48:34.592Z", warnings: [],
  strikes: [{ strike: 80_000, calls: 1e8, puts: 2e8, net: -1e8 }, { strike: 85_000, calls: 2e8, puts: 0, net: 2e8 }],
  byExpiry: [
    { expiry: "2026-10-23", calls: 1e8, puts: 1e8, net: 0, callWall: 82_000, putWall: 81_000 },
    { expiry: "2026-10-30", calls: 2e8, puts: 1e8, net: 1e8, callWall: 85_000, putWall: 80_000 },
  ],
  venue: "Deribit",
};

test("a Deribit expiry is labelled with its 08:00 UTC settlement, a US one by its date alone", () => {
  expect(settlementTime("2026-10-30T08:00:00.000Z")).toBe("08:00 UTC");
  expect(settlementTime(undefined)).toBeNull();
  expect(settlementTime("2026-10-30T00:00:00.000Z")).toBeNull();
  expect(expiryWithTimeLabel({ date: "2026-10-30", expiresAt: "2026-10-30T08:00:00.000Z" })).toBe("Oct 30 '26 08:00 UTC");
  expect(expiryWithTimeLabel({ date: "2026-10-30" })).toBe("Oct 30 '26");
});

test("coin open interest keeps its tenths, and the spot is the venue's index with no US session", () => {
  expect(formatContracts(7_986.7, true)).toBe("7,986.7");
  expect(formatContracts(7_986.7, false)).toBe("7,987");
  expect(positioningSpotDetail(81_230.13, "2026-10-22T22:48:34.592Z", "Deribit").detail).toBe("index 22:48 UTC");
  expect(formatPositioningSpot(81_230.13, "2026-10-22T22:48:34.592Z", "Deribit")).toStartWith("81,230.13 Deribit index 2026-10-22 22:48 UTC");
});

test("each expiry's walls come from the all-expiries gamma, and not from an older server's", () => {
  expect(wallsByExpiry(gamma)?.get("2026-10-30")).toEqual({ callWall: 85_000, putWall: 80_000 });
  expect(wallsByExpiry({ ...gamma, byExpiry: gamma.byExpiry!.map(({ callWall: _c, putWall: _p, ...row }) => row) })).toBeNull();
  expect(wallsByExpiry({ ...gamma, expiry: "2026-10-30" })).toBeNull();
});

test("OPX BTC-USD reports max pain and walls per expiry, settling at 08:00 UTC, with live OI in BTC", async () => {
  const definition = optionsPositioningHeadless("strikes");
  const args = createTestHeadlessArgs({ symbols: ["BTC-USD"] });
  const apiClient = {
    optionsPositioning: async (path: string) => path.startsWith("open-interest") ? openInterest : gamma,
  } as never;
  const result = await definition.load(args, createTestHeadlessContext({ apiClient })) as HeadlessBundleResult;
  const freshness = deriveHeadlessFreshness(definition, result, READ_AT);
  const tables = headlessReportTables(definition, result, args, "OPX", freshness, { complete: true, unavailableSymbols: [] });
  const expiries = tables.tables.find((table) => table.title?.startsWith("Expiries"))!;
  expect(expiries.columns).toEqual(expect.arrayContaining(["Settles", "Call OI (BTC)", "Max pain", "Call wall", "Put wall"]));
  const row = expiries.rows.find((entry) => entry[expiries.columns.indexOf("Expiry")] === "2026-10-30")!;
  expect(row[expiries.columns.indexOf("Settles")]).toBe("08:00 UTC");
  expect(row[expiries.columns.indexOf("Max pain")]).toBe(78_000);
  expect(row[expiries.columns.indexOf("Call wall")]).toBe(85_000);
  expect(row[expiries.columns.indexOf("Put wall")]).toBe(80_000);

  const text = renderHeadlessPaneText(definition, result, args, "OPX", freshness);
  expect(text).toContain("Venue                Deribit");
  expect(text).toContain("1 BTC; OI counts BTC");
  expect(text).toContain("Strikes · Oct 30 '26 08:00 UTC");
  expect(text).toContain("87,461.9");
  // The book is read live, not a day-old OI session.
  expect(freshness.status).toBe("live");
});

test("a bare BTC is read as the coin for OPX, and a coin without options is answered with the ones that have them", () => {
  const definition = optionsPositioningHeadless("strikes");
  expect(definition.symbolAlias?.("btc")).toEqual({
    symbol: "BTC-USD", note: "BTC read as BTC-USD, the coin's options. For the US fund that trades as BTC: gloomberb fn OPX BTC:ARCA",
  });
  expect(definition.symbolAlias?.("IBIT")).toBeNull();
  expect(definition.refuseSymbol?.("SOL-USD")).toEqual({
    message: "Options are not available for SOL-USD.",
    details: "Listed crypto options cover BTC and ETH: gloomberb fn OPX BTC-USD, gloomberb fn OPX ETH-USD."
      + " Bitcoin-linked US listings have their own: gloomberb fn OPX IBIT.",
  });
  expect(definition.refuseSymbol?.("BTC-USD")).toBeNull();
  expect(definition.refuseSymbol?.("SPY")).toBeNull();
});
