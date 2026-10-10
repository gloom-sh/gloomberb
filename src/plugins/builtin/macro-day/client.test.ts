import { describe, expect, test } from "bun:test";
import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import { loadMacroDayEarnings, macroDayEarningsNotice } from "./client";

const report = (date: string, afterSession: string | null) => ({ date, timing: "amc" as const, realized: afterSession ? { afterSession } : null });
const resource = (reports: unknown[]) => ({ payload: { reports } as unknown as EarningsHistoryPayload, stale: false, refreshError: null });

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
