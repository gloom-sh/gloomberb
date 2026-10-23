import { FINANCIAL_VINTAGE_NOTICE, filledPeriodsNote, stalePeriodNote, statementHistoryNotes } from "../../../utils/financial-statements";
import { hasValidQuoteObservationTime } from "../../../market-data/quotes/freshness";
import { EXTENDED_SESSION_LABELS, getQuoteSessionFields, quoteHeadlineTime, type ExtendedSession } from "../../../market-data/market/status";
import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessPaneOptionValues } from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import { formatMarketPrice, formatMarketPriceWithCurrency, formatPriceObservation, quoteFormatOptions, withCurrencyMinorDigits, type MarketFormatOptions } from "../../../market-data/market/format";
import {
  MISSING_VOLUME_TEXT, missingVolumeCount, missingVolumeNotice, pricePointValues, priceHistoryIntegrityNotice,
} from "../../../utils/price-history-integrity";
import {
  buildFinancialTableModel, financialStatementCurrency, financialStatementDateNotice, financialStatementLimitations,
  financialStatementPeriods, financialSubTabFields, formatFinancialHeader, isPerShareFinancialRow, receiptShareCountLabel,
} from "./financials/model";
import { adrRatioText } from "../../../utils/depositary-receipt";
import { paneSchemas } from "./headless-schema";
import { loadPeriodEndHistory } from "./financials/period-end-history";
import { latestBalanceSheetDate, loadOfferingNote } from "./financials/offerings";
import { reportsShortTermTotal, runwayMethod } from "../../../utils/cash-runway";
import { logFailure } from "../../../utils/log-failure";
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
import { barHistoryFreshness, quoteFreshnessFields, REPORTED_DATA } from "../shared/report-freshness";
import {
  BAR_INTERVAL_LABELS, barPriceDecimals, cleanFloat32Price, formatBarPrice, historyAllStart, historyAllStartNote, historyMissingPeriodsNote, historyPriceDecimals,
} from "../../../cli/history-rows";
import { isoDateToday } from "../../../utils/calendar-date";
import { formatUtcTime } from "../../../utils/utc-time";
import { maxDrawdown, maxDrawdownText } from "../../../utils/max-drawdown";
import { loadPriceWindowHistory, priceWindowText, readPriceWindow, type PriceWindow } from "../../../utils/price-window";
import { historyCoverageNotice } from "../../../sources/history-coverage";
import { getChartResolutionLabel, isIntradayResolution, RANGE_HISTORY_RESOLUTION, type ManualChartResolution } from "../../../time-series/resolution";
import { DAY_SO_FAR_TEXT, withSessionBar } from "../../../time-series/session-bar";
import { buildReturnRows, closedMarketNote, isTodayReturnRow, returnBaseCloseDay, type ReturnRange } from "./data-panes/returns-model";
import { periodBaseText } from "../../../market-data/market/period-return";
import { loadReturnSeries } from "./data-panes/returns-history";
import {
  closedHistoryBarDay, formingHistoryBar, HISTORY_DEFAULT_RANGE, historyBarDate, historyBarSize, historyBarSizeWord, historyDateHeader, isDailyOrLongerBar,
  type HistoryBarSize,
} from "./data-panes/history-bars";

const optionText = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;

/** The `--from`/`--to` window HP and RETURN read in place of their range; null when neither was given. */
function readReportWindow(options: HeadlessPaneOptionValues): PriceWindow | null {
  return readPriceWindow(optionText(options.from), optionText(options.to));
}

/** `2007 to 2009` for a report's title, when it reads a window. */
function reportWindowText(options: HeadlessPaneOptionValues): string | null {
  try {
    const window = readReportWindow(options);
    return window ? priceWindowText(window) : null;
  } catch {
    // Intentional ignore: the load reports a window it cannot read; the title keeps the range.
    return null;
  }
}

