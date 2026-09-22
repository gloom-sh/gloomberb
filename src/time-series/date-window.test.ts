import { expect, test } from "bun:test";

const replay = `
import { createSnapshotDataProvider } from "../market-data/snapshot-provider.ts";
import { createTestDataProvider } from "../test-support/data-provider.ts";
import { historicalPricesHeadless } from "../plugins/builtin/ticker-detail/headless.ts";
import { correlationHeadless } from "../plugins/builtin/correlation/headless.ts";
import { createDefaultConfig } from "../types/config.ts";
import { subtractTimeRange, isDateWindowWithinTimeRange } from "./date-window.ts";
import { clipPriceHistoryToRange } from "./history-window.ts";
import { buildPresetDateWindow } from "../components/chart/core/date-window.ts";
import { buildPriceReturnFields } from "../market-data/performance.ts";
import { apiClient } from "../api-client/index.ts";
import { CloudDataApi } from "../api-client/data.ts";
import { GloomberbCloudProvider } from "../sources/gloomberb-cloud/index.ts";
import { setSystemTime } from "bun:test";

let liveCalls = 0;
const fallback = createTestDataProvider({ getPriceHistory: async () => { liveCalls++; throw new Error("Unexpected live history"); } });
const symbols = ["BTC-USD:CCC", "ETH-USD:CCC"];
const cases = [];
for (const end of ["2026-04-03T00:00:00Z", "2025-11-03T00:00:00Z", "2026-09-22T00:00:00Z", "2026-03-31T00:00:00Z", "2024-03-31T00:00:00Z"]) {
  setSystemTime(Date.parse(end));
  const history = Array.from({ length: 40 }, (_, index) => ({ date: new Date(Date.parse(end) - (39 - index) * 86400000), close: 100 + index }));
  const financials = symbols.map((symbol, asset) => [symbol, {
    annualStatements: [], quarterlyStatements: [], priceHistoryResolution: "1d",
    priceHistory: asset ? history.map((point, index) => ({ ...point, close: 200 + index * 2 + 3 * Math.sin(index / 3) })) : history,
  }]);
  const run = async (captured) => {
    const context = { marketData: createSnapshotDataProvider({ financials: captured }, fallback),
      config: createDefaultConfig(":memory:"), apiClient: {}, signal: new AbortController().signal };
    const args = { argument: symbols[0], rawArgument: symbols[0], symbols: [symbols[0]], options: { range: "1M" } };
    const prices = await historicalPricesHeadless.load(args, context);
    const all = await historicalPricesHeadless.load({ ...args, options: { range: "ALL" } }, context);
    const correlation = await correlationHeadless.load({ ...args, argument: symbols, symbols, options: { rangePreset: "1M" } }, context);
    return { first: prices.rows[0].date, last: prices.rows.at(-1).date, rows: prices.rows.length, allRows: all.rows.length,
      sampleSize: correlation.rows[0].sampleSize, correlation: correlation.rows[0].correlation,
      errors: [...prices.errors ?? [], ...correlation.errors ?? []] };
  };
  const original = await run(financials);
  const serialized = await run(JSON.parse(JSON.stringify(financials)));
  const cloudRequests = [];
  const transport = new CloudDataApi(async path => {
    const url = new URL(path, "https://controlled.invalid");
    cloudRequests.push({ symbol: url.searchParams.get("symbol"), exchange: url.searchParams.get("exchange"),
      interval: url.searchParams.get("interval"), start: url.searchParams.get("startDate"), end: url.searchParams.get("endDate") });
    return { status: "success", data: [{ date: end, close: 139 }] };
  });
  apiClient.getCloudHistory = transport.getCloudHistory.bind(transport);
  const cloud = new GloomberbCloudProvider();
  const cloudValues = [];
  for (const [symbol, exchange, resolution] of [["BTC-USD", "CCC", "15m"], ["AAPL", "NASDAQ", "15m"], ["AAPL", "NASDAQ", "1d"]]) {
    cloudValues.push((await cloud.getPriceHistoryForResolutionWithMetadata(symbol, exchange, "1M", resolution)).points[0].close);
  }
  cases.push({ ...serialized, datesRoundTrip: JSON.stringify(original) === JSON.stringify(serialized),
    oneMonthReturn: buildPriceReturnFields(history).find(field => field.id === "1M").value,
    cloudRequests, cloudValues,
    supportedAtBoundary: isDateWindowWithinTimeRange(new Date(serialized.first), new Date(end), "1M"),
    unsupportedBeforeBoundary: !isDateWindowWithinTimeRange(new Date(Date.parse(serialized.first) - 1), new Date(end), "1M") });
}
const end = new Date("2026-03-30T15:45:12.345Z");
const ranges = ["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"].map(range => subtractTimeRange(end, range).toISOString());
const rollover = [["2026-03-31T15:45:00Z", "1M"], ["2026-08-31T15:45:00Z", "6M"], ["2024-02-29T15:45:00Z", "1Y"]]
  .map(([date, range]) => subtractTimeRange(new Date(date), range).toISOString());
const oldHistory = [{ date: new Date("1950-01-01"), close: 1 }, { date: new Date("2024-02-29"), close: 2 }];
const allContract = { first: clipPriceHistoryToRange(oldHistory, "ALL")[0].date.toISOString(),
  chartStart: buildPresetDateWindow(oldHistory.map(point => point.date), "ALL").start.toISOString(),
  supported: isDateWindowWithinTimeRange(oldHistory[0].date, oldHistory[1].date, "ALL"),
  requestStart: subtractTimeRange(oldHistory[1].date, "ALL").toISOString() };
const yearlyReturn = buildPriceReturnFields([
  { date: "2025-10-25T00:00:00Z", close: 100 }, { date: "2025-10-26T00:00:00Z", close: 110 },
  { date: "2026-10-26T00:00:00Z", close: 121 },
]).find(field => field.id === "1Y").value;
setSystemTime();
console.log(JSON.stringify({ cases, liveCalls, ranges, rollover, yearlyReturn, allContract, input: end.toISOString() }));
`;

