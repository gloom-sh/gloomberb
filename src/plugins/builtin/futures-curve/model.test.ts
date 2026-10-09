import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesContract, FuturesCurveAsOfPayload, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { fetchFuturesCurve, validateFuturesCurve } from "./client";
import { FUTURES_CONTRACTS } from "../futures/contracts";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { annualisedBasisPct, archivedFuturesCurve, basisSpotSymbol, contractBasis, CURVE_ROOTS, curveAsOfDate, curveAxisPrice, curveBasisPercent, curveBasisRows, curveChangeText, curveContractChanges, curveContractMonth, curvePrice, curveRank, curveRootForTicker, curveSpot, curveSpotLabel, daysToExpiry, futuresCurveSeries, newestQuote, normalizeCurveRoot, sortCurveContracts, vsSpotPct } from "./model";
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
  await expect(fetchFuturesCurve("BAD", { getCloudFuturesCurve: async () => { throw new Error("should not request"); } })).rejects.toThrow("Unsupported futures root");
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
  expect(await open("BTC", "AAPL")).toMatchObject({ title: "CTM BTC", params: { root: "BTC" } });
  expect(await open(undefined, "BTC")).toMatchObject({ title: "CTM ES", params: { root: "ES" } });
  expect(await open(undefined, "ETH-USD")).toMatchObject({ title: "CTM ETH", params: { root: "ETH" } });
  expect(await open(undefined, "SOL")).toMatchObject({ title: "CTM ES" });
  // An explicit argument still wins over the cursor.
  expect(await open("XRP", "BTC-USD")).toMatchObject({ title: "CTM XRP" });
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
  const contract = { price: 67_500, stale: false, expiration: "2026-12-25" };

  test("a premium is positive in contango and negative in backwardation, annualised on a 365-day year", () => {
    expect(vsSpotPct(67_500, 67_250.1)).toBeCloseTo((67_500 / 67_250.1 - 1) * 100, 10);
    expect(vsSpotPct(66_000, 67_250.1)!).toBeLessThan(0);
    // 77 calendar days from 9 Oct to 25 Dec.
    expect(daysToExpiry(SPOT_AT, "2026-12-25")).toBe(77);
    expect(annualisedBasisPct(67_500, 67_250.1, 77)).toBeCloseTo((67_500 / 67_250.1 - 1) * 365 / 77 * 100, 10);
    expect(annualisedBasisPct(66_000, 67_250.1, 77)!).toBeLessThan(0);
    // The day count starts at the UTC date of the spot's own timestamp, whatever the local zone.
    expect(daysToExpiry(Date.parse("2026-10-09T23:59:00Z"), "2026-10-30")).toBe(21);
    expect(daysToExpiry(Date.parse("2026-10-10T00:01:00Z"), "2026-10-30")).toBe(20);
  });

  test("on the expiry day or after it the annualised rate is blank and the premium stays", () => {
    expect(daysToExpiry(SPOT_AT, "2026-10-09")).toBe(0);
    expect(annualisedBasisPct(67_500, 67_250.1, 0)).toBeNull();
    expect(annualisedBasisPct(67_500, 67_250.1, -3)).toBeNull();
    const spot = curveSpot("BTC-USD", btc, SPOT_AT);
    expect(contractBasis({ ...contract, expiration: "2026-10-09" }, spot)).toEqual({ vsSpotPct: vsSpotPct(67_500, 67_250.1), annualisedBasisPct: null });
    expect(contractBasis({ ...contract, expiration: "2026-10-01" }, spot).annualisedBasisPct).toBeNull();
  });

  test("a missing, zero, negative or non-finite price on either side gives nothing", () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN, Infinity]) {
      expect(vsSpotPct(bad, 67_250.1)).toBeNull();
      expect(vsSpotPct(67_500, bad)).toBeNull();
      expect(annualisedBasisPct(bad, 67_250.1, 77)).toBeNull();
      expect(annualisedBasisPct(67_500, bad, 77)).toBeNull();
    }
    expect(annualisedBasisPct(67_500, 67_250.1, null)).toBeNull();
    expect(annualisedBasisPct(67_500, 67_250.1, Number.NaN)).toBeNull();
    expect(daysToExpiry(SPOT_AT, "soon")).toBeNull();
  });

  test("spot is stale past ten minutes of the quote's own time, with a delayed feed's hold-back allowed on top", () => {
    const minutes = (count: number) => SPOT_AT + count * 60_000;
    expect(curveSpot("BTC-USD", btc, minutes(10))).toMatchObject({ status: "ok", price: 67_250.1, asOf: "2026-10-09T07:25:00Z", reason: null });
    expect(curveSpot("BTC-USD", btc, minutes(11))).toMatchObject({ status: "stale", reason: "BTC-USD quote is 11m old", price: 67_250.1 });
    expect(curveSpot("BTC-USD", btc, SPOT_AT + 2.5 * 3_600_000).reason).toBe("BTC-USD quote is 2h old");
    expect(curveSpot("BTC-USD", btc, SPOT_AT + 3 * 86_400_000).reason).toBe("BTC-USD quote is 3d old");
    // The free tier's quotes are always about 15 minutes old; that is the feed, not a stall.
    const delayed = { ...btc, dataSource: "delayed" };
    expect(curveSpot("BTC-USD", delayed, minutes(17)).status).toBe("ok");
    expect(curveSpot("BTC-USD", delayed, minutes(26)).status).toBe("stale");
    expect(curveSpot("BTC-USD", { ...btc, stale: true }, minutes(1))).toMatchObject({ status: "stale", reason: "BTC-USD quote is stale" });
    expect(curveSpot("BTC-USD", { ...btc, lastUpdated: 0 }, SPOT_AT)).toMatchObject({ status: "stale", asOf: null });
    expect(curveSpot("BTC-USD", null, SPOT_AT)).toEqual({ symbol: "BTC-USD", price: null, asOf: null, status: "missing", reason: "no BTC-USD quote" });
    expect(curveSpot("BTC-USD", { ...btc, price: Number.NaN }, SPOT_AT).status).toBe("missing");
  });

  test("a stale or unpriced contract, or an unusable spot, blanks every basis cell", () => {
    const ok = curveSpot("BTC-USD", btc, SPOT_AT);
    expect(contractBasis(contract, ok).vsSpotPct).toBeCloseTo(0.3716, 3);
    expect(contractBasis({ ...contract, stale: true }, ok)).toEqual({ vsSpotPct: null, annualisedBasisPct: null });
    expect(contractBasis({ ...contract, price: null }, ok)).toEqual({ vsSpotPct: null, annualisedBasisPct: null });
    for (const spot of [curveSpot("BTC-USD", btc, SPOT_AT + 3_600_000), curveSpot("BTC-USD", null, SPOT_AT)]) {
      expect(contractBasis(contract, spot)).toEqual({ vsSpotPct: null, annualisedBasisPct: null });
    }
  });

  test("cells read to two decimals and one, signed, and the footer names the spot and its UTC time", () => {
    expect(curveBasisPercent(0.4213, 2)).toBe("+0.42%");
    expect(curveBasisPercent(-0.4213, 2)).toBe("-0.42%");
    expect(curveBasisPercent(5.14, 1)).toBe("+5.1%");
    expect(curveBasisPercent(-0.001, 2)).toBe("0.00%");
    expect(curveBasisPercent(null, 1)).toBe("--");
    const spot = curveSpot("BTC-USD", btc, SPOT_AT);
    expect(curveSpotLabel(spot, "BTC", SPOT_AT)).toBe("spot BTC-USD 67,250.10 · 07:25 UTC");
    // A quote from an earlier UTC day carries its date.
    expect(curveSpotLabel(spot, "BTC", SPOT_AT + 86_400_000)).toBe("spot BTC-USD 67,250.10 · 2026-10-09 07:25 UTC");
    expect(curveSpotLabel(curveSpot("XRP-USD", { price: 1.3978, lastUpdated: SPOT_AT }, SPOT_AT), "XRP", SPOT_AT)).toBe("spot XRP-USD 1.3978 · 07:25 UTC");
  });

  test("only the four crypto roots have a spot, and the basis columns sort with blanks last", () => {
    expect(["BTC", "ETH", "SOL", "XRP"].map(basisSpotSymbol)).toEqual(["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD"]);
    expect(["ES", "CL", "VX", "constructor"].map(basisSpotSymbol)).toEqual([null, null, null, null]);
    const rows = [first, { ...first, symbol: "CLZ26.NYM", price: 90 }, { ...first, symbol: "CLF27.NYM", price: 70 }, { ...first, symbol: "CLG27.NYM", stale: true }];
    const basis = curveBasisRows(rows, curveSpot("CL-USD", { price: 80, lastUpdated: SPOT_AT }, SPOT_AT));
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

  test("take a past date or latest, and refuse a future or malformed one", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    expect(curveAsOfDate("", now)).toBe("");
    expect(curveAsOfDate(" latest ", now)).toBe("");
    expect(curveAsOfDate("2020-03-16", now)).toBe("2020-03-16");
    expect(() => curveAsOfDate("2026-09-29", now)).toThrow("future");
    expect(() => curveAsOfDate("2020-02-30", now)).toThrow("YYYY-MM-DD");
    expect(() => curveAsOfDate("2020-13-01", now)).toThrow("YYYY-MM-DD");
  });
});
