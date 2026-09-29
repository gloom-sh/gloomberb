import { FINANCIAL_VINTAGE_NOTICE } from "../../../utils/financial-statements";
import { hasValidQuoteObservationTime } from "../../../market-data/quotes/freshness";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import { formatMarketPrice, formatMarketPriceWithCurrency, formatPriceObservation, withCurrencyMinorDigits, type MarketFormatOptions } from "../../../market-data/market/format";
import { pricePointValues, priceHistoryIntegrityNotice } from "../../../utils/price-history-integrity";
import { buildFinancialTableModel, financialStatementCurrency, financialStatementDateNotice, financialStatementLimitations, formatFinancialHeader } from "./financials/model";
import { paneSchemas } from "./headless-schema";
import { loadPeriodEndHistory } from "./financials/period-end-history";
import {
  RATIO_GAP_TEXT,
  findRatioTab,
  formatRatioInput,
  formatRatioValue,
  ratioPeriodEnd,
  ratioTableForFinancials,
  resolveFinancialSectionKey,
  type RatioAmount,
  type RatioTabDef,
} from "./financials/ratios";
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
    const requestedPeriod = options.period === "quarterly" ? "quarterly" : "annual";
    const hasRequestedStatements = (requestedPeriod === "quarterly"
      ? financials.quarterlyStatements : financials.annualStatements).length > 0;
    const ratioTab = findRatioTab(resolveFinancialSectionKey(String(options.statement ?? "income")));
    if (ratioTab) return loadRatioReport(ctx, symbol, financials, ratioTab, requestedPeriod, hasRequestedStatements);
    // The interactive tabs visibly select their fallback. A headless request
    // has no such selection change, so it must keep the requested period.
    const table = hasRequestedStatements ? buildFinancialTableModel(financials, {
      period: requestedPeriod,
      statement: String(options.statement ?? "income"),
      expandAll: true,
    }) : null;
    const statementCurrency = financialStatementCurrency(financials, [
      ...financials.annualStatements, ...financials.quarterlyStatements,
    ]);
    const dates = table?.statements.map(({ date, currency, dateSource, providerDate, dateEvidence, availableAt, fieldAvailability, fieldSources, unavailableFields, epsBasis, unavailableEarnings, aggregation }) => ({
      date, currency: currency ?? statementCurrency ?? null,
      availableAt: availableAt ?? null,
      fieldAvailability: fieldAvailability ? { ...fieldAvailability } : null,
      ...(fieldSources ? { fieldSources } : {}),
      ...(unavailableFields ? { unavailableFields } : {}),
      ...(epsBasis ? { epsBasis } : {}),
      ...(unavailableEarnings ? { unavailableEarnings } : {}),
      ...(aggregation ? { aggregation } : {}),
      dateSource: date === "TTM" ? "derived" : dateSource ?? "provider",
      providerDate: date === "TTM" ? null : providerDate ?? null,
      dateEvidence: date === "TTM" || dateSource !== "sec" ? null : dateEvidence ?? null,
      // Rows in the shared money unit no longer name it, so the header does.
      label: formatFinancialHeader(date, [currency ?? statementCurrency, table.unit].filter(Boolean).join(" ") || undefined, dateSource, false, aggregation?.periodEnd).trim(),
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
      ...(!hasRequestedStatements ? { errors: [`${symbol}: No ${requestedPeriod} financial statement coverage.`] } : {}),
      metadata: {
        symbol, name: financials.quote?.name ?? symbol, currency: statementCurrency ?? null, unit: table?.unit ?? null, quoteCurrency: financials.quote?.currency ?? null,
        statement: table?.subTab.key ?? options.statement, statementLabel: table?.subTab.name ?? null,
        period: requestedPeriod, growthBasis: requestedPeriod === "quarterly" ? "QoQ" : "YoY", columns: dates,
        notices: rows.length ? [FINANCIAL_VINTAGE_NOTICE] : [],
        limitations: financialStatementLimitations(financials),
        dateProvenance: financialStatementDateNotice(table?.statements ?? []),
      },
    };
  },
};

const reportAmount = (amount: RatioAmount) => (typeof amount === "number" ? amount : null);

