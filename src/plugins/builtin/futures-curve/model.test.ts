import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesContract, FuturesCurveAsOfPayload, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { fetchFuturesCurve, validateFuturesCurve } from "./client";
import { FUTURES_CONTRACTS } from "../../../market-data/futures-board";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { annualisedBasisPct, archivedFuturesCurve, basisSpotSymbol, blankBasisNote, contractBasis, CURVE_ROOTS, curveAsOfDate, curveAxisPrice, curveBasisPercent, curveBasisRows, curveChangeText, curveContractChanges, curveContractMonth, curvePrice, curveRank, curveRootForTicker, curveSpot, curveSpotLabel, curveSpotSource, curveSpreadLabel, curveUnitLabel, daysToExpiry, futuresCurveSeries, newestQuote, normalizeCurveRoot, shortDatedBasis, shortDatedBasisNote, sortCurveContracts, spotBarsFromHistory, unpairedContractCount, vsSpotPct } from "./model";
import { futuresCurveModule } from "./index";

const first: FuturesContract = { symbol: "CLX26.NYM", label: "Nov 2026", expiration: "2026-10-20",
  price: 80, asOf: "2026-09-22T15:00:00Z", currency: "USD", quoteUnit: "USD", volume: 0, openInterest: 0, delayMinutes: 10,
  stale: false, percentile: 50, samples: 200, historyStart: "2025-09-22", historyEnd: "2026-09-21" };
function payload(): FuturesCurvePayload {
  return { root: "CL", name: "WTI Crude Oil", source: "gloom", currency: "USD", quoteUnit: "USD", asOf: first.asOf,
    fetchedAt: "2026-09-22T15:05:00Z", status: "partial", stale: false,
    catalogue: { method: "bounded-search", complete: false, horizonEnd: "2029-09-01" },
    contracts: [first, { ...first, symbol: "CLZ26.NYM", expiration: "2026-11-20", price: null, openInterest: null, percentile: null, samples: 0 }],
    ghosts: [{ label: "1W", requestedDate: "2026-09-15", asOf: "2026-09-15", points: [
      { symbol: first.symbol, expiration: first.expiration, price: 75, asOf: "2026-09-15" },
      { symbol: "CLZ26.NYM", expiration: "2026-11-20", price: null, asOf: null },
    ] }],
    slope: { frontSymbol: first.symbol, nextSymbol: "CLZ26.NYM", value: null, annualizedRollYield: null,
      percentile: null, rollPercentile: null, samples: 0, historyStart: null, historyEnd: null, asOf: null, state: "unavailable" },
    gaps: ["Provider catalogue incomplete"],
  };
}

test("partial curve preserves actual expiries, null ghost legs and reported zero activity", () => {
  const data = validateFuturesCurve(payload(), "CL");
  const series = futuresCurveSeries(data);
  expect(series[0]!.points[0]!.x).toBe(Date.parse("2026-10-20"));
  expect(series[1]!.asOf).toBe("2026-09-15");
  expect(series[1]!.points[1]!.value).toBeNull();
  expect(data.contracts.map((row) => row.openInterest)).toEqual([0, null]);
  expect(data.contracts[0]!.volume).toBe(0);
  expect(curveRank(50, 1)).toBe("pctl unavailable");
});

test("rejects cross-root responses, invalid expiries, nonfinite prices and mismatched historical contracts", () => {
  expect(() => validateFuturesCurve(payload(), "ES")).toThrow("invalid futures curve");
  const badDate = payload(); badDate.contracts = [{ ...first, expiration: "2026-02-30" }];
  expect(() => validateFuturesCurve(badDate, "CL")).toThrow("invalid futures contract");
  const badPrice = payload(); badPrice.contracts = [{ ...first, price: Infinity }];
  expect(() => validateFuturesCurve(badPrice, "CL")).toThrow("invalid futures contract");
  const badChange = payload(); badChange.contracts = [{ ...first, change: Number.NaN }];
  expect(() => validateFuturesCurve(badChange, "CL")).toThrow("invalid futures contract");
  // A curve cached before the server kept the session change still loads.
  expect(validateFuturesCurve(payload(), "CL").contracts[0]!.change).toBeUndefined();
  const badGhost = payload(); badGhost.ghosts[0]!.points[0]!.symbol = "ESZ26.CME";
  expect(() => validateFuturesCurve(badGhost, "CL")).toThrow("invalid futures history");
});

test("normalizes FUT aliases before cloud request and handles missing endpoints without swallowing access errors", async () => {
  const requested: string[] = [];
  await fetchFuturesCurve("cl=f", { getCloudFuturesCurve: async (root) => { requested.push(root); return payload(); } });
  expect(requested).toEqual(["CL"]);
  await expect(fetchFuturesCurve("BAD", { getCloudFuturesCurve: async () => { throw new Error("should not request"); } })).rejects.toThrow("No futures curve for BAD");
  expect(normalizeCurveRoot("ttf=f")).toBe("TTF");
  await expect(fetchFuturesCurve("CL", { getCloudFuturesCurve: async () => { throw new ApiRequestError("Not found", 404); } })).rejects.toThrow("not available yet");
  const denied = new ApiRequestError("Forbidden", 403);
  await expect(fetchFuturesCurve("CL", { getCloudFuturesCurve: async () => { throw denied; } })).rejects.toBe(denied);
});

