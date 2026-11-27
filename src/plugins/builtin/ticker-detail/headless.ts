import { formatDay } from "../../../utils/day-format";
import {
  FINANCIAL_VINTAGE_NOTICE, fillDate, filledPeriodPublications, filledPeriodsNote, reportsHalfYearly, stalePeriodNote,
  statementHistoryNotes,
} from "../../../utils/financial-statements";
import { hasEarlierGfRevenue } from "../../../time-series/fundamentals/history-link";
import { canonicalExchange, isUsEquityExchange } from "../../../utils/exchanges";
import { hasValidQuoteObservationTime } from "../../../market-data/quotes/freshness";
import { quotesSourceName } from "../../../market-data/quotes/export-identity";
import { quoteMonitorColumns, quoteMonitorRow, QUOTE_MONITOR_BASE_COLUMNS, QUOTE_MONITOR_ROW_KEYS } from "./quote-monitor/rows";
import type {
  HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessPaneOptionValues, HeadlessRowsResult,
} from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { MISSING_VALUE, formatNumber } from "../../../utils/format";
import { formatPriceObservation, penceFigure, quoteFormatOptions } from "../../../market-data/market/format";
import {
  MISSING_VOLUME_TEXT, missingVolumeCount, missingVolumeNotice, pricePointOpenWithheld, withoutPriceOnlyVolume, pricePointWickFlags, priceHistoryIntegrityNotice,
  priceHistoryOpenNotice, priceHistoryRescaleNotice, priceHistoryWickNotice,
} from "../../../utils/price-history-integrity";
import { indexBarVolume } from "../../../market-data/market/index-level";
import {
  buildFinancialTableModel, financialColumnLabel, financialColumnPeriod, financialGrowthNotice, financialPeriodFiling, financialStatementCurrency, financialStatementDateNotice, financialStatementLimitations,
  financialReportHeader, financialStatementPeriods, financialSubTabFields, formatFinancialAmount, isPerShareFinancialRow, notInYetNote, receiptShareCountLabel, trailingNotInYetNote,
} from "./financials/model";
import { FINANCIAL_SUB_TABS } from "./financials/schema";
import { fiscalYearEndMonth } from "../../../utils/fiscal-period";
import { adrRatioText } from "../../../utils/depositary-receipt";
import { paneSchemas } from "./headless-schema";
import { loadPeriodEndHistory } from "./financials/period-end-history";
import { createValuationCurrencyContext, loadValuationFx } from "../../../time-series/valuation-currency";
import { loadExchangeResultsNotes } from "./financials/exchange-results";
import { boardKey, newYorkToday } from "../earnings/board-model";
import { fetchEarningsHistory } from "../earnings/client";
import { fiscalPeriodText, fiscalQuarterOf } from "../earnings/fiscal-quarter";
import { latestBalanceSheetDate, loadOfferingNote, loadRunwayOfferings } from "./financials/offerings";
import { burnsCash, cashRunway, formatRunwayMonths, reportsShortTermTotal, runwayMethod, runwayOfferingNote, type OfferingFiling } from "../../../utils/cash-runway";
import { formatPerShareNumber } from "../../../utils/reported-money";
import { logFailure } from "../../../utils/log-failure";
import { loadStatementCurrency } from "../shared/statement-currency";
import {
  RATIO_GAP_TEXT,
  blankRatioPeriodsNote,
  findRatioTab,
  formatRatioInput,
  formatRatioValue,
  latestRunwayPeriodEnd,
  oldestRatioPeriodEnd,
  ratioGapText,
  ratioPeriodEnd,
  ratioStatements,
  ratioTableForFinancials,
  resolveFinancialSectionKey,
  type RatioAmount,
  type RatioTabDef,
} from "./financials/ratios";
import {
  loadHeadlessContractPriceUnit, loadHeadlessFinancials, loadHeadlessPriceHistory, loadHeadlessSymbols, resolveHeadlessInstrument,
} from "../shared/headless-market-data";
import { barHistoryFreshness, brokerNameOf, REPORTED_DATA } from "../shared/report-freshness";
import {
  BAR_INTERVAL_LABELS, barPriceDecimals, cleanBarPrice, cleanFloat32Price, formatBarPrice, historyAllStart, historyAllStartNote, historyBarFlags,
  historyBarValues, historyExportUnit, historyMissingPeriodsNote, historyPriceDecimals, historyUnit, priceTableIntegrityNotice, quotedPriceDivisor,
} from "../../../cli/history-rows";
import { formatUtcTime } from "../../../utils/utc-time";
import { closeMoves } from "../../../utils/max-drawdown";
import { isYieldIndexSymbol } from "../../../tickers/index-roots";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { isPastPriceWindow, loadPriceWindowHistory, priceWindowInterval, priceWindowText, readPriceWindow, type PriceWindow } from "../../../utils/price-window";
import { historyCoverageNotice } from "../../../sources/history-coverage";
import { getChartResolutionLabel, isIntradayResolution, RANGE_HISTORY_RESOLUTION, type ManualChartResolution } from "../../../time-series/resolution";
import { DAY_SO_FAR_TEXT, requestedSessionBarSize, withSessionBar } from "../../../time-series/session-bar";
import { buildReturnRows, closedMarketNote, defaultReturnInterval, isTodayReturnRow, returnBaseCloseDay, type ReturnRange } from "./data-panes/returns-model";
import { barCloseSession } from "../../../market-data/market/bar-period";
import { periodBaseText } from "../../../market-data/market/period-return";
import { loadReturnSeries } from "./data-panes/returns-history";
import { CLOSING_PRINT_PENDING_TEXT } from "../../../time-series/official-close";
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

/**
 * What a listing's bars are priced in, as `history` exports it in `currency_or_unit` (`GBP`, `JPY per USD`, `index
 * points`): by its quote, else by the listing facts research reads, as `history` falls back to them. Null when neither says.
 */
async function barPriceUnit(
  ctx: Pick<HeadlessContext, "marketData" | "apiClient">,
  key: string,
  listing: string,
  exchange: string | undefined,
  quote: { currency?: string; instrumentType?: string } | null,
): Promise<string | null> {
  const listed = quote?.currency ? quote
    : await ctx.marketData.getQuoteMetadata?.(listing, exchange ?? "").catch(logFailure("ticker-detail.headless", "Read listing facts for a bar unit failed", null));
  const facts = listed ?? quote;
  return historyExportUnit(historyUnit(key, facts, await loadHeadlessContractPriceUnit(ctx, listing, facts?.instrumentType)));
}

/** The currency a bar unit is in, for a price header: GBP, or JPY for a pair's `JPY per USD`; none for points or a contract's unit. */
function headerCurrency(unit: string | null): string | null {
  if (!unit) return null;
  if (/^[A-Z]{3}$/.test(unit)) return unit;
  return /^([A-Z]{3}) per [A-Z]{3}$/.exec(unit)?.[1] ?? null;
}

/** Bars of a window that closed before today: the history asked for, which no later bar makes stale. */
function pastWindowFreshness(window: PriceWindow, size: HistoryBarSize, observedKey: string): HeadlessPaneFreshness {
  return { status: "not-a-feed", basis: `${historyBarSizeWord(size)} bars, ${priceWindowText(window)}`, observedKey, oldest: null };
}

