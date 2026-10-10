import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { statsCache } from "./cache";
import { econStatisticsHeadless } from "./headless";
import { createTestHeadlessContext } from "../../../test-support/headless";

beforeEach(() => statsCache.reset());
afterEach(() => statsCache.reset());

function monthlyCpi() {
  return Array.from({ length: 25 }, (_, index) => {
    const year = 2024 + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return {
      date: `${year}-${String(month).padStart(2, "0")}-01`,
      value: 300 + index,
    };
  });
}

const args: HeadlessPaneLoadArgs = {
  rawArgument: "cpi",
  argument: "cpi",
  symbols: [],
  options: { range: "5Y" },
};

describe("economic statistics headless model", () => {
  test("loads through the injected cloud client and produces category sections", async () => {
    const requested: string[] = [];
    const apiClient = {
      getCloudFredSeries: async (seriesId: string) => {
        requested.push(seriesId);
        return { seriesId, observations: monthlyCpi() };
      },
    } as unknown as HeadlessPaneContext["apiClient"];
    const result = await econStatisticsHeadless.load(args, createTestHeadlessContext({ apiClient }));

    expect(requested).toEqual(["CPIAUCNS"]);
    expect(result.sections.map(({ title }) => title)).toEqual(["Inflation", "CPI"]);
    expect(result.sections[0]).toMatchObject({
      rows: [{ id: "cpi-yoy", indicator: "CPI y/y" }],
    });
    expect(result.metadata).toMatchObject({ range: "5Y", selected: "cpi-yoy" });
  });

  test("dates each reading by its period, keeps the raw date in the rows, and explains %ile once", async () => {
    const apiClient = {
      getCloudFredSeries: async () => ({ observations: monthlyCpi() }),
    } as unknown as HeadlessPaneContext["apiClient"];
    const result = await econStatisticsHeadless.load(args, createTestHeadlessContext({ apiClient }));
    const [table, detail] = result.sections as Array<{ columns?: Array<{ header: string; format?: (value: unknown, row: Record<string, unknown>) => string }>; rows?: Array<Record<string, unknown>>; entries?: Array<{ label: string; value: unknown; formatted?: string }> }>;
    const row = table!.rows![0]!;
    // Monthly data runs to Jan 2026 here: 2026-01-01 is January, not the first of the month.
    expect(row).toMatchObject({ asOf: "2026-01-01", reading: "Jan 2026" });
    const period = table!.columns!.find((column) => column.header === "Period")!;
    expect(period.format!(row.asOf, row)).toBe("Jan 2026");
    expect(detail!.entries!.find((entry) => entry.label === "Period")).toMatchObject({ value: "2026-01-01", formatted: "Jan 2026" });
    expect(result.notes).toEqual(["%ile is the share of past readings at or below the latest one, over the last 5 years."]);
    const all = await econStatisticsHeadless.load({ ...args, options: { range: "ALL" } }, createTestHeadlessContext({ apiClient }));
    expect(all.notes?.[0]).toContain("over the full history");
  });
});
