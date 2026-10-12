import { FINANCIAL_VINTAGE_NOTICE } from "../../../utils/financial-statements";
import { hasValidQuoteObservationTime } from "../../../market-data/quotes/freshness";
import { EXTENDED_SESSION_LABELS, getQuoteSessionFields, type ExtendedSession } from "../../../market-data/market/status";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import { formatMarketPrice, formatMarketPriceWithCurrency, formatPriceObservation, withCurrencyMinorDigits, type MarketFormatOptions } from "../../../market-data/market/format";
import { pricePointValues, priceHistoryIntegrityNotice } from "../../../utils/price-history-integrity";
import {
  buildFinancialTableModel, financialStatementCurrency, financialStatementDateNotice, financialStatementLimitations,
  formatFinancialHeader, isPerShareFinancialRow, receiptShareCountLabel,
} from "./financials/model";
import { adrRatioText } from "../../../utils/depositary-receipt";
import { paneSchemas } from "./headless-schema";
import { loadPeriodEndHistory } from "./financials/period-end-history";
import {
  RATIO_GAP_TEXT,
  findRatioTab,
  formatRatioInput,
  formatRatioValue,
  oldestRatioPeriodEnd,
  ratioPeriodEnd,
  ratioStatements,
  ratioTableForFinancials,
  resolveFinancialSectionKey,
  type RatioAmount,
  type RatioTabDef,
} from "./financials/ratios";
import {
  loadHeadlessFinancials, loadHeadlessPriceHistory, loadHeadlessSymbols, resolveHeadlessInstrument,
} from "../shared/headless-market-data";
import { barHistoryFreshness, barResolutionFromDates, quoteFreshnessFields, REPORTED_DATA } from "../shared/report-freshness";
import { cleanFloat32Price, historyPriceDecimals } from "../../../cli/history-rows";
import { historyCoverageNotice } from "../../../sources/history-coverage";
import { getChartResolutionLabel, isIntradayResolution, type ManualChartResolution } from "../../../time-series/resolution";
import { buildReturnRows, closedMarketNote, type ReturnRange } from "./data-panes/returns-model";
import { loadReturnSeries } from "./data-panes/returns-history";

export const financialStatementsHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["financial-analysis-pane"],
  shape: "rows",
  // Dated by the latest reported period; earlier periods are the statement's history.
  freshness: { ...REPORTED_DATA, basis: "financial statements", observedKey: "date", oldest: null },
  description: "Annual or quarterly financial statement rows for one ticker: the income statement, balance sheet, cash flow, or a ratio table.",
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
    // Gloom Cloud states when a period's share counts and EPS are on the receipts.
    const receiptPeriods = table?.statements.filter(({ shareBasis }) => shareBasis === "depositary_receipt").map(({ date }) => date) ?? [];
    const allReceipts = receiptPeriods.length > 0 && receiptPeriods.length === table?.statements.length;
    const shareBases = new Set(table?.statements.map(({ shareBasis }) => shareBasis ?? null));
    const ratio = adrRatioText(financials.fundamentals?.adrRatio ?? financials.quote?.adrRatio);
    const shareBasisNotice = receiptPeriods.length === 0 || !table?.rows.some(isPerShareFinancialRow) ? null
      : allReceipts
        ? `Share counts are in ADRs and EPS is per ADR${ratio ? `; ${ratio}` : ""}.`
        : `Share counts are in ADRs and EPS is per ADR for ${receiptPeriods.join(", ")}${ratio ? ` (${ratio})` : ""}; other periods as reported.`;
    const dates = table?.statements.map(({ date, currency, dateSource, providerDate, dateEvidence, availableAt, fieldAvailability, fieldSources, unavailableFields, epsBasis, unavailableEarnings, aggregation, shareBasis }) => ({
      date, currency: currency ?? statementCurrency ?? null,
      shareBasis: shareBasis ?? null,
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
      id: row.id, kind: row.kind, metric: allReceipts ? receiptShareCountLabel(row) : row.unitLabel,
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
        shareBasis: shareBases.size === 1 ? [...shareBases][0] ?? null : null,
        ...(receiptPeriods.length > 0 ? { adrRatio: financials.fundamentals?.adrRatio ?? financials.quote?.adrRatio ?? null } : {}),
        notices: rows.length ? [FINANCIAL_VINTAGE_NOTICE, ...(shareBasisNotice ? [shareBasisNotice] : [])] : [],
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
  const oldest = hasRequestedStatements ? oldestRatioPeriodEnd(ratioStatements(financials, period)) : undefined;
  const history = oldest && tab.key === "valuation"
    ? await resolveHeadlessInstrument(ctx, symbol)
      .then(({ symbol: bare, exchange }) => loadPeriodEndHistory(ctx.marketData, bare, exchange ?? "", oldest))
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

function percentCell(value: unknown): string {
  return formatPercentRaw(typeof value === "number" && Number.isFinite(value) ? value : undefined);
}

const QUOTE_MONITOR_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "price", header: "Last", align: "right", format: (value, row) => quoteAmount(value, row) },
  { key: "change", header: "Change", align: "right", format: (value, row) => quoteAmount(value, row, true) },
  { key: "changePercent", header: "Change %", align: "right", format: percentCell },
];

/** The pre-market or after-hours print and its move from the regular close, for the rows that have one. */
function extendedSessionColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice", header: EXTENDED_SESSION_LABELS[session], align: "right",
    format: (value, row) => row.extendedSession === session
      ? `${quoteAmount(value, row)} ${percentCell(row.extendedChangePercent)}`
      : "—",
  };
}

