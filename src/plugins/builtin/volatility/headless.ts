import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createVolatilityDependencies, loadVolatilityData, type VolatilityLoadResult } from "./client";
import type { VolatilityData } from "./model";

function formattedValue(value: unknown): string { return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "--"; }
function formattedPercentile(value: unknown): string { return typeof value === "number" && Number.isFinite(value) ? value.toFixed(0) : "--"; }
export function projectVolatilityHeadless(data: VolatilityData): HeadlessBundleResult {
  return { sections: [
    { title: "Cash VIX tenor curve", entries: [
      { label: "As of", value: data.curve.date },
      { label: "State", value: data.curve.termState }, { label: "3M / 30D", value: data.curve.ratio, formatted: formattedValue(data.curve.ratio) },
      { label: "3M / 30D 1Y percentile", value: data.curve.ratioPercentile1y, formatted: formattedPercentile(data.curve.ratioPercentile1y) }, { label: "3M / 30D 1Y sample", value: data.curve.ratioSampleSize },
      { label: "3M spread (points)", value: data.curve.slope, formatted: formattedValue(data.curve.slope) },
    ] },
    { title: "Aligned curve observations", columns: [
      { key: "label", header: "Index" }, { key: "tenor", header: "Tenor" },
      { key: "value", header: "Level", align: "right", format: formattedValue },
      { key: "sourceId", header: "Series" },
    ], rows: data.curve.points.map((point) => ({ ...point, date: data.curve.date })) },
    { title: "FRED 30D/3M history", entries: [
      { label: "As of", value: data.fred.termDate }, { label: "3M / 30D", value: data.fred.ratio, formatted: formattedValue(data.fred.ratio) },
      { label: "3M spread (points)", value: data.fred.slope, formatted: formattedValue(data.fred.slope) },
    ] },
    { title: "FRED 3M / 30D ratio", columns: [{ key: "date", header: "Date" }, { key: "value", header: "3M / 30D", format: formattedValue }],
      rows: data.fred.ratioHistory.map((point) => ({ ...point })) },
    { title: "Cross-asset volatility", columns: [
      { key: "label", header: "Index" }, { key: "symbol", header: "Symbol" },
      { key: "value", header: "Level", align: "right", format: formattedValue },
      { key: "date", header: "As of" },
      { key: "change1d", header: "1D points", align: "right", format: formattedValue },
      { key: "change1dPercent", header: "1D %", align: "right", format: formattedValue },
      { key: "percentile1y", header: "1Y percentile", align: "right", format: formattedPercentile },
      { key: "sampleSize", header: "Samples", align: "right" }, { key: "status", header: "Coverage" },
    ], rows: data.board.map((row) => ({ ...row })) },
  ] };
}
export interface VolatilityHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, context: HeadlessPaneContext): Promise<VolatilityLoadResult>;
}
const defaultDependencies: VolatilityHeadlessDependencies = {
  load: (_args, context) => loadVolatilityData(false, createVolatilityDependencies(context.marketData, context.apiClient),
    { signal: context.signal }),
};
export function createVolatilityHeadless(dependencies: VolatilityHeadlessDependencies = defaultDependencies): HeadlessPaneDefinition<"bundle"> {
  return { shape: "bundle", argument: { kind: "none" }, options: [], describe: "VIX curve and volatility board",
    discovery: { screenshotReadiness: "live-dom", limitations: [
      "Daily histories may contain isolated index observations; sparse coverage has no daily change or annual percentile.",
      "Thin histories do not support daily changes or one-year percentiles.",
      "The existing sources do not supply a VIX futures curve.",
    ] },
    async load(args, context) {
      const result = await dependencies.load(args, context);
      context.signal.throwIfAborted();
      return { ...projectVolatilityHeadless(result.data), errors: result.errors,
        complete: result.phase === "ready" && !result.stale && result.data.warnings.length === 0,
        unavailableSymbols: result.data.board.filter((row) => row.value == null).map((row) => row.symbol),
        metadata: { stale: result.stale, phase: result.phase, loaded: result.loaded, total: result.total,
          data: result.data, unit: "index points", observations: "daily history or isolated index observation",
          percentile: "Midrank within last calendar year; at least 200 observations spanning 300 days",
          vixFuturesAvailable: false, methodology: "docs/research-data.md#vix-curve-and-cross-asset-volatility-board" },
      };
    },
  };
}
export const volatilityHeadless = createVolatilityHeadless();
