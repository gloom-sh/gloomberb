import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetFredSeriesPersistence } from "../../../data/fred-series";
import type { DataProvider } from "../../../types/data-provider";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { buildVolatilityData } from "./model";
import { createVolatilityHeadless } from "./headless";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };
const signal = new AbortController().signal;
beforeEach(resetFredSeriesPersistence);
afterEach(resetFredSeriesPersistence);

describe("volatility headless model", () => {
  test("default loader uses the supplied provider and cloud API while preserving distinct observation dates", async () => {
    const chartCalls: unknown[][] = [];
    const fredCalls: string[] = [];
    const marketData = { id: "injected", getPriceHistoryForResolution: async (...request: unknown[]) => {
      chartCalls.push(request);
      return request[0] === "^VIX" ? [{ date: new Date("2026-09-21T20:00:00Z"), close: 20 }]
        : request[0] === "^VIX3M" ? [{ date: new Date("2026-09-21T20:00:00Z"), close: 23 }] : [];
    } } as unknown as DataProvider;
    const apiClient = { getCloudFredSeries: async (id: string) => {
      fredCalls.push(id);
      return { info: null, observations: [{ date: "2026-09-18", value: id === "VIXCLS" ? 18 : 21 }] };
    } } as HeadlessPaneContext["apiClient"];
    const result = await createVolatilityHeadless().load(args, { marketData, apiClient, signal } as HeadlessPaneContext);
    expect(chartCalls).toHaveLength(22);
    expect(chartCalls.every((call) => call[1] === "" && call[2] === "1Y" && call[3] === "1d")).toBe(true);
    expect(fredCalls).toEqual(["VIXCLS", "VXVCLS"]);
    expect(result.complete).toBe(false);
    expect(result.unavailableSymbols).toContain("^RVX");
    const metadata = result.metadata as { data: ReturnType<typeof buildVolatilityData>; phase: string; observations: string; vixFuturesAvailable: boolean };
    expect(metadata.data.curve).toMatchObject({ date: "2026-09-21", ratio: 23 / 20 });
    expect(metadata.data.fred).toMatchObject({ termDate: "2026-09-18", ratio: 21 / 18 });
    expect(metadata.data.board.find((row) => row.id === "vix")).toMatchObject({ source: "injected", sampleSize: 1, change1d: null, percentile1y: null });
    expect(metadata.phase).toBe("partial");
    const curve = result.sections.find((section) => section.title === "Aligned curve observations");
    const board = result.sections.find((section) => section.title === "Cross-asset volatility");
    expect(curve && "rows" in curve ? curve.rows[1] : null).toMatchObject({ sourceId: "^VIX", value: 20, date: "2026-09-21" });
    expect(board && "rows" in board ? board.rows.find((row) => row.id === "vix") : null)
      .toMatchObject({ value: 20, change1d: null, percentile1y: null, date: "2026-09-21" });
  });

  test("cancellation after an injected load prevents publishing a completed headless result", async () => {
    const controller = new AbortController();
    const headless = createVolatilityHeadless({ load: async () => {
      controller.abort();
      return { data: buildVolatilityData({}), phase: "error", stale: false, errors: ["offline"], loaded: 24, total: 24 };
    } });
    await expect(headless.load(args, { signal: controller.signal } as HeadlessPaneContext)).rejects.toMatchObject({ name: "AbortError" });
  });
});