test("charts the strip within the horizon and dates it by its freshest quote, not the oldest", () => {
  const data = payload();
  data.asOf = "2020-04-07T17:14:00Z";
  data.contracts = [first, { ...first, symbol: "CLZ28.NYM", expiration: "2028-11-20", asOf: "2020-04-07T17:14:00Z", stale: true },
    { ...first, symbol: "CLZ36.NYM", expiration: "2036-11-20", asOf: "2026-09-16T19:24:47Z", stale: true }];
  data.ghosts[0]!.points = data.contracts.map((row) => ({ symbol: row.symbol, expiration: row.expiration, price: 70, asOf: "2026-09-15" }));
  const now = Date.parse("2026-09-22T16:00:00Z");
  const near = futuresCurveSeries(data, undefined, "24", now);
  expect(near[0]!.points.map((point) => point.id)).toEqual(["CLX26.NYM"]);
  expect(near[0]!.asOf).toBe(first.asOf);
  expect(near[1]!.points.map((point) => point.id)).toEqual(["CLX26.NYM"]);
  // The payload dates the ghost by its oldest point, here a contract beyond the charted horizon.
  data.ghosts[0]!.points[2]!.asOf = "2026-09-14";
  data.ghosts[0]!.asOf = "2026-09-14";
  expect(futuresCurveSeries(data, undefined, "24", now)[1]!.asOf).toBe("2026-09-15");
  const all = futuresCurveSeries(data, undefined, "all", now);
  expect(all[0]!.points).toHaveLength(3);
  expect(all[0]!.asOf).toBe(first.asOf);
  expect(newestQuote([])).toBeNull();
});

test("Treasury prices keep one decimal count per root on their 32nd tick grid and contracts read by delivery month", () => {
  expect(curvePrice(105.265625, "ZN")).toBe("105.265625");
  expect(curvePrice(105.5, "ZN")).toBe("105.500000");
  expect(curvePrice(101.6796875, "ZT")).toBe("101.67968750");
  expect(curvePrice(108, "ZB")).toBe("108.00000");
  expect(curvePrice(-0.1875, "ZN")).toBe("-0.187500");
  expect(curvePrice(-0.001, "CL")).toBe("0.00");
  expect(curvePrice(0.00635, "6J")).toBe("0.0063500");
  // Crude's November contract expires in October.
  expect(curveContractMonth("CLX26.NYM", "2026-10-20")).toBe("Nov 26");
  expect(curveContractMonth("ZFZ26.CBT", "2026-12-31")).toBe("Dec 26");
  expect(curveContractMonth("RTYH27.CME", "2027-03-19")).toBe("Mar 27");
  expect(curveContractMonth("VX/V6", "2026-10-21")).toBe("Oct 26");
});

test("CME crypto roots are listed with prices at their tick, and FUT's board keeps its own list", () => {
  expect(CURVE_ROOTS.filter((row) => ["BTC", "ETH", "SOL", "XRP"].includes(row.value)).map((row) => row.label)).toEqual(["BTC Bitcoin", "ETH Ether", "SOL Solana", "XRP"]);
  expect(futuresCurveModule.paneTemplates?.[0]?.shortcut?.argOptions?.().map((row) => row.value)).toEqual(expect.arrayContaining(["BTC", "ETH", "SOL", "XRP"]));
  expect(FUTURES_CONTRACTS.some((row) => ["BTC", "ETH", "SOL", "XRP"].includes(row.code))).toBe(false);
  // BTC $5, ETH $0.50, SOL $0.05 and XRP $0.0005 ticks, as the live curves quote them.
  expect(curvePrice(82470, "BTC")).toBe("82470.00");
  expect(curvePrice(2492.5, "ETH")).toBe("2492.50");
  expect(curvePrice(110.1, "SOL")).toBe("110.10");
  expect(curvePrice(1.399, "XRP")).toBe("1.3990");
  expect(curveChangeText(-0.0935, "XRP")).toBe("-0.0935");
});

