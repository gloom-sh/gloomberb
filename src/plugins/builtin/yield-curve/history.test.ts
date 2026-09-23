import { describe, expect, test } from "bun:test";
import type { CloudFredSeriesPayload } from "../../../api-client";
import { completeYieldCurve, loadHistoricalYieldCurve, yieldCurveDate } from "./history";
import { curveAsOf, spreadBasisPoints, TREASURY_MATURITIES } from "./treasury-data";

function payload(id: string, observations: CloudFredSeriesPayload["observations"]): CloudFredSeriesPayload {
  return {
    observations,
    info: { id, title: "Treasury", units: "Percent", frequency: "Daily", seasonalAdjustment: "Not Seasonally Adjusted", source: "FRED", notes: "" },
    fetchedAt: "2026-09-10T12:00:00Z",
    stale: false,
  };
}

describe("historical Treasury curves", () => {
  test("uses one preceding business date for a weekend and keeps the requested bounds", async () => {
    const requests: unknown[] = [];
    const points = await loadHistoricalYieldCurve("2024-03-02", async (id, options) => {
      requests.push(options);
      return payload(id, [
        { date: "2024-03-04", value: 99 }, // An upstream over-fetch must not leak into the selected curve.
        { date: "2024-03-02", value: null },
        { date: "2024-03-01", value: id === "DGS2" ? 4.54 : 4.19 },
        { date: "2024-02-29", value: 4.25 },
      ]);
    });
    expect(requests).toHaveLength(TREASURY_MATURITIES.length);
    expect(requests[0]).toEqual({ startDate: "2024-02-21", endDate: "2024-03-02", limit: 10, sortOrder: "desc" });
    expect(points).toHaveLength(TREASURY_MATURITIES.length);
    expect(curveAsOf(points)).toBe("2024-03-01");
    expect(spreadBasisPoints(points)).toBe(-35);
    expect(points.every((point) => point.asOf === "2024-03-01")).toBe(true);
  });

  test("partial failures and lagging tenors never carry older values into a newer curve", async () => {
    const points = await loadHistoricalYieldCurve("2024-02-29", async (id) => {
      if (id === "DGS30") throw new Error("provider unavailable");
      if (id === "DGS2") return payload(id, [{ date: "2024-02-28", value: 4.64 }]);
      if (id === "DGS20") return { ...payload(id, [{ date: "2024-02-29", value: 450 }]), info: { ...payload(id, []).info!, units: "Basis Points" } };
      if (id === "DGS6MO") return { ...payload(id, [{ date: "2024-02-29", value: -0.2 }]), info: null };
      return { ...payload(id, [{ date: "2024-02-29", value: id === "DGS1" ? 0 : -0.1 }]), stale: true };
    });
    expect(curveAsOf(points)).toBe("2024-02-29");
    expect(spreadBasisPoints(points)).toBeNull();
    expect(points.filter((point) => point.yield == null).map((point) => point.maturity)).toEqual(["2Y", "20Y", "30Y"]);
    expect(points.find((point) => point.maturity === "1Y")?.yield).toBe(0);
    expect(points[0]?.yield).toBe(-0.1);
    expect(points[0]?.stale).toBe(true);
    expect(points[0]?.fetchedAt).toBe("2026-09-10T12:00:00Z");
    expect(points.find((point) => point.maturity === "6M")?.yield).toBe(-0.2);
  });

  test("does not return a fabricated empty curve when every series fails", async () => {
    await expect(loadHistoricalYieldCurve("2024-02-29", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(loadHistoricalYieldCurve("2024-02-29", async (id) => payload(id, [{ date: "2024-02-01", value: 4 }]))).rejects.toThrow("No Treasury observations");
  });

  test("validates real calendar dates before requesting history", async () => {
    const now = new Date("2026-09-10T12:00:00Z");
    expect(yieldCurveDate("2024-02-29", now)).toBe("2024-02-29");
    expect(yieldCurveDate(" latest ", now)).toBe("");
    for (const date of ["2023-02-29", "2024-02-30", "2024-2-1", "2024-01-01T00:00:00Z", 2024]) {
      expect(() => yieldCurveDate(date, now)).toThrow("YYYY-MM-DD");
    }
    expect(() => yieldCurveDate("2026-09-11", now)).toThrow("future date");
    let calls = 0;
    await expect(loadHistoricalYieldCurve("2023-02-29", async (id) => { calls++; return payload(id, []); })).rejects.toThrow("YYYY-MM-DD");
    expect(calls).toBe(0);
  });

  test("exposes omitted and invalid latest tenors as missing", () => {
    const points = completeYieldCurve([
      { maturity: "2Y", maturityYears: 2, yield: Number.NaN, asOf: "2024-02-29" },
      { maturity: "10Y", maturityYears: 100, yield: 0, asOf: "2024-02-29" },
    ]);
    expect(points).toHaveLength(TREASURY_MATURITIES.length);
    expect(points.find((point) => point.maturity === "2Y")).toMatchObject({ yield: null, asOf: null });
    expect(points.find((point) => point.maturity === "10Y")).toMatchObject({ yield: 0, maturityYears: 10 });
  });
});


test("rejects a contrary or unidentified metadata response without dropping other tenors", async () => {
  for (const identity of ["DGS10", "", undefined]) {
    const points = await loadHistoricalYieldCurve("2024-03-02", async id => ({
      ...payload(id, [{date: "2024-03-01", value: id === "DGS1" ? -0.2 : 0}]),
      info: {...payload(id, []).info!, id: id === "DGS2" ? identity as string : id},
    }));
    expect(points.find(p => p.maturity === "2Y")).toMatchObject({yield: null, error: expect.stringContaining("Expected DGS2")});
    expect(points.find(p => p.maturity === "10Y")).toMatchObject({yield: 0, asOf: "2024-03-01", error: undefined});
    expect(points.find(p => p.maturity === "1Y")?.yield).toBe(-0.2);
    expect(spreadBasisPoints(points)).toBeNull();
  }
});

test("malformed dated observations cannot own a session but valid observations in that source survive", async () => {
  const points = await loadHistoricalYieldCurve("2024-03-02", async id => payload(id, [
    {date: "2024-02-30", value: 99}, {date: "2024-02-29", value: id === "DGS2" ? 4.54 : 4.19},
  ]));
  expect(curveAsOf(points)).toBe("2024-02-29");
  expect(spreadBasisPoints(points)).toBe(-35);
  expect(points.every(p => p.error?.includes("2024-02-30"))).toBe(true);
  expect(points[0]?.fetchedAt).toBe("2026-09-10T12:00:00Z");
  await expect(loadHistoricalYieldCurve("2024-03-02", async id => payload(id, [{date: "2024-02-30", value: 99}]))).rejects.toThrow("Invalid Treasury observation date");
});

test("latest invalid date retains reported yield as undated and cannot establish a spread", () => {
  const raw = [{maturity: "2Y", maturityYears: 2, yield: 0, asOf: "2024-02-30"}, {maturity: "10Y", maturityYears: 10, yield: -0.2, asOf: "2024-02-30"}];
  expect(curveAsOf(raw)).toBeNull();
  expect(spreadBasisPoints(raw)).toBeNull();
  const points = completeYieldCurve(raw);
  expect(points.find(p => p.maturity === "2Y")).toMatchObject({yield: 0, asOf: null, error: "Invalid Treasury observation date: 2024-02-30"});
  expect(points.find(p => p.maturity === "10Y")?.yield).toBe(-0.2);
});

test("missing metadata compatibility preserves values while a failed tenor carries its actual cause", async () => {
  const points = await loadHistoricalYieldCurve("2024-03-02", async id => {
    if (id === "DGS2") throw new Error("controlled 503");
    return {...payload(id, [{date: "2024-03-01", value: 0}]), info: null};
  });
  expect(points.find(p => p.maturity === "2Y")).toMatchObject({yield: null, error: "controlled 503"});
  expect(points.find(p => p.maturity === "10Y")).toMatchObject({yield: 0, error: undefined});
  expect(curveAsOf(points)).toBe("2024-03-01");
});
