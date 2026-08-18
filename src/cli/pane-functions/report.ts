import type { TimeRange } from "../../time-series/range";
import {
  buildCorrelationMatrix,
  pairKey,
  type CorrelationSeries,
} from "../../plugins/builtin/correlation/matrix/model";
import { computeDatedReturns } from "../../plugins/builtin/correlation/compute";
import {
  buildRelationshipAnalysis,
  DEFAULT_RELATIONSHIP_SECOND_SYMBOL,
} from "../../plugins/builtin/correlation/relationship/model";
import {
  graphRowsForFinancials,
  limitGraphRowsBySymbol,
  metricDef,
} from "../../time-series/reporting";
import type {
  FundamentalPeriod,
  GraphKind,
  GraphMetricKey,
} from "../../time-series/reporting";
import {
  buildFinancialTableModel,
  formatFinancialHeader,
} from "../../plugins/builtin/ticker-detail/financials/model";
import type { PricePoint, TickerFinancials } from "../../types/financials";
import { formatCurrency, formatNumber, formatPercent, formatPercentRaw } from "../../utils/format";
import { publicTickerKey } from "../../utils/exchanges";
import { apiClient } from "../../api-client";
import { parseChartSpec } from "../../plugins/builtin/chart-composer/chart-spec";
import { resolveChartSpecData } from "../../time-series/resolve";
import { createChartSeriesResolver } from "../../capabilities";
import { getSharedRegistry } from "../../plugins/registry";
import { formatTimestamp } from "../helpers";
import { buildTickerReport } from "../commands/ticker";
import { createBaseConverter } from "../base-converter";
import type { MarketContext } from "../types";
import type { NormalizedPaneFunctionOptions } from "./capabilities";
import {
  fetchTickerFinancials,
  isFinancialAnalysisFunction,
  clipPriceHistoryToRange,
  requireSymbol,
  withShotPriceHistory,
} from "./data";
import type { ResolvedPaneFunction } from "./resolver";

export interface PaneFunctionReportData {
  kind: string;
  target: string;
  capabilityId: string;
  symbols: string[];
  options: NormalizedPaneFunctionOptions;
  rowCount: number;
  empty: boolean;
  complete: boolean;
  unavailableSymbols: string[];
  [key: string]: unknown;
}

export interface PaneFunctionReport {
  data: PaneFunctionReportData;
  text: string;
}

function reportBase(
  resolved: ResolvedPaneFunction,
  symbols: string[],
  rowCount: number,
  unavailableSymbols: string[] = rowCount === 0 ? symbols : [],
): Pick<
  PaneFunctionReportData,
  "target" | "capabilityId" | "symbols" | "options" | "rowCount" | "empty" | "complete" | "unavailableSymbols"
> {
  return {
    target: resolved.token,
    capabilityId: resolved.capability.id,
    symbols,
    options: resolved.options,
    rowCount,
    empty: rowCount === 0,
    complete: unavailableSymbols.length === 0,
    unavailableSymbols,
  };
}