test("Dutch TTF gas is a curve root that reads in euros per MWh at its 0.001 tick", () => {
  expect(["ttf", "TTF=F", " ttf "].map(normalizeCurveRoot)).toEqual(["TTF", "TTF", "TTF"]);
  expect(["TTF", "TTF=F"].map(curveRootForTicker)).toEqual(["TTF", "TTF"]);
  expect(CURVE_ROOTS.find((row) => row.value === "TTF")).toBeDefined();
  expect(curvePrice(81.434, "TTF")).toBe("81.434");
  expect(curvePrice(62.72, "TTF")).toBe("62.720");
  expect(curveChangeText(2.5849999, "TTF")).toBe("+2.585");
  expect(curveChangeText(-0.088, "TTF")).toBe("-0.088");
  const ttf = { ...payload(), root: "TTF", currency: "EUR", quoteUnit: "EUR", spec: null };
  // The server sends no contract terms for the euro contract, so the catalogue says what a price counts.
  expect(curveUnitLabel(ttf)).toBe("EUR / MWh");
  // A root with neither terms nor a catalogue unit reads its quote unit, and the server's terms win.
  expect(curveUnitLabel({ ...payload(), spec: null })).toBe("USD");
  expect(curveUnitLabel({ ...ttf, spec: { unit: "EUR / MWh", size: "1 MW", pointValue: 1, tick: 0.001, tickValue: 0.001, settlement: "cash" } })).toBe("EUR / MWh");
  // A past TTF curve keeps the archive's euro rather than defaulting to dollars.
  const past = archivedFuturesCurve("TTF", { root: "TTF", name: "Dutch TTF Natural Gas", date: "2026-10-02", asOf: "2026-10-02", currency: "EUR", quoteUnit: "EUR",
    archiveStart: "2020-11-30", gaps: [], spec: null, contracts: [{ contract: "TTFX26", symbol: "TTFX26.NYM", label: "Nov 26", deliveryMonth: "2026-11", expiration: "2026-10-29",
      tradeDate: "2026-10-02", price: 74.76, volume: 458, openInterest: 1449, asOf: "2026-10-02T04:00:00.000Z", stale: false, settled: true }] },
  { "1W": null, "1M": null }, "2026-10-11T00:00:00Z");
  expect(past.contracts[0]).toMatchObject({ currency: "EUR", quoteUnit: "EUR" });
  expect(curveUnitLabel(past)).toBe("EUR / MWh");
});

test("every FUT board root opens a curve, as a typed code or an =F symbol; the cursor keeps a security's code", async () => {
  const requested: string[] = [];
  for (const row of FUTURES_CONTRACTS) {
    for (const typed of [row.code, row.code.toLowerCase(), row.symbol]) expect(normalizeCurveRoot(typed)).toBe(row.code);
    expect(CURVE_ROOTS.some((root) => root.value === row.code)).toBe(true);
    await fetchFuturesCurve(row.symbol, { getCloudFuturesCurve: async (root) => { requested.push(root); return { ...payload(), root }; } });
  }
  expect(requested).toEqual(FUTURES_CONTRACTS.map((row) => row.code));
  // Zoom, KC wheat's, live cattle's, lean hogs' and aluminum's codes are listed securities too, as are those of a sector ETF
  // (XAR), Goldmoney (XAU), Sensient (SXT) and the micros listed abroad: under the cursor they open the curve only as the
  // future's symbol, while a typed argument always means the future.
  const securities = ["ZM", "KE", "LE", "HE", "ALI", "EMD", "RS1", "MES", "MYM", "M2K", "SXT", "SXI", "SOX", "XAU", "XAR", "RX", "MCL", "MNG", "HH"];
  for (const row of FUTURES_CONTRACTS) {
    expect(curveRootForTicker(row.symbol)).toBe(row.code);
    expect(curveRootForTicker(row.code.toLowerCase())).toBe(securities.includes(row.code) ? null : row.code);
  }
  // No bare-code row has a security answering to it, so those open from the cursor like ES always has.
  expect(["ZL", "OJ", "LBR", "ZW", "TTF", "SXO"].map(curveRootForTicker)).toEqual(["ZL", "OJ", "LBR", "ZW", "TTF", "SXO"]);
  const template = futuresCurveModule.paneTemplates![0]!;
  const open = (arg: string | undefined, activeTicker: string | null) => template.createInstance!({ activeTicker } as never, { arg } as never);
  expect(await open(undefined, "ZM")).toMatchObject({ title: "Curve · ES", params: { root: "ES" } });
  expect(await open("ZM", "ZM")).toMatchObject({ title: "Curve · ZM", params: { root: "ZM" } });
  expect(await open(undefined, "ZM=F")).toMatchObject({ title: "Curve · ZM", params: { root: "ZM" } });
  expect(await open(undefined, "ALI")).toMatchObject({ title: "Curve · ES", params: { root: "ES" } });
  expect(await open(undefined, "OJ")).toMatchObject({ title: "Curve · OJ", params: { root: "OJ" } });
});

test("roots the server sends no terms for read their catalogue unit, each price at its tick", () => {
  const curve = (root: string, quoteUnit: string) => ({ ...payload(), root, currency: quoteUnit, quoteUnit, spec: null });
  expect([["ALI", "USD"], ["OJ", "USX"], ["LBR", "USD"], ["LE", "USX"], ["HE", "USX"]].map(([root, unit]) => curveUnitLabel(curve(root!, unit!))))
    .toEqual(["USD / metric ton", "US cents / lb", "USD / 1,000 board ft", "US cents / lb", "US cents / lb"]);
  // Soybean meal to a dime, live cattle and lean hogs to 0.025 cents, lumber to 50 cents.
  expect([["ZM", 368.7], ["ZL", 67.72], ["KE", 719.25], ["OJ", 149.95], ["LE", 224.975], ["HE", 75.05], ["LBR", 533], ["ALI", 3172.5]]
    .map(([root, price]) => curvePrice(price as number, root as string))).toEqual(["368.70", "67.72", "719.25", "149.95", "224.975", "75.050", "533.00", "3172.50"]);
});

