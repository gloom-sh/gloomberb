import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchShortInterest, loadShortInterest } from "./client";

const yahoo = spyOn(YahooHttpClient.prototype, "fetchJsonWithCrumb");
afterEach(() => yahoo.mockReset());
afterAll(() => yahoo.mockRestore());
const fallback = { getCloudShortInterest: async () => { throw new Error("Controlled history unavailable"); } };
const record = (shares = 20_000_000, ratio = 2.3, percent?: number) => ({
  quoteSummary: { result: [{ defaultKeyStatistics: {
    dateShortInterest: "2026-08-31", sharesShort: { raw: shares }, shortRatio: { raw: ratio },
    sharesShortPreviousMonthDate: "2026-08-14", sharesShortPriorMonth: { raw: 10_000_000 },
    floatShares: { raw: 100_000_000 },
    ...(percent === undefined ? {} : { shortPercentOfFloat: { raw: percent } }),
  } }] },
});

test("fallback preserves reported settlement metrics without inventing dated denominators", async () => {
  yahoo.mockResolvedValue(record(20_000_000, 2.3, .25));
  const rows = await fetchShortInterest("TEST", fallback);
  expect(rows.map(row => row.settlementDate.toISOString())).toEqual(["2026-08-14T00:00:00.000Z", "2026-08-31T00:00:00.000Z"]);
  expect(rows[0]).toMatchObject({ sharesShort: 10_000_000, shortRatio: null, averageDailyVolume: null, shortPercentFloat: null });
  expect(rows[1]).toMatchObject({ sharesShort: 20_000_000, shortRatio: 2.3, averageDailyVolume: null, shortPercentFloat: 25 });
});

test("missing percent stays unknown even when an undated float is supplied", async () => {
  yahoo.mockResolvedValue(record());
  const rows = await fetchShortInterest("TEST", fallback);
  expect(rows.map(row => row.shortPercentFloat)).toEqual([null, null]);
  expect(rows.map(row => row.averageDailyVolume)).toEqual([null, null]);
});

test("reported zero and percentages above 100 remain source data", async () => {
  yahoo.mockResolvedValue(record(0, 0, 0));
  expect((await fetchShortInterest("TEST", fallback))[1]).toMatchObject({ sharesShort: 0, shortRatio: 0, averageDailyVolume: null, shortPercentFloat: 0 });
  yahoo.mockResolvedValue(record(150_000_000, 2, 1.5));
  expect((await fetchShortInterest("TEST", fallback))[1]!.shortPercentFloat).toBe(150);
});

test("FINRA average daily volume remains independent of its reported days-to-cover ratio", async () => {
  const rows = await fetchShortInterest("TEST", { getCloudShortInterest: async () => ({ status: "success", data: {
    symbol: "TEST", issueName: null, points: [{ settlementDate: "2026-08-31", sharesShort: 20_000_000,
      averageDailyVolume: 8_800_000, daysToCover: 2.3, previousSharesShort: null, changePercent: null, revised: false }],
  } }) });
  expect(rows[0]).toMatchObject({ averageDailyVolume: 8_800_000, shortRatio: 2.3, shortPercentFloat: null });
  expect(yahoo).not.toHaveBeenCalled();
});

test("the Yahoo fallback reports its source and whether Cloud wanted a session", async () => {
  yahoo.mockResolvedValue(record());
  const denied = { getCloudShortInterest: async () => { throw new ApiRequestError("Unauthorized", 401); } };
  expect(await loadShortInterest("TEST", denied)).toMatchObject({ source: "yahoo", cloudSessionRequired: true });
  expect(await loadShortInterest("TEST", fallback)).toMatchObject({ source: "yahoo", cloudSessionRequired: false });
});
