import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesContract, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { fetchFuturesCurve, validateFuturesCurve } from "./client";
import { curveContractMonth, curvePrice, curveRank, futuresCurveSeries, newestQuote } from "./model";

const first: FuturesContract = { symbol: "CLX26.NYM", label: "Nov 2026", expiration: "2026-10-20",
  price: 80, asOf: "2026-09-22T15:00:00Z", currency: "USD", quoteUnit: "USD", volume: 0, openInterest: 0, delayMinutes: 10,
  stale: false, percentile: 50, samples: 200, historyStart: "2025-09-22", historyEnd: "2026-09-21" };
function payload(): FuturesCurvePayload {
  return { root: "CL", name: "WTI Crude Oil", source: "yahoo", currency: "USD", quoteUnit: "USD", asOf: first.asOf,
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
  const badGhost = payload(); badGhost.ghosts[0]!.points[0]!.symbol = "ESZ26.CME";
  expect(() => validateFuturesCurve(badGhost, "CL")).toThrow("invalid futures history");
});

test("normalizes FUT aliases before cloud request and handles missing endpoints without swallowing access errors", async () => {
  const requested: string[] = [];
  await fetchFuturesCurve("cl=f", { getCloudFuturesCurve: async (root) => { requested.push(root); return payload(); } });
  expect(requested).toEqual(["CL"]);
  await expect(fetchFuturesCurve("BAD", { getCloudFuturesCurve: async () => { throw new Error("should not request"); } })).rejects.toThrow("Unsupported futures root");
  await expect(fetchFuturesCurve("CL", { getCloudFuturesCurve: async () => { throw new ApiRequestError("Not found", 404); } })).rejects.toThrow("not available on this Gloom Cloud server yet");
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

test("Treasury prices stay on their 32nd tick grid and contracts read by delivery month", () => {
  expect(curvePrice(105.265625, "ZN")).toBe("105.265625");
  expect(curvePrice(101.6796875, "ZT")).toBe("101.6796875");
  expect(curvePrice(108, "ZB")).toBe("108.00");
  expect(curvePrice(-0.1875, "ZN")).toBe("-0.1875");
  expect(curvePrice(0.00635, "6J")).toBe("0.0063500");
  // Crude's November contract expires in October.
  expect(curveContractMonth("CLX26.NYM", "2026-10-20")).toBe("Nov 26");
  expect(curveContractMonth("ZFZ26.CBT", "2026-12-31")).toBe("Dec 26");
  expect(curveContractMonth("RTYH27.CME", "2027-03-19")).toBe("Mar 27");
  expect(curveContractMonth("VX/V6", "2026-10-21")).toBe("Oct 26");
});