test("a crypto root opens from a typed argument, a crypto ticker or a futures symbol, never from the equity under the cursor", async () => {
  expect(["btc", "ETH", "sol=f", " xrp "].map(normalizeCurveRoot)).toEqual(["BTC", "ETH", "SOL", "XRP"]);
  // BTC and ETH are Grayscale's mini trusts, SOL an equity too: the bare symbol is theirs.
  expect(["BTC", "ETH", "SOL", "XRP", "btc"].map(curveRootForTicker)).toEqual([null, null, null, null, null]);
  expect(["BTC-USD", "eth-usd", "BTC=F", "SOL-USD", "XRP=F"].map(curveRootForTicker)).toEqual(["BTC", "ETH", "BTC", "SOL", "XRP"]);
  expect(["DOGE-USD", "AAPL", null].map(curveRootForTicker)).toEqual([null, null, null]);
  // The futures that already follow the cursor still do.
  expect(["ES", "CL=F", "gc"].map(curveRootForTicker)).toEqual(["ES", "CL", "GC"]);

  const template = futuresCurveModule.paneTemplates![0]!;
  const open = (arg: string | undefined, activeTicker: string | null) => template.createInstance!({ activeTicker } as never, { arg } as never);
  expect(await open("BTC", "AAPL")).toMatchObject({ title: "Curve · BTC", params: { root: "BTC" } });
  expect(await open(undefined, "BTC")).toMatchObject({ title: "Curve · ES", params: { root: "ES" } });
  expect(await open(undefined, "ETH-USD")).toMatchObject({ title: "Curve · ETH", params: { root: "ETH" } });
  expect(await open(undefined, "SOL")).toMatchObject({ title: "Curve · ES" });
  // An explicit argument still wins over the cursor.
  expect(await open("XRP", "BTC-USD")).toMatchObject({ title: "Curve · XRP" });
  const requested: string[] = [];
  await fetchFuturesCurve("btc", { getCloudFuturesCurve: async (root) => { requested.push(root); return { ...payload(), root }; } });
  expect(requested).toEqual(["BTC"]);
});

test("each contract's move since the look-back curves, with missing legs left empty", () => {
  const data = payload();
  data.ghosts.push({ label: "1M", requestedDate: "2026-08-22", asOf: "2026-08-22", points: [
    { symbol: first.symbol, expiration: first.expiration, price: 82.5, asOf: "2026-08-22" },
  ] });
  const changes = curveContractChanges(data);
  expect(changes.get("CLX26.NYM")).toEqual({ "1W": 5, "1M": -2.5 });
  // No latest price on the second contract, and no month-back quote either.
  expect(changes.get("CLZ26.NYM")).toEqual({ "1W": null, "1M": null });
  expect(curveChangeText(5, "CL")).toBe("+5.00");
  expect(curveChangeText(-2.5, "CL")).toBe("-2.50");
  expect(curveChangeText(0.001, "CL")).toBe("0.00");
  expect(curveChangeText(null, "CL")).toBe("--");
  // The change columns sort like any other, with gaps last.
  const rows = [first, { ...first, symbol: "CLZ26.NYM", price: null }, { ...first, symbol: "CLF27.NYM" }];
  const moves = new Map([["CLX26.NYM", { "1W": 5, "1M": null }], ["CLZ26.NYM", { "1W": null, "1M": null }], ["CLF27.NYM", { "1W": -1, "1M": null }]]);
  expect(sortCurveContracts(rows, "change1w", "desc", moves).map((row) => row.symbol)).toEqual(["CLX26.NYM", "CLF27.NYM", "CLZ26.NYM"]);
  expect(sortCurveContracts(rows, "change1w", "asc", moves).map((row) => row.symbol)).toEqual(["CLF27.NYM", "CLX26.NYM", "CLZ26.NYM"]);
});

