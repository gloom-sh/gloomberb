import type { HeadlessPaneDefinition } from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { formatNumber, formatSignificant } from "../../../utils/format";
import { mixedSessionCloseNote } from "../../../market-data/market/session-close-note";
import { resolveHeadlessInstrument, loadHeadlessSymbols } from "../shared/headless-market-data";
import { buildCorrelationMatrix, buildCorrelationSeries, buildGeoCorrelationSeries, pairKey, type CorrelationSeries } from "./matrix/model";
import { geoSeriesToken, loadGeoCorrelationHistory } from "./geo";
import { buildRelationshipAnalysis, DEFAULT_RELATIONSHIP_SECOND_SYMBOL } from "./relationship/model";
import { paneSchemas } from "./headless-schema";
import { CORRELATION_RETURN_BASIS, GEO_CORRELATION_CHANGE_BASIS, loadCorrelationHistory } from "./history";
import type { HeadlessPaneContext } from "../../../types/headless";
import { newestReportTime } from "../../../utils/utc-time";
import { DAILY_CLOSES } from "../shared/report-freshness";

async function loadHistory(ctx: HeadlessPaneContext, key: string, range: TimeRange) {
  const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
  return loadCorrelationHistory(ctx.marketData, symbol, exchange ?? "", range,
    ctx.refresh ? { cacheMode: "refresh" } : undefined);
}

/**
 * Daily closes with the exchange the symbol trades on, which the session note
 * needs. A symbol that is not in the local data names no exchange, so its
 * quote says where it lists; a missing quote only leaves the note out.
 */
async function loadListedHistory(ctx: HeadlessPaneContext, key: string, range: TimeRange) {
  const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
  const [points, quote] = await Promise.all([
    loadHistory(ctx, key, range),
    exchange ? null : (async () => ctx.marketData.getQuote(symbol, "", ctx.refresh ? { cacheMode: "refresh" } : undefined))().catch(() => null),
  ]);
  return { exchange: exchange || quote?.listingExchangeName || quote?.exchangeName || "", points };
}

/** A ticker's daily closes, or a map series' daily values read straight from the Cloud client. */
async function loadCorrelationInput(ctx: HeadlessPaneContext, key: string, range: TimeRange): Promise<CorrelationSeries> {
  const geo = geoSeriesToken(key);
  if (!geo) return buildCorrelationSeries(key, await loadHistory(ctx, key, range));
  const request = <T,>(path: string, init?: RequestInit) => ctx.apiClient.geo<T>(path, { ...init, signal: init?.signal ?? ctx.signal });
  return buildGeoCorrelationSeries(key, await loadGeoCorrelationHistory(request, geo, range, ctx.signal));
}

export const correlationHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["correlation-pane"],
  shape: "rows",
  freshness: DAILY_CLOSES,
  describe: ({ symbols, options }) => `Correlation Matrix | Daily returns | ${options.rangePreset ?? "1Y"} | ${symbols.join(", ")}`,
  columns: [
    { key: "pair", header: "Pair", format: (_value, row) => `${row.left}/${row.right}` },
    { key: "correlation", header: "Correlation", align: "right", format: (value) => value == null ? "-" : formatNumber(Number(value), 3) },
    { key: "sampleSize", header: "Shared obs", align: "right" },
  ],
  async load({ symbols, options }, ctx) {
    const range = (options.rangePreset ?? "1Y") as TimeRange;
    const loaded = await loadHeadlessSymbols(symbols, ctx, (symbol) => loadCorrelationInput(ctx, symbol, range));
    const bySymbol = new Map(loaded.entries.map(({ symbol, data }) => [symbol, data]));
    const matrix = buildCorrelationMatrix(symbols, bySymbol);
    const rows = symbols.flatMap((left, index) => symbols.slice(index + 1).map((right) => {
      const result = matrix.results.get(pairKey(left, right));
      return { left, right, correlation: result?.correlation ?? null, sampleSize: result?.sampleSize ?? 0 };
    }));
    const unavailableSymbols = symbols.filter((symbol) => bySymbol.get(symbol)?.status !== "ready");
    if (!unavailableSymbols.length && rows.every((row) => row.correlation == null)) unavailableSymbols.push(...symbols);
    const unavailablePairs = rows.filter((row) => row.correlation == null).map((row) => ({
      left: row.left, right: row.right, sampleSize: row.sampleSize,
      reason: bySymbol.get(row.left as string)?.status === "invalid" || bySymbol.get(row.right as string)?.status === "invalid"
        ? "Inconsistent OHLC history"
        : row.sampleSize < 5 ? "Insufficient shared return observations" : "Zero return variance",
    }));
    return {
      freshness: { asOf: newestReportTime(symbols.map((symbol) => bySymbol.get(symbol)?.prices.at(-1)?.dateKey)) },
      rows, unavailableSymbols,
      errors: [
        ...loaded.errors,
        ...unavailablePairs.map((pair) => `${pair.left}/${pair.right}: ${pair.reason} (${pair.sampleSize} shared observations).`),
      ],
      metadata: {
        range,
        unavailablePairs,
        returnAlignment: CORRELATION_RETURN_BASIS,
        ...(symbols.some((symbol) => geoSeriesToken(symbol)) ? { mapSeriesChange: GEO_CORRELATION_CHANGE_BASIS } : {}),
        availability: symbols.map((symbol) => ({
          symbol, status: bySymbol.get(symbol)?.status ?? "error", observationCount: bySymbol.get(symbol)?.observationCount ?? 0,
          ...(bySymbol.get(symbol)?.integrity ? { integrity: bySymbol.get(symbol)!.integrity } : {}),
          firstDate: bySymbol.get(symbol)?.prices.at(0)?.dateKey ?? null,
          lastDate: bySymbol.get(symbol)?.prices.at(-1)?.dateKey ?? null,
        })),
      },
    };
  },
};

