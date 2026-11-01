import { describe, expect, test } from "bun:test";
import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import { loadMacroDayEarnings, loadMacroDaySeriesHistory, macroDayEarningsNotice } from "./client";
import { formatMacroDayMove, projectMacroDays } from "./model";
import { fredSeriesArgument } from "../../../series/fred-argument";

const report = (date: string, afterSession: string | null) => ({ date, timing: "amc" as const, realized: afterSession ? { afterSession } : null });
const resource = (reports: unknown[]) => ({ payload: { reports } as unknown as EarningsHistoryPayload, stale: false, refreshError: null });

describe("macro-day on a FRED series", () => {
  test("FRED:T10Y2Y reads as the spread's daily values, and a release day's move is the change in bp", async () => {
    expect(fredSeriesArgument("fred:t10y2y")).toBe("T10Y2Y");
    expect(fredSeriesArgument("FRED:TSXV")).toBeNull();
    const asked: Array<[string, unknown]> = [];
    const client = { getCloudFredSeries: async (id: string, params: unknown) => {
      asked.push([id, params]);
      return { info: { id, title: "10-Year Treasury Constant Maturity Minus 2-Year Treasury Constant Maturity", units: "Percent" } as never,
        observations: [{ date: "2026-10-12", value: null }, { date: "2026-10-13", value: 0.42 }, { date: "2026-10-14", value: 0.37 },
          { date: "2026-10-15", value: 0.33 }, { date: "2026-10-16", value: 0.35 }] };
    } };
    const series = await loadMacroDaySeriesHistory({ seriesId: "T10Y2Y" }, client, Date.parse("2026-10-20T12:00:00Z"));
    expect(asked[0]).toEqual(["T10Y2Y", { startDate: "2021-10-16", sortOrder: "asc" }]);
    // A day FRED lists with no value (a holiday) is no close.
    expect(series).toMatchObject({ rate: true, error: null, stale: false });
    expect(series.history.map((point) => point.close)).toEqual([0.42, 0.37, 0.33, 0.35]);
    const model = projectMacroDays(series.history, { symbol: "FRED:T10Y2Y", basis: "yield", lookbackYears: 1, coveredThrough: "2026-10-16",
      releases: [{ kind: "cpi", date: "2026-10-14" }] });
    expect(model.basis).toBe("yield");
    expect(formatMacroDayMove(model.events[0]!.move, model.basis)).toBe("-5.0bp");
    // A series not in percent moves by its return.
    const index = await loadMacroDaySeriesHistory({ seriesId: "SP500" }, { getCloudFredSeries: async () => ({ info: { units: "Index" } as never,
      observations: [{ date: "2026-10-13", value: 100 }] }) });
    expect(index.rate).toBe(false);
  });
});

describe("macro-day earnings dates", () => {
  test("ask for the bare US symbol, skip other venues, and leave the study unmarked when the read fails", async () => {
    const asked: Array<[string, number | undefined]> = [];
    const load = async (symbol: string, _force?: boolean, limit?: number) => { asked.push([symbol, limit]); return resource([report("2026-08-11", "2026-08-12"), report("2026-11-09", null)]); };

    const listed = await loadMacroDayEarnings({ instrument: { symbol: "crwv:xnas", exchange: "NASDAQ" } }, load);
    expect(asked.map(([symbol]) => symbol)).toEqual(["CRWV"]);
    expect(asked[0]![1]).toBeGreaterThan(20);
    expect(listed.reports).toEqual([{ date: "2026-08-11", timing: "amc", reactionSession: "2026-08-12" }, { date: "2026-11-09", timing: "amc", reactionSession: null }]);

    // A listing key naming another venue is not the US company of the same symbol.
    expect((await loadMacroDayEarnings({ instrument: { symbol: "SAP:XETR", exchange: "" } }, load)).reports).toEqual([]);
    expect(asked).toHaveLength(1);

    const failed = await loadMacroDayEarnings({ instrument: { symbol: "CRWV", exchange: "NASDAQ" } }, async () => { throw new Error("offline"); });
    expect(failed).toMatchObject({ reports: [], error: "offline" });
    expect(macroDayEarningsNotice(failed)).toContain("offline");
    expect(macroDayEarningsNotice(listed)).toBeNull();

    const controller = new AbortController();
    controller.abort();
    await expect(loadMacroDayEarnings({ instrument: { symbol: "CRWV" }, signal: controller.signal }, load)).rejects.toThrow();
  });
});
