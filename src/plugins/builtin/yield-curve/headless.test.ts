import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createYieldCurveHeadless, type YieldCurveHeadlessDependencies } from "./headless";
import { completeYieldCurve } from "./history";
import { TREASURY_MATURITIES, type YieldPoint } from "./treasury-data";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

const curve = (asOf: string, yields: Record<string, number | null>): YieldPoint[] => TREASURY_MATURITIES.map(({ maturity, years }) => {
  const value = yields[maturity] ?? null;
  return { maturity, maturityYears: years, yield: value, asOf: value == null ? null : asOf };
});

/** A stored curve with its look-backs, as Gloom Cloud serves it. */
const stored = (yields: Record<string, number | null>, day: Record<string, number | null> | null): YieldCurveHeadlessDependencies => ({
  load: async (_curve, requestedDate) => ({
    curve: "us", requestedDate, basis: "par", couponsPerYear: 2, spreads: null,
    points: curve("2026-10-09", yields),
    lookbacks: { "1D": day ? curve("2026-10-08", day) : null },
  }),
});

describe("yield curve headless model", () => {
  test("marks a partial, mixed-date curve incomplete and does not calculate a spread", async () => {
    const headless = createYieldCurveHeadless({
      load: async () => ({
        curve: "us", requestedDate: "", basis: "par", couponsPerYear: 2, lookbacks: null, spreads: null,
        points: completeYieldCurve([
          { maturity: "10Y", maturityYears: 10, yield: 4.1, asOf: "2026-09-03" },
          { maturity: "2Y", maturityYears: 2, yield: 4.35, asOf: "2026-09-04" },
        ]),
      }),
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);
    expect(result.rows).toHaveLength(TREASURY_MATURITIES.length);
    expect(result.metadata).toMatchObject({
      requestedDate: null, asOf: null, inverted: null, spread2Y10YBasisPoints: null,
      missingTenors: ["1M", "3M", "6M", "1Y", "3Y", "5Y", "7Y", "20Y", "30Y"], stale: false,
    });
    expect(result.errors).toHaveLength(2);
  });

  test("without the stored curve, date options call bounded FRED history, preserve observation dates and flag stale sources", async () => {
    const calls: string[] = [];
    const context = { apiClient: { getCloudCurve: async () => {
      throw new Error("Not Found");
    }, getCloudFredSeries: async (id: string, options: { endDate: string }) => {
      calls.push(`${id}:${options.endDate}`);
      return {
        info: { id, units: "Percent", frequency: "Daily" },
        observations: [{ date: "2024-03-01", value: id === "DGS2" ? 4.54 : 4.19 }],
        stale: id === "DGS30",
      };
    } } } as unknown as HeadlessPaneContext;
    const result = await createYieldCurveHeadless().load({ ...args, options: { date: "2024-03-02" } }, context);
    // The curve first, then the look-backs that read the 1D move against the session before.
    expect(calls.slice(0, TREASURY_MATURITIES.length)).toEqual(TREASURY_MATURITIES.map(({ seriesId }) => `${seriesId}:2024-03-02`));
    expect(calls.slice(TREASURY_MATURITIES.length)).toEqual(TREASURY_MATURITIES.map(({ seriesId }) => `${seriesId}:2024-02-29`));
    expect(result.metadata).toMatchObject({ requestedDate: "2024-03-02", asOf: "2024-03-01", spread2Y10YBasisPoints: -35, missingTenors: [], stale: true });
    expect(result.errors).toEqual(["Some Treasury sources are stale cached data."]);
  });

  test("prints each tenor's move since the previous session in basis points, blank without one", async () => {
    const headless = createYieldCurveHeadless(stored({ "3M": 4.25, "2Y": 4.8, "10Y": 5.24, "30Y": 5.6 }, { "3M": 4.23, "2Y": 4.75, "10Y": 5.25, "30Y": 5.6 }));
    const result = await headless.load(args, {} as HeadlessPaneContext);
    const row = (maturity: string) => result.rows.find((entry) => entry.maturity === maturity)!;
    expect(row("2Y")).toMatchObject({ yield: 4.8, change1dBasisPoints: 5 });
    expect(row("10Y").change1dBasisPoints).toBe(-1);
    expect(row("30Y").change1dBasisPoints).toBe(0);
    // A tenor with no prior point has no move, not a zero one.
    expect(row("5Y").change1dBasisPoints).toBeNull();
    const lines = renderHeadlessPaneText(headless, result, args, "GC").split("\n");
    const cells = (maturity: string) => lines.find((line) => line.startsWith(`${maturity} `))!.split(/\s+/);
    expect(lines.find((line) => line.startsWith("Maturity"))!.split(/\s+/)).toEqual(["Maturity", "Years", "Yield", "1D", "bp", "As", "of"]);
    expect(cells("2Y")).toEqual(["2Y", "2", "4.80%", "+5bp", "2026-10-09"]);
    expect(cells("10Y")[3]).toBe("-1bp");
    expect(cells("30Y")[3]).toBe("0bp");
    expect(cells("5Y")[3]).toBe("-");
  });

  test("leaves the move blank when the stored curve has no previous session, and loads FRED's look-backs for the fallback", async () => {
    const result = await createYieldCurveHeadless(stored({ "2Y": 4.8 }, null)).load(args, {} as HeadlessPaneContext);
    expect(result.rows.find((row) => row.maturity === "2Y")!.change1dBasisPoints).toBeNull();

    const fallback = createYieldCurveHeadless({
      load: async () => ({ curve: "us", requestedDate: "", basis: "par", couponsPerYear: 2, lookbacks: null, spreads: null, points: curve("2026-10-09", { "2Y": 4.8 }) }),
      lookbacks: async (session) => {
        expect(session).toBe("2026-10-09");
        return { "1D": curve("2026-10-08", { "2Y": 4.75 }) };
      },
    });
    expect((await fallback.load(args, {} as HeadlessPaneContext)).rows.find((row) => row.maturity === "2Y")!.change1dBasisPoints).toBe(5);
  });

  test("a span compares with the session that many days, weeks, months or years back and shows both curves and the difference", async () => {
    const requested: string[] = [];
    const headless = createYieldCurveHeadless({
      ...stored({ "2Y": 4.8, "10Y": 5.24 }, null),
      compare: async (_curve, date) => {
        requested.push(date);
        return curve("2026-10-08", { "2Y": 4.75, "10Y": 5.3 });
      },
    });
    for (const span of ["1D", "1W", "1M", "3M", "1Y"]) await headless.load({ ...args, options: { compare: span.toLowerCase() } }, {} as HeadlessPaneContext);
    expect(requested).toEqual(["2026-10-08", "2026-10-02", "2026-09-09", "2026-07-09", "2025-10-09"]);

    const result = await headless.load({ ...args, options: { compare: "1D" } }, {} as HeadlessPaneContext);
    expect(result.metadata).toMatchObject({ compare: "1D", compareAsOf: "2026-10-08" });
    const lines = renderHeadlessPaneText(headless, result, args, "GC").split("\n");
    expect(lines.find((line) => line.startsWith("Maturity"))!.split(/\s+/)).toEqual(["Maturity", "Years", "Yield", "As", "of", "vs", "2026-10-08", "Chg", "bp"]);
    expect(lines.find((line) => line.startsWith("2Y "))!.split(/\s+/)).toEqual(["2Y", "2", "4.80%", "2026-10-09", "4.75%", "+5bp"]);
    expect(lines.find((line) => line.startsWith("10Y"))!.split(/\s+/)).toEqual(["10Y", "10", "5.24%", "2026-10-09", "5.30%", "-6bp"]);
  });

  test("tenors not yet issued on a past date are a note, not an error; a gap in the latest curve still is one", async () => {
    const yields = { "3M": 3.3, "6M": 3.49, "10Y": 5.94 };
    const past = await createYieldCurveHeadless(stored(yields, null)).load({ ...args, options: { date: "2026-10-09" } }, {} as HeadlessPaneContext);
    expect(past.notes).toEqual([`Not issued then: ${["1M", "1Y", "2Y", "3Y", "5Y", "7Y", "20Y", "30Y"].join(", ")}`]);
    expect(past.errors).toEqual([]);
    // The tenors stay in the metadata as they were.
    expect(past.metadata).toMatchObject({ missingTenors: ["1M", "1Y", "2Y", "3Y", "5Y", "7Y", "20Y", "30Y"] });
    const text = renderHeadlessPaneText(createYieldCurveHeadless(), past, args, "GC");
    expect(text).toContain("Notes: Not issued then:");
    expect(text).not.toContain("Errors:");

    const latest = await createYieldCurveHeadless(stored(yields, null)).load(args, {} as HeadlessPaneContext);
    expect(latest.notes).toBeUndefined();
    expect(latest.errors).toEqual([`Tenors unavailable: ${["1M", "1Y", "2Y", "3Y", "5Y", "7Y", "20Y", "30Y"].join(", ")}`]);
  });
});