test("saved daily exports, correlation and range boundaries use the same UTC dates across DST and host timezones", () => {
  for (const timezone of ["UTC", "Europe/Berlin", "America/Los_Angeles"]) {
    const processResult = Bun.spawnSync([process.execPath, "--eval", replay], {
      cwd: import.meta.dir, env: { ...process.env, TZ: timezone }, stdout: "pipe", stderr: "pipe",
    });
    expect({ timezone, code: processResult.exitCode, error: new TextDecoder().decode(processResult.stderr) })
      .toEqual({ timezone, code: 0, error: "" });
    const result = JSON.parse(new TextDecoder().decode(processResult.stdout));
    const endpoints = [["2026-03-03", "2026-04-03"], ["2025-10-03", "2025-11-03"], ["2026-08-22", "2026-09-22"], ["2026-02-28", "2026-03-31"], ["2024-02-29", "2024-03-31"]];
    const newYorkBounds = [["2026-03-02 19:00:00", "2026-04-02 20:00:00"], ["2025-10-02 20:00:00", "2025-11-02 19:00:00"], ["2026-08-21 20:00:00", "2026-09-21 20:00:00"], ["2026-02-27 19:00:00", "2026-03-30 20:00:00"], ["2024-02-28 19:00:00", "2024-03-30 20:00:00"]];
    for (const [index, [first, last]] of endpoints.entries()) {
      expect(result.cases[index]).toMatchObject({ first: first + "T00:00:00.000Z", last: last + "T00:00:00.000Z",
        rows: 32, allRows: 40, sampleSize: 31, errors: [], datesRoundTrip: true,
        supportedAtBoundary: true, unsupportedBeforeBoundary: true });
      expect(result.cases[index].correlation).toBeCloseTo(-0.0955022928516023, 12);
      expect(result.cases[index].oneMonthReturn).toBeCloseTo(31 / 108, 12);
      expect(result.cases[index].cloudRequests).toEqual([
        { symbol: "BTC-USD", exchange: "CCC", interval: "15min", start: first + " 00:00:00", end: last + " 00:00:00" },
        { symbol: "AAPL", exchange: "NASDAQ", interval: "15min", start: newYorkBounds[index][0], end: newYorkBounds[index][1] },
        { symbol: "AAPL", exchange: "NASDAQ", interval: "1day", start: first, end: last },
      ]);
      expect(result.cases[index].cloudValues).toEqual([139, 139, 139]);
    }
    expect(result.liveCalls).toBe(0);
    expect(result.allContract).toEqual({ first: "1950-01-01T00:00:00.000Z", chartStart: "1950-01-01T00:00:00.000Z",
      supported: true, requestStart: "1974-02-28T00:00:00.000Z" });
    expect(result.ranges).toEqual([
      "2026-03-29T15:45:12.345Z", "2026-03-23T15:45:12.345Z", "2026-02-28T15:45:12.345Z", "2025-12-30T15:45:12.345Z",
      "2025-09-30T15:45:12.345Z", "2025-03-30T15:45:12.345Z", "2021-03-30T15:45:12.345Z", "1976-03-30T15:45:12.345Z",
    ]);
    // Month/year cutoffs clamp to valid calendar dates and retain their UTC clock.
    expect(result.rollover).toEqual(["2026-02-28T15:45:00.000Z", "2026-02-28T15:45:00.000Z", "2023-02-28T15:45:00.000Z"]);
    expect(result.input).toBe("2026-03-30T15:45:12.345Z");
    expect(result.yearlyReturn).toBeCloseTo(0.1, 12);
  }
});
