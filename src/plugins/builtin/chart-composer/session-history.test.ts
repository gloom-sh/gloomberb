import { expect, test } from "bun:test";
import { buildFunctionReport } from "../../../cli/pane-functions/report";
import { parsePaneFunctionArgs } from "../../../cli/pane-functions/options";
import { resolvePaneFunction } from "../../../cli/pane-functions/resolver";
import { loadResolvedHeadlessPaneModel } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import type { MarketContext } from "../../../cli/types";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { PricePoint } from "../../../types/financials";
import { chartComposerModule } from ".";
import type { ChartPaneModel } from "./headless";
import { historicalIntradayClose } from "./session-history";

const day = "2026-10-30";
const point = (time: string, close: number, fields?: Partial<PricePoint>): PricePoint => ({ date: new Date(`${day}T${time}:00Z`), close, ...fields });
const prior = point("19:37", 12.27, { open: 12.26, high: 12.28, low: 12.26, volume: 710 });
const last = point("19:38", 12.31, { open: 12.27, high: 12.31, low: 12.27, volume: 811 });
const bell = point("20:00", 12.19, { sessionClose: true });
const later = point("20:04", 12.23, { open: 12.22, high: 12.23, low: 12.20, volume: 30 });
const catalog = {
  panes: new Map((chartComposerModule.panes ?? []).map((entry) => [entry.id, entry])),
  paneTemplates: new Map((chartComposerModule.paneTemplates ?? []).map((entry) => [entry.id, entry])),
  destroy: () => {},
};

test.each([
  { name: "declared close", points: [prior, last, bell, { ...bell, close: 12.20, sessionClose: undefined }, later], count: 4, close: true },
  { name: "unmarked bell print and adjusted daily close", points: [prior, last, { ...bell, close: 12.21, sessionClose: undefined }, later], count: 4, close: false },
  { name: "sparse session and unverifiable daily close", points: [prior, last], count: 2, close: false },
  { name: "no intraday data", points: [], count: 0, close: false },
])("dated GIP CLI and CSV preserve source observations: $name", async ({ points, count, close, name }) => {
  const requested: string[] = [];
  const buffered = points.length ? [{ ...prior, date: new Date("2026-10-29T19:37:00Z") }, ...points] : [];
  const provider = createTestDataProvider({
    getQuote: async () => createTestQuote({ symbol: "BDRY", instrumentType: "ETF", listingExchangeName: "ARCA", regularClose: 12.84,
      regularCloseSessionDate: "2026-11-27", lastUpdated: Date.parse("2026-11-27T18:00:00Z") }),
    getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, _start, _end, interval) => {
      requested.push(interval);
      return { resolution: interval === "1d" ? "1d" : "1m", sourceKey: "test", points: interval === "1d"
        ? [{ date: new Date(day), close: 12.19, low: 12.05, high: 12.42, ...(name.includes("adjusted") ? { rescaled: true } : {}) }]
        : buffered };
    },
  });
  const market = { config: createDefaultConfig("."), dataProvider: provider,
    store: { loadTicker: async () => null } } as unknown as MarketContext;
  const raw = "BDRY:ARCA";
  const resolved = await resolvePaneFunction(catalog, market, parsePaneFunctionArgs(["GIP", raw, "--session", day]), { command: "fn" });
  const report = await buildFunctionReport(resolved, market, raw, catalog);
  const model = (await loadResolvedHeadlessPaneModel(resolved, market, raw)).result as ChartPaneModel;
  const history = model.snapshot.intradayHistories[0]!;
  expect(history.points).toHaveLength(count);
  expect(history.bufferedPoints).toHaveLength(count ? count + 1 : 0);
  expect(model.chart.series[0]?.points ?? []).toHaveLength(count);
  expect(requested).not.toContain("1d");
  if (!count) {
    expect(report.data.empty).toBe(true);
    expect(report.data.complete).toBe(false);
    return;
  }
  const csv = renderReportCsv(report.tables!, report.data.freshness);
  expect(csv).toContain("19:38:00");
  expect(csv).toContain("12.31,811");
  if (count === 4) expect(csv).toContain("12.23,30");
  if (close) {
    expect(report.text).toContain("official close 20:00 UTC");
    expect(history.points.filter((entry) => +entry.date === +bell.date)).toEqual([bell]);
    expect(csv.split("\n").filter((line) => line.includes("20:00:00"))).toMatchObject([expect.stringContaining(",,,,12.19,")]);
    expect(model.chart.series[0]?.points.find((entry) => +entry.date === +bell.date)).toMatchObject({
      open: null, high: null, low: null, close: 12.19, volume: null, availableAt: bell.date,
    });
  } else {
    expect(report.text).toContain("last regular print 19:38 UTC; official close unavailable");
    expect(report.data.complete).toBe(false);
    expect(csv).not.toContain(",12.19,");
  }
});

test("the latest dated session still uses its same-session quote path if no source close is declared", () => {
  expect(historicalIntradayClose({ exchange: "ARCA", points: [last],
    quote: createTestQuote({ symbol: "BDRY", listingExchangeName: "ARCA", lastUpdated: +bell.date }) }, day, +bell.date)).toBeNull();
});
