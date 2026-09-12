import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import { loadChartPaneModel } from "../../../plugins/builtin/chart-composer/headless";
import { buildPriceChartPreset } from "../../../plugins/builtin/chart-composer/presets";
import { formatMarketPriceWithCurrency } from "../../../market-data/market/format";
import { applyResolvedSeriesTransform } from "../../../time-series/transforms";
import type { HeadlessPaneContext } from "../../../types/headless";
import { formatCompositeCursorValue, formatCompositeSeriesValue } from "./format";
import { applyCompositeChartCursor, buildCompositeChartScene, resolveCompositeCursorDate } from "./scene";
import { reuseResolvedSeriesIdentity } from "./panel-series";

const cases = [
  ["EURUSD=X", "USD", "CURRENCY", 1.1602274179458618, "$1.160227"],
  ["USDEUR=X", "EUR", "CURRENCY", 0.8618999719619751, "€0.8619"],
  ["JPY=X", "JPY", "CURRENCY", 153.5540008544922, "¥153.554001"],
  ["JPYUSD=X", "USD", "CURRENCY", 0.00651236716657877, "$0.006512"],
  ["AAPL", "USD", "EQUITY", 259.7499, "$259.75"],
  ["BTC-USD", "USD", "CRYPTOCURRENCY", 79_432.18, "$79,432.18"],
  ["SHIB-USD", "USD", "CRYPTOCURRENCY", 0.00000526, "$0.00000526"],
] as const;

async function priceModel(symbol: string, currency: string, instrumentType: string, value: number) {
  const step = Math.min(0.0001, value / 10);
  const points = [0, 1, 2].map((offset) => ({ date: new Date(Date.UTC(2026, 8, 9 + offset)), close: value + (offset - 2) * step }));
  const spec = buildPriceChartPreset(symbol);
  spec.viewport = { ...spec.viewport, range: "1M", resolution: "1d", dateWindow: { start: "2026-09-09", end: "2026-09-11" } };
  spec.studies = [{ id: "sma", kind: "sma", inputSeriesIds: [spec.series[0]!.id], parameters: { period: 2 }, panelId: "main", axis: "left" }];
  const provider = createTestDataProvider({
    getQuote: async () => ({ symbol, currency, instrumentType, price: value, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11T21:00Z"), stale: true }),
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: points }),
    getPriceHistory: async () => points,
    getPriceHistoryForResolution: async () => points,
    getDetailedPriceHistory: async () => points,
  });
  const model = await loadChartPaneModel(spec, {
    marketData: provider, config: createDefaultConfig("/tmp/fx-precision-unused"),
    apiClient: {} as HeadlessPaneContext["apiClient"], signal: new AbortController().signal,
  });
  return { model, points };
}

for (const [symbol, currency, category, value, expected] of cases) {
  test(`${symbol} keeps its price basis through export, legend, pointer cursor and price study`, async () => {
    const { model, points } = await priceModel(symbol, currency, category, value);
    const series = model.chart.series.find((entry) => entry.id === model.spec.series[0]!.id)!;
    expect(series.points.map((point) => point.value)).toEqual(points.map((point) => point.close));
    const exported = JSON.parse(JSON.stringify(model)).series.find((entry: { id: string }) => entry.id === series.id);
    expect(exported.points.at(-1).value).toBe(value);
    expect(exported.unit).toBe(series.unit);
    expect(formatCompositeSeriesValue(value, series)).toBe(expected);
    expect(formatCompositeSeriesValue(value, exported)).toBe(expected);

    const scene = buildCompositeChartScene(model.chart.series, model.spec.panels, { width: 101, height: 20 })!;
    const panel = scene.panels.find((entry) => entry.series.some((item) => item.source.id === series.id))!;
    const projected = panel.series.find((entry) => entry.source.id === series.id)!.points.at(-1)!;
    const cursorDate = resolveCompositeCursorDate(scene, projected.xRatio * (scene.width - 1))!;
    const cursor = applyCompositeChartCursor(scene, cursorDate).cursorValues.find((entry) => entry.seriesId === series.id)!;
    expect(cursor.value).toBe(value);
    expect(formatCompositeCursorValue(cursor.value!, panel.axes[series.axis]!)).toBe(expected);
    const average = model.chart.series.find((entry) => entry.id === "sma")!;
    const averageValue = average.points.at(-1)!.value!;
    expect(formatCompositeSeriesValue(averageValue, average)).toBe(formatMarketPriceWithCurrency(averageValue, currency, { assetCategory: category }));
  });
}

test("shared price axes retain FX cursor precision in either order and metadata recovery updates identical points", async () => {
  const fx = (await priceModel("EURUSD=X", "USD", "CURRENCY", 1.1602274179458618)).model.chart.series[0]!;
  const equity = (await priceModel("AAPL", "USD", "EQUITY", 259.7499)).model.chart.series[0]!;
  for (const entries of [[equity, fx], [fx, equity]]) {
    const scene = buildCompositeChartScene(entries, [{ id: "main" }], { width: 101, height: 20 })!;
    expect(formatCompositeCursorValue(1.1602274179458618, scene.panels[0]!.axes.left!)).toBe("$1.160227");
  }
  const untyped = { ...fx, priceAssetCategory: undefined };
  const recovered = reuseResolvedSeriesIdentity(untyped, fx);
  expect(formatCompositeSeriesValue(1.1602274179458618, untyped)).toBe("$1.16");
  expect(formatCompositeSeriesValue(1.1602274179458618, recovered)).toBe("$1.160227");
  expect(recovered.points).toBe(untyped.points);
});

test("FX metadata does not turn normalized returns or ratios into currency prices", async () => {
  const fx = (await priceModel("EURUSD=X", "USD", "CURRENCY", 1.1602274179458618)).model.chart.series[0]!;
  const percent = applyResolvedSeriesTransform(fx, "percent");
  const latest = percent.points.at(-1)!;
  expect(latest.value).toBeCloseTo((fx.points.at(-1)!.value! / fx.points[0]!.value! - 1) * 100, 10);
  expect(latest.rawValue).toBe(fx.points.at(-1)!.value);
  expect(formatCompositeSeriesValue(latest.value!, percent)).toEndWith("%");
  expect(formatCompositeSeriesValue(1.25, { ...fx, unit: "x", unitGroup: "ratio" })).toBe("1.25x");
});