/** Bars of a window that closed before today: the history asked for, which no later bar makes stale. */
function pastWindowFreshness(window: PriceWindow, size: HistoryBarSize, observedKey: string): HeadlessPaneFreshness {
  return { status: "not-a-feed", basis: `${historyBarSizeWord(size)} bars, ${priceWindowText(window)}`, observedKey, oldest: null };
}

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
    const dates = table?.statements.map(({ date, currency, dateSource, providerDate, dateEvidence, availableAt, fieldAvailability, fieldSources, unavailableFields, epsBasis, unavailableEarnings, aggregation, shareBasis, filledFrom }) => ({
      date, currency: currency ?? statementCurrency ?? null,
      shareBasis: shareBasis ?? null,
      availableAt: availableAt ?? null,
      fieldAvailability: fieldAvailability ? { ...fieldAvailability } : null,
      ...(fieldSources ? { fieldSources } : {}),
      ...(filledFrom ? { filledFrom } : {}),
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
    // The balance sheet's cash, when an offering since is not in it yet.
    const offering = table?.subTab.key === "balance" ? await reportOfferingNote(ctx, symbol, financials) : null;
    // A latest period over 15 months old says how old it is.
    const stale = table ? stalePeriodNote(financialStatementPeriods(table.statements, table.subTab)) : null;
    // Years filled from the listing's exchange, with the lines this table shows.
    const filled = table ? filledPeriodsNote(table.statements, financialSubTabFields(table.subTab)) : null;
    return {
      rows, columns, unavailableSymbols: rows.length ? [] : [symbol],
      ...(!hasRequestedStatements ? { errors: [`${symbol}: No ${requestedPeriod} financial statement coverage.`] } : {}),
      // The report closes with how old its latest period is, how far back its periods go, and how to read further.
      notes: [...stale ? [stale] : [], ...filled ? [filled] : [], ...offering ? [offering] : [], ...statementHistoryNotes(requestedPeriod, dates.map(({ date }) => date), symbol)],
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

/** The note that an offering filed after the latest balance sheet is not in its cash yet; a failed read leaves it out. */
async function reportOfferingNote(
  ctx: Parameters<typeof financialStatementsHeadless.load>[1],
  symbol: string,
  financials: Awaited<ReturnType<typeof loadHeadlessFinancials>>,
): Promise<string | null> {
  const periodEnd = latestBalanceSheetDate(financials);
  if (!periodEnd) return null;
  return resolveHeadlessInstrument(ctx, symbol)
    .then((listing) => loadOfferingNote(ctx.apiClient, listing, periodEnd, ctx.signal))
    .catch(logFailure("ticker-detail.headless", "Reading the offering filings failed", null));
}

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
  // Liquidity's runway says how it counts months, and that the cash predates an offering since.
  const liquidity = tab.key === "liquidity" && table;
  const runwayShown = liquidity && table.ratios.some((def) => def.format === "months"
    && table.cells.get(def.id)!.some((cell) => typeof cell.value === "number"));
  const offering = liquidity ? await reportOfferingNote(ctx, symbol, financials) : null;
  return {
    rows, columns, unavailableSymbols: rows.length ? [] : [symbol],
    ...(!hasRequestedStatements ? { errors: [`${symbol}: No ${period} financial statement coverage.`] } : {}),
    ...(tab.key === "valuation" && hasRequestedStatements && !history?.length ? { complete: false } : {}),
    notes: [
      ...[stalePeriodNote(dates.map(({ periodEnd }) => ({ date: periodEnd, lead: true })))].filter((note): note is string => !!note),
      ...[filledPeriodsNote(table?.periods.map(({ statement }) => statement) ?? [])].filter((note): note is string => !!note),
      ...offering ? [offering] : [],
      ...runwayShown ? [runwayMethod(reportsShortTermTotal([...financials.quarterlyStatements, ...financials.annualStatements]))] : [],
      ...statementHistoryNotes(period, dates.map(({ date }) => date), symbol),
    ],
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

/** The pre-market, after-hours or overnight print and its move from the regular close, for the rows that have one. */
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
        marketCap: quote.marketCap ?? null, updatedAt: quoteHeadlineTime(quote),
        ...quoteFreshnessFields(quote),
      };
    });
    // An extended column only when a row has a print for it, so a closed board stays as narrow as before.
    const extendedColumns = (["PRE", "POST", "OVERNIGHT"] as const)
      .filter((session) => rows.some((row) => row.extendedSession === session))
      .map(extendedSessionColumn);
    return {
      rows,
      ...(extendedColumns.length > 0 ? { columns: [...QUOTE_MONITOR_COLUMNS, ...extendedColumns] } : {}),
      unavailableSymbols: loaded.unavailableSymbols, errors: loaded.errors,
    };
  },
};

