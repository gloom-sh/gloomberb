import type { HeadlessPaneDefinition } from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { formatNumber } from "../../../utils/format";
import { loadHeadlessPriceHistory, loadHeadlessSymbols } from "../shared/headless-market-data";
import { buildCorrelationMatrix, buildCorrelationSeries, pairKey } from "./matrix/model";
import { buildRelationshipAnalysis, DEFAULT_RELATIONSHIP_SECOND_SYMBOL } from "./relationship/model";
import { paneSchemas } from "./headless-schema";

export const correlationHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["correlation-pane"],
  shape: "rows",
  describe: ({ symbols, options }) => `Correlation Matrix | Daily returns | ${options.rangePreset ?? "1Y"} | ${symbols.join(", ")}`,
  columns: [
    { key: "pair", header: "Pair", format: (_value, row) => `${row.left}/${row.right}` },
    { key: "correlation", header: "Correlation", align: "right", format: (value) => value == null ? "-" : formatNumber(Number(value), 3) },
    { key: "sampleSize", header: "Shared obs", align: "right" },
  ],
  async load({ symbols, options }, ctx) {
    const range = (options.rangePreset ?? "1Y") as TimeRange;
    const loaded = await loadHeadlessSymbols(symbols, ctx, (symbol) => loadHeadlessPriceHistory(ctx, symbol, range));
    const bySymbol = new Map(loaded.entries.map(({ symbol, data }) => [symbol, buildCorrelationSeries(symbol, data)]));
    const matrix = buildCorrelationMatrix(symbols, bySymbol);
    const rows = symbols.flatMap((left, index) => symbols.slice(index + 1).map((right) => {
      const result = matrix.results.get(pairKey(left, right));
      return { left, right, correlation: result?.correlation ?? null, sampleSize: result?.sampleSize ?? 0 };
    }));
    const unavailableSymbols = symbols.filter((symbol) => bySymbol.get(symbol)?.status !== "ready");
    if (!unavailableSymbols.length && rows.every((row) => row.correlation == null)) unavailableSymbols.push(...symbols);
    const unavailablePairs = rows.filter((row) => row.correlation == null).map((row) => ({
      left: row.left, right: row.right, sampleSize: row.sampleSize,
      reason: row.sampleSize < 5 ? "Insufficient shared return observations" : "Zero return variance",
    }));
    return {
      rows, unavailableSymbols,
      errors: [
        ...loaded.errors,
        ...unavailablePairs.map((pair) => `${pair.left}/${pair.right}: ${pair.reason} (${pair.sampleSize} shared observations).`),
      ],
      metadata: {
        range,
        unavailablePairs,
        returnAlignment: "Close-to-close returns between shared UTC dates; exchange closing times may differ.",
        availability: symbols.map((symbol) => ({
          symbol, status: bySymbol.get(symbol)?.status ?? "error", observationCount: bySymbol.get(symbol)?.observationCount ?? 0,
        })),
      },
    };
  },
};

export const relationshipHeadless: HeadlessPaneDefinition<"series"> = {
  ...paneSchemas["relationship-graph-pane"],
  shape: "series",
  describe: ({ symbols, options }) => `Relationship Graph | ${symbols[0]}/${symbols[1] ?? DEFAULT_RELATIONSHIP_SECOND_SYMBOL} | ${options.range ?? "1Y"}`,
  async load(args, ctx) {
    const symbols = [args.symbols[0]!, args.symbols[1] ?? DEFAULT_RELATIONSHIP_SECOND_SYMBOL];
    const range = (args.options.range ?? "1Y") as TimeRange;
    const correlationWindow = Number(args.options.correlationWindow ?? 120);
    const loaded = await loadHeadlessSymbols(symbols, ctx, (symbol) => loadHeadlessPriceHistory(ctx, symbol, range));
    const histories = new Map(loaded.entries.map(({ symbol, data }) => [symbol, data]));
    const analysis = buildRelationshipAnalysis(histories.get(symbols[0]!) ?? [], histories.get(symbols[1]!) ?? [], correlationWindow);
    const unavailableSymbols = symbols.filter((symbol) => (histories.get(symbol) ?? []).filter((point) => (
      Number.isFinite(point.close) && point.close > 0 && Number.isFinite(new Date(point.date).getTime())
    )).length < 2);
    if (!unavailableSymbols.length && !analysis.returns.length) unavailableSymbols.push(...symbols);
    return {
      symbols,
      series: [
        { id: "ratio", label: `${symbols[0]}/${symbols[1]}`, points: analysis.ratioPoints.map(({ date, close }) => ({ date: date.toISOString(), value: close })) },
        { id: "correlation", label: `Rolling correlation (${correlationWindow})`, points: analysis.correlationPoints.map(({ date, close }) => ({ date: date.toISOString(), value: close })) },
      ],
      stats: [
        { key: "latestRatio", label: "Latest ratio", value: analysis.latestRatio, formatted: formatNumber(analysis.latestRatio ?? undefined, 4) },
        { key: "latestCorrelation", label: `Rolling correlation (${correlationWindow})`, value: analysis.latestCorrelation, formatted: formatNumber(analysis.latestCorrelation ?? undefined, 3) },
        ...(["beta", "alpha", "rSquared"] as const).map((key) => ({
          key, label: { beta: "Beta", alpha: "Alpha", rSquared: "R squared" }[key],
          value: analysis.stats?.[key] ?? null, formatted: formatNumber(analysis.stats?.[key], 3),
        })),
        { key: "returnCount", label: "Shared returns", value: analysis.stats?.sampleSize ?? analysis.returns.length },
      ],
      unavailableSymbols: [...new Set(unavailableSymbols)],
      errors: loaded.errors,
      metadata: {
        left: symbols[0], right: symbols[1], range, correlationWindow,
        latestRatio: analysis.latestRatio, latestCorrelation: analysis.latestCorrelation,
        regression: analysis.stats, alignedPriceCount: analysis.aligned.length, returnCount: analysis.returns.length,
      },
    };
  },
};