export const quoteComparisonHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["quote-monitor-pane"],
  shape: "rows",
  description: "Current quotes for one or more tickers: name, the regular session's last price, change and percent change, and any pre-market or after-hours print.",
  describe: ({ symbols }) => `Quote Monitor | ${symbols.join(", ")}`,
  columns: QUOTE_MONITOR_COLUMNS,
  async load({ symbols }, ctx) {
    const loaded = await loadHeadlessSymbols(symbols, ctx, async (key) => {
      const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
      const quote = await ctx.marketData.getQuote(symbol, exchange);
      if (!quote) throw new Error(`Quote is unavailable for ${key}`);
      if (!hasValidQuoteObservationTime(quote)) throw new Error(`Quote observation time is unavailable for ${key}`);
      return quote;
    });
    const rows = loaded.entries.map(({ symbol, data: quote }) => {
      // As the pane's cards show them: the regular session, then any extended print from its close.
      const { price, change, changePercent, ...extended } = getQuoteSessionFields(quote);
      return {
        symbol, name: quote.name ?? "", price, currency: quote.currency,
        ...(quote.instrumentType ? { instrumentType: quote.instrumentType } : {}),
        ...(quote.priceBasis ? { priceBasis: quote.priceBasis } : {}),
        change, changePercent, ...extended,
        marketCap: quote.marketCap ?? null, updatedAt: quote.lastUpdated,
        ...quoteFreshnessFields(quote),
      };
    });
    // An extended column only when a row has a print for it, so a closed board stays as narrow as before.
    const extendedColumns = (["PRE", "POST"] as const)
      .filter((session) => rows.some((row) => row.extendedSession === session))
      .map(extendedSessionColumn);
    return {
      rows,
      ...(extendedColumns.length > 0 ? { columns: [...QUOTE_MONITOR_COLUMNS, ...extendedColumns] } : {}),
      unavailableSymbols: loaded.unavailableSymbols, errors: loaded.errors,
    };
  },
};

export const historicalPricesHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["historical-prices-pane"],
  shape: "rows",
  description: "Daily OHLCV rows (date, open, high, low, close, volume) for one ticker over a range.",
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
    // A bar history: dated by its last bar, stale once bars of its size stop arriving.
    const freshness = { ...barHistoryFreshness(barResolutionFromDates(rows.map((row) => row.date))), observedKey: "date", oldest: null };
    return { rows, freshness, ...(notice ? { complete: false } : {}), unavailableSymbols: rows.some((row) => row.close !== null) ? [] : [symbol], metadata: { symbol, range, ...(notice ? { notices: [notice] } : {}) } };
  },
};