/** A ratio tab as a report: each ratio, then its inputs, per period. */
async function loadRatioReport(
  ctx: Parameters<typeof financialStatementsHeadless.load>[1],
  symbol: string,
  financials: Awaited<ReturnType<typeof loadHeadlessFinancials>>,
  tab: RatioTabDef,
  period: "annual" | "quarterly",
  hasRequestedStatements: boolean,
) {
  const oldest = hasRequestedStatements ? ratioTableForFinancials(financials, tab, period).periods.at(-1) : undefined;
  const history = oldest && tab.key === "valuation"
    ? await resolveHeadlessInstrument(ctx, symbol)
      .then(({ symbol: bare, exchange }) => loadPeriodEndHistory(ctx.marketData, bare, exchange ?? "", ratioPeriodEnd(oldest.statement)))
      .catch(() => null)
    : null;
  const table = hasRequestedStatements ? ratioTableForFinancials(financials, tab, period, history) : null;
  const statementCurrency = financialStatementCurrency(financials, [
    ...financials.annualStatements, ...financials.quarterlyStatements,
  ]);
  const dates = table?.periods.map(({ statement }) => ({
    date: statement.date,
    periodEnd: ratioPeriodEnd(statement),
    currency: statement.currency ?? statementCurrency ?? null,
    label: formatFinancialHeader(statement.date, statement.currency ?? statementCurrency, statement.dateSource, false, statement.aggregation?.periodEnd).trim(),
  })) ?? [];
  const rows = table?.rows.map((row) => {
    const cells = table.cells.get(row.def.id)!.map((cell, index) => {
      const amount = row.kind === "ratio" ? cell.value : cell.inputs[row.index]!;
      return {
        date: dates[index]!.date,
        value: reportAmount(amount),
        gap: typeof amount === "number" ? null : RATIO_GAP_TEXT[amount],
        formatted: row.kind === "ratio"
          ? formatRatioValue(row.def.format, amount)
          : formatRatioInput(row.def.inputs[row.index]!.format, amount, row.divisor),
      };
    });
    return {
      id: row.id, kind: row.kind, metric: row.kind === "ratio" ? row.label : row.unitLabel,
      cells,
      ...Object.fromEntries(cells.map((cell) => [cell.date, cell.value])),
    };
  }) ?? [];
  const columns: HeadlessPaneColumn[] = [
    { key: "metric", header: "Ratio" },
    ...dates.map(({ date, label }, index) => ({
      key: date, header: label, align: "right" as const,
      format: (_value: unknown, row: Record<string, unknown>) => (row.cells as Array<{ formatted: string }>)[index]!.formatted,
    })),
  ];
  return {
    rows, columns, unavailableSymbols: rows.length ? [] : [symbol],
    ...(!hasRequestedStatements ? { errors: [`${symbol}: No ${period} financial statement coverage.`] } : {}),
    ...(tab.key === "valuation" && hasRequestedStatements && !history?.length ? { complete: false } : {}),
    metadata: {
      symbol, name: financials.quote?.name ?? symbol, currency: statementCurrency ?? null,
      quoteCurrency: financials.quote?.currency ?? null,
      statement: tab.key, statementLabel: tab.name, period, columns: dates,
      notices: rows.length ? [FINANCIAL_VINTAGE_NOTICE] : [],
      limitations: financialStatementLimitations(financials),
    },
  };
}

function quoteAmount(value: unknown, row: Record<string, unknown>, signed = false): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const currency = typeof row.currency === "string" && row.currency.trim() ? row.currency : undefined;
  const base: MarketFormatOptions = { assetCategory: typeof row.instrumentType === "string" ? row.instrumentType : undefined,
    priceBasis: row.priceBasis === "per-unit" || row.priceBasis === "percent-of-par" ? row.priceBasis : undefined };
  // Par quotes keep two decimals; money pads to its currency's minor unit (none for JPY).
  const options = base.priceBasis === "percent-of-par" ? { ...base, minimumFractionDigits: 2 } : withCurrencyMinorDigits(base, currency);
  const amount = currency
    ? formatMarketPriceWithCurrency(value, currency, options)
    : formatMarketPrice(value, options);
  return amount === "—" ? amount : `${signed && value >= 0 ? "+" : ""}${amount}`;
}

export const quoteComparisonHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["quote-monitor-pane"],
  shape: "rows",
  describe: ({ symbols }) => `Quote Monitor | ${symbols.join(", ")}`,
  columns: [
    { key: "symbol", header: "Ticker" },
    { key: "name", header: "Name" },
    { key: "price", header: "Last", align: "right", format: (value, row) => quoteAmount(value, row) },
    { key: "change", header: "Change", align: "right", format: (value, row) => quoteAmount(value, row, true) },
    { key: "changePercent", header: "Change %", align: "right", format: (value) => formatPercentRaw(typeof value === "number" && Number.isFinite(value) ? value : undefined) },
  ],
  async load({ symbols }, ctx) {
    const loaded = await loadHeadlessSymbols(symbols, ctx, async (key) => {
      const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
      const quote = await ctx.marketData.getQuote(symbol, exchange);
      if (!quote) throw new Error(`Quote is unavailable for ${key}`);
      if (!hasValidQuoteObservationTime(quote)) throw new Error(`Quote observation time is unavailable for ${key}`);
      return quote;
    });
    return {
      rows: loaded.entries.map(({ symbol, data: quote }) => {
        // The pane's cards show the live session's print, so the rows do too.
        const display = getActiveQuoteDisplay(quote)!;
        return {
          symbol, name: quote.name ?? "", price: display.price, currency: quote.currency,
          ...(quote.instrumentType ? { instrumentType: quote.instrumentType } : {}),
          ...(quote.priceBasis ? { priceBasis: quote.priceBasis } : {}),
          change: display.change, changePercent: display.changePercent,
          marketCap: quote.marketCap ?? null, updatedAt: quote.lastUpdated,
        };
      }),
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
      format: (value: unknown) => value == null || !Number.isFinite(Number(value)) ? "-"
        : key === "volume" ? formatNumber(Number(value), 0)
        : formatPriceObservation(Number(value), { minimumFractionDigits: 2 }),
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
        ...pricePointValues(point),
      };
    }).sort((left, right) => left.date.localeCompare(right.date));
    const notice = priceHistoryIntegrityNotice(rows.filter((row) => row.integrity).length);
    return { rows, ...(notice ? { complete: false } : {}), unavailableSymbols: rows.some((row) => row.close !== null) ? [] : [symbol], metadata: { symbol, range, ...(notice ? { notices: [notice] } : {}) } };
  },
};
