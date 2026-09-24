import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { CotClassSummary, CotContractPayload } from "../../../api-client/cot";
import { fetchCotBoard, loadCotDetail, validateCotContract } from "./client";
import { COT_MAJOR_CODES, cotContractCode, cotLegendValue, cotNetPoints, cotScope } from "./model";

function position(): CotClassSummary {
  const percentile = { value: null, rank: null, sampleCount: 2, windowStart: "2025-09-15", windowEnd: "2026-09-15",
    historyStart: "2026-09-01", historyEnd: "2026-09-15", completeWindow: false, min: -20, max: 0, mean: -10 };
  return { id: "noncommercial", label: "Noncommercial", long: 10, short: 30, spreading: 0, net: -20, netPercentOfOpenInterest: -10,
    weeklyChange: null, previousReportDate: "2026-09-01", percentile1Y: percentile,
    percentile3Y: { ...percentile, windowStart: "2023-09-15" } };
}
function payload(): CotContractPayload {
  return { source: "CFTC", scope: "futures-only", reportFamily: "legacy", generatedAt: "2026-09-22T12:00:00Z", asOf: "2026-09-15",
    fetchedAt: "2026-09-18T20:00:00Z", publishedAt: null, status: "partial", gaps: ["Limited history"],
    classes: [{ id: "noncommercial", label: "Noncommercial" }],
    contract: { contractCode: "067651", marketName: "WTI-PHYSICAL", exchangeCode: "NYM", commodityCode: "067" },
    sourceUrl: "https://www.cftc.gov/dea/newcot/deafut.txt", openInterest: 200, positions: [position()],
    history: [{ reportDate: "2026-09-01", openInterest: 180, positions: [{ id: "noncommercial", long: 20, short: 20, spreading: 0, net: 0, netPercentOfOpenInterest: 0 }] },
      { reportDate: "2026-09-15", openInterest: 200, positions: [{ id: "noncommercial", long: 10, short: 30, spreading: 0, net: -20, netPercentOfOpenInterest: -10 }] }],
  };
}

test("position charts retain missing-week gaps, zero net and alphanumeric identities", () => {
  const data = validateCotContract(payload(), "legacy", "067651");
  expect(cotNetPoints(data.history, "noncommercial").map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
    ["2026-09-01", 0], ["2026-09-08", null], ["2026-09-15", -20],
  ]);
  // A holiday-shifted report eight days on is the next week, not a missing one.
  const shifted = { ...data, history: [data.history[0]!, { ...data.history[1]!, reportDate: "2026-09-09" }] };
  expect(cotNetPoints(shifted.history, "noncommercial").map((point) => point.value)).toEqual([0, -20]);
  expect(cotContractCode("001602")).toBe("001602");
  expect(cotContractCode("1170e1")).toBe("1170E1");
  expect(cotContractCode("13874+")).toBe("13874+");
  expect(cotContractCode("../067651")).toBeNull();
  expect(data.publishedAt).toBeNull();
});

test("rejects report-family contamination, identity mismatch and net inferred from suppressed legs", () => {
  expect(() => validateCotContract(payload(), "disaggregated", "067651")).toThrow("invalid COT report");
  expect(() => validateCotContract(payload(), "legacy", "067411")).toThrow("invalid COT contract");
  const bad = payload(); bad.positions[0]!.long = null;
  expect(() => validateCotContract(bad, "legacy", "067651")).toThrow("invalid COT positions");
  const revised = payload(); revised.positions[0] = { ...position(), long: null, net: null, netPercentOfOpenInterest: null };
  expect(validateCotContract(revised, "legacy", "067651").positions[0]!.net).toBeNull();
});

test("price-source failure leaves report history readable and never substitutes a cash index", async () => {
  const result = await loadCotDetail("067651", "legacy", { getCloudCotContract: async () => payload(), getCloudHistory: async () => { throw new Error("price unavailable"); } });
  expect(result.payload.history).toHaveLength(2);
  expect(result.price).toEqual([]);
  expect(result.priceWarning).toContain("Positioning remains available");
  const vx = payload(); vx.contract = { ...vx.contract!, contractCode: "1170E1", marketName: "VIX FUTURES" };
  let priceRequested = false;
  const resultVx = await loadCotDetail("1170E1", "legacy", { getCloudCotContract: async () => vx, getCloudHistory: async () => { priceRequested = true; throw new Error("must not substitute cash VIX"); } });
  expect(priceRequested).toBe(false);
  expect(resultVx.priceSymbol).toBeNull();
  expect(resultVx.priceWarning).toBeNull();
  const corn = payload(); corn.contract = { ...corn.contract!, contractCode: "002602", marketName: "CORN" };
  const requested: string[] = [];
  const resultCorn = await loadCotDetail("002602", "legacy", { getCloudCotContract: async () => corn,
    getCloudHistory: async (symbol, exchange) => { requested.push(`${symbol} ${exchange}`); return { status: "success", data: [] } as never; } });
  expect(requested).toEqual(["ZC=F CBT"]);
  expect(resultCorn.priceSymbol).toBe("ZC=F");
  // A market code is never an equity alias: Soybean Meal's ZM stays Zoom's.
  expect(cotContractCode("ZM")).toBeNull();
});

test("missing migration gives unavailable state; access failures remain access failures", async () => {
  await expect(fetchCotBoard("legacy", "noncommercial", { getCloudCotBoard: async () => { throw new ApiRequestError("not ready", 503); } })).rejects.toThrow("not available on this Gloom Cloud server yet");
  const denied = new ApiRequestError("Forbidden", 403);
  await expect(fetchCotBoard("legacy", "noncommercial", { getCloudCotBoard: async () => { throw denied; } })).rejects.toBe(denied);
});

test("major scope keeps only verified codes and never invents a market", () => {
  expect(cotScope("all")).toBe("all");
  expect(cotScope(undefined)).toBe("major");
  expect(COT_MAJOR_CODES.has("13874A")).toBe(true);
  expect(COT_MAJOR_CODES.has("0063DB")).toBe(false);
  expect([...COT_MAJOR_CODES].every((code) => /^[0-9A-Z]{5}[0-9A-Z+]$/.test(code))).toBe(true);
});

test("legend values stay exact without the float32 tail of price bars", () => {
  expect(cotLegendValue(Math.fround(4346.3), { id: "price" })).toBe("4,346.3");
  expect(cotLegendValue(7765.25, { id: "price" })).toBe("7,765.25");
  expect(cotLegendValue(112.640625, { id: "price" })).toBe("112.640625");
  expect(cotLegendValue(-100461, { id: "net" })).toBe("-100,461");
});