/** A percent with its sign, two decimals: `+0.63%`; a dash for a gap. */
function signedPercentCell(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export const returnsHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["returns-pane"],
  shape: "rows",
  description: "Interval and cumulative price returns of one ticker's bars over a range: each bar's close, its move from the bar before, and its move from the bar before the window.",
  describe: ({ symbols, options }) => `Returns | ${symbols[0]} | ${options.range ?? "5D"} | ${options.interval ?? "1h"}`,
  async load({ symbols, options }, ctx) {
    const key = symbols[0]!;
    const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
    const range = (options.range ?? "5D") as ReturnRange;
    const requested = (options.interval ?? "1h") as ManualChartResolution;
    const support = await Promise.resolve(ctx.marketData.getChartResolutionSupport?.(symbol, exchange ?? "") ?? []).catch(() => []);
    const series = await loadReturnSeries(ctx.marketData, {
      symbol, exchange: exchange ?? "", range, resolution: requested, support, now: Date.now(), forceRefresh: ctx.refresh,
    });
    const returns = buildReturnRows(series.points, series.visibleFrom, series.visibleTo).reverse();
    const decimals = historyPriceDecimals(returns.flatMap((row) => row.price === null ? [] : [{
      open: null, high: null, low: null, close: cleanFloat32Price(row.price),
    }]));
    const rounded = (value: number | null) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(Math.min(20, decimals)));
    const percent = (value: number | null) => value === null ? null : value * 100;
    const intraday = isIntradayResolution(series.resolution);
    // A daily or longer bar is a trading date; an intraday one its UTC open.
    const rows = returns.map((row) => ({
      time: intraday ? new Date(row.timestamp).toISOString() : new Date(row.timestamp).toISOString().slice(0, 10),
      close: rounded(row.price),
      intervalChange: rounded(row.intervalChange),
      intervalReturnPct: percent(row.intervalPercent),
      totalChange: rounded(row.cumulativeChange),
      totalReturnPct: percent(row.cumulativePercent),
      ...(row.inconsistent ? { inconsistent: true } : {}),
    }));
    const price = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(decimals) : "-";
    const columns: HeadlessPaneColumn[] = [
      { key: "time", header: intraday ? "Time (UTC)" : "Date", format: (value) => String(value).slice(0, 16).replace("T", " ") },
      { key: "close", header: "Price", align: "right", format: price },
      { key: "intervalChange", header: "Int $", align: "right", format: price },
      { key: "intervalReturnPct", header: "Int %", align: "right", format: signedPercentCell },
      { key: "totalChange", header: "Total $", align: "right", format: price },
      { key: "totalReturnPct", header: "Total %", align: "right", format: signedPercentCell },
    ];
    // An interval the range is too long for is served in the nearest longer bar; say so rather than switch silently.
    const notices = [
      series.resolution !== requested
        ? `${getChartResolutionLabel(requested)} bars do not reach back ${range}; these are ${getChartResolutionLabel(series.resolution)} bars.`
        : null,
      historyCoverageNotice(series.coverageStart, series.visibleFrom),
      priceHistoryIntegrityNotice(rows.filter((row) => row.inconsistent).length) ?? null,
    ].filter((notice): notice is string => !!notice);
    return {
      rows,
      columns,
      unavailableSymbols: rows.length ? [] : [key],
      ...(rows.length ? {} : { errors: [`${key}: No bars in this window.`] }),
      freshness: {
        ...barHistoryFreshness(intraday ? null : series.resolution),
        observedKey: "time",
        oldest: null,
        ...(series.venue ? { cadenceExchange: series.venue } : {}),
        // The window ends at the last session while the market is shut, which the status line says.
        ...(series.lastSession ? { note: closedMarketNote(series.lastSession, series.visibleTo) } : {}),
      },
      metadata: {
        symbol: key,
        range,
        interval: series.resolution,
        requestedInterval: requested,
        window: { after: new Date(series.visibleFrom).toISOString(), through: new Date(series.visibleTo).toISOString() },
        ...(series.lastSession ? { marketClosed: true, lastSession: series.lastSession } : {}),
        basis: "Price returns of bar closes; dividends are not included",
        ...(notices.length ? { notices } : {}),
      },
    };
  },
};
