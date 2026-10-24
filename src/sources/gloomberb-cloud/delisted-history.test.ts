import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { CloudHistoryParams } from "../../api-client/paths";
import type { CloudPricePointPayload } from "../../api-client/types";
import { resolveChartSpecData } from "../../time-series/resolve";
import type { ChartSpec } from "../../time-series/types";
import { AssetDataRouter } from "../provider-router";
import { GloomberbCloudProvider } from "./index";

// TWTR last traded 2022-10-27 and NYSE removed it the next
// day. Gloom Cloud serves its daily bars as asked, up to that session, and says
// so on every answer, an empty one included. A window ending today holds none.
const originalHistory = apiClient.getCloudHistory;
const originalQuote = apiClient.getCloudQuote;
afterEach(() => { apiClient.getCloudHistory = originalHistory; apiClient.getCloudQuote = originalQuote; });

const delisting = { status: "delisted", lastTradeDate: "2022-10-27", historyStart: "2019-01-02" };
const sessions: CloudPricePointPayload[] = [];
for (let time = Date.parse("2019-01-02"); time <= Date.parse("2022-10-27"); time += 86_400_000) {
  const day = new Date(time).getUTCDay();
  if (day !== 0 && day !== 6) sessions.push({ date: new Date(time).toISOString().slice(0, 10), close: 30 + sessions.length / 100 } as CloudPricePointPayload);
}

const apple: CloudPricePointPayload[] = [];
for (let time = Date.parse("2019-01-02"); time <= Date.parse("2022-12-30"); time += 86_400_000) {
  const day = new Date(time).getUTCDay();
  if (day !== 0 && day !== 6) apple.push({ date: new Date(time).toISOString().slice(0, 10), close: 40 + apple.length / 10 } as CloudPricePointPayload);
}

function serveTwitter(calls: CloudHistoryParams[]) {
  apiClient.getCloudHistory = async (symbol, _exchange, params = {}) => {
    if (symbol === "AAPL") {
      const data = apple.filter((bar) => String(bar.date) >= (params.startDate ?? "") && String(bar.date) < (params.endDate ?? "9999"));
      return { status: "success", data };
    }
    calls.push(params);
    // A date-only end is exclusive, one with a time holds its day; an intraday range is served daily bars.
    const start = params.startDate?.slice(0, 10) ?? "0000", end = params.endDate ?? "9999-12-31";
    const data = sessions.filter((bar) => String(bar.date) >= start
      && (end.length === 10 ? String(bar.date) < end : String(bar.date) <= end.slice(0, 10)));
    const servedResolution = /min|h$/.test(params.interval ?? "") ? "1day" : undefined;
    return data.length ? { status: "success", data, delisting, servedResolution } : { status: "empty", data: null, delisting };
  };
  // Its last quote: stale, and a later print than its last bar, as First Republic's pre-market one was.
  // The chart adds no bar for it.
  apiClient.getCloudQuote = async (symbol) => symbol === "AAPL" ? { status: "success", data: {
    symbol: "AAPL", name: "Apple Inc.", price: 250, currency: "USD", change: 1, changePercent: 0.4, lastUpdated: Date.now(),
    marketState: "REGULAR", providerId: "gloomberb-cloud", instrumentType: "EQUITY", listingExchangeName: "NASDAQ" } }
  : ({ status: "success", stale: true, data: {
    symbol: "TWTR", name: "Twitter, Inc.", price: 54.2, currency: "USD", change: 0.34, changePercent: 0.63,
    lastUpdated: Date.parse("2022-10-28T12:00:00Z"), marketState: "PRE", providerId: "gloomberb-cloud",
    instrumentType: "EQUITY", listingExchangeName: "NYSE", delisting } });
}

const spec = (range: ChartSpec["viewport"]["range"], symbols = ["TWTR"], dateWindow?: { start: string; end: string }): ChartSpec => ({ version: 2,
  viewport: { range, resolution: dateWindow ? "1d" : "auto", ...(dateWindow ? { dateWindow } : {}) }, panels: [{ id: "main" }], studies: [],
  series: symbols.map((symbol) => ({ id: symbol, label: symbol, source: { kind: "security" as const, instrument: { symbol, exchange: symbol === "AAPL" ? "NASDAQ" : "NYSE" },
    fieldId: "market.close" }, style: "line" as const, transform: "raw" as const, axis: "left" as const, panelId: "main", interpolation: "none" as const })),
});
const sources = (router: AssetDataRouter) => ({ dataProvider: router,
  loadFredSeries: async () => { throw Error("No FRED source belongs to this fixture"); } });

test("a delisted listing's chart ends on its last session, says so, and adds no later print", async () => {
  const calls: CloudHistoryParams[] = [];
  serveTwitter(calls);
  const router = new AssetDataRouter(new GloomberbCloudProvider());
  const year = await resolveChartSpecData(spec("1Y"), sources(router));
  expect(year.errors).toEqual([]);
  const days = year.series[0]!.points.map((point) => point.date.toISOString().slice(0, 10));
  expect(days.at(-1)).toBe("2022-10-27");
  expect(year.viewport?.end.toISOString().slice(0, 10)).toBe("2022-10-27");
  expect(year.viewport?.start.toISOString().slice(0, 10)).toBe("2021-10-27");
  expect(year.warnings).toContain("TWTR: Delisted Oct 27, 2022");
  // The window ending today came back empty; the one asked again ends the day after the last session.
  expect(calls.map((params) => params.endDate)).toEqual([expect.not.stringMatching(/^2022/), "2022-10-28"]);
  // Known from then on: the next window is asked up to the last session at once (its 15-minute
  // bars are daily ones, so the month is then charted from the range the service anchors itself).
  calls.length = 0;
  const month = await resolveChartSpecData(spec("1M"), sources(router));
  expect(month.series[0]!.points.at(-1)?.date.toISOString().slice(0, 10)).toBe("2022-10-27");
  expect(calls.every((params) => !params.endDate || params.endDate <= "2022-10-28")).toBe(true);
  expect(month.warnings).toContain("TWTR: Delisted Oct 27, 2022");
});

test("AAPL against TWTR over 2019 to 2022: each line ends on its own last session, the delisted one named", async () => {
  serveTwitter([]);
  const compared = await resolveChartSpecData(spec("ALL", ["AAPL", "TWTR"], { start: "2019-01-01", end: "2022-12-31" }),
    sources(new AssetDataRouter(new GloomberbCloudProvider())));
  expect(compared.errors).toEqual([]);
  const last = (id: string) => compared.series.find((series) => series.id === id)!.points
    .filter((point) => point.value != null).at(-1)?.date.toISOString().slice(0, 10);
  expect([last("AAPL"), last("TWTR")]).toEqual(["2022-12-30", "2022-10-27"]);
  expect(compared.series.find((series) => series.id === "TWTR")!.points[0]?.date.toISOString().slice(0, 10)).toBe("2019-01-02");
  expect(compared.warnings).toEqual(["TWTR: Delisted Oct 27, 2022"]);
  expect(compared.delistings).toEqual([{ symbol: "TWTR", label: "Delisted Oct 27, 2022", notice: "TWTR: Delisted Oct 27, 2022" }]);
});