/**
 * The price columns of HP, which `fn HP` prints and exports with the date column of the bars' size. Every price has
 * the table's one decimal count (`decimals`, barPriceDecimals), as `history` and the pane print it; the columns a
 * report declares before it has bars keep every digit the source sent. A bar without
 * volume in a history that reports it (`volumeMissing`) prints it as missing, never as 0.
 */
const historyPriceColumns = (volumeMissing: boolean, decimals?: number): HeadlessPaneColumn[] => ["open", "high", "low", "close", "volume"].map((key) => ({
  key, header: key, align: "right" as const,
  format: (value: unknown) => value == null || !Number.isFinite(Number(value)) ? key === "volume" && volumeMissing ? MISSING_VOLUME_TEXT : "-"
    : key === "volume" ? formatNumber(Number(value), 0)
    : decimals == null ? formatPriceObservation(Number(value), { minimumFractionDigits: 2 })
    : formatBarPrice(Number(value), decimals),
}));

/**
 * The columns of HP's rows. A day or longer bar is a date and an intraday one a
 * UTC time. The text table dates a month's bar as the month and marks a bar
 * whose period runs on (`2026-10 MTD`); the export keeps each bar's own date
 * and adds a `Partial` column when one is.
 */
function historyColumns(size: HistoryBarSize, partial: boolean, text: boolean, volumeMissing = false, decimals?: number): HeadlessPaneColumn[] {
  const daily = isDailyOrLongerBar(size);
  const date: HeadlessPaneColumn = {
    key: "date",
    header: daily ? historyDateHeader(size) ?? "Date" : "Time (UTC)",
    format: (value, row) => daily
      ? (text ? historyBarDate(String(value).slice(0, 10), size, row.partial === true) : String(value).slice(0, 10))
      : String(value).slice(0, 16).replace("T", " "),
  };
  const marked: HeadlessPaneColumn[] = partial && !text
    ? [{ key: "partial", header: "Partial", format: (value) => value === true ? "true" : "" }]
    : [];
  return [date, ...historyPriceColumns(volumeMissing, decimals), ...marked];
}