export const financialStatementsHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["financial-analysis-pane"],
  shape: "rows",
  // Dated by the latest reported period (each row's `periodEnd`); earlier periods are the statement's history.
  freshness: { ...REPORTED_DATA, basis: "financial statements", observedKey: "periodEnd", oldest: null, retrievedToo: true },
  description: "Annual or quarterly financial statement rows for one ticker, or several in one long table: the income statement, balance sheet, cash flow, or a ratio table.",
  describe: ({ symbols, options }) => `Financial Statements | ${symbols.join(", ")} | ${options.period} | ${options.statement}`,
  async load({ symbols, options }, ctx) {
    if (financialReportLayout(symbols, options) === "long") return loadLongFinancialReport(symbols, options, ctx);
    return loadFinancialReport(symbols[0]!, options, ctx);
  },
};

/**
 * Wide, one column per period, for one ticker; long, a row per ticker, period and metric, for several or when
 * `--layout long` asks for it. Several tickers have no shared columns, so they are never laid out wide.
 */
function financialReportLayout(symbols: readonly string[], options: HeadlessPaneOptionValues): "wide" | "long" {
  if (options.layout === "wide" && (symbols.length > 1 || options.currency)) {
    throw new Error("--layout wide shows one ticker in its reporting currency. Leave --layout out for converted figures or multiple tickers.");
  }
  return options.layout === "long" || symbols.length > 1 || options.currency ? "long" : "wide";
}

/** How a figure of an FA row reads: the kind of number it is, which names its unit and draws it. */
type FigureFormat = "money" | "count" | "perShare" | "percent" | "multiple" | "days" | "months";

const DIVISOR_WORDS: Record<number, string> = { 1e3: "k", 1e6: "mn", 1e9: "bn", 1e12: "tn" };

/** The unit a figure of this kind is in, as exports name it in `currency_or_unit`: `USD bn`, `%`, `USD per share`, `bn shares`. */
function figureUnit(format: FigureFormat, currency: string | null, divisor: number, shares = "shares"): string {
  const scale = DIVISOR_WORDS[divisor] ?? "";
  switch (format) {
    case "money": return [currency, scale].filter(Boolean).join(" ");
    case "count": return [scale, shares].filter(Boolean).join(" ");
    case "perShare": return currency ? `${currency} per ${shares === "shares" ? "share" : "ADR"}` : "per share";
    case "percent": return "%";
    case "multiple": return "x";
    case "days": return "days";
    case "months": return "months";
  }
}

/** A figure as FA's table draws it, from the row's kind and unit: what the text prints and an export reads the scale of. */
function drawFigure(format: FigureFormat, value: number, divisor: number, ratio = false): string {
  if (format === "percent") return ratio ? formatRatioValue("percent", value) : `${formatNumber(value * 100, 1)}%`;
  if (format === "perShare") return formatPerShareNumber(value);
  if (format === "money" || format === "count") return ratio ? formatRatioInput("money", value, divisor) : formatFinancialAmount(value, divisor);
  return format === "days" && !ratio ? formatNumber(value, 1) : formatRatioValue(format, value);
}

/** A statement row's kind of figure. */
function statementFigure(row: { format: "compact" | "eps" | "percent"; moneyUnit: string | null }): FigureFormat {
  return row.format === "percent" ? "percent" : row.format === "eps" ? "perShare" : row.moneyUnit == null ? "count" : "money";
}

/**
 * A period column of a wide FA table: the cell as the table drew it, its growth beside it in text. The figure is
 * drawn from the value it is handed, so an export reads its scale, and a reason drawn in place of a missing one
 * (`needs prior period`, `N/M`) goes to the `status` column rather than into a column of numbers.
 */
function financialPeriodColumn(date: string, header: string, index: number, withGrowth: boolean): HeadlessPaneColumn {
  type Cell = { formatted: string; growthFormatted?: string };
  const cellOf = (row: Record<string, unknown>) => (row.cells as Cell[] | undefined)?.[index];
  const draw = (value: unknown, row: Record<string, unknown>) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return cellOf(row)?.formatted ?? MISSING_VALUE;
    const format = row.figure as FigureFormat | undefined;
    return format ? drawFigure(format, value, Number(row.divisor) || 1, row.kind === "ratio" || row.kind === "input") : value.toFixed(2);
  };
  return {
    key: date, header, align: "right",
    // Exports write the amount alone, every digit; its growth (or N/M) is in the JSON and on the text table.
    format: draw,
    ...withGrowth ? {
      textFormat: (value: unknown, row: Record<string, unknown>) => [draw(value, row), cellOf(row)?.growthFormatted].filter(Boolean).join(" "),
    } : {},
  };
}

/** The newest period end of a table's columns, which dates every row of it. */
function newestPeriodEnd(columns: ReadonlyArray<{ periodEnd: string }>): string | null {
  return columns.map(({ periodEnd }) => periodEnd).filter(Boolean).sort().at(-1) ?? null;
}

/** A figure of the long layout as the text prints it: the number in the row's unit, which the Unit column names. */
function drawLongFigure(format: FigureFormat, value: number, divisor: number): string {
  switch (format) {
    case "percent": return formatNumber(value * 100, 1);
    case "money": case "count": return formatFinancialAmount(value, divisor);
    case "perShare": return formatPerShareNumber(value);
    case "multiple": return formatNumber(value, Math.abs(value) < 10 ? 2 : 1);
    case "days": return formatNumber(value, 1);
    case "months": return formatRunwayMonths(value, "");
  }
}

/** The figure in its long-layout unit: a percent as percent, money and share counts in their unit, the rest as they are. */
function longFigureValue(format: FigureFormat, value: number, divisor: number): number {
  return format === "percent" ? value * 100 : format === "money" || format === "count" ? value / divisor : value;
}

const mostCommon = (values: readonly number[]): number | undefined => {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0];
};

/**
 * Text columns of the long layout. The export keeps Ticker to Value: each row's unit is its `currency_or_unit`,
 * its period end its `as_of`, and a reason a figure is missing its `status`.
 */
const LONG_FINANCIAL_COLUMNS: HeadlessPaneColumn[] = [
  { key: "ticker", header: "Ticker" },
  { key: "period", header: "Period" },
  { key: "periodEnd", header: "Period End" },
  { key: "metric", header: "Metric" },
  { key: "value", header: "Value", align: "right", unitKey: "unit",
    format: (value, row) => typeof value === "number" && Number.isFinite(value) ? String(row.formatted) : String(row.gap ?? MISSING_VALUE) },
];

/**
 * FA for several tickers, or one with `--layout long`: a row per ticker, fiscal period and metric (Ticker, Period,
 * Period End, Metric, Value, Unit), each ticker's table as `fn FA <ticker>` reads it. Money is in the one unit most
 * of the tables' money rows take, so a figure pasted beside another ticker's needs no conversion; a ratio's input
 * that several ratios share (Net Income under ROE, ROA and Net Margin) is one row.
 */