function formatQuoteLine(financials: TickerFinancials): string {
  const quote = financials.quote;
  if (!quote) return "";
  const change = `${quote.change >= 0 ? "+" : ""}${formatCurrency(quote.change, quote.currency)} (${formatPercentRaw(quote.changePercent)})`;
  const parts = [
    `${quote.symbol} ${quote.name ?? ""}`.trim(),
    formatCurrency(quote.price, quote.currency),
    change,
    quote.marketCap != null ? `MCap ${formatNumber(quote.marketCap, 0)}` : "",
    quote.lastUpdated ? `Updated ${formatTimestamp(quote.lastUpdated)}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

async function buildFinancialStatementReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<PaneFunctionReport> {
  const symbol = requireSymbol(resolved, rawArg);
  const { tickerFile, financials } = await fetchTickerFinancials(context, symbol);
  if (!financials.quote) throw new Error(`No quote data available for ${symbol}.`);
  const table = buildFinancialTableModel(financials, {
    period: resolved.options.period as FundamentalPeriod | undefined,
    statement: resolved.options.statement as string | undefined,
  });
  const name = financials.quote.name ?? tickerFile?.metadata.name ?? symbol;
  const lines = [
    `${financials.quote.symbol} ${name}`,
    table
      ? `Financial Statements | ${table.period === "annual" ? "Annual" : "Quarterly"} | ${table.subTab.name}`
      : "Financial Statements",
    financials.quote.currency ? `Currency ${financials.quote.currency}` : "",
    "",
  ].filter((line) => line !== "");
  if (!table) {
    lines.push(formatQuoteLine(financials));
    lines.push("");
    lines.push(`No financial statement rows are available for ${symbol} from the configured data providers.`);
    return {
      data: {
        kind: "financial-statement",
        ...reportBase(resolved, [symbol], 0),
        symbol,
        name,
        currency: financials.quote.currency,
        statement: resolved.options.statement,
        period: resolved.options.period,
        columns: [],
        rows: [],
      },
      text: lines.join("\n"),
    };
  }

  const columns = table.statements.map((statement) => ({
    date: statement.date,
    label: formatFinancialHeader(statement.date).trim(),
  }));
  const structuredRows = table.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    metric: row.unitLabel,
    cells: row.cells.map((cell, index) => ({
      date: table.statements[index]?.date ?? "",
      value: cell.value ?? null,
      growth: cell.growth ?? null,
      formatted: cell.valueText.trim(),
    })),
  }));
  lines.push(contextOutputTable(
    [
      { header: "Metric" },
      ...columns.map(({ label }) => ({ header: label, align: "right" as const })),
    ],
    table.rows.map((row) => [
      row.unitLabel,
      ...row.cells.map((cell) => `${cell.valueText.trim()}${cell.growthText.trim() ? ` ${cell.growthText.trim()}` : ""}`),
    ]),
  ));

  return {
    data: {
      kind: "financial-statement",
      ...reportBase(resolved, [symbol], structuredRows.length),
      symbol,
      name,
      currency: financials.quote.currency,
      statement: table.subTab.key,
      statementLabel: table.subTab.name,
      period: table.period,
      columns,
      rows: structuredRows,
    },
    text: lines.join("\n"),
  };
}

function contextOutputTable(
  columns: Array<{ header: string; align?: "left" | "right" | "center" }>,
  rows: string[][],
): string {
  const widths = columns.map((column, index) => Math.max(
    column.header.length,
    ...rows.map((row) => (row[index] ?? "").length),
  ));
  const renderRow = (cells: string[], header = false) => cells
    .map((cell, index) => {
      const align = columns[index]?.align ?? "left";
      const width = widths[index] ?? cell.length;
      const padding = Math.max(0, width - cell.length);
      const text = align === "right" ? `${" ".repeat(padding)}${cell}` : `${cell}${" ".repeat(padding)}`;
      return header ? text.toUpperCase() : text;
    })
    .join("  ");
  return [
    renderRow(columns.map((column) => column.header), true),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => renderRow(row)),
  ].join("\n");
}

async function buildChartComposerReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
): Promise<PaneFunctionReport> {
  const parsed = parseChartSpec(resolved.instance.settings?.chartSpec);
  if (!parsed) throw new Error("The chart composer specification is invalid.");
  const spec = {
    ...parsed,
    series: await Promise.all(parsed.series.map(async (series) => {
      if (series.source.kind !== "security" || series.source.instrument.exchange) return series;
      const ticker = await context.store.loadTicker(series.source.instrument.symbol);
      return ticker?.metadata.exchange
        ? {
          ...series,
          source: {
            ...series.source,
            instrument: { ...series.source.instrument, exchange: ticker.metadata.exchange },
          },
        }
        : series;
    })),
  };
  const capabilityInvoker = getSharedRegistry();
  const result = await resolveChartSpecData(spec, {
    dataProvider: context.dataProvider,
    ...(capabilityInvoker ? { resolveCapabilitySeries: createChartSeriesResolver(capabilityInvoker) } : {}),
    loadFredSeries: async (request) => ({
      data: await apiClient.getCloudFredSeries(request.seriesId, {
        startDate: request.startDate,
        sortOrder: request.sortOrder,
      }),
      fetchedAt: Date.now(),
      stale: false,
      source: "network",
    }),
  });
  const baseIds = new Set(spec.series.map((series) => series.id));
  const series = result.series.map((entry) => ({
    id: entry.id,
    label: entry.label,
    derived: !baseIds.has(entry.id),
    unit: entry.unit,
    panelId: entry.panelId,
    axis: entry.axis,
    style: entry.style,
    transform: entry.transform,
    observations: entry.points.map((point) => ({
      date: point.date.toISOString(),
      value: point.value ?? point.close ?? null,
    })),
  }));
  const symbols = [...new Set(spec.series.flatMap((entry) => entry.source.kind === "security"
    ? [publicTickerKey(entry.source.instrument.symbol, entry.source.instrument.exchange)]
    : []))];
  const unavailable = spec.series.flatMap((entry) => {
    const output = result.series.find((candidate) => candidate.id === entry.id);
    if (output?.points.length) return [];
    return [entry.source.kind === "security"
      ? publicTickerKey(entry.source.instrument.symbol, entry.source.instrument.exchange)
      : entry.source.kind === "economic"
        ? `FRED:${entry.source.seriesId}`
        : `CAP:${entry.source.capabilityId}:${entry.source.seriesId}`];
  });
  const rowCount = series.reduce((count, entry) => count + entry.observations.length, 0);
  const tableRows = series.map((entry) => {
    const latest = entry.observations.at(-1);
    return [
      entry.label,
      latest?.date.slice(0, 10) ?? "-",
      latest?.value == null ? "-" : formatNumber(latest.value, 4),
      entry.unit,
      String(entry.observations.length),
    ];
  });
  const text = [
    `${resolved.label} | ${spec.viewport.range} | ${spec.viewport.resolution}`,
    "",
    contextOutputTable([
      { header: "Series" },
      { header: "Latest" },
      { header: "Value", align: "right" },
      { header: "Unit" },
      { header: "Points", align: "right" },
    ], tableRows),
    ...(result.warnings.length > 0 ? ["", `Warnings: ${result.warnings.join(" ")}`] : []),
    ...(result.errors.length > 0 ? ["", `Errors: ${result.errors.join(" ")}`] : []),
  ].join("\n");
  return {
    data: {
      kind: "chart-composer",
      ...reportBase(resolved, symbols, rowCount, unavailable),
      viewport: spec.viewport,
      panels: spec.panels,
      warnings: result.warnings,
      errors: result.errors,
      series,
    },
    text,
  };
}

function resolvedSymbols(resolved: ResolvedPaneFunction): string[] {
  return resolved.createOptions?.symbols?.length
    ? resolved.createOptions.symbols
    : resolved.createOptions?.symbol
      ? [resolved.createOptions.symbol]
      : [];
}

async function loadFinancials(
  context: MarketContext,
  symbols: string[],
  includePriceHistory = false,
): Promise<Array<{ symbol: string; financials: TickerFinancials }>> {
  return Promise.all(symbols.map(async (symbol) => {
    const entry = await fetchTickerFinancials(context, symbol);
    return {
      symbol,
      financials: includePriceHistory
        ? await withShotPriceHistory(context, symbol, entry.tickerFile, entry.financials)
        : entry.financials,
    };
  }));
}

async function buildGraphSeriesReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  kind: GraphKind,
): Promise<PaneFunctionReport> {
  const symbols = resolvedSymbols(resolved);
  const metric = resolved.options.metric as GraphMetricKey;
  const period = resolved.options.period as FundamentalPeriod;
  const definition = metricDef(kind, metric);
  const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
  const entries = await loadFinancials(context, symbols, kind === "valuation");
  const rows = entries.flatMap(({ symbol, financials }) => (
    limitGraphRowsBySymbol(
      graphRowsForFinancials(financials, kind, metric, period, symbol),
      periodCount,
    ).map((row) => ({
      symbol: row.symbol,
      date: row.date,
      category: row.category,
      value: row.value,
      formattedValue: definition.format(row.value),
      growth: row.growth,
      currency: financials.quote?.currency ?? null,
    }))
  ));
  const availability = entries.map(({ symbol, financials }) => ({
    symbol,
    currency: financials.quote?.currency ?? null,
    annualStatements: financials.annualStatements.length,
    quarterlyStatements: financials.quarterlyStatements.length,
    rowCount: rows.filter((row) => row.symbol === symbol).length,
  }));
  const unavailableSymbols = availability.filter(({ rowCount }) => rowCount === 0).map(({ symbol }) => symbol);
  const textRows = rows.map((row) => [
    row.symbol,
    row.category,
    row.formattedValue,
    row.growth == null ? "-" : formatPercent(row.growth),
  ]);
  const text = [
    `${resolved.label} | ${definition.label} | ${period === "annual" ? "Annual" : "Quarterly"} | ${symbols.join(", ")}`,
    "",
    rows.length > 0
      ? contextOutputTable([
        { header: "Ticker" },
        { header: "Period" },
        { header: "Value", align: "right" },
        { header: "Growth", align: "right" },
      ], textRows)
      : `No ${definition.label.toLowerCase()} rows are available for ${symbols.join(", ")}.`,
  ].join("\n");
  return {
    data: {
      kind: kind === "valuation" ? "valuation-series" : "fundamental-series",
      ...reportBase(resolved, symbols, rows.length, unavailableSymbols),
      metric,
      metricLabel: definition.label,
      period,
      rows,
      availability,
    },
    text,
  };
}

async function buildQuoteComparisonReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
): Promise<PaneFunctionReport> {
  const symbols = resolvedSymbols(resolved);
  const quotes = await Promise.all(symbols.map((symbol) => context.dataProvider.getQuote(symbol)));
  const rows = quotes.map((quote) => ({
    symbol: quote.symbol,
    name: quote.name ?? "",
    price: quote.price,
    currency: quote.currency,
    change: quote.change,
    changePercent: quote.changePercent,
    marketCap: quote.marketCap ?? null,
    updatedAt: quote.lastUpdated,
  }));
  return {
    data: {
      kind: "quote-comparison",
      ...reportBase(resolved, symbols, rows.length),
      rows,
    },
    text: [
      `${resolved.label} | ${symbols.join(", ")}`,
      "",
      contextOutputTable([
        { header: "Ticker" },
        { header: "Name" },
        { header: "Last", align: "right" },
        { header: "Change", align: "right" },
        { header: "Change %", align: "right" },
      ], quotes.map((quote) => [
        quote.symbol,
        quote.name ?? "",
        formatCurrency(quote.price, quote.currency),
        `${quote.change >= 0 ? "+" : ""}${formatCurrency(quote.change, quote.currency)}`,
        formatPercentRaw(quote.changePercent),
      ])),
    ].join("\n"),
  };
}

function relativeValuationValues(financials: TickerFinancials) {
  const { quote, fundamentals } = financials;
  const evSales = fundamentals?.enterpriseValue != null && fundamentals.revenue
    ? fundamentals.enterpriseValue / fundamentals.revenue
    : null;
  const fcfYield = fundamentals?.freeCashFlow != null && quote?.marketCap
    ? fundamentals.freeCashFlow / quote.marketCap
    : null;
  return {
    price: quote?.price ?? null,
    currency: quote?.currency ?? null,
    changePercent: quote?.changePercent ?? null,
    marketCap: quote?.marketCap ?? null,
    trailingPE: fundamentals?.trailingPE ?? null,
    forwardPE: fundamentals?.forwardPE ?? null,
    evSales,
    fcfYield,
    revenueGrowth: fundamentals?.revenueGrowth ?? fundamentals?.lastQuarterGrowth ?? null,
    operatingMargin: fundamentals?.operatingMargin ?? null,
  };
}

async function buildRelativeValuationReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
): Promise<PaneFunctionReport> {
  const symbols = resolvedSymbols(resolved);
  const entries = await loadFinancials(context, symbols);
  const rows = entries.map(({ symbol, financials }) => ({ symbol, ...relativeValuationValues(financials) }));
  const usableSymbols = new Set(rows
    .filter((row) => [
      row.marketCap,
      row.trailingPE,
      row.forwardPE,
      row.evSales,
      row.fcfYield,
      row.revenueGrowth,
      row.operatingMargin,
    ].some((value) => value != null))
    .map(({ symbol }) => symbol));
  const unavailableSymbols = symbols.filter((symbol) => !usableSymbols.has(symbol));
  const usableRowCount = usableSymbols.size;
  return {
    data: {
      kind: "relative-valuation",
      ...reportBase(resolved, symbols, usableRowCount, unavailableSymbols),
      rows,
    },
    text: [
      `${resolved.label} | ${symbols.join(", ")}`,
      "",
      contextOutputTable([
        { header: "Ticker" },
        { header: "Last", align: "right" },
        { header: "P/E", align: "right" },
        { header: "Fwd P/E", align: "right" },
        { header: "EV/S", align: "right" },
        { header: "FCF Yield", align: "right" },
        { header: "Revenue Growth", align: "right" },
        { header: "Op Margin", align: "right" },
      ], rows.map((row) => [
        row.symbol,
        row.price == null || !row.currency ? "-" : formatCurrency(row.price, row.currency),
        row.trailingPE == null ? "-" : formatNumber(row.trailingPE, 1),
        row.forwardPE == null ? "-" : formatNumber(row.forwardPE, 1),
        row.evSales == null ? "-" : formatNumber(row.evSales, 1),
        row.fcfYield == null ? "-" : formatPercent(row.fcfYield),
        row.revenueGrowth == null ? "-" : formatPercent(row.revenueGrowth),
        row.operatingMargin == null ? "-" : formatPercent(row.operatingMargin),
      ])),
    ].join("\n"),
  };
}

function pricePointDate(point: PricePoint): string {
  const value = point.date instanceof Date ? point.date : new Date(point.date);
  return Number.isFinite(value.getTime()) ? value.toISOString() : String(point.date);
}

async function loadPriceHistory(
  context: MarketContext,
  symbol: string,
  range: TimeRange,
): Promise<PricePoint[]> {
  const ticker = await context.store.loadTicker(symbol);
  const points = await context.dataProvider.getPriceHistory(symbol, ticker?.metadata.exchange ?? "", range);
  return clipPriceHistoryToRange(points, range);
}

function resolvedPriceRange(resolved: ResolvedPaneFunction): TimeRange {
  if (resolved.capability.id === "intraday-price-chart") return "1D";
  return (resolved.options.rangePreset ?? resolved.options.range ?? "1Y") as TimeRange;
}

async function buildPriceHistoryReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<PaneFunctionReport> {
  const symbol = requireSymbol(resolved, rawArg);
  const range = resolvedPriceRange(resolved);
  const points = await loadPriceHistory(context, symbol, range);
  const rows = [...points]
    .sort((left, right) => pricePointDate(left).localeCompare(pricePointDate(right)))
    .map((point) => ({
      date: pricePointDate(point),
      open: point.open ?? null,
      high: point.high ?? null,
      low: point.low ?? null,
      close: point.close,
      volume: point.volume ?? null,
    }));
  const shown = rows.slice(-30).reverse();
  return {
    data: {
      kind: "price-history",
      ...reportBase(resolved, [symbol], rows.length),
      symbol,
      range,
      rows,
    },
    text: [
      `${resolved.label} | ${symbol} | ${range} | ${rows.length} points`,
      "",
      rows.length > 0
        ? contextOutputTable([
          { header: "Date" },
          { header: "Open", align: "right" },
          { header: "High", align: "right" },
          { header: "Low", align: "right" },
          { header: "Close", align: "right" },
          { header: "Volume", align: "right" },
        ], shown.map((row) => [
          row.date.slice(0, 10),
          row.open == null ? "-" : formatNumber(row.open, 2),
          row.high == null ? "-" : formatNumber(row.high, 2),
          row.low == null ? "-" : formatNumber(row.low, 2),
          formatNumber(row.close, 2),
          row.volume == null ? "-" : formatNumber(row.volume, 0),
        ]))
        : `No price history is available for ${symbol}.`,
    ].join("\n"),
  };
}

async function buildPriceComparisonReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
): Promise<PaneFunctionReport> {
  const symbols = resolvedSymbols(resolved);
  const range = resolvedPriceRange(resolved);
  const rows = await Promise.all(symbols.map(async (symbol) => {
    const points = (await loadPriceHistory(context, symbol, range))
      .filter((point) => Number.isFinite(point.close))
      .sort((left, right) => pricePointDate(left).localeCompare(pricePointDate(right)));
    const first = points[0];
    const last = points.at(-1);
    return {
      symbol,
      startDate: first ? pricePointDate(first) : null,
      endDate: last ? pricePointDate(last) : null,
      startPrice: first?.close ?? null,
      endPrice: last?.close ?? null,
      return: first && last && first.close !== 0 ? (last.close - first.close) / first.close : null,
      pointCount: points.length,
    };
  }));
  const usableRows = rows.filter((row) => row.return != null);
  const unavailableSymbols = rows.filter((row) => row.return == null).map((row) => row.symbol);
  return {
    data: {
      kind: "price-performance",
      ...reportBase(resolved, symbols, usableRows.length, unavailableSymbols),
      range,
      axisMode: resolved.options.axisMode,
      rows,
    },
    text: [
      `${resolved.label} | ${range} price performance | ${symbols.join(", ")}`,
      "",
      contextOutputTable([
        { header: "Ticker" },
        { header: "Start" },
        { header: "End" },
        { header: "Start Price", align: "right" },
        { header: "End Price", align: "right" },
        { header: "Return", align: "right" },
        { header: "Points", align: "right" },
      ], rows.map((row) => [
        row.symbol,
        row.startDate?.slice(0, 10) ?? "-",
        row.endDate?.slice(0, 10) ?? "-",
        row.startPrice == null ? "-" : formatNumber(row.startPrice, 2),
        row.endPrice == null ? "-" : formatNumber(row.endPrice, 2),
        row.return == null ? "-" : formatPercent(row.return),
        String(row.pointCount),
      ])),
    ].join("\n"),
  };
}

async function buildCorrelationReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
): Promise<PaneFunctionReport> {
  const symbols = resolvedSymbols(resolved);
  const range = resolvedPriceRange(resolved);
  const series = await Promise.all(symbols.map(async (symbol): Promise<CorrelationSeries> => {
    const returns = computeDatedReturns(await loadPriceHistory(context, symbol, range));
    return {
      symbol,
      returns,
      status: returns.length >= 5 ? "ready" : "insufficient",
      observationCount: returns.length,
    };
  }));
  const bySymbol = new Map(series.map((entry) => [entry.symbol, entry]));
  const matrix = buildCorrelationMatrix(symbols, bySymbol);
  const rows = symbols.flatMap((left, leftIndex) => symbols.slice(leftIndex + 1).map((right) => {
    const result = matrix.results.get(pairKey(left, right));
    return {
      left,
      right,
      correlation: result?.correlation ?? null,
      sampleSize: result?.sampleSize ?? 0,
    };
  }));
  const usableRows = rows.filter((row) => row.correlation != null);
  const unavailableSymbols = series
    .filter(({ status }) => status !== "ready")
    .map(({ symbol }) => symbol);
  return {
    data: {
      kind: "correlation-matrix",
      ...reportBase(resolved, symbols, usableRows.length, unavailableSymbols),
      range,
      rows,
      availability: series.map(({ symbol, status, observationCount }) => ({ symbol, status, observationCount })),
    },
    text: [
      `${resolved.label} | Daily returns | ${range} | ${symbols.join(", ")}`,
      "",
      contextOutputTable([
        { header: "Pair" },
        { header: "Correlation", align: "right" },
        { header: "Shared obs", align: "right" },
      ], rows.map((row) => [
        `${row.left}/${row.right}`,
        row.correlation == null ? "-" : formatNumber(row.correlation, 3),
        String(row.sampleSize),
      ])),
    ].join("\n"),
  };
}

async function buildRelationshipReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
): Promise<PaneFunctionReport> {
  const requested = resolvedSymbols(resolved);
  const symbols = [requested[0]!, requested[1] ?? DEFAULT_RELATIONSHIP_SECOND_SYMBOL];
  const range = resolvedPriceRange(resolved);
  const correlationWindow = Number(resolved.options.correlationWindow ?? 120);
  const histories = await Promise.all(symbols.map((symbol) => loadPriceHistory(context, symbol, range)));
  const leftPoints = histories[0] ?? [];
  const rightPoints = histories[1] ?? [];
  const analysis = buildRelationshipAnalysis(leftPoints, rightPoints, correlationWindow);
  const rowCount = analysis.stats?.sampleSize ?? analysis.returns.length;
  const unavailableSymbols = [
    ...(leftPoints.length < 2 ? [symbols[0]!] : []),
    ...(rightPoints.length < 2 ? [symbols[1]!] : []),
  ];
  const row = {
    left: symbols[0],
    right: symbols[1],
    range,
    correlationWindow,
    latestRatio: analysis.latestRatio,
    latestCorrelation: analysis.latestCorrelation,
    regression: analysis.stats,
    alignedPriceCount: analysis.aligned.length,
    returnCount: analysis.returns.length,
  };
  return {
    data: {
      kind: "relationship-analysis",
      ...reportBase(resolved, symbols, rowCount, unavailableSymbols),
      ...row,
    },
    text: [
      `${resolved.label} | ${symbols[0]}/${symbols[1]} | ${range}`,
      "",
      contextOutputTable([
        { header: "Metric" },
        { header: "Value", align: "right" },
      ], [
        ["Latest ratio", analysis.latestRatio == null ? "-" : formatNumber(analysis.latestRatio, 4)],
        [`Rolling correlation (${correlationWindow})`, analysis.latestCorrelation == null ? "-" : formatNumber(analysis.latestCorrelation, 3)],
        ["Beta", analysis.stats ? formatNumber(analysis.stats.beta, 3) : "-"],
        ["Alpha", analysis.stats ? formatNumber(analysis.stats.alpha, 3) : "-"],
        ["R squared", analysis.stats ? formatNumber(analysis.stats.rSquared, 3) : "-"],
        ["Shared returns", String(analysis.stats?.sampleSize ?? analysis.returns.length)],
      ]),
    ].join("\n"),
  };
}

export async function buildFunctionReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<PaneFunctionReport> {
  if (isFinancialAnalysisFunction(resolved)) {
    return buildFinancialStatementReport(resolved, context, rawArg);
  }
  if (
    resolved.template?.shortcut?.argKind === "ticker-list"
    && resolvedSymbols(resolved).length === 0
  ) {
    return buildLegacyPaneReport(resolved, context, rawArg);
  }

  switch (resolved.capability.id) {
    case "chart-composer":
      return buildChartComposerReport(resolved, context);
    case "fundamental-series":
      return buildGraphSeriesReport(resolved, context, "fundamental");
    case "valuation-series":
      return buildGraphSeriesReport(resolved, context, "valuation");
    case "quote-comparison":
      return buildQuoteComparisonReport(resolved, context);
    case "relative-valuation":
      return buildRelativeValuationReport(resolved, context);
    case "historical-prices":
    case "price-chart":
    case "intraday-price-chart":
      return buildPriceHistoryReport(resolved, context, rawArg);
    case "price-comparison":
      return buildPriceComparisonReport(resolved, context);
    case "return-correlation":
      return buildCorrelationReport(resolved, context);
    case "security-relationship":
      return buildRelationshipReport(resolved, context);
  }

  if (resolved.capability.reportReadiness === "unsupported") {
    return buildLegacyPaneReport(resolved, context, rawArg);
  }
  throw new Error(`No structured report builder is registered for ${resolved.token}.`);
}

async function buildLegacyPaneReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<PaneFunctionReport> {
  const symbols = resolvedSymbols(resolved);
  if (resolved.template?.shortcut?.argKind === "ticker-list" && symbols.length > 0) {
    return buildQuoteComparisonReport(resolved, context);
  }
  if (resolved.template?.shortcut?.argKind === "ticker") {
    const symbol = requireSymbol(resolved, rawArg);
    const { tickerFile, financials } = await fetchTickerFinancials(context, symbol);
    if (!financials.quote) throw new Error(`No quote data available for ${symbol}.`);
    const toBase = createBaseConverter(context.dataProvider, context.config.baseCurrency);
    const text = await buildTickerReport({
      symbol,
      tickerFile,
      financials,
      config: context.config,
      toBase,
    });
    return {
      data: {
        kind: "legacy-ticker-summary",
        ...reportBase(resolved, [symbol], 1),
        text,
      },
      text,
    };
  }

  const settings = Object.entries(resolved.instance.settings ?? {}).map(([key, value]) => ({
    key,
    value,
  }));
  const text = [
    resolved.label,
    resolved.description,
    "",
    `Pane: ${resolved.pane.id} (${resolved.pane.name})`,
    ...(resolved.template ? [`Template: ${resolved.template.id}`] : []),
    ...(resolved.shortcut ? [`Shortcut: ${resolved.shortcut}`] : []),
    ...(rawArg ? [`Argument: ${rawArg}`] : []),
    ...(settings.length > 0
      ? ["", "Settings:", ...settings.map(({ key, value }) => `  ${key}: ${String(value)}`)]
      : []),
  ].join("\n");
  return {
    data: {
      kind: "pane-description",
      ...reportBase(resolved, symbols, settings.length),
      paneId: resolved.pane.id,
      templateId: resolved.template?.id ?? null,
      settings,
    },
    text,
  };
}