export const relationshipHeadless: HeadlessPaneDefinition<"series"> = {
  ...paneSchemas["relationship-graph-pane"],
  shape: "series",
  freshness: DAILY_CLOSES,
  describe: ({ symbols, options }) => `Relationship Graph | ${symbols[0]}/${symbols[1] ?? DEFAULT_RELATIONSHIP_SECOND_SYMBOL} | ${options.range ?? "1Y"}`,
  async load(args, ctx) {
    const symbols = [args.symbols[0]!, args.symbols[1] ?? DEFAULT_RELATIONSHIP_SECOND_SYMBOL];
    const range = (args.options.range ?? "1Y") as TimeRange;
    const correlationWindow = Number(args.options.correlationWindow ?? 120);
    const loaded = await loadHeadlessSymbols(symbols, ctx, (symbol) => loadListedHistory(ctx, symbol, range));
    const listings = new Map(loaded.entries.map(({ symbol, data }) => [symbol, data]));
    const histories = new Map(loaded.entries.map(({ symbol, data }) => [symbol, data.points]));
    const analysis = buildRelationshipAnalysis(histories.get(symbols[0]!) ?? [], histories.get(symbols[1]!) ?? [], correlationWindow);
    const [left, right] = symbols.map((symbol) => ({ symbol, ...listings.get(symbol) }));
    const sessionNote = listings.size === 2 ? mixedSessionCloseNote(left!, right!, analysis.aligned.at(-1)?.dateKey) : null;
    const unavailableSymbols = symbols.filter((symbol) => (histories.get(symbol) ?? []).filter((point) => (
      Number.isFinite(point.close) && point.close > 0 && Number.isFinite(new Date(point.date).getTime())
    )).length < 2);
    if (analysis.integrity?.left.length) unavailableSymbols.push(symbols[0]!);
    if (analysis.integrity?.right.length) unavailableSymbols.push(symbols[1]!);
    if (!unavailableSymbols.length && !analysis.returns.length) unavailableSymbols.push(...symbols);
    const correlations = new Map(analysis.correlationPoints.map(({ date, close }) => [date.getTime(), close]));
    return {
      symbols,
      series: [
        { id: "ratio", label: `${symbols[0]}/${symbols[1]}`, points: analysis.ratioPoints.map(({ date, close }) => ({ date: date.toISOString(), value: close })) },
        { id: "correlation", label: `Rolling correlation (${correlationWindow})`, points: analysis.returns.slice(correlationWindow - 1).map(({ date }) => ({ date: date.toISOString(), value: correlations.get(date.getTime()) ?? null })) },
      ],
      stats: [
        { key: "latestRatio", label: "Latest ratio", value: analysis.latestRatio, formatted: formatSignificant(analysis.latestRatio ?? undefined) },
        { key: "latestCorrelation", label: `Rolling correlation (${correlationWindow})`, value: analysis.latestCorrelation, formatted: formatNumber(analysis.latestCorrelation ?? undefined, 3) },
        ...(["beta", "alpha", "rSquared"] as const).map((key) => ({
          key, label: { beta: "Beta", alpha: "Alpha", rSquared: "R squared" }[key],
          value: analysis.stats?.[key] ?? null,
          // Alpha is the regression intercept on daily percent returns.
          formatted: key === "alpha" && analysis.stats ? `${formatNumber(analysis.stats.alpha, 3)}%` : formatNumber(analysis.stats?.[key], 3),
        })),
        { key: "returnCount", label: "Shared returns", value: analysis.stats?.sampleSize ?? analysis.returns.length },
      ],
      unavailableSymbols: [...new Set(unavailableSymbols)],
      errors: [...loaded.errors, ...(analysis.unavailableReason ? [analysis.unavailableReason] : []),
        ...(analysis.correlationUnavailableReason ? [analysis.correlationUnavailableReason] : [])],
      metadata: {
        left: symbols[0], right: symbols[1], range, correlationWindow,
        returnAlignment: CORRELATION_RETURN_BASIS,
        ...(sessionNote ? { notices: [sessionNote] } : {}),
        firstDate: analysis.aligned.at(0)?.dateKey ?? null,
        lastDate: analysis.aligned.at(-1)?.dateKey ?? null,
        ...(analysis.integrity ? { integrity: analysis.integrity } : {}),
        latestRatio: analysis.latestRatio, latestCorrelation: analysis.latestCorrelation,
        regression: analysis.stats, alignedPriceCount: analysis.aligned.length, returnCount: analysis.returns.length,
      },
    };
  },
};