export const historicalPricesHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["historical-prices-pane"],
  shape: "rows",
  description: "OHLCV bars (date, open, high, low, close, volume) for one ticker over a range: daily to start, weekly for 5Y and monthly for ALL. The newest bar is marked partial while its day, week or month runs on; a day's bar then comes from the live quote.",
  describe: ({ symbols, options }) => `Historical Prices | ${symbols[0]} | ${reportWindowText(options) ?? options.range ?? HISTORY_DEFAULT_RANGE}`,
  columns: historyColumns("1d", false, false),
  async load({ symbols, options }, ctx) {
    const symbol = symbols[0]!;
    const range = (options.range ?? HISTORY_DEFAULT_RANGE) as TimeRange;
    // --from 2007 --to 2009 reads those dates' bars in place of the range.
    const window = readReportWindow(options);
    const pastWindow = !!window && window.to < isoDateToday();
    // A range of daily or longer bars reaches into the session now trading, whose bar is the quote's (withSessionBar).
    const { symbol: listing, exchange } = await resolveHeadlessInstrument(ctx, symbol);
    const [loaded, quote] = await Promise.all([
      window ? loadPriceWindowHistory(ctx.marketData, listing, exchange ?? "", window).then((result) => result.points)
        : loadHeadlessPriceHistory(ctx, symbol, range),
      pastWindow || (!window && isIntradayResolution(RANGE_HISTORY_RESOLUTION[range])) ? null
        : ctx.marketData.getQuote(listing, exchange ?? "").catch(() => null),
    ]);
    // The venue whose sessions say whether a day, week or month is still running: the key's, or for a bare symbol its quote's.
    const venue = exchange || quote?.listingExchangeName || quote?.exchangeName || undefined;
    const now = Date.now();
    const points = withSessionBar(loaded, quote, { now, venue });
    // Providers serve float32 prices (4013.39990234 for 4013.4): the rows hold the decimal each is, as `history` does.
    const clean = (value: number | null) => value == null ? null : cleanFloat32Price(value);
    const rows = points.map((point) => {
      const date = new Date(point.date);
      const values = pricePointValues(point);
      return {
        date: Number.isFinite(date.getTime()) ? date.toISOString() : String(point.date),
        open: clean(values.open), high: clean(values.high), low: clean(values.low), close: clean(values.close), volume: values.volume,
        ...(values.integrity ? { integrity: values.integrity } : {}),
        ...(point.partial ? { partial: true } : {}),
        // A coin's day Gloom Cloud rebuilt from hourly bars has no volume of its own, as `history` marks it.
        ...(point.filled ? { filled: true } : {}),
      };
    }).sort((left, right) => left.date.localeCompare(right.date));
    const notice = priceHistoryIntegrityNotice(rows.filter((row) => row.integrity).length);
    const size = historyBarSize(rows.map((row) => Date.parse(row.date)));
    // A weekly or monthly bar whose period runs on is dated by how far it runs, as `history` dates it.
    const forming = formingHistoryBar(size, rows.at(-1)?.date, venue, now);
    // A complete one is dated by the day its last session closed, the day its close is from.
    const closedDay = closedHistoryBarDay(size, rows.at(-1)?.date, venue, now);
    const shown = forming ? [...rows.slice(0, -1), { ...rows.at(-1)!, partial: true }] : rows;
    // One decimal count for the table, by the instrument's display rules when the quote names its kind.
    const decimals = barPriceDecimals(rows, quoteFormatOptions(quote).assetCategory);
    const marked = shown.some((row) => row.partial === true);
    const volumeMissing = missingVolumeCount(shown);
    const volumeNote = missingVolumeNotice(volumeMissing, shown.length);
    // Every month or week without a bar is named, and ALL says where the source's bars start (BTC-USD's in 2014-09).
    const interval = size === "intraday" ? null : size;
    const gapNote = historyMissingPeriodsNote(rows.map((row) => Date.parse(row.date)), interval);
    const allStart = window ? null : historyAllStart(range, interval, rows[0]?.date, now);
    const notes = [allStart ? historyAllStartNote(allStart) : null, gapNote, volumeNote].filter((note): note is string => note != null);
    // The day's bar built from the quote is not a close; a coin's day in progress, as its source flags it, keeps its line.
    const dayToDate = points !== loaded && size === "1d" && shown.at(-1)?.partial === true;
    // A bar history: dated by its last bar, stale once bars of its size stop arriving.
    const freshness = pastWindow ? pastWindowFreshness(window, size, "date") : {
      ...barHistoryFreshness(isDailyOrLongerBar(size) ? size : null),
      observedKey: "date", oldest: null,
      ...(forming ? { periodToDate: forming } : closedDay ? { asOf: closedDay } : {}),
      ...(dayToDate ? { basis: "daily bars", note: `the newest bar is ${DAY_SO_FAR_TEXT}`, ...(quote ? { asOf: new Date(quote.lastUpdated).toISOString() } : {}) } : {}),
    };
    // The largest fall from a close to a later one in the bars shown, said under the title.
    const drawdown = maxDrawdown(shown);
    const drawdownLine = drawdown ? maxDrawdownText(drawdown, { basis: `${historyBarSizeWord(size)} closes`, price: (value) => formatBarPrice(value, decimals),
      date: (value) => isDailyOrLongerBar(size) ? value.slice(0, 10) : formatUtcTime(value) }) : null;
    const reportNotices = [drawdownLine, notice].filter((line): line is string => line != null);
    return {
      rows: shown,
      columns: historyColumns(size, marked, false, false, decimals),
      textColumns: historyColumns(size, marked, true, volumeMissing > 0, decimals),
      freshness,
      ...(notes.length > 0 ? { notes } : {}),
      ...(notice ? { complete: false } : {}),
      unavailableSymbols: rows.some((row) => row.close !== null) ? [] : [symbol],
      metadata: { symbol, range: window ? null : range, ...(window ? { window } : {}), ...(size === "intraday" ? {} : { interval: size }),
        ...(allStart ? { sourceStart: allStart } : {}), maxDrawdown: drawdown,
        ...(reportNotices.length ? { notices: reportNotices } : {}) },
    };
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
  describe: ({ symbols, options }) => `Returns | ${symbols[0]} | ${reportWindowText(options) ?? options.range ?? "5D"} | ${options.interval ?? "1h"}`,
  async load({ symbols, options }, ctx) {
    const key = symbols[0]!;
    const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
    const range = (options.range ?? "5D") as ReturnRange;
    const requested = (options.interval ?? "1h") as ManualChartResolution;
    // --from 2007 --to 2009 measures those dates' returns in place of the range.
    const window = readReportWindow(options);
    const pastWindow = !!window && window.to < isoDateToday();
    const support = await Promise.resolve(ctx.marketData.getChartResolutionSupport?.(symbol, exchange ?? "") ?? []).catch(() => []);
    const now = Date.now();
    const series = await loadReturnSeries(ctx.marketData, {
      symbol, exchange: exchange ?? "", range, resolution: requested, support, now, forceRefresh: ctx.refresh, window,
    });
    const returns = buildReturnRows(series.points, series.visibleFrom, series.visibleTo).reverse();
    const venue = series.venue || undefined;
    // The close every total is measured from, which the report names: `Totals from Mon 21 Sep close.`
    const baseDay = returns.length ? returnBaseCloseDay(series.points, series.visibleFrom, series.resolution, venue, now) : null;
    const decimals = historyPriceDecimals(returns.flatMap((row) => row.price === null ? [] : [{
      open: null, high: null, low: null, close: cleanFloat32Price(row.price),
    }]));
    const rounded = (value: number | null) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(Math.min(20, decimals)));
    const percent = (value: number | null) => value === null ? null : value * 100;
    const intraday = isIntradayResolution(series.resolution);
    // A daily or longer bar is a trading date; an intraday one its UTC open.
    const unmarked = returns.map((row) => ({
      time: intraday ? new Date(row.timestamp).toISOString() : new Date(row.timestamp).toISOString().slice(0, 10),
      close: rounded(row.price),
      intervalChange: rounded(row.intervalChange),
      intervalReturnPct: percent(row.intervalPercent),
      totalChange: rounded(row.cumulativeChange),
      totalReturnPct: percent(row.cumulativePercent),
      ...(row.inconsistent ? { inconsistent: true } : {}),
    }));
    // A weekly or monthly bar whose period runs on is the period so far: marked partial, and dated by how far it runs.
    const forming = formingHistoryBar(series.resolution, unmarked.at(-1)?.time, venue, now);
    const closedDay = closedHistoryBarDay(series.resolution, unmarked.at(-1)?.time, venue, now);
    // Today's daily bar is the session still trading, not a close: marked partial (DTD), as `history` marks it.
    const dayToDate = isTodayReturnRow(returns.at(-1), series.resolution, venue, now);
    const rows = forming || dayToDate ? [...unmarked.slice(0, -1), { ...unmarked.at(-1)!, partial: true }] : unmarked;
    const price = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(decimals) : "-";
    // The largest fall from a close to a later one in the window, said under the title.
    const drawdown = maxDrawdown(unmarked.map((row) => ({ date: row.time, close: row.close })));
    const maxDrawdownLine = drawdown ? maxDrawdownText(drawdown, { basis: `${BAR_INTERVAL_LABELS[series.resolution]} closes`, price,
      date: (value) => intraday ? formatUtcTime(value) : value.slice(0, 10) }) : null;
    const figures: HeadlessPaneColumn[] = [
      { key: "close", header: "Price", align: "right", format: price },
      { key: "intervalChange", header: "Int $", align: "right", format: price },
      { key: "intervalReturnPct", header: "Int %", align: "right", format: signedPercentCell },
      { key: "totalChange", header: "Total $", align: "right", format: price },
      { key: "totalReturnPct", header: "Total %", align: "right", format: signedPercentCell },
    ];
    // The text table dates a month's bar as the month and marks one still running (`2026-10 MTD`); the export keeps the day and says which bar is partial.
    const timeColumn = (text: boolean): HeadlessPaneColumn => ({
      key: "time",
      header: intraday ? "Time (UTC)" : "Date",
      format: (value, row) => text && !intraday
        ? historyBarDate(String(value).slice(0, 10), series.resolution, row.partial === true)
        : String(value).slice(0, 16).replace("T", " "),
    });
    const columns: HeadlessPaneColumn[] = [
      timeColumn(false),
      ...figures,
      ...forming || dayToDate ? [{ key: "partial", header: "Partial", format: (value: unknown) => value === true ? "true" : "" }] : [],
    ];
    const textColumns: HeadlessPaneColumn[] = [timeColumn(true), ...figures];
    // An interval the range is too long for is served in the nearest longer bar; say so rather than switch silently.
    const notices = [
      maxDrawdownLine,
      baseDay ? `Totals ${periodBaseText(baseDay, now)}.` : null,
      series.resolution !== requested
        ? `${getChartResolutionLabel(requested)} bars do not ${window ? `cover ${priceWindowText(window)}` : `reach back ${range}`}; these are ${getChartResolutionLabel(series.resolution)} bars.`
        : null,
      historyCoverageNotice(series.coverageStart, series.visibleFrom),
      priceHistoryIntegrityNotice(rows.filter((row) => row.inconsistent).length) ?? null,
    ].filter((notice): notice is string => !!notice);
    return {
      rows,
      columns,
      textColumns,
      unavailableSymbols: rows.length ? [] : [key],
      ...(rows.length ? {} : { errors: [`${key}: No bars in this window.`] }),
      freshness: pastWindow ? pastWindowFreshness(window, series.resolution, "time") : {
        ...barHistoryFreshness(intraday ? null : series.resolution),
        observedKey: "time",
        oldest: null,
        ...(forming ? { periodToDate: forming } : closedDay ? { asOf: closedDay } : {}),
        ...(series.venue ? { cadenceExchange: series.venue } : {}),
        // The window ends at the last session while the market is shut, which the status line says.
        ...(series.lastSession ? { note: closedMarketNote(series.lastSession, series.visibleTo) } : {}),
        ...(dayToDate ? { basis: "daily bars", note: `the newest bar is ${DAY_SO_FAR_TEXT}` } : {}),
      },
      metadata: {
        symbol: key,
        range: window ? null : range,
        // The years asked for; `window` below is the span of the bars served.
        ...(window ? { requestedWindow: window } : {}),
        interval: series.resolution,
        requestedInterval: requested,
        window: { after: new Date(series.visibleFrom).toISOString(), through: new Date(series.visibleTo).toISOString() },
        ...(baseDay ? { baseDay } : {}),
        ...(series.lastSession ? { marketClosed: true, lastSession: series.lastSession } : {}),
        basis: "Price returns of bar closes; dividends are not included",
        maxDrawdown: drawdown,
        ...(notices.length ? { notices } : {}),
      },
    };
  },
};