describe("basis against spot", () => {
  const SPOT_AT = Date.parse("2026-10-09T07:25:00Z");
  const btc = { price: 67_250.1, lastUpdated: SPOT_AT };
  const minute = (time: string) => Date.parse(`2026-10-09T${time}:00Z`);
  // One-minute spot bars from 07:20 to 07:25 UTC, BTC-USD rising $50 a minute; 07:23 is missing.
  const BARS = spotBarsFromHistory(["07:20", "07:21", "07:22", "07:24", "07:25"].map((time, index) => ({ date: new Date(minute(time)), close: 67_000 + index * 50 })));
  const contract = { price: 67_500, stale: false, expiration: "2026-12-25", asOf: "2026-10-09T07:24:30Z" as string | null };

  test("a premium is positive in contango and negative in backwardation, annualised on a 365-day year", () => {
    expect(vsSpotPct(67_500, 67_250.1)).toBeCloseTo((67_500 / 67_250.1 - 1) * 100, 10);
    expect(vsSpotPct(66_000, 67_250.1)!).toBeLessThan(0);
    expect(annualisedBasisPct(67_500, 67_250.1, 77)).toBeCloseTo((67_500 / 67_250.1 - 1) * 365 / 77 * 100, 10);
    expect(annualisedBasisPct(66_000, 67_250.1, 77)!).toBeLessThan(0);
    for (const bad of [null, undefined, 0, -1, Number.NaN, Infinity]) {
      expect(vsSpotPct(bad, 67_250.1)).toBeNull();
      expect(annualisedBasisPct(67_500, bad, 77)).toBeNull();
    }
    expect(annualisedBasisPct(67_500, 67_250.1, null)).toBeNull();
  });

  test("days to expiry run to final settlement at 16:00 London, in fractions of a day, across the clock change", () => {
    // Saturday 24 Oct 01:33 UTC to Friday 30 Oct 16:00 London, which is GMT again after the 25th: 6 days 14h27m, not the 6 UTC dates.
    expect(daysToExpiry(Date.parse("2026-10-24T01:33:00Z"), "2026-10-30")).toBeCloseTo(6 + (14 * 60 + 27) / 1440, 10);
    // In summer 16:00 London is 15:00 UTC.
    expect(daysToExpiry(Date.parse("2026-06-20T15:00:00Z"), "2026-06-26")).toBe(6);
    // The last morning still has hours to run; after the fixing there is no rate, and the premium stays.
    expect(daysToExpiry(Date.parse("2026-10-30T10:00:00Z"), "2026-10-30")).toBeCloseTo(0.25, 10);
    // 9 Oct is still summer time: the fixing is at 15:00 UTC.
    const late = { ...contract, expiration: "2026-10-09", asOf: "2026-10-09T07:22:10Z" };
    expect(contractBasis(late, BARS)).toMatchObject({ annualisedBasisPct: expect.any(Number), daysToExpiry: expect.closeTo((15 * 3600 - (7 * 3600 + 22 * 60 + 10)) / 86_400, 10) });
    const settled = { ...late, expiration: "2026-10-08" };
    expect(contractBasis(settled, BARS)).toMatchObject({ vsSpotPct: expect.any(Number), annualisedBasisPct: null });
    expect(daysToExpiry(SPOT_AT, "soon")).toBeNull();
  });

  test("each trade is read against the spot bar of its own minute, never a spot from another minute", () => {
    // The trade at 07:24:30 reads the 07:24 bar's close, 67,150, though a later spot (67,200 at 07:25) is known.
    const basis = contractBasis(contract, BARS);
    expect(basis).toEqual({ vsSpotPct: vsSpotPct(67_500, 67_150), annualisedBasisPct: annualisedBasisPct(67_500, 67_150, daysToExpiry(Date.parse(contract.asOf!), contract.expiration)),
      spot: 67_150, spotTime: "2026-10-09T07:24:00Z", daysToExpiry: daysToExpiry(Date.parse(contract.asOf!), contract.expiration), unpaired: null });
    // The same trade reads the same basis however the bars around its minute move.
    const moved = spotBarsFromHistory([{ date: new Date(minute("07:24")), close: 67_150 }, { date: new Date(minute("07:25")), close: 69_000 }]);
    expect(contractBasis(contract, moved).vsSpotPct).toBe(basis.vsSpotPct);
  });

  test("a trade no spot bar shares a minute with is blank, before or after the bars alike, and says how far apart they are", () => {
    const at = (asOf: string | null) => contractBasis({ ...contract, asOf }, BARS);
    // After the newest bar (a delayed spot trails the futures), before the oldest, and in a minute the bars skip.
    expect(at("2026-10-09T07:31:05Z")).toEqual({ vsSpotPct: null, annualisedBasisPct: null, spot: null, spotTime: null, daysToExpiry: null,
      unpaired: { print: Date.parse("2026-10-09T07:31:05Z"), spot: minute("07:25") } });
    expect(at("2026-10-09T07:14:59Z").unpaired).toEqual({ print: Date.parse("2026-10-09T07:14:59Z"), spot: minute("07:20") });
    expect(at("2026-10-09T07:23:00Z").unpaired).toMatchObject({ spot: expect.any(Number) });
    // A date-only price has no minute to pair; with no bars at all there is nothing near.
    expect(at("2026-10-09").unpaired).toEqual({ print: null, spot: null });
    expect(at(null).unpaired).toEqual({ print: null, spot: null });
    expect(contractBasis(contract, []).unpaired).toEqual({ print: Date.parse(contract.asOf!), spot: null });
    // Until the bars are known, and for rows another rule blanks, nothing is unpaired, so nothing is counted twice.
    expect(contractBasis(contract, null)).toMatchObject({ vsSpotPct: null, unpaired: null });
    expect(contractBasis({ ...contract, stale: true }, BARS).unpaired).toBeNull();
    expect(contractBasis({ ...contract, price: null }, BARS).unpaired).toBeNull();
    expect(unpairedContractCount([at("2026-10-09T07:31:05Z"), at("2026-10-09"), at("2026-10-09T07:24:00Z")])).toBe(2);
  });

  test("bars are read by minute, oldest first, without closes that cannot price anything", () => {
    expect(spotBarsFromHistory([
      { date: "2026-10-09T07:21:00.000Z", close: 2 }, { date: new Date(minute("07:20")), close: 1 },
      { date: new Date(minute("07:22")), close: Number.NaN }, { date: "not a date", close: 3 }, { date: new Date(minute("07:23")), close: 0 },
    ])).toEqual([{ minute: minute("07:20"), price: 1 }, { minute: minute("07:21"), price: 2 }]);
  });

  test("spot is stale past ten minutes of the quote's own time, with a delayed feed's hold-back allowed on top", () => {
    const minutes = (count: number) => SPOT_AT + count * 60_000;
    expect(curveSpot("BTC-USD", btc, minutes(10))).toMatchObject({ status: "ok", price: 67_250.1, asOf: "2026-10-09T07:25:00Z", reason: null });
    expect(curveSpot("BTC-USD", btc, minutes(11))).toMatchObject({ status: "stale", reason: "BTC-USD quote is 11m old", price: 67_250.1 });
    expect(curveSpot("BTC-USD", btc, SPOT_AT + 2.5 * 3_600_000).reason).toBe("BTC-USD quote is 2h old");
    // The free tier's quotes are always about 15 minutes old; that is the feed, not a stall.
    const delayed = { ...btc, dataSource: "delayed" };
    expect(curveSpot("BTC-USD", delayed, minutes(17)).status).toBe("ok");
    expect(curveSpot("BTC-USD", delayed, minutes(26)).status).toBe("stale");
    expect(curveSpot("BTC-USD", { ...btc, stale: true }, minutes(1))).toMatchObject({ status: "stale", reason: "BTC-USD quote is stale" });
    expect(curveSpot("BTC-USD", { ...btc, lastUpdated: 0 }, SPOT_AT)).toMatchObject({ status: "stale", asOf: null });
    expect(curveSpot("BTC-USD", null, SPOT_AT)).toEqual({ symbol: "BTC-USD", price: null, asOf: null, status: "missing", reason: "no BTC-USD quote" });
  });

  test("cells read to two decimals and one, signed, and the footer names the spot and its UTC time", () => {
    expect(curveBasisPercent(0.4213, 2)).toBe("+0.42%");
    expect(curveBasisPercent(-0.4213, 2)).toBe("-0.42%");
    expect(curveBasisPercent(-0.001, 2)).toBe("0.00%");
    expect(curveBasisPercent(null, 1)).toBe("--");
    const spot = curveSpot("BTC-USD", btc, SPOT_AT);
    expect(curveSpotLabel(spot, "BTC", SPOT_AT)).toBe("spot BTC-USD 67,250.10 · 07:25 UTC");
    // A quote from an earlier UTC day carries its date.
    expect(curveSpotLabel(spot, "BTC", SPOT_AT + 86_400_000)).toBe("spot BTC-USD 67,250.10 · 2026-10-09 07:25 UTC");
  });

  test("the quote's listing is named in plain words, never as its code, with its feed beside it", () => {
    const reported = curveSpot("BTC-USD", { ...btc, listingExchangeName: "CCC", dataSource: "live" }, SPOT_AT);
    expect(reported).toMatchObject({ status: "ok", venue: "crypto composite price", feed: "real-time" });
    expect(curveSpotSource(reported)).toBe("crypto composite price, real-time");
    expect(curveSpotSource(curveSpot("BTC-USD", { ...btc, exchangeName: " ccc ", dataSource: "delayed" }, SPOT_AT))).toBe("crypto composite price, delayed");
    // A snapshot is neither real-time nor delayed, and a quote that reports neither is not given a venue it did not name.
    expect(curveSpot("BTC-USD", { ...btc, listingExchangeName: "CCC", dataSource: "snapshot" }, SPOT_AT)).not.toHaveProperty("feed");
    expect(curveSpotSource(curveSpot("BTC-USD", btc, SPOT_AT))).toBeNull();
  });

  test("a blank basis names its contracts, cause and both times, and a rate inside a week says what 10 bp of spot does to it", () => {
    const row = (code: string, expiration: string, extra: Partial<FuturesContract> = {}): FuturesContract =>
      ({ ...first, symbol: `${code}.CME`, expiration, price: 67_500, stale: false, asOf: "2026-10-09T07:24:30Z", ...extra });
    const rows = [row("BTCV26", "2026-10-16"), row("BTCX26", "2026-11-27"),
      // Printed after the newest bar, the day before, without a time, unpriced, and flagged stale by the server.
      row("BTCZ26", "2026-12-25", { asOf: "2026-10-09T07:31:05Z" }), row("BTCF27", "2027-01-29", { asOf: "2026-10-08T22:10:00Z" }),
      row("BTCG27", "2027-02-26", { asOf: "2026-10-08" }), row("BTCH27", "2027-03-26", { price: null }), row("BTCJ27", "2027-04-30", { stale: true })];
    const basis = curveBasisRows(rows, BARS);
    expect(blankBasisNote(rows, basis)).toBe("Basis blank for BTCZ26 (spot and print 6 min apart: print 07:31, nearest spot 07:25 UTC); "
      + "BTCF27 (spot and print 9 h apart: print 2026-10-08 22:10, nearest spot 2026-10-09 07:20 UTC); BTCG27 (last trade has no time of day); "
      + "BTCH27 (no price); BTCJ27 (price over two sessions old).");
    expect(blankBasisNote(rows, curveBasisRows(rows.slice(0, 1), []))).toBe("Basis blank for BTCV26 (no one-minute spot prices).");
    // BTCV26 settles 7.32 days after its 07:24 trade (15:00 UTC, London still on summer time), so it is not short-dated;
    // a day nearer it is: 0.1% × 365 / 6.32 = 5.8 points.
    expect(shortDatedBasisNote(rows, basis)).toBeNull();
    const near = [row("BTCU26", "2026-10-15"), row("BTCX26", "2026-11-27")];
    expect(shortDatedBasisNote(near, curveBasisRows(near, BARS)))
      .toBe("Ann Basis is noisy under 7 days to expiry, so read Vs Spot there: 10 bp of spot noise moves BTCU26 (6.3 days) by ±5.8 points.");
    expect(shortDatedBasis(curveBasisRows(near, BARS).get("BTCU26.CME"))).toBe(true);
    expect(shortDatedBasis(curveBasisRows(near, BARS).get("BTCX26.CME"))).toBe(false);
  });

  test("only the four crypto roots have a spot, and the basis columns sort with blanks last", () => {
    expect(["BTC", "ETH", "SOL", "XRP"].map(basisSpotSymbol)).toEqual(["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD"]);
    expect(["ES", "CL", "VX", "constructor"].map(basisSpotSymbol)).toEqual([null, null, null, null]);
    const rows = [first, { ...first, symbol: "CLZ26.NYM", price: 90 }, { ...first, symbol: "CLF27.NYM", price: 70 }, { ...first, symbol: "CLG27.NYM", stale: true }];
    const fresh = rows.map((row) => ({ ...row, expiration: "2026-12-18", asOf: "2026-10-09T07:20:00Z" }));
    const basis = curveBasisRows(fresh, spotBarsFromHistory([{ date: new Date(minute("07:20")), close: 80 }]));
    expect(sortCurveContracts(rows, "vsSpot", "desc", undefined, basis).map((row) => row.symbol)).toEqual(["CLZ26.NYM", "CLX26.NYM", "CLF27.NYM", "CLG27.NYM"]);
    expect(sortCurveContracts(rows, "annBasis", "asc", undefined, basis).map((row) => row.symbol).slice(0, 2)).toEqual(["CLF27.NYM", "CLX26.NYM"]);
  });
});