async function loadLongFinancialReport(symbols: string[], options: HeadlessPaneOptionValues, ctx: HeadlessPaneContext): Promise<HeadlessRowsResult> {
  const loaded = await loadHeadlessSymbols(symbols, ctx, (symbol) => loadFinancialReport(symbol, options, ctx));
  type WideRow = { kind: string; label: string; figure: FigureFormat; divisor: number;
    cells: Array<{ value: number | null; formatted: string; gap?: string | null }> };
  type WideColumn = { period: string; periodEnd: string; currency: string | null };
  const tables = loaded.entries.map(({ symbol, data }) => ({
    symbol, data, rows: data.rows as unknown as WideRow[], columns: (data.metadata?.columns ?? []) as WideColumn[],
  }));
  const divisor = mostCommon(tables.flatMap(({ rows }) => rows.filter((row) => row.figure === "money").map((row) => row.divisor))) ?? 1;
  const target = typeof options.currency === "string" ? options.currency : null;
  const fx = target ? await loadStatementCurrency(target, tables.flatMap(({ columns }) => columns.flatMap(({ currency }) => currency ? [currency] : [])), ctx) : null;
  const rows = tables.flatMap(({ symbol, rows: wide, columns }) => {
    const said = new Set<string>();
    return wide.flatMap((row) => {
      // An input is named without the operator that joins it to its ratio, and once.
      const metric = row.kind === "input" ? row.label.replace(/^[÷+−-]\s*/, "") : row.label;
      if (said.has(metric)) return [];
      said.add(metric);
      const rowDivisor = row.figure === "money" ? divisor : row.divisor;
      return columns.map((column, index) => {
        const cell = row.cells[index];
        const native = typeof cell?.value === "number" && Number.isFinite(cell.value) ? cell.value : null;
        const monetary = row.figure === "money" || row.figure === "perShare";
        const rate = fx && monetary ? fx.rates.get(column.currency ?? "") : 1;
        const value = native != null && rate != null ? native * rate : null;
        const nativeUnit = figureUnit(row.figure, column.currency, rowDivisor);
        return {
          ticker: symbol, period: column.period, periodEnd: column.periodEnd, metric,
          value: value == null ? null : longFigureValue(row.figure, value, rowDivisor),
          unit: figureUnit(row.figure, monetary && target ? target : column.currency, rowDivisor),
          formatted: value == null ? null : drawLongFigure(row.figure, value, rowDivisor),
          gap: native != null && rate == null ? "No FX rate" : value == null ? cell?.gap ?? (cell?.formatted && cell.formatted !== MISSING_VALUE ? cell.formatted : null) : null,
          ...(fx && monetary && native != null ? { nativeValue: longFigureValue(row.figure, native, rowDivisor), nativeUnit,
            nativeFormatted: `${drawLongFigure(row.figure, native, rowDivisor)} ${nativeUnit}` } : {}),
        };
      });
    });
  });
  // A note every table makes is said once; one only some make names the ticker. The headers' date sources are
  // not in this layout's columns, so neither is what they mean.
  const kept = (note: string) => note !== SEC_DATE_NOTE && note !== PROVIDER_DATE_NOTE;
  for (const table of tables) table.data = { ...table.data, notes: (table.data.notes ?? []).filter(kept) };
  const notes = tables.flatMap(({ data }) => data.notes ?? []);
  const shared = (note: string) => tables.every(({ data }) => (data.notes ?? []).includes(note));
  const ownNotes = tables.flatMap(({ symbol, data }) => (data.notes ?? []).filter((note) => !shared(note)).map((note) => `${symbol}: ${note}`));
  const empty = tables.filter(({ rows: wide }) => wide.length === 0);
  const first = tables[0]?.data.metadata ?? {};
  const nativeColumn: HeadlessPaneColumn = { key: "nativeValue", header: "Native", align: "right", unitKey: "nativeUnit",
    format: (_value, row) => String(row.nativeFormatted ?? "") };
  return {
    rows,
    columns: fx ? [...LONG_FINANCIAL_COLUMNS, nativeColumn] : LONG_FINANCIAL_COLUMNS,
    textColumns: [...LONG_FINANCIAL_COLUMNS, { key: "unit", header: "Unit" }, ...(fx ? [nativeColumn] : [])],
    rowUnitKey: "unit", rowSymbolKey: "ticker", rowAsOfKey: "periodEnd",
    interval: options.period === "quarterly" ? "quarterly" : "annual",
    unavailableSymbols: [...loaded.unavailableSymbols, ...empty.flatMap(({ data }) => data.unavailableSymbols ?? [])],
    errors: [...loaded.errors, ...tables.flatMap(({ symbol, data }) => (data.errors ?? []).map((error) => error.startsWith(symbol) ? error : `${symbol}: ${error}`))],
    notes: [...new Set([...notes.filter(shared), ...ownNotes, ...(fx?.note ? [fx.note] : []), ...fx?.failures ?? []])],
    metadata: {
      symbols, layout: "long", statement: first.statement ?? options.statement, statementLabel: first.statementLabel ?? null,
      period: options.period === "quarterly" ? "quarterly" : "annual",
      ...(fx ? { currency: target, conversions: fx.conversions } : {}),
      notices: [...new Set(tables.flatMap(({ data }) => (data.metadata?.notices ?? []) as string[]))],
      limitations: [...new Set(tables.flatMap(({ data }) => (data.metadata?.limitations ?? []) as string[]))],
    },
  };
}

