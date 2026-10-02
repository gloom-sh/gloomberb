import { afterEach, expect, setSystemTime, test } from "bun:test";
import { apiClient, type CloudPricePointPayload } from "../../api-client";
import { AssetDataRouter } from "../provider-router";
import { GloomberbCloudProvider } from "./index";

const originalHistory = apiClient.getCloudHistory;
afterEach(() => { apiClient.getCloudHistory = originalHistory; setSystemTime(); });

const bars = (...dates: string[]): CloudPricePointPayload[] => dates.map((date, index) => ({
  date, open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 1000,
}));
// Signed out, Cloud is the only history source: a miss leaves nothing to answer.
async function staleHistory(now: string, data: CloudPricePointPayload[], symbol: string, exchange: string, range: "1W" | "1M") {
  setSystemTime(Date.parse(now));
  apiClient.getCloudHistory = async () => ({ status: "success", stale: true, data });
  return new AssetDataRouter(new GloomberbCloudProvider()).getPriceHistory(symbol, exchange, range);
}

const aaplMonth = bars("2026-09-28", "2026-09-29");
// Helsinki closes 18:30 EEST (15:30Z); hourly bars open on the hour.
const ttaloWeek = bars("2026-10-02T13:00:00Z", "2026-10-02T14:00:00Z", "2026-10-02T15:00:00Z");

test("a copy the server marks stale answers when it reaches the venue's latest settled session", async () => {
  // Wednesday 11:00 ET: Tuesday is the latest settled session.
  expect(await staleHistory("2026-09-30T15:00:00Z", aaplMonth, "AAPL", "NASDAQ", "1M")).toHaveLength(2);
  // Friday evening after the Helsinki close, and over the weekend.
  expect(await staleHistory("2026-10-02T21:39:00Z", ttaloWeek, "TTALO", "HEL", "1W")).toHaveLength(3);
  expect(await staleHistory("2026-10-04T12:00:00Z", ttaloWeek, "TTALO", "HEL", "1W")).toHaveLength(3);
});

test("a copy the server marks stale is still a miss once a later session has settled", async () => {
  // Wednesday's close settled at 20:30Z without its bar.
  await expect(staleHistory("2026-09-30T21:00:00Z", aaplMonth, "AAPL", "NASDAQ", "1M"))
    .rejects.toThrow("No history provider available for AAPL");
  // Monday after the Helsinki close, still on Friday's bars.
  await expect(staleHistory("2026-10-05T17:00:00Z", ttaloWeek, "TTALO", "HEL", "1W"))
    .rejects.toThrow("No history provider available for TTALO");
  // In Wednesday's session, Tuesday's hourly bars reach the settled session
  // but not the delayed feed: the app's own current-window check decides.
  await expect(staleHistory("2026-09-30T16:00:00Z", bars("2026-09-29T18:30:00Z", "2026-09-29T19:30:00Z"), "AAPL", "NASDAQ", "1W"))
    .rejects.toThrow("No history provider available for AAPL");
});