test("axis labels take their decimals from the plotted range, never the contract tick", () => {
  const domain = (min: number, max: number): CompositeAxisDomain => ({ side: "right", min, max, scale: "linear", unit: "", unitGroup: "", seriesIds: [] });
  // Hundreds of index points read as whole points, not 7800.00.
  expect(curveAxisPrice(7800, domain(7690, 8080), "ES")).toBe("7800");
  expect(curveAxisPrice(7803.75, domain(7690, 8080), "ES")).toBe("7804");
  // A VIX strip spans a few points: one decimal, not the settlement's four.
  expect(curveAxisPrice(18, domain(17.4, 22.3), "VX")).toBe("18.0");
  // A narrow Treasury range keeps the 1/4 ticks exact.
  expect(curveAxisPrice(104.75, domain(104.4, 105.1), "ZN")).toBe("104.75");
});


describe("past curves", () => {
  const row = (symbol: string, expiration: string, price: number, extra: Partial<FuturesCurveAsOfPayload["contracts"][number]> = {}) => ({
    contract: symbol.replace("/", ""), symbol, label: symbol, deliveryMonth: expiration.slice(0, 7), expiration, tradeDate: "2020-03-16",
    price, volume: 10, openInterest: 100, asOf: "2020-03-16T00:00:00.000Z", stale: false, ...extra,
  });
  const payload = (date: string, contracts: FuturesCurveAsOfPayload["contracts"]): FuturesCurveAsOfPayload => ({
    root: "VX", name: "VIX Futures", date, asOf: date, currency: "USD", quoteUnit: "volatility points", archiveStart: "2013-05-20", contracts, gaps: [],
  });

  test("read the archived curve in the live curve's shape, with the curves a week and a month before as ghosts", () => {
    const curve = archivedFuturesCurve("VX", payload("2020-03-16", [row("VX/J0", "2020-04-15", 59.15), row("VX/H0", "2020-03-18", 72.625),
      row("VX/K0", "2020-05-20", 44.875, { stale: true, asOf: "2020-03-13T00:00:00.000Z" })]),
    { "1W": payload("2020-03-09", [row("VX/H0", "2020-03-18", 44.375)]), "1M": null }, "2020-03-17T00:00:00.000Z");
    expect(curve.contracts.map((contract) => [contract.symbol, contract.price, contract.asOf, contract.stale])).toEqual([
      ["VX/H0", 72.625, "2020-03-16", false], ["VX/J0", 59.15, "2020-03-16", false], ["VX/K0", 44.875, "2020-03-13", true],
    ]);
    expect(curve.slope).toMatchObject({ frontSymbol: "VX/H0", nextSymbol: "VX/J0", state: "backwardation", percentile: null, samples: 0 });
    expect(curve.slope.value).toBeCloseTo(-13.475);
    expect(curve.ghosts.map((ghost) => [ghost.label, ghost.requestedDate, ghost.points.length])).toEqual([["1W", "2020-03-09", 1], ["1M", "2020-02-15", 0]]);
    expect(curveContractChanges(curve).get("VX/H0")).toEqual({ "1W": 28.25, "1M": null });
    expect(futuresCurveSeries(curve, undefined, "all", Date.parse("2020-03-16"), "2020-03-16")[0]?.label).toBe("2020-03-16");
  });

  test("date a weekend or holiday curve by the session before it, where only carried prices are stale", () => {
    // The archive marks every row stale on a date nothing traded; a carried price is dated before its row.
    const carried = { stale: true, tradeDate: "2020-03-13", asOf: "2020-03-11T00:00:00.000Z" };
    const curve = archivedFuturesCurve("VX", { ...payload("2020-03-14", [
      row("VX/H0", "2020-03-18", 53.425, { stale: true, tradeDate: "2020-03-13", asOf: "2020-03-13T00:00:00.000Z" }),
      row("VX/J0", "2020-04-15", 44.875, { stale: true, tradeDate: "2020-03-13", asOf: "2020-03-13T00:00:00.000Z" }),
      row("VX/K0", "2020-05-20", 36.1, carried), row("VX/M0", "2020-06-17", 33.2, carried)]), asOf: "2020-03-13" },
    { "1W": null, "1M": null }, "2020-03-15T00:00:00.000Z");
    expect(curve.contracts.map((contract) => [contract.symbol, contract.asOf, contract.stale])).toEqual([
      ["VX/H0", "2020-03-13", false], ["VX/J0", "2020-03-13", false], ["VX/K0", "2020-03-11", true], ["VX/M0", "2020-03-11", true],
    ]);
    expect(curve.slope).toMatchObject({ frontSymbol: "VX/H0", nextSymbol: "VX/J0", state: "backwardation" });
  });

  test("a past curve's settlements are only the rows the archive confirms, and its spread pairs settlements with settlements", () => {
    // GC on Fri 9 Oct 2026, read the same evening: every row is that session's last trade (GCN27's 4324 under GCM27's 4327).
    const gold = (rows: Array<[string, string, number, boolean]>) => payload("2026-10-09", rows.map(([symbol, expiration, price, settled]) =>
      row(symbol, expiration, price, { tradeDate: "2026-10-09", asOf: "2026-10-09T04:00:00.000Z", settled })));
    const evening = archivedFuturesCurve("GC", gold([["GCZ26.CMX", "2026-12-29", 4220.3, false], ["GCM27.CMX", "2027-06-28", 4327, false],
      ["GCN27.CMX", "2027-07-28", 4324, false]]), { "1W": null, "1M": null }, "2026-10-10T16:00:00.000Z");
    expect(evening.contracts.map((contract) => contract.settlement)).toEqual([null, null, null]);
    expect(evening.settlementDate).toBeNull();
    expect(curveSpreadLabel(evening.slope)).toBe("GCM27-GCZ26");
    // The morning read confirms the settlements; one confirmed row beside last trades makes no spread at all.
    const morning = archivedFuturesCurve("GC", gold([["GCZ26.CMX", "2026-12-29", 4216.3, true], ["GCM27.CMX", "2027-06-28", 4322.3, true],
      ["GCN27.CMX", "2027-07-28", 4341.1, true]]), { "1W": null, "1M": null }, "2026-10-10T16:00:00.000Z");
    expect(morning.contracts.map((contract) => contract.settlement)).toEqual([4216.3, 4322.3, 4341.1]);
    expect(morning.settlementDate).toBe("2026-10-09");
    expect(morning.slope.value).toBeCloseTo(106);
    const mixed = archivedFuturesCurve("GC", gold([["GCZ26.CMX", "2026-12-29", 4216.3, true], ["GCM27.CMX", "2027-06-28", 4327, false],
      ["GCN27.CMX", "2027-07-28", 4324, false]]), { "1W": null, "1M": null }, "2026-10-10T16:00:00.000Z");
    expect(mixed.slope).toMatchObject({ frontSymbol: null, nextSymbol: null, value: null, state: "unavailable" });
  });

  test("the front spread is named by the contracts it subtracts, next less front", () => {
    expect(curveSpreadLabel({ frontSymbol: "GCZ26.CMX", nextSymbol: "GCF27.CMX" })).toBe("GCF27-GCZ26");
    expect(curveSpreadLabel({ frontSymbol: "VX/V6", nextSymbol: "VX/X6" })).toBe("VX/X6-VX/V6");
    expect(curveSpreadLabel({ frontSymbol: null, nextSymbol: null })).toBe("M2-M1");
  });

  test("take a past date or latest, and refuse a future or malformed one", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    expect(curveAsOfDate("", now)).toBe("");
    expect(curveAsOfDate(" latest ", now)).toBe("");
    expect(curveAsOfDate("2020-03-16", now)).toBe("2020-03-16");
    expect(() => curveAsOfDate("2026-09-29", now)).toThrow("future");
    expect(() => curveAsOfDate("2020-02-30", now)).toThrow("YYYY-MM-DD");
    expect(() => curveAsOfDate("2020-13-01", now)).toThrow("YYYY-MM-DD");
  });

  test("a date written day first gets the date to type, as every date option gives", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(() => curveAsOfDate("22/10/2026", now, "--date")).toThrow("type --date 2026-10-22 for 22/10/2026");
    expect(() => curveAsOfDate("22/10/2026", now)).toThrow("type 2026-10-22 for 22/10/2026");
    expect(curveAsOfDate("22.10.2026", now, "--date")).toBe("2026-10-22");
  });
});