/** One ticker's statement or ratio table, its periods as columns. */
async function loadFinancialReport(symbol: string, options: HeadlessPaneOptionValues, ctx: HeadlessPaneContext): Promise<HeadlessRowsResult> {
  {
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
    const ratio = adrRatioText(financials.fundamentals?.adrRatio ?? financials.quote?.adrRatio,
      (financials.fundamentals?.depositaryPair ?? financials.quote?.depositaryPair)?.ordinary[0]);
    const shareBasisNotice = receiptPeriods.length === 0 || !table?.rows.some(isPerShareFinancialRow) ? null
      : allReceipts
        ? `Share counts are in ADRs and EPS is per ADR${ratio ? `; ${ratio}` : ""}.`
        : `Share counts are in ADRs and EPS is per ADR for ${receiptPeriods.join(", ")}${ratio ? ` (${ratio})` : ""}; other periods as reported.`;
    const yearEndMonth = fiscalYearEndMonth(financials.annualStatements);
    // The list a column comes from: a comparative column is dated by the row a year on in it.
    const listRows = requestedPeriod === "quarterly" ? financials.quarterlyStatements : financials.annualStatements;
    const annualDates = new Set(financials.annualStatements.map(({ date }) => date));
    const dates = table?.statements.map((statement) => {
      const { date, currency, dateSource, providerDate, dateEvidence, availableAt, fieldAvailability, fieldSources, unavailableFields, epsBasis, unavailableEarnings, aggregation, shareBasis, filledFrom } = statement;
      const filled = date === "TTM" || filledFrom?.source !== "results" ? null : fillDate(statement, listRows);
      const issuerFiling = financialPeriodFiling(financials.periodFilings, statement, financialColumnPeriod(statement, requestedPeriod, annualDates));
      return {
      date, currency: currency ?? statementCurrency ?? null,
      shareBasis: shareBasis ?? null,
      availableAt: availableAt ?? null,
      fieldAvailability: fieldAvailability ? { ...fieldAvailability } : null,
      ...(fieldSources ? { fieldSources } : {}),
      ...(filledFrom ? { filledFrom } : {}),
      ...(issuerFiling ? { issuerFiling } : {}),
      // The day the company's results announcement published the period's filled lines, or, for a later
      // period's comparative column, that period's first announcement.
      ...(filled?.label === "published" && filled.date ? { announced: filled.date } : {}),
      ...(filled?.label === "catalogue" && filled.date ? { catalogued: filled.date } : {}),
      ...(filled?.label === "first observed" && filled.date ? { firstObserved: filled.date } : {}),
      ...(filled?.label === "comparative" ? { comparativeIn: filled.date } : {}),
      ...(unavailableFields ? { unavailableFields } : {}),
      ...(epsBasis ? { epsBasis } : {}),
      ...(unavailableEarnings ? { unavailableEarnings } : {}),
      ...(aggregation ? { aggregation } : {}),
      dateSource: date === "TTM" ? "derived" : dateSource ?? "provider",
      providerDate: date === "TTM" ? null : providerDate ?? null,
      dateEvidence: date === "TTM" || dateSource !== "sec" ? null : dateEvidence ?? null,
      // The fiscal period as the pane names it, and the day it ends, which the long layout and exports date it by.
      period: financialColumnLabel(statement, requestedPeriod, yearEndMonth),
      periodEnd: ratioPeriodEnd(statement),
      // Rows in the table's one money unit do not name it, so the header does.
      label: financialReportHeader(statement, [currency ?? statementCurrency, table.unit].filter(Boolean).join(" ") || undefined, requestedPeriod, yearEndMonth, listRows),
      };
    }) ?? [];
    const asOf = newestPeriodEnd(dates);
    const rows = table?.rows.map((row) => {
      const figure = statementFigure(row);
      return {
        id: row.id, kind: row.kind, metric: allReceipts ? receiptShareCountLabel(row) : row.unitLabel, label: row.label,
        // What the figures are in, which exports name in `currency_or_unit`, and the newest period they run to.
        figure, divisor: row.divisor, unit: figureUnit(figure, statementCurrency ?? null, row.divisor, allReceipts ? "ADRs" : "shares"), periodEnd: asOf,
        cells: row.cells.map((cell, index) => ({
          date: dates[index]?.date ?? "", value: cell.value ?? null,
          growth: cell.growth ?? null, formatted: cell.valueText.trim(), growthFormatted: cell.growthText.trim(),
        })),
        ...Object.fromEntries(row.cells.map((cell, index) => [dates[index]!.date, cell.value ?? null])),
      };
    }) ?? [];
    const columns: HeadlessPaneColumn[] = [
      { key: "metric", header: "Metric" },
      ...dates.map(({ date, label }, index) => financialPeriodColumn(date, label, index, true)),
    ];
    // The balance sheet's cash, when an offering since is not in it yet.
    const offering = table?.subTab.key === "balance" ? await reportOfferingNote(ctx, symbol, latestBalanceSheetDate(financials)) : null;
    // A newest period with only some figures (an EPS alone) is left out, as in the pane, and a line says so.
    const notInYet = table ? notInYetNote(table.notInYet, table.subTab, requestedPeriod, yearEndMonth)
      ?? trailingNotInYetNote(table.statements, table.trailingNotInYet, table.subTab, yearEndMonth) : null;
    // A latest period over 15 months old says how old it is; an HKEX company's, the announcement its results came in.
    const stale = table ? stalePeriodNote(financialStatementPeriods(table.statements, table.subTab)) : null;
    // Years filled from the listing's exchange, with the lines this table shows; an announcement that dates one is not
    // said again in the results line.
    const shownFields = table ? financialSubTabFields(table.subTab) : undefined;
    const filled = table ? filledPeriodsNote(table.statements, shownFields) : null;
    const periodDates = dates.map(({ date }) => date);
    const [announced, newerRelease] = await Promise.all([
      table ? reportExchangeResults(ctx, symbol, financials, filledPeriodPublications(table.statements, shownFields)) : [],
      requestedPeriod === "quarterly" ? newerQuarterRelease(ctx, symbol, financials, periodDates[0]) : null,
    ]);
    const missing = rows.length ? null : await missingPeriodsError(ctx, symbol, financials, requestedPeriod, hasRequestedStatements, options.statement);
    return {
      rows, columns, unavailableSymbols: rows.length ? [] : [symbol],
      ...(missing ? { errors: [missing] } : {}),
      // Each exported row names its unit, the statements' period and the newest period end it runs to.
      rowUnitKey: "unit", rowAsOfKey: "periodEnd", interval: requestedPeriod,
      // The report closes with how old its latest period is, how far back its periods go, and how to read further.
      notes: [...notInYet ? [notInYet] : [], ...newerRelease ? [newerRelease] : [], ...announced, ...stale ? [stale] : [], ...filled ? [filled] : [], ...offering ? [offering] : [],
        ...statementHistoryNotes(requestedPeriod, periodDates, symbol, await reportOlderStatements(ctx, symbol, requestedPeriod, periodDates)),
        ...table?.subTab.key === "cashflow" ? [CASH_FLOW_NOTE] : [], ...dateSourceNotes(dates)],
      metadata: {
        symbol, name: financials.quote?.name ?? symbol, currency: statementCurrency ?? null, unit: table?.unit ?? null, quoteCurrency: financials.quote?.currency ?? null,
        statement: table?.subTab.key ?? options.statement, statementLabel: table?.subTab.name ?? null,
        period: requestedPeriod, growthBasis: requestedPeriod === "quarterly" ? "QoQ" : "YoY", columns: dates,
        shareBasis: shareBases.size === 1 ? [...shareBases][0] ?? null : null,
        ...(receiptPeriods.length > 0 ? { adrRatio: financials.fundamentals?.adrRatio ?? financials.quote?.adrRatio ?? null } : {}),
        notices: rows.length ? [FINANCIAL_VINTAGE_NOTICE, financialGrowthNotice(requestedPeriod, table?.statements ?? []),
          ...(shareBasisNotice ? [shareBasisNotice] : [])] : [],
        limitations: financialStatementLimitations(financials),
        dateProvenance: financialStatementDateNotice(table?.statements ?? []),
      },
    };
  }
}

const reportAmount = (amount: RatioAmount) => (typeof amount === "number" ? amount : null);

/** What the profitability tab's figures are, said under it, as docs/financial-ratios.md defines them. */
const PROFITABILITY_NOTES = [
  "ROIC is NOPAT / average (equity + total debt), cash not netted; ROIC ex Cash takes cash and short-term investments out of that capital.",
  "NOPAT is operating income x (1 - tax provision / pretax income), the rate held between 0% and 100%; a pretax loss pays no tax.",
  "Margins and NOPAT are GAAP, as the income statement reports them, not the company's adjusted (non-GAAP) figures.",
];

const NEEDS_OPENING_NOTE = "needs prior period: an average of the opening and closing balance has no opening balance sheet on file, the period before the column's (the prior year end for a year, the prior quarter end for a quarter, the quarter a year earlier for TTM), as for the oldest column or a year whose prior year is missing.";

/** What the cash flow table works out of its own lines. */
const CASH_FLOW_NOTE = "CapEx / Revenue is capex over revenue; Reinvestment Rate is capex plus acquisitions less D&A, over NOPAT.";

const SEC_DATE_NOTE = "SEC date: the period end the company's 10-K or 10-Q states.";
const PROVIDER_DATE_NOTE = "provider date: the period end as the statements source dates it, which can be a few days off the company's own.";

/** What a column header's `(SEC date)` and `(provider date)` mean, for the ones the table has. */
function dateSourceNotes(columns: ReadonlyArray<{ dateSource: string }>): string[] {
  return [
    ...columns.some(({ dateSource }) => dateSource === "sec") ? [SEC_DATE_NOTE] : [],
    ...columns.some(({ dateSource }) => dateSource === "provider") ? [PROVIDER_DATE_NOTE] : [],
  ];
}

type HeadlessContext = Parameters<typeof financialStatementsHeadless.load>[1];

