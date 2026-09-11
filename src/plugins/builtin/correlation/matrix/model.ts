import { pricePointIntegrity, type PriceHistoryIntegrity } from "../../../../utils/price-history-integrity";
import type { QueryEntry } from "../../../../market-data/result-types";
import { colors } from "../../../../theme/colors";
import type { PricePoint } from "../../../../types/financials";
import { dailyCloses, correlateDailyCloses, type CorrelationResult, type DailyClose } from "../compute";
import type { CorrelationRangePreset } from "../settings";

export const ROW_HEADER_WIDTH = 7;
export const MATRIX_CELL_WIDTH = 10;
export const MIN_MATRIX_CELL_WIDTH = 7;
const MIN_CORRELATION_OBSERVATIONS = 5;

export type SeriesStatus = "loading" | "ready" | "insufficient" | "empty" | "error" | "invalid";

export interface CorrelationSeries {
  symbol: string;
  prices: DailyClose[];
  status: SeriesStatus;
  observationCount: number;
  integrity?: PriceHistoryIntegrity[];
}

export function displaySymbol(symbol: string): string {
  return symbol.length > 5 ? symbol.slice(0, 5) : symbol;
}

export function pairKey(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

function formatSymbolList(symbols: string[]): string {
  if (symbols.length <= 3) return symbols.join(", ");
  return `${symbols.slice(0, 3).join(", ")} +${symbols.length - 3}`;
}

function formatSeriesSymbolList(symbols: string[], seriesBySymbol: Map<string, CorrelationSeries>, includeCounts = false): string {
  return formatSymbolList(symbols.map((symbol) => {
    const series = seriesBySymbol.get(symbol);
    return includeCounts && series ? `${symbol}(${series.observationCount})` : symbol;
  }));
}

export function getSeriesForEntry(
  symbol: string,
  entry: QueryEntry<PricePoint[]> | undefined,
): CorrelationSeries {
  const priceHistory = entry?.data ?? entry?.lastGoodData ?? null;

  if (!priceHistory || priceHistory.length === 0) {
    if (entry?.error?.reasonCode === "NO_DATA") {
      return { symbol, prices: [], status: "empty", observationCount: 0 };
    }
    if (entry?.phase === "error" || entry?.error) {
      return {
        symbol,
        prices: [],
        status: "error",
        observationCount: 0,
      };
    }
    return { symbol, prices: [], status: "loading", observationCount: 0 };
  }

  return buildCorrelationSeries(symbol, priceHistory);
}

export function buildCorrelationSeries(symbol: string, history: readonly PricePoint[]): CorrelationSeries {
  const integrity = history.flatMap((point) => { const issue = pricePointIntegrity(point); return issue ? [issue] : []; });
  if (integrity.length) return { symbol, prices: [], observationCount: 0, status: "invalid", integrity };
  const prices = dailyCloses(history);
  const observationCount = Math.max(0, prices.length - 1);
  return {
    symbol, prices, observationCount,
    status: observationCount < MIN_CORRELATION_OBSERVATIONS ? "insufficient" : "ready",
  };
}

export function rowHeaderColor(status: SeriesStatus): string {
  switch (status) {
    case "loading":
      return colors.textDim;
    case "invalid":
    case "error":
    case "empty":
      return colors.negative;
    case "insufficient":
      return colors.textMuted;
    case "ready":
      return colors.textBright;
  }
}

export function buildCorrelationMatrix(
  symbols: string[],
  seriesBySymbol: Map<string, CorrelationSeries>,
): {
  results: Map<string, CorrelationResult>;
  sampleMin: number | null;
  sampleMax: number | null;
  hasThinPair: boolean;
} {
  const results = new Map<string, CorrelationResult>();
  const sampleSizes: number[] = [];
  let hasThinPair = false;

  for (let rowIndex = 0; rowIndex < symbols.length; rowIndex++) {
    for (let colIndex = 0; colIndex < symbols.length; colIndex++) {
      const rowSym = symbols[rowIndex]!;
      const colSym = symbols[colIndex]!;
      const rowSeries = seriesBySymbol.get(rowSym);
      const colSeries = seriesBySymbol.get(colSym);
      const result = rowSeries && colSeries
        ? correlateDailyCloses(rowSeries.prices, colSeries.prices, MIN_CORRELATION_OBSERVATIONS)
        : { correlation: null, sampleSize: 0 };
      results.set(pairKey(rowSym, colSym), result);
      if (rowIndex < colIndex) {
        if (result.sampleSize > 0) sampleSizes.push(result.sampleSize);
        if (rowSeries?.status !== "invalid" && colSeries?.status !== "invalid"
          && result.correlation == null && result.sampleSize < MIN_CORRELATION_OBSERVATIONS) {
          hasThinPair = true;
        }
      }
    }
  }

  return {
    results,
    sampleMin: sampleSizes.length > 0 ? Math.min(...sampleSizes) : null,
    sampleMax: sampleSizes.length > 0 ? Math.max(...sampleSizes) : null,
    hasThinPair,
  };
}

export function buildStatusSummary(
  symbols: string[],
  seriesBySymbol: Map<string, CorrelationSeries>,
  sampleMin: number | null,
  sampleMax: number | null,
  hasThinPair = false,
): string {
  const parts: string[] = [];
  const byStatus = (status: SeriesStatus) => symbols.filter((symbol) => seriesBySymbol.get(symbol)?.status === status);

  const loading = byStatus("loading");
  const errors = [...byStatus("error"), ...byStatus("empty")];
  const insufficient = byStatus("insufficient");
  const invalid = byStatus("invalid");

  if (invalid.length > 0) parts.push(`Inconsistent OHLC: ${formatSeriesSymbolList(invalid, seriesBySymbol)}`);
  if (loading.length > 0) parts.push(`Loading: ${formatSeriesSymbolList(loading, seriesBySymbol)}`);
  if (errors.length > 0) parts.push(`No data: ${formatSeriesSymbolList(errors, seriesBySymbol)}`);
  if (insufficient.length > 0) parts.push(`Need history: ${formatSeriesSymbolList(insufficient, seriesBySymbol, true)}`);

  if (sampleMin != null && sampleMax != null) {
    parts.push(sampleMin === sampleMax ? `obs ${sampleMin}` : `obs ${sampleMin}-${sampleMax}`);
  } else if (symbols.length >= 2 && invalid.length === 0) {
    parts.push("No paired dates yet");
  }

  // Only legend the blank cells when at least one pair actually has too few
  // shared dates to correlate.
  if (hasThinPair) parts.push(`- <${MIN_CORRELATION_OBSERVATIONS} shared`);
  return parts.join(" · ");
}

/**
 * The matrix already labels every symbol on both axes and the pane now carries
 * its own range control, so the title stays generic instead of repeating them.
 */
export function buildCorrelationPaneTitle(): string {
  return "Correlation";
}
