import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { PsdBoardPayload } from "../../api-client/commodity-balances";
import type { CotBoardPayload, CotClassSummary } from "../../api-client/cot";
import { AppPersistence } from "../../data/app-persistence";
import { getLoadablePlugins } from "../../plugins/catalog";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import { parseCliGlobalArgs } from "../options";
import { serializeCliResult } from "../result";
import { runPaneFunction } from "./index";

beforeEach(() => setSystemTime(new Date("2026-11-27T15:20:00Z")));
afterEach(() => setSystemTime());

function reportJson(json: string) {
  return JSON.parse(json, (key, value) => key === "elapsedMs" ? undefined : value);
}

async function report(...args: string[]) {
  const parsed = parseCliGlobalArgs(["fn", ...args]);
  const persistence = new AppPersistence(":memory:");
  const cli = createTestCliContext({ persistence, config: createDefaultConfig("fixture"), dataProvider: createTestDataProvider() }, parsed.options);
  Object.assign(cli.context, { plugins: getLoadablePlugins() });
  await runPaneFunction(parsed.args.slice(1), cli.context);
  const printed = cli.printed[0]!;
  expect(printed.result.failure).toBeUndefined();
  return serializeCliResult(printed.result, parsed.options, printed.options);
}

test("FUT crops keeps all balances and forecasts by default, and aliases select a crop before export or limits", async () => {
  const crops = ["Wheat", "Corn", "Soybeans", "Cotton", "Coffee", "Sugar"];
  const rows = crops.flatMap((crop, cropOrder) => Array.from({ length: 12 }, (_, countryOrder) => ({
    id: `${crop}-${countryOrder}`, crop, cropOrder, country: `Market ${countryOrder}`, countryOrder,
    attribute: "Production", attributeOrder: 0, value: 100 + countryOrder,
    unit: "1000 MT", year: "2026/27", month: "2026-11",
  })));
  const board: PsdBoardPayload = {
    status: "available", source: "USDA", stale: false, checkedAt: "2026-11-17T20:00:00Z",
    gaps: [], month: "2026-11", marketYear: "2026/27", rows, pricesDate: "2026-11-17",
    prices: [{ id: "Corn|2026/27", crop: "Corn", forecast: 4.2, unit: "$/bu", season: "2026/27", cropOrder: 1, seasonYear: 2026 }],
  };
  const read = spyOn(apiClient, "getCloudPsdBoard").mockResolvedValue(board);
  try {
    const text = await report("FUT", "--tab", "crops");
    expect(text.match(/Market \d+/g)).toHaveLength(72);
    expect(text).toContain("Sugar");
    expect(text).toContain("Prices");
    const json = reportJson(await report("GLCO", "soy", "--tab=crops", "--json"));
    expect(json).toMatchObject({ ok: true, data: { complete: true, rowCount: 12 } });
    expect(json).toEqual(reportJson(await report("PSD", "soy", "--json")));
    const csv = await report("GLCO", "soy", "--tab=crops", "--limit", "2", "--csv");
    expect(csv).toBe(await report("PSD", "soy", "--limit", "2", "--csv"));
    expect(csv.match(/Soybeans,Market/g)).toHaveLength(2);
  } finally { read.mockRestore(); }
});

test("FUT positioning keeps COT report options and the limit across text, JSON and CSV", async () => {
  const percentile = { value: null, rank: null, sampleCount: 0, windowStart: "2025-11-17", windowEnd: "2026-11-17",
    historyStart: null, historyEnd: null, completeWindow: false, min: null, max: null, mean: null };
  const position: CotClassSummary = { id: "commercial", label: "Commercial", long: 100, short: 80, spreading: null,
    net: 20, netPercentOfOpenInterest: 10, weeklyChange: null, previousReportDate: null, percentile1Y: percentile, percentile3Y: percentile };
  const board: CotBoardPayload = {
    source: "CFTC", reportFamily: "legacy", scope: "combined", traderClass: "commercial", status: "available", gaps: [],
    generatedAt: "2026-11-23T20:00:00Z", fetchedAt: "2026-11-23T20:00:00Z", asOf: "2026-11-17", publishedAt: null,
    classes: [{ id: "commercial", label: "Commercial" }],
    rows: Array.from({ length: 47 }, (_, index) => ({ contractCode: String(2602 + index).padStart(6, "0"),
      marketName: `Market ${index}`, exchangeCode: "CBT", commodityCode: "002", reportDate: "2026-11-17",
      openInterest: 200, position, status: "available" })),
  };
  const read = spyOn(apiClient, "getCloudCotBoard").mockResolvedValue(board);
  const options = ["--report", "legacy", "--trader-class", "commercial", "--positions", "combined", "--scope", "all"];
  try {
    const text = await report("FUT", "--tab=positioning", ...options);
    expect(text).toContain("report date 2026-11-17");
    expect(text).toContain("Net commercial");
    expect(text.match(/Market \d+/gi)).toHaveLength(47);
    const limited = await report("GLCO", "--tab=POSITIONING", ...options, "--limit", "15");
    expect(limited).toContain("Showing the first 15 of 47 markets.");
    expect(limited.match(/Market \d+/gi)).toHaveLength(15);
    for (const format of ["--json", "--csv"]) {
      const actual = await report("FUT", "--tab=positioning", ...options, "--limit", "15", format);
      const direct = await report("COT", ...options, "--limit", "15", format);
      if (format === "--json") {
        expect(reportJson(actual)).toEqual(reportJson(direct));
        expect(reportJson(actual)).toMatchObject({ ok: true, data: { rowCount: 15 } });
      } else {
        expect(actual).toBe(direct);
        expect(actual.split("\n")[0]).toContain(",Net,");
      }
    }
    expect(read.mock.calls.every((call) => call.join("/") === "legacy/commercial/combined")).toBe(true);
  } finally { read.mockRestore(); }
});