async function newerQuarterRelease(ctx: HeadlessContext, symbol: string, financials: Awaited<ReturnType<typeof loadHeadlessFinancials>>, filedEnd: string | undefined): Promise<string | null> {
  const exchange = parsePublicTickerKey(symbol).exchange ?? financials.quote?.listingExchangeName;
  if (!filedEnd || !isUsEquityExchange(exchange ?? undefined)) return null;
  const history = await fetchEarningsHistory(boardKey(symbol), ctx.apiClient, 4)
    .catch(logFailure("fa", "Earnings release lookup failed", null));
  if (!history) return null;
  const today = newYorkToday();
  const report = history.reports.filter((entry) => entry.date <= today && entry.dateStatus === "reported"
    && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(entry.fiscalPeriod ?? "") && entry.fiscalPeriod! > filedEnd.slice(0, 7)
    && (entry.revenueActualSource === "press-release" || entry.epsActualSource === "press-release"))
    .sort((left, right) => right.fiscalPeriod!.localeCompare(left.fiscalPeriod!) || right.date.localeCompare(left.date))[0];
  if (!report) return null;
  const quarter = report.fiscalYear && report.fiscalQuarter
    ? { fiscalYear: report.fiscalYear, fiscalQuarter: report.fiscalQuarter } : fiscalQuarterOf(report.fiscalPeriod, history.fiscalAnchor);
  return `Newer results for ${fiscalPeriodText(report.fiscalPeriod, quarter)} were reported on ${report.date} in the company's earnings release. See ERN ${symbol} for the release figures until FA reflects the filing.`;
}

/** Whether GF, reading the listing's extended statement history, goes back further than the report (statementHistoryNotes). */
function reportOlderStatements(ctx: HeadlessContext, symbol: string, period: "annual" | "quarterly", dates: readonly string[]) {
  return hasEarlierGfRevenue(async () => {
    const { symbol: bare, exchange } = await resolveHeadlessInstrument(ctx, symbol);
    return ctx.marketData.getTickerFinancials(bare, exchange ?? "", { statementHistory: "extended" });
  }, period, dates);
}

/**
 * Why a statements report has no rows, and what to read instead: a listing
 * with years but no quarters names its years, and says so of a company that
 * reports half-yearly (Qantas on ASX); one with quarters but no full year
 * reported (O8A:FWB2) names its quarters. Null when it has years and
 * quarters, whatever this table lacks.
 */
async function missingPeriodsError(
  ctx: HeadlessContext,
  symbol: string,
  financials: Awaited<ReturnType<typeof loadHeadlessFinancials>>,
  period: "annual" | "quarterly",
  hasRequestedStatements: boolean,
  statement: unknown,
): Promise<string | null> {
  const hasYears = financials.annualStatements.length > 0;
  const tab = typeof statement === "string" && statement && statement !== "income" ? ` --statement ${statement}` : "";
  if (period === "annual" && !hasRequestedStatements && financials.quarterlyStatements.length > 0) {
    return `${symbol}: No annual financial statement coverage. For its quarters: gloom fn FA ${symbol} --period quarterly${tab}`;
  }
  if (period === "annual" || !hasYears) return hasRequestedStatements ? null : `${symbol}: No ${period} financial statement coverage.`;
  const exchange = await resolveHeadlessInstrument(ctx, symbol).then(({ exchange }) => canonicalExchange(exchange ?? ""))
    .catch(logFailure("ticker-detail.headless", "Resolving the listing of a statements report failed", ""));
  const halfYearly = reportsHalfYearly(exchange, financials.quarterlyStatements, financials.annualStatements);
  if (hasRequestedStatements && !halfYearly) return null;
  const years = `For its years: gloom fn FA ${symbol} --period annual${tab}`;
  return halfYearly ? `${symbol} reports half-yearly, not quarterly. ${years}` : `${symbol}: No quarterly financial statement coverage. ${years}`;
}

/** The note that an offering filed after the latest balance sheet is not in its cash yet; a failed read leaves it out. */
async function reportOfferingNote(
  ctx: Parameters<typeof financialStatementsHeadless.load>[1],
  symbol: string,
  periodEnd: string | null,
): Promise<string | null> {
  if (!periodEnd) return null;
  return resolveHeadlessInstrument(ctx, symbol)
    .then((listing) => loadOfferingNote(ctx.apiClient, listing, periodEnd, ctx.signal))
    .catch(logFailure("ticker-detail.headless", "Reading the offering filings failed", null));
}

