import { afterEach, expect, setSystemTime, test } from "bun:test";
import { apiClient, type CloudPricePointPayload } from "../../api-client";
import { historyBarStatusNote, historyRows } from "../../cli/history-rows";
import { AssetDataRouter } from "../provider-router";
import { GloomberbCloudProvider } from "./index";

const originalHistory = apiClient.getCloudHistory;
afterEach(() => { apiClient.getCloudHistory = originalHistory; setSystemTime(); });

// Gloom Cloud has EGX listings as daily bars only, and answers an intraday
// range with them, saying so. Wednesday 7 Oct 2026 is the latest session over
// the Thursday holiday and the weekend; Cairo is UTC+3.
const wednesday: CloudPricePointPayload[] = [
  { date: "2026-10-07T00:00:00.000Z", open: 125.16, high: 125.9, low: 124.14, close: 124.65, volume: 3345837 },
];

async function oneDay(now: string, servedResolution?: string) {
  setSystemTime(Date.parse(now));
  const asked: string[] = [];
  apiClient.getCloudHistory = async (symbol: string, exchange?: string, interval?: string) => {
    asked.push(`${symbol}:${exchange ?? ""}:${interval ?? ""}`);
    return { status: "success", data: wednesday, ...(servedResolution ? { servedResolution } : {}) };
  };
  const result = await new AssetDataRouter(new GloomberbCloudProvider()).getPriceHistoryWithMetadata("COMI.CA", "", "1D");
  return { ...result, asked };
}

test("an EGX one-day range is its latest session's daily bar, read as daily, on the weekend and in session", async () => {
  // Saturday evening, then Sunday 11:00 Cairo with no bar for today yet.
  for (const now of ["2026-10-10T19:40:00Z", "2026-10-11T08:00:00Z"]) {
    const { points, resolution, asked } = await oneDay(now, "1day");
    expect(resolution, now).toBe("1d");
    expect(points.map((point) => [new Date(point.date).toISOString(), point.close]), now)
      .toEqual([["2026-10-07T00:00:00.000Z", 124.65]]);
    expect(asked.every((request) => request.startsWith("COMI.CA:EGX:")), now).toBe(true);
  }
});

test("a coin's partial and filled days keep their flags through the router", async () => {
  setSystemTime(Date.parse("2026-10-12T00:25:00Z"));
  apiClient.getCloudHistory = async () => ({ status: "success", data: [
    { date: "2026-10-10T00:00:00.000Z", open: 82546.32, high: 83092.03, low: 82473.04, close: 82912.23, volume: 12485050512 },
    { date: "2026-10-11T00:00:00.000Z", open: 82913.3, high: 84110.54, low: 82716.81, close: 83680.59, filled: true },
    { date: "2026-10-12T00:00:00.000Z", open: 83673.01, high: 83704.88, low: 83652.21, close: 83704.88, partial: true },
  ] });
  const { points } = await new AssetDataRouter(new GloomberbCloudProvider()).getPriceHistoryWithMetadata("BTC-USD", "CCC", "1M");
  expect(points.map((point) => [new Date(point.date).toISOString().slice(0, 10), point.volume ?? null, point.partial ?? false, point.filled ?? false])).toEqual([
    ["2026-10-10", 12485050512, false, false],
    ["2026-10-11", null, false, true],
    ["2026-10-12", null, true, false],
  ]);
});

test("a future's unsettled and trading sessions keep their flags through the router, and history says what they are", async () => {
  // CL=F read at 20:40 New York on 2026-10-13: 10-13 has closed on its last trade, 10-14 trades from the evening open.
  setSystemTime(Date.parse("2026-10-14T00:40:00Z"));
  apiClient.getCloudHistory = async () => ({ status: "success", data: [
    { date: "2026-10-12T00:00:00.000Z", open: 90.98, high: 93.43, low: 88.9, close: 92.86, volume: 165128 },
    { date: "2026-10-13T00:00:00.000Z", open: 92.4, high: 94.09, low: 90.85, close: 93.2, volume: 191509, unsettled: true },
    { date: "2026-10-14T00:00:00.000Z", open: 93.73, high: 93.91, low: 93.52, close: 93.8, volume: 1820, partial: true },
  ] });
  const { points, resolution } = await new AssetDataRouter(new GloomberbCloudProvider()).getPriceHistoryWithMetadata("CL=F", "", "1M");
  expect(points.map((point) => [new Date(point.date).toISOString().slice(0, 10), point.unsettled ?? false, point.partial ?? false])).toEqual([
    ["2026-10-12", false, false], ["2026-10-13", true, false], ["2026-10-14", false, true],
  ]);
  expect(historyBarStatusNote(historyRows(points, resolution, "USD")))
    .toBe("2026-10-14 is still forming (partial); 2026-10-13 closes on the last trade until the settlement is confirmed (unsettled)");
});
