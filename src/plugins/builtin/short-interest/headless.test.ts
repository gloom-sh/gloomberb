import { describe, expect, test } from "bun:test";
import { CloudDataApi } from "../../../api-client/data";
import type { CloudMarketResponse, CloudShortInterestPayload } from "../../../api-client/types";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import { loadShortInterest } from "./client";
import { createShortInterestHeadless } from "./headless";
import { createTestHeadlessContext } from "../../../test-support/headless";
import { reportGlossary } from "../../../cli/glossary";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { shortInterestFreshness } from "./schedule";
import { shortWatchHeadless } from "./watch-headless";
import { setupLabel } from "./watch-model";

const records = [
  {
    settlementDate: new Date("2026-08-15T00:00:00.000Z"),
    sharesShort: 12_000_000,
    shortRatio: 2.5,
    averageDailyVolume: 4_800_000,
    shortPercentFloat: 3.2,
  },
  {
    settlementDate: new Date("2026-08-31T00:00:00.000Z"),
    sharesShort: 15_000_000,
    shortRatio: 3,
    averageDailyVolume: 5_000_000,
    shortPercentFloat: 4.1,
  },
];

function args(overrides: Partial<HeadlessPaneLoadArgs["options"]> = {}): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AMD",
    argument: "AMD",
    symbols: ["AMD"],
    options: { order: "newest", limit: 24, ...overrides },
  };
}

describe("short interest client", () => {
  test("uses the served market route for FINRA history", async () => {
    const paths: string[] = [];
    const dataApi = new CloudDataApi(async <T>(path: string): Promise<T> => {
      paths.push(path);
      return {
        status: "success",
        data: {
          symbol: "AAPL",
          issueName: "Apple Inc.",
          points: [{
            settlementDate: "2026-08-31",
            sharesShort: 15_000_000,
            previousSharesShort: 12_000_000,
            averageDailyVolume: 5_000_000,
            daysToCover: 3,
            changePercent: 25,
            revised: false,
          }],
        },
      } as CloudMarketResponse<CloudShortInterestPayload> as T;
    });

    const { records: result } = await loadShortInterest("aapl", dataApi);

    expect(paths).toEqual(["/market/short-interest?symbol=AAPL"]);
    expect(result[0]).toMatchObject({ sharesShort: 15_000_000, shortRatio: 3 });
  });
});

describe("short interest headless model", () => {
  test("projects raw settlement values and applies order and limit", async () => {
    const headless = createShortInterestHeadless({
      loadRecords: async () => records,
    });

    const newest = await headless.load(args({ limit: 1 }), createTestHeadlessContext());
    expect(newest.rows).toEqual([{
      settlementDate: "2026-08-31",
      sharesShort: 15_000_000,
      daysToCover: 3,
      averageDailyVolume: 5_000_000,
      shortPercentFloat: 4.1,
    }]);

    const oldest = await headless.load(args({ order: "oldest", limit: 1 }), createTestHeadlessContext());
    expect(oldest.rows[0]).toMatchObject({
      settlementDate: "2026-08-15",
      sharesShort: 12_000_000,
    });
  });

  test("a gloom payload with rows says the full history is unavailable", async () => {
    const headless = createShortInterestHeadless({
      loadRecords: async () => ({ records, source: "gloom", cloudSessionRequired: false }),
    });
    const result = await headless.load(args(), createTestHeadlessContext());
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.errors).toEqual(["Full history unavailable; showing the latest two settlements."]);
  });
});

describe("what --explain finds in the reports", () => {
  const now = Date.parse("2026-10-14T06:00:00Z");
  const explained = (token: string, text: string) => reportGlossary(token, text).map((entry) => entry.term);

  test("SI's own headers and source line carry the terms, and the source line says when the settlement was published", async () => {
    const headless = createShortInterestHeadless({ loadRecords: async () => records });
    const result = await headless.load(args(), createTestHeadlessContext());
    // The newest settlement shown is the one the schedule is read from.
    expect(result.freshness).toEqual(shortInterestFreshness("2026-08-31"));
    const text = [headless.columns!.map((column) => column.header).join("  "), formatFreshnessLine(deriveHeadlessFreshness(headless, result, now))].join("\n");
    expect(text).toContain("Days to cover");
    expect(explained("SI", text)).toEqual(["Short interest", "Settlement", "Days to cover", "Average daily volume", "Float"]);
  });

  test("SIW's headers, flags and title carry the terms", () => {
    const text = ["Short squeeze watch", shortWatchHeadless.columns!.map((column) => column.header).join("  "), setupLabel("crowded-rising")].join("\n");
    expect(explained("SIW", text)).toEqual(["Short interest", "Settlement", "Days to cover", "Float", "Crowded", "Squeeze", "SI change", "1M return"]);
    // A date column that holds a day says so.
    expect(shortWatchHeadless.columns!.map((column) => column.header)).toContain("Close date");
  });
});