/** An HKEX company's latest period and its results announcement (exchangeResultsNotes); a failed read leaves them out. */
async function reportExchangeResults(
  ctx: Parameters<typeof financialStatementsHeadless.load>[1],
  symbol: string,
  financials: Awaited<ReturnType<typeof loadHeadlessFinancials>>,
  dated: ReturnType<typeof filledPeriodPublications>,
): Promise<string[]> {
  return resolveHeadlessInstrument(ctx, symbol)
    .then((listing) => loadExchangeResultsNotes(ctx.apiClient, listing, latestBalanceSheetDate(financials), dated))
    .catch(logFailure("ticker-detail.headless", "Reading the HKEXnews results announcements failed", [] as string[]));
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
  const statements = hasRequestedStatements && tab.key === "valuation" ? ratioStatements(financials, period) : [];
  const oldest = oldestRatioPeriodEnd(statements);
  const [history, fx] = oldest ? await Promise.all([
    resolveHeadlessInstrument(ctx, symbol)
      .then(({ symbol: bare, exchange }) => loadPeriodEndHistory(ctx.marketData, bare, exchange ?? "", oldest))
      .catch(logFailure("ticker-detail.headless", "Load valuation price history failed", null)),
    loadValuationFx(createValuationCurrencyContext(financials).fxCurrencies(statements), oldest, ctx.apiClient),
  ]) : [null, undefined] as const;
  const currencies = createValuationCurrencyContext(financials, fx);
  const currencyNotes = tab.key === "valuation" ? [currencies.conversionNote(statements, ratioPeriodEnd), currencies.warning(statements, ratioPeriodEnd)] : [];
  const runway = tab.key === "liquidity" && hasRequestedStatements ? cashRunway(financials) : null;
  const periodEnd = burnsCash(runway) ? runway.periodEnd : null;
  const filings = periodEnd ? await resolveHeadlessInstrument(ctx, symbol)
    .then((listing) => loadRunwayOfferings(ctx.apiClient, listing, periodEnd, ctx.signal))
    .catch(logFailure("ticker-detail.headless", "Reading the offering filings failed", [] as OfferingFiling[])) : [];
  const table = hasRequestedStatements ? ratioTableForFinancials(financials, tab, period, history,
    periodEnd ? { periodEnd, filings } : undefined, currencies) : null;
  const statementCurrency = financialStatementCurrency(financials, [
    ...financials.annualStatements, ...financials.quarterlyStatements,
  ]);
  const yearEndMonth = fiscalYearEndMonth(financials.annualStatements);
  const dates = table?.periods.map(({ statement }) => ({
    date: statement.date,
    // The fiscal period as the pane names it, and the day it ends.
    period: financialColumnLabel(statement, period, yearEndMonth),
    periodEnd: ratioPeriodEnd(statement),
    currency: statement.currency ?? statementCurrency ?? null,
    dateSource: statement.date === "TTM" ? "derived" : statement.dateSource ?? "provider",
    label: financialReportHeader(statement, statement.currency ?? statementCurrency, period, yearEndMonth,
      period === "quarterly" ? financials.quarterlyStatements : financials.annualStatements),
  })) ?? [];
  const asOf = newestPeriodEnd(dates);
  const rows = table?.rows.map((row) => {
    const cells = table.cells.get(row.def.id)!.map((cell, index) => {
      const amount = row.kind === "ratio" ? cell.value : cell.inputs[row.index]!;
      return {
        date: dates[index]!.date,
        value: reportAmount(amount),
        gap: typeof amount === "number" ? null : ratioGapText(amount, row.def.format),
        formatted: row.kind === "ratio"
          ? formatRatioValue(row.def.format, amount)
          : formatRatioInput(row.def.inputs[row.index]!.format, amount, row.divisor, row.def.format),
      };
    });
    const figure: FigureFormat = row.kind === "ratio" ? row.def.format : row.def.inputs[row.index]!.format;
    const divisor = row.kind === "ratio" ? 1 : row.divisor;
    return {
      id: row.id, kind: row.kind, metric: row.kind === "ratio" ? row.label : row.unitLabel,
      label: row.kind === "ratio" ? row.label : row.unitLabel.replace(/ \([a-z]+\)$/, ""),
      // What the figures are in, which exports name in `currency_or_unit`, and the newest period they run to.
      figure, divisor, unit: figureUnit(figure, statementCurrency ?? null, divisor), periodEnd: asOf,
      cells,
      ...Object.fromEntries(cells.map((cell) => [cell.date, cell.value])),
    };
  }) ?? [];
  const columns: HeadlessPaneColumn[] = [
    { key: "metric", header: "Ratio" },
    ...dates.map(({ date, label }, index) => financialPeriodColumn(date, label, index, false)),
  ];
  // An average with no opening balance sheet on file (the oldest column, a year after a missing one, TTM) says what it needs.
  const needsOpening = rows.some((row) => row.cells.some((cell) => cell.gap === RATIO_GAP_TEXT["no-opening"]));
  // Liquidity's runway says how it counts months, and that the cash predates an offering since.
  const liquidity = tab.key === "liquidity" && table;
  const runwayPeriodEnd = liquidity ? latestRunwayPeriodEnd(table) : null;
  const offering = periodEnd ? runwayOfferingNote(filings, periodEnd, runway?.currency)
    : !runway && runwayPeriodEnd ? await reportOfferingNote(ctx, symbol, runwayPeriodEnd) : null;
  const periodDates = dates.map(({ date }) => date);
  const missing = rows.length ? null : await missingPeriodsError(ctx, symbol, financials, period, hasRequestedStatements, tab.key);
  return {
    rows, columns, unavailableSymbols: rows.length ? [] : [symbol],
    ...(missing ? { errors: [missing] } : {}),
    ...(tab.key === "valuation" && hasRequestedStatements && !history?.length ? { complete: false } : {}),
    // Each exported row names its unit, the statements' period and the newest period end it runs to.
    rowUnitKey: "unit", rowAsOfKey: "periodEnd", interval: period,
    notes: [
      ...[table ? notInYetNote(table.notInYet ?? [], FINANCIAL_SUB_TABS[0]!, period, yearEndMonth)
        ?? trailingNotInYetNote(table.periods.map(({ statement }) => statement), table.trailingNotInYet ?? [], FINANCIAL_SUB_TABS[0]!, yearEndMonth) : null,
        table ? blankRatioPeriodsNote(table, period, yearEndMonth) : null].filter((note): note is string => !!note),
      ...currencyNotes.filter((note): note is string => !!note),
      ...[stalePeriodNote(dates.map(({ periodEnd }) => ({ date: periodEnd, lead: true })))].filter((note): note is string => !!note),
      ...[filledPeriodsNote(table?.periods.map(({ statement }) => statement) ?? [])].filter((note): note is string => !!note),
      ...offering ? [offering] : [],
      ...runwayPeriodEnd ? [runwayMethod(reportsShortTermTotal([...financials.quarterlyStatements, ...financials.annualStatements]))] : [],
      ...statementHistoryNotes(period, periodDates, symbol, await reportOlderStatements(ctx, symbol, period, periodDates)),
      ...tab.key === "profitability" && rows.length ? PROFITABILITY_NOTES : [],
      ...needsOpening ? [NEEDS_OPENING_NOTE] : [],
      ...dateSourceNotes(dates),
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

export const quoteComparisonHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["quote-monitor-pane"],
  shape: "rows",
  description: "Current quotes for one or more tickers: name, the regular session's last price, change and percent change, and any pre-market or after-hours print.",
  describe: ({ symbols }) => `Quote Monitor | ${symbols.join(", ")}`,
  columns: QUOTE_MONITOR_BASE_COLUMNS,
  // A board across markets (Hong Kong beside New York) dates each market's session and says when each opens.
  freshness: { datesEachVenue: true },
  async load({ symbols }, ctx) {
    const loaded = await loadHeadlessSymbols(symbols, ctx, async (key) => {
      const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
      // Each move is printed with the close it is from, so the close is checked against its date first.
      const quote = await ctx.marketData.getQuote(symbol, exchange, { datesChangeBasis: true });
      if (!quote) throw new Error(`Quote is unavailable for ${key}`);
      if (!hasValidQuoteObservationTime(quote)) throw new Error(`Quote observation time is unavailable for ${key}`);
      return quote;
    });
    const now = Date.now();
    const brokerName = brokerNameOf(ctx);
    const rows = loaded.entries.map(({ symbol, data: quote }) => quoteMonitorRow(symbol, quote, now, brokerName));
    const columns = quoteMonitorColumns(rows);
    return {
      rows,
      // The report cites the sources its rows name, never Gloom Cloud for a quote that is not its own.
      ...loaded.entries.length > 0 ? { freshness: { source: quotesSourceName(loaded.entries.map(({ data }) => data), brokerName) || null } } : {},
      // An extended column or Chg bp only when a row has one, so a closed board stays as narrow as before. The text
      // report dates each print beside it, where an export has a column for the time.
      ...(columns.length > QUOTE_MONITOR_BASE_COLUMNS.length ? { columns, textColumns: quoteMonitorColumns(rows, { exported: false }) } : {}),
      // Each exported row names its ticker, its unit, its source and when its own price was observed.
      ...QUOTE_MONITOR_ROW_KEYS,
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
const historyPriceColumns = (volumeMissing: boolean, decimals?: number, pence?: (close: number) => string | null, currency?: string | null): HeadlessPaneColumn[] => ["open", "high", "low", "close", "volume"].map((key) => ({
  key, header: key, align: "right" as const,
  // The text table names the currency over each price (Open GBP), as an export's currency_or_unit does.
  ...currency && key !== "volume" ? { textHeader: `${key.charAt(0).toUpperCase()}${key.slice(1)} ${currency}` } : {},
  format: (value: unknown) => {
    if (value == null || !Number.isFinite(Number(value))) return key === "volume" && volumeMissing ? MISSING_VOLUME_TEXT : MISSING_VALUE;
    if (key === "volume") return formatNumber(Number(value), 0);
    if (decimals == null) return formatPriceObservation(Number(value), { minimumFractionDigits: 2 });
    // A London line's close also reads in pence, as the pane's close notes it: 6.385 638.5p.
    const note = key === "close" ? pence?.(Number(value)) : null;
    return `${formatBarPrice(Number(value), decimals)}${note ? ` ${note}` : ""}`;
  },
}));

/**
 * The columns of HP's rows. A day or longer bar is a date and an intraday one a
 * UTC time. The text table dates a month's bar as the month and marks a bar
 * whose period runs on (`2026-10 MTD`); the export keeps each bar's own date
 * and adds a `Partial` column when one is.
 */
function historyColumns(
  size: HistoryBarSize,
  partial: boolean,
  text: boolean,
  volumeMissing = false,
  decimals?: number,
  pence?: (close: number) => string | null,
  /** A bar is flagged (`high<close`, `low<close/2`): the Flag column says how, as `history`'s does. */
  flagged = false,
  /** The currency the prices are in, which the text table's price headers name. */
  currency?: string | null,
): HeadlessPaneColumn[] {
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
  const flag: HeadlessPaneColumn[] = flagged ? [{ key: "flag", header: "Flag", format: (value) => typeof value === "string" ? value : "" }] : [];
  return [date, ...historyPriceColumns(volumeMissing, decimals, text ? pence : undefined, text ? currency : undefined), ...flag, ...marked];
}

export const historicalPricesHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["historical-prices-pane"],
  shape: "rows",
  currencyPairs: true,
  description: "OHLCV bars (date, open, high, low, close, volume) for one ticker over a range: daily to start, weekly for 5Y and monthly for ALL. The newest bar is marked partial while its day, week or month runs on; a day's bar then comes from the live quote.",
  describe: ({ symbols, options }) => `Historical Prices | ${symbols[0]} | ${reportWindowText(options) ?? options.range ?? HISTORY_DEFAULT_RANGE}`,
  columns: historyColumns("1d", false, false),
  async load({ symbols, options }, ctx) {
    const symbol = symbols[0]!;
    const range = (options.range ?? HISTORY_DEFAULT_RANGE) as TimeRange;
    // --from 2007 --to 2009 reads those dates' bars in place of the range.
    const window = readReportWindow(options);
    const pastWindow = !!window && isPastPriceWindow(window);
    // A range of daily or longer bars reaches into the session now trading, whose bar is the quote's (withSessionBar).
    const { symbol: listing, exchange } = await resolveHeadlessInstrument(ctx, symbol);
    const [loaded, quote] = await Promise.all([
      window ? loadPriceWindowHistory(ctx.marketData, listing, exchange ?? "", window).then((result) => result.points)
        : loadHeadlessPriceHistory(ctx, symbol, range),
      pastWindow || (!window && isIntradayResolution(RANGE_HISTORY_RESOLUTION[range])) ? null
        : ctx.marketData.getQuote(listing, exchange ?? "").catch(logFailure("ticker-detail.headless", "Load historical prices quote failed", null)),
    ]);
    // The venue whose sessions say whether a day, week or month is still running: the key's, or for a bare symbol its quote's.
    const venue = exchange || quote?.listingExchangeName || quote?.exchangeName || undefined;
    const now = Date.now();
    // The bars the range or window asks for: a thin listing's daily bars a week or two apart are still daily.
    const requested = window ? priceWindowInterval(window) : RANGE_HISTORY_RESOLUTION[range];
    const points = withSessionBar(loaded, quote, { now, venue, ...requestedSessionBarSize(loaded, requested) });
    // Providers serve float32 prices (4013.39990234 for 4013.4): the rows hold the decimal each is, as `history` does,
    // a London line's cleaned in the pence it was priced in.
    const priceDivisor = quotedPriceDivisor(quote);
    const clean = (value: number | null) => value == null ? null : cleanBarPrice(value, priceDivisor);
    // A monthly bar whose prices contradict each other keeps its close, flagged, as `history` keeps it.
    const monthly = historyBarSize(points.map((point) => new Date(point.date).getTime()), requested) === "1mo";
    // A price on its own after intraday bars (a closing auction's price) has no volume of its own, never 0.
    const rows = withoutPriceOnlyVolume(points.map((point) => {
      const date = new Date(point.date);
      const values = historyBarValues(point, monthly);
      const flags = historyBarFlags(point);
      return {
        date: Number.isFinite(date.getTime()) ? date.toISOString() : String(point.date),
        open: clean(values.open), high: clean(values.high), low: clean(values.low), close: clean(values.close),
        volume: indexBarVolume(values.volume, quote?.instrumentType),
        ...(flags.length ? { flag: flags.join(",") } : {}),
        ...(values.integrity ? { integrity: values.integrity } : {}),
        ...(point.partial ? { partial: true } : {}),
        // A coin's day Gloom Cloud rebuilt from hourly bars has no volume of its own, as `history` marks it.
        ...(point.filled ? { filled: true } : {}),
      };
    }).sort((left, right) => left.date.localeCompare(right.date)));
    const notice = priceTableIntegrityNotice(rows);
    const size = historyBarSize(rows.map((row) => Date.parse(row.date)), requested);
    // A weekly or monthly bar whose period runs on is dated by how far it runs, as `history` dates it.
    const forming = formingHistoryBar(size, rows.at(-1)?.date, venue, now);
    // A complete one is dated by the day its last session closed, the day its close is from.
    const closedDay = closedHistoryBarDay(size, rows.at(-1)?.date, venue, now);
    // A daily bar of a session still trading is as of its listing's latest quote, never its midnight.
    const quotedAt = size === "1d" && !closedDay && rows.length && quote && Number.isFinite(quote.lastUpdated)
      && quote.lastUpdated >= Date.parse(`${rows.at(-1)!.date.slice(0, 10)}T00:00:00Z`) ? new Date(quote.lastUpdated).toISOString() : null;
    const shown = forming ? [...rows.slice(0, -1), { ...rows.at(-1)!, partial: true }] : rows;
    // One decimal count for the table, by the instrument's display rules when the quote names its kind.
    const decimals = barPriceDecimals(rows, quoteFormatOptions(quote).assetCategory, priceDivisor);
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
      ...(forming ? { periodToDate: forming } : closedDay ? { asOf: closedDay } : quotedAt ? { asOf: quotedAt } : {}),
      ...(dayToDate ? { basis: "daily bars", note: `the newest bar is ${DAY_SO_FAR_TEXT}`, ...(quote ? { asOf: new Date(quote.lastUpdated).toISOString() } : {}) } : {}),
    };
    // The largest fall from a close to a later one in the bars shown, said under the title; a yield's in bp, with its largest rise.
    // A week's or month's close is dated by its last session, not the 1st its bar is dated by.
    const closes = shown.map((row) => ({ date: isDailyOrLongerBar(size) ? barCloseSession(size, row.date, venue, now) : row.date, close: row.close }));
    // A window's last week can close after the dates asked for: the fall is measured to its end.
    const moves = (day: (value: string) => string) => closeMoves(closes, drawdownScaleOf(symbol), { basis: `${historyBarSizeWord(size)} closes`,
      price: (value) => formatBarPrice(value, decimals), date: (value) => isDailyOrLongerBar(size) ? day(value.slice(0, 10)) : formatUtcTime(value) }, window?.to);
    const { drawdown, runUp, lines: moveLines } = moves((day) => day);
    // A wick left out of the range is said, though the bar's close still counts.
    const wickNotice = priceHistoryWickNotice(points.filter((point) => pricePointWickFlags(point).length > 0).length);
    // As are bars the source served in the wrong unit, shown scaled back.
    const openNotice = priceHistoryOpenNotice(points.filter(pricePointOpenWithheld).length);
    const otherNotices = [notice, openNotice, wickNotice, priceHistoryRescaleNotice(points)].filter((line): line is string => line != null);
    const reportNotices = [...moveLines, ...otherNotices];
    // The text writes the drawdown's days first, as the pane does; JSON and CSV keep them in ISO.
    const textReportNotices = [...moves((day) => formatDay(day)).lines, ...otherNotices];
    const flagged = rows.some((row) => row.flag);
    // Every exported bar names what it is priced in and its size, as `history --csv` does.
    const unit = await barPriceUnit(ctx, symbol, listing, exchange, quote);
    const barInterval = size === "intraday" ? isIntradayResolution(requested) ? requested : null : size;
    return {
      rows: shown,
      ...(unit ? { unit } : {}),
      ...(barInterval ? { interval: barInterval } : {}),
      columns: historyColumns(size, marked, false, false, decimals, undefined, flagged),
      textColumns: historyColumns(size, marked, true, volumeMissing > 0, decimals,
        (close) => penceFigure(Number(close.toFixed(Math.min(20, decimals))), quote, decimals), flagged, headerCurrency(unit)),
      freshness,
      ...(notes.length > 0 ? { notes } : {}),
      ...(reportNotices.length ? { textNotices: textReportNotices } : {}),
      ...(notice ? { complete: false } : {}),
      unavailableSymbols: rows.some((row) => row.close !== null) ? [] : [symbol],
      metadata: { symbol, range: window ? null : range, ...(window ? { requestedWindow: window } : {}), ...(size === "intraday" ? {} : { interval: size }),
        ...(allStart ? { sourceStart: allStart } : {}), maxDrawdown: drawdown, ...(runUp ? { maxRunUp: runUp } : {}),
        ...(reportNotices.length ? { notices: reportNotices } : {}) },
    };
  },
};

/** A percent with its sign, two decimals: `+0.63%`; a dash for a gap. */
function signedPercentCell(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING_VALUE;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export const returnsHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["returns-pane"],
  shape: "rows",
  description: "Interval and cumulative price returns of one ticker's bars over a range: each bar's close, its move from the bar before, and its move from the bar before the window.",
  describe: ({ symbols, options }) => `Returns | ${symbols[0]} | ${reportWindowText(options) ?? options.range ?? "5D"} | ${
    options.interval ?? defaultReturnInterval((options.range ?? "5D") as ReturnRange, readReportWindow(options))}`,
  async load({ symbols, options }, ctx) {
    const key = symbols[0]!;
    const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
    const range = (options.range ?? "5D") as ReturnRange;
    // --from 2007 --to 2009 measures those dates' returns in place of the range.
    const window = readReportWindow(options);
    // No --interval: the bars grow with the range, daily to 1Y.
    const requested = (options.interval ?? defaultReturnInterval(range, window)) as ManualChartResolution;
    const pastWindow = !!window && isPastPriceWindow(window);
    const support = await Promise.resolve(ctx.marketData.getChartResolutionSupport?.(symbol, exchange ?? "") ?? []).catch(logFailure("ticker-detail.headless", "Read return interval support failed", []));
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
    const price = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(decimals) : MISSING_VALUE;
    // The largest fall from a close to a later one in the window, said under the title; a yield's in bp, with its largest rise.
    // A week's or month's close is dated by its last session, not the 1st its bar is dated by ("peak 35.70 on 31 Mar 2026").
    const closes = unmarked.map((row) => ({ date: intraday ? row.time : barCloseSession(series.resolution, row.time, venue, now), close: row.close }));
    // A week still forming runs to today, and a window's last week can close after the dates asked for: the fall is measured to their end.
    const moves = (day: (value: string) => string) => closeMoves(closes, drawdownScaleOf(symbol),
      { basis: `${BAR_INTERVAL_LABELS[series.resolution]} closes`, price, date: (value) => intraday ? formatUtcTime(value) : day(value.slice(0, 10)) }, window?.to);
    const { drawdown, runUp, lines: moveLines } = moves((day) => day);
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
    // A narrow table drops the dollar moves, the interval's first, rather than putting Total % on a line under every row.
    const textFigures = figures.map((column) => column.key === "intervalChange" ? { ...column, optional: true, dropPriority: 2 }
      : column.key === "totalChange" ? { ...column, optional: true, dropPriority: 1 } : column);
    const textColumns: HeadlessPaneColumn[] = [timeColumn(true), ...textFigures];
    // Every exported row names what its prices are in and the bars' size, as `history --csv` does.
    const unit = rows.length ? await barPriceUnit(ctx, key, symbol, exchange, null) : null;
    // An interval the range is too long for is served in the nearest longer bar; say so rather than switch silently.
    const otherNotices = [
      baseDay ? `Totals ${periodBaseText(baseDay, now)}.` : null,
      series.resolution !== requested
        ? `${getChartResolutionLabel(requested)} bars do not ${window ? `cover ${priceWindowText(window)}` : `reach back ${range}`}; these are ${getChartResolutionLabel(series.resolution)} bars.`
        : null,
      historyCoverageNotice(series.coverageStart, series.visibleFrom),
      priceHistoryIntegrityNotice(rows.filter((row) => row.inconsistent).length) ?? null,
    ].filter((notice): notice is string => !!notice);
    const notices = [...moveLines, ...otherNotices];
    // The text writes the drawdown's days first, as the pane does; JSON and CSV keep them in ISO.
    const textNotices = [...moves((day) => formatDay(day)).lines, ...otherNotices];
    return {
      rows,
      columns,
      textColumns,
      ...(notices.length ? { textNotices } : {}),
      ...(unit ? { unit } : {}),
      interval: series.resolution,
      unavailableSymbols: rows.length ? [] : [key],
      ...(rows.length ? {} : { errors: [`${key}: No bars in this window.`] }),
      freshness: pastWindow ? pastWindowFreshness(window, series.resolution, "time") : {
        ...barHistoryFreshness(intraday ? null : series.resolution),
        observedKey: "time",
        oldest: null,
        ...(forming ? { periodToDate: forming } : closedDay ? { asOf: closedDay } : {}),
        ...(series.venue ? { cadenceExchange: series.venue } : {}),
        // The window ends at the last session while the market is shut, which the status line says, and whether its
        // last bar ends on the official close yet.
        ...(series.lastSession || series.closingPrintPending ? { note: [
          series.lastSession ? closedMarketNote(series.lastSession, series.visibleTo) : null,
          series.closingPrintPending ? CLOSING_PRINT_PENDING_TEXT : null,
        ].filter(Boolean).join(", ") } : {}),
        ...(dayToDate ? { basis: "daily bars", note: `the newest bar is ${DAY_SO_FAR_TEXT}` } : {}),
      },
      metadata: {
        symbol: key,
        range: window ? null : range,
        // The dates asked for, as history and HP carry them; `window` below is the span of the bars served.
        ...(window ? { requestedWindow: window } : {}),
        interval: series.resolution,
        requestedInterval: requested,
        window: { after: new Date(series.visibleFrom).toISOString(), through: new Date(series.visibleTo).toISOString() },
        ...(baseDay ? { baseDay } : {}),
        ...(series.lastSession ? { marketClosed: true, lastSession: series.lastSession } : {}),
        basis: "Price returns of bar closes; dividends are not included",
        maxDrawdown: drawdown,
        ...(runUp ? { maxRunUp: runUp } : {}),
        ...(notices.length ? { notices } : {}),
      },
    };
  },
};

/** A Cboe yield index (^TNX) moves by its level, in bp; anything else by its return. */
const drawdownScaleOf = (symbol: string) => isYieldIndexSymbol(parsePublicTickerKey(symbol).symbol) ? "yield" as const : "return" as const;
