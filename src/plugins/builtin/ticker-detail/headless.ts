import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { formatCurrency, formatNumber, formatPercentRaw } from "../../../utils/format";
import { buildFinancialTableModel, financialStatementCurrency, formatFinancialHeader } from "./financials/model";
import { paneSchemas } from "./headless-schema";
import {
  loadHeadlessFinancials, loadHeadlessPriceHistory, loadHeadlessSymbols, resolveHeadlessInstrument,
} from "../shared/headless-market-data";

export const financialStatementsHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["financial-analysis-pane"],
  shape: "rows",
  describe: ({ symbols, options }) => `Financial Statements | ${symbols[0]} | ${options.period} | ${options.statement}`,
  async load({ symbols, options }, ctx) {
    const symbol = symbols[0]!;
    const financials = await loadHeadlessFinancials(ctx, symbol);
    const table = buildFinancialTableModel(financials, {
      period: options.period === "quarterly" ? "quarterly" : "annual",
      statement: String(options.statement ?? "income"),
    });
    const statementCurrency = financialStatementCurrency(financials, table?.statements ?? []);
    const dates = table?.statements.map(({ date, currency }) => ({
      date, currency: currency ?? statementCurrency ?? null,
      label: formatFinancialHeader(date, currency ?? statementCurrency).trim(),
    })) ?? [];
    const rows = table?.rows.map((row) => ({
      id: row.id, kind: row.kind, metric: row.unitLabel,
      cells: row.cells.map((cell, index) => ({
        date: dates[index]?.date ?? "", value: cell.value ?? null,
        growth: cell.growth ?? null, formatted: cell.valueText.trim(), growthFormatted: cell.growthText.trim(),
      })),
      ...Object.fromEntries(row.cells.map((cell, index) => [dates[index]!.date, cell.value ?? null])),
    })) ?? [];
    const columns: HeadlessPaneColumn[] = [
      { key: "metric", header: "Metric" },
      ...dates.map(({ date, label }, index) => ({
        key: date, header: label, align: "right" as const,
        format: (_value: unknown, row: Record<string, unknown>) => {
          const cell = (row.cells as Array<{ formatted: string; growthFormatted: string }>)[index]!;
          return [cell.formatted, cell.growthFormatted].filter(Boolean).join(" ");
        },
      })),
    ];
    return {
      rows, columns, unavailableSymbols: rows.length ? [] : [symbol],
      metadata: {
        symbol, name: financials.quote?.name ?? symbol, currency: statementCurrency ?? null, quoteCurrency: financials.quote?.currency ?? null,
        statement: table?.subTab.key ?? options.statement, statementLabel: table?.subTab.name ?? null,
        period: table?.period ?? options.period, growthBasis: table?.period === "quarterly" ? "QoQ" : "YoY", columns: dates,
      },
    };
  },
};

export const quoteComparisonHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["quote-monitor-pane"],
  shape: "rows",
  describe: ({ symbols }) => `Quote Monitor | ${symbols.join(", ")}`,
  columns: [
    { key: "symbol", header: "Ticker" },
    { key: "name", header: "Name" },
    { key: "price", header: "Last", align: "right", format: (value, row) => formatCurrency(Number(value), String(row.currency)) },
    { key: "change", header: "Change", align: "right", format: (value, row) => `${Number(value) >= 0 ? "+" : ""}${formatCurrency(Number(value), String(row.currency))}` },
    { key: "changePercent", header: "Change %", align: "right", format: (value) => formatPercentRaw(Number(value)) },
  ],
  async load({ symbols }, ctx) {
    const loaded = await loadHeadlessSymbols(symbols, ctx, async (key) => {
      const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
      return ctx.marketData.getQuote(symbol, exchange);
    });
    return {
      rows: loaded.entries.map(({ symbol, data: quote }) => ({
        symbol, name: quote.name ?? "", price: quote.price, currency: quote.currency,
        change: quote.change, changePercent: quote.changePercent,
        marketCap: quote.marketCap ?? null, updatedAt: quote.lastUpdated,
      })),
      unavailableSymbols: loaded.unavailableSymbols, errors: loaded.errors,
    };
  },
};

export const historicalPricesHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["historical-prices-pane"],
  shape: "rows",
  describe: ({ symbols, options }) => `Historical Prices | ${symbols[0]} | ${options.range ?? "ALL"}`,
  columns: [
    { key: "date", header: "Date", format: (value) => String(value).slice(0, 10) },
    ...["open", "high", "low", "close", "volume"].map((key) => ({
      key, header: key, align: "right" as const,
      format: (value: unknown) => value == null ? "-" : formatNumber(Number(value), key === "volume" ? 0 : 2),
    })),
  ],
  async load({ symbols, options }, ctx) {
    const symbol = symbols[0]!;
    const range = (options.range ?? "ALL") as TimeRange;
    const points = await loadHeadlessPriceHistory(ctx, symbol, range);
    const rows = points.map((point) => {
      const date = new Date(point.date);
      return {
        date: Number.isFinite(date.getTime()) ? date.toISOString() : String(point.date),
        open: point.open ?? null, high: point.high ?? null, low: point.low ?? null,
        close: point.close, volume: point.volume ?? null,
      };
    }).sort((left, right) => left.date.localeCompare(right.date));
    return { rows, unavailableSymbols: rows.length ? [] : [symbol], metadata: { symbol, range } };
  },
};
